const express = require('express');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const { parseImportFile } = require('../services/fileParser');
const { UserError, publicMessage, logError } = require('../utils/errors');
const { requireAuth, requireRole, canManageVlan } = require('../middleware/auth');
const ipService = require('../services/ipService');
const dictService = require('../services/dictService');
const db = require('../db');

const ALLOWED_MIMES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/csv',
  'text/plain',
  '',
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype) || /\.(xlsx|xls|csv)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('仅支持 .xlsx, .xls, .csv 文件'));
    }
  },
});

const uploadSingle = upload.single('file');
function handleUpload(req, res, next) {
  uploadSingle(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '文件超过 10MB 限制' });
    if (err.name === 'MulterError') return res.status(400).json({ error: '文件上传失败' });
    return res.status(400).json({ error: publicMessage(err, '文件上传失败') });
  });
}

// 同一时间仅允许一个导入任务，避免并发大导入长时间占用同步数据库。
let importing = false;

const FIELD_MAP = {
  'VLAN': 'vlan', 'vlan': 'vlan',
  'IP地址': 'ip', 'IP': 'ip', 'ip地址': 'ip',
  'MAC地址': 'mac', 'MAC': 'mac', 'mac地址': 'mac',
  '设备类型': 'device_type',
  '设备名称': 'device_name', '设备名称/标识': 'device_name', '设备标识': 'device_name',
  '物理部署位置': 'location', '部署位置': 'location', '位置': 'location',
  '所属部门': 'department', '部门': 'department',
  '使用人': 'user_name',
  '备注': 'remark', '备注信息': 'remark',
  '使用状态': 'status', '状态': 'status',
  '登记日期': 'registered_at', '登记/更新日期': 'registered_at', '更新日期': 'registered_at',
  '上层交换机': 'upper_switch', '交换机': 'upper_switch',
  '交换机端口': 'switch_port', '端口': 'switch_port',
  '向日葵远程ID': 'sunlogin_id', '向日葵ID': 'sunlogin_id', '向日葵': 'sunlogin_id',
  '网关': 'gateway',
};

function normalizeVlan(val) {
  if (val === null || val === undefined || val === '') return null;
  const s = String(val).trim();
  if (s === '自动获取') return null;
  const num = parseInt(s);
  if (!isNaN(num)) return String(num);
  return s;
}

function normalizeStatus(val) {
  if (!val) return '已使用';
  const s = String(val).trim();
  if (s.includes('使用') && !s.includes('废弃') && !s.includes('预留') && !s.includes('备用')) return '已使用';
  if (s.includes('预留') || s.includes('备用')) return '预留/备用';
  if (s.includes('废弃')) return '已废弃';
  if (s.includes('DHCP') || s.includes('动态')) return '已使用';
  return s;
}

function normalizeSunloginId(val) {
  if (val === null || val === undefined) return null;
  return String(val).trim();
}

function normalizeRegisteredAt(val) {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  if (typeof val === 'number' && Number.isFinite(val)) {
    const date = new Date(Date.UTC(1899, 11, 30) + val * 86400000);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  const text = String(val).trim();
  const parsed = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (parsed) return `${parsed[1]}-${parsed[2].padStart(2, '0')}-${parsed[3].padStart(2, '0')}`;
  return text;
}

function getPlanByVlan(vlan, ip) {
  const plans = db.prepare('SELECT * FROM vlan_plans WHERE vlan = ? ORDER BY sort_order, id').all(String(vlan));
  if (!plans.length) return null;
  if (ip) {
    const matched = plans.find(p => p.subnet && ipService.ipInCidr(ip, p.subnet));
    if (matched) return matched;
  }
  return plans[0];
}

class ImportRollback extends Error {
  constructor(result) { super('import rolled back'); this.result = result; }
}

function processRows(rows, req, strategy, atomic = false) {
  const batchId = crypto.randomBytes(4).toString('hex');
  let result;
  try {
    // 整批导入放入同一事务：中途异常整体回滚；严格模式下只要有被跳过的行就整体回滚
    result = db.transaction(() => {
      const r = processRowsInner(rows, req, strategy, batchId);
      if (atomic && r.skip > 0) throw new ImportRollback(r);
      return r;
    });
  } catch (e) {
    if (e instanceof ImportRollback) {
      const r = e.result;
      dictService.auditLog(req.session.user, 'import_data', `导入批次 ${batchId} 严格模式已整体回滚；操作者 ${req.session.user.username}；文件 ${getFileName(req)}（SHA-256 ${getFileSha256(req)}）；共${rows.length}行，策略 ${strategy}，跳过${r.skip}条，错误/警告${r.totalErrors}条`, { target_type: 'import' });
      return { success: 0, updated: 0, skip: r.skip, errors: r.errors, totalErrors: r.totalErrors, rolledBack: true, batchId };
    }
    throw e;
  }
  const errSummary = result.allErrors.slice(0, 10).join('；').slice(0, 1500);
  dictService.auditLog(req.session.user, 'import_data', `导入批次 ${batchId}；操作者 ${req.session.user.username}；文件 ${getFileName(req)}（SHA-256 ${getFileSha256(req)}）；共${rows.length}行，策略 ${strategy}；成功${result.success}条，更新${result.updated}条，跳过${result.skip}条${result.totalErrors > 0 ? `，错误/警告${result.totalErrors}条（前10条：${errSummary}）` : ''}`, { target_type: 'import' });
  delete result.allErrors;
  return { ...result, batchId };
}

function getFileSha256(req) {
  return req.file ? crypto.createHash('sha256').update(req.file.buffer).digest('hex') : '';
}

function getFileName(req) {
  return req.file ? Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 200) : '未知';
}

function processRowsInner(rows, req, strategy) {
  let success = 0, skip = 0, updated = 0;
  const errors = [];
  const validDeviceTypes = new Set(db.prepare('SELECT name FROM dict_device_types').all().map(r => r.name));
  const validStatuses = new Set(db.prepare('SELECT name FROM dict_statuses').all().map(r => r.name));
  const validDepartments = new Set(db.prepare('SELECT name FROM dict_departments').all().map(r => r.name));
  const validVlans = new Set(db.prepare('SELECT DISTINCT vlan FROM vlan_plans').all().map(r => String(r.vlan)));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const record = {};
    for (const [key, val] of Object.entries(row)) {
      const trimmedKey = key.trim();
      if (!Object.prototype.hasOwnProperty.call(FIELD_MAP, trimmedKey)) continue;
      const field = FIELD_MAP[trimmedKey];
      // 保留 Excel 的 Date 对象，避免先转成英文日期字符串导致格式无法统一。
      record[field] = val !== null && val !== undefined && !(val instanceof Date) ? String(val).trim() : val;
    }

    record.vlan = normalizeVlan(record.vlan);
    if (!record.vlan && record.ip) {
      record.vlan = ipService.lookupVlanByIp(record.ip);
    }

    // Determine if this VLAN is a dynamic IP pool
    const planForVlan = record.vlan ? getPlanByVlan(record.vlan, record.ip) : null;
    const isDynamic = planForVlan && planForVlan.is_dynamic;

    if (!isDynamic) {
      if (!record.ip) {
        errors.push(`第${i + 2}行: IP地址为空，已跳过`);
        skip++; continue;
      }
      if (!ipService.isValidIp(record.ip)) {
        errors.push(`第${i + 2}行: IP地址格式不合法: ${record.ip}`);
        skip++;
        continue;
      }
    } else if (record.ip && !ipService.isValidIp(record.ip)) {
      errors.push(`第${i + 2}行: IP地址格式不合法: ${record.ip}`);
      skip++;
      continue;
    }

    record.status = normalizeStatus(record.status);
    record.sunlogin_id = normalizeSunloginId(record.sunlogin_id);
    record.registered_at = normalizeRegisteredAt(record.registered_at);

    if (!record.vlan) {
      errors.push(`第${i + 2}行: 无法自动识别VLAN，且该VLAN不存在于字典中，请先至数据字典添加`);
      skip++;
      continue;
    }
    if (!validVlans.has(String(record.vlan))) {
      errors.push(`第${i + 2}行: VLAN "${record.vlan}" 不存在于数据字典中，请先至数据字典添加`);
      skip++;
      continue;
    }

    if (record.device_type && !validDeviceTypes.has(record.device_type)) {
      errors.push(`第${i + 2}行: 设备类型"${record.device_type}"不在字典中，已清空`);
      record.device_type = null;
    }
    if (record.department && !validDepartments.has(record.department)) {
      errors.push(`第${i + 2}行: 部门"${record.department}"不在字典中，已清空`);
      record.department = null;
    }
    if (record.status && !validStatuses.has(record.status)) {
      errors.push(`第${i + 2}行: 状态"${record.status}"不在字典中，已设为默认`);
      record.status = '已使用';
    }

    // 同一 VLAN 编号可能对应多条网段规划：必须按 IP 所属子网选 plan，不能 LIMIT 1 取第一条
    const vlanToken = record.vlan ? (() => {
      const planId = getPlanIdByVlan(record.vlan, record.ip);
      return planId ? `plan:${planId}` : record.vlan;
    })() : null;
    if (!canManageVlan(req, vlanToken || record.vlan)) {
      errors.push(`第${i + 2}行: 无权管理VLAN ${record.vlan || '(自动)'}`);
      skip++;
      continue;
    }

    try {
      if (vlanToken && record.ip) ipService.validateIpForVlan(record.ip, vlanToken);
    } catch (e) {
      errors.push(`第${i + 2}行: ${e.message}`);
      skip++;
      continue;
    }

    const existing = record.ip ? db.prepare('SELECT id, vlan FROM ip_records WHERE ip = ? ORDER BY id LIMIT 1').get(record.ip) : null;
    if (existing) {
      if (strategy === 'skip') {
        errors.push(`第${i + 2}行: IP ${record.ip} 已存在，按"跳过"策略未导入`);
        skip++;
        continue;
      } else if (strategy === 'update') {
        // 必须同时具备"原记录所属 VLAN"的管理权限，防止越权覆盖/迁移未授权 VLAN 的记录
        if (!canManageVlan(req, existing.vlan)) {
          errors.push(`第${i + 2}行: 无权更新IP ${record.ip} 的现有记录（其所属VLAN未授权给您）`);
          skip++;
          continue;
        }
        try {
          ipService.updateRecord(existing.id, record);
          updated++;
        } catch (e) {
          errors.push(`第${i + 2}行: 更新失败: ${e.message}`);
          skip++;
        }
        continue;
      } else {
        errors.push(`第${i + 2}行: IP重复（策略: 报错）`);
        skip++;
        continue;
      }
    }

    try {
      ipService.createRecord(record);
      success++;
    } catch (e) {
      errors.push(`第${i + 2}行: ${e.message}`);
      skip++;
    }
  }

  return { success, updated, skip, errors: errors.slice(0, 20), totalErrors: errors.length, allErrors: errors };
}

function getPlanIdByVlan(vlan, ip) {
  const plan = getPlanByVlan(vlan, ip);
  return plan ? plan.id : null;
}

async function handleImport(kind, req, res, next) {
  if (!req.file) return res.status(400).json({ error: '请选择文件' });
  const strategy = ['skip', 'update', 'error'].includes(req.body.strategy) ? req.body.strategy : 'skip';
  const atomic = req.body.atomic === '1' || req.body.atomic === 'true';
  if (importing) return res.status(429).json({ error: '已有导入任务正在进行，请稍后再试' });
  importing = true;
  try {
    const rows = await parseImportFile(req.file.buffer, kind);
    const result = processRows(rows, req, strategy, atomic);
    res.json(result);
  } catch (e) {
    if (!e.expose) logError(req, e, 'import');
    res.status(e.expose ? (e.status || 400) : 500).json({ error: publicMessage(e, '导入失败，请检查文件内容后重试'), requestId: req.id });
  } finally {
    importing = false;
  }
}

router.post('/excel', requireAuth, requireRole('superadmin'), handleUpload, (req, res, next) => handleImport('excel', req, res, next));
router.post('/csv', requireAuth, requireRole('superadmin'), handleUpload, (req, res, next) => handleImport('csv', req, res, next));

module.exports = router;
