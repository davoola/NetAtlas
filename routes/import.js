const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const { parse } = require('csv-parse');
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

function validateDictValues(record, errors, rowIdx) {
  if (record.device_type) {
    const valid = db.prepare('SELECT 1 FROM dict_device_types WHERE name = ?').get(record.device_type);
    if (!valid) errors.push(`第${rowIdx}行: 设备类型"${record.device_type}"不在字典中`);
  }
  if (record.department) {
    const valid = db.prepare('SELECT 1 FROM dict_departments WHERE name = ?').get(record.department);
    if (!valid) errors.push(`第${rowIdx}行: 部门"${record.department}"不在字典中`);
  }
  if (record.status) {
    const valid = db.prepare('SELECT 1 FROM dict_statuses WHERE name = ?').get(record.status);
    if (!valid) {
      record.status = normalizeStatus(record.status);
      const valid2 = db.prepare('SELECT 1 FROM dict_statuses WHERE name = ?').get(record.status);
      if (!valid2) errors.push(`第${rowIdx}行: 状态"${record.status}"不在字典中`);
    }
  }
}

function processRows(rows, req, strategy) {
  const user = req.session.user;
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
      const field = FIELD_MAP[key.trim()];
      if (field) record[field] = val !== null && val !== undefined ? String(val).trim() : '';
    }

    if (!record.ip) {
      errors.push(`第${i + 2}行: IP地址为空，已跳过`);
      skip++; continue;
    }

    if (!ipService.isValidIp(record.ip)) {
      errors.push(`第${i + 2}行: IP地址格式不合法: ${record.ip}`);
      skip++;
      continue;
    }

    record.vlan = normalizeVlan(record.vlan);
    if (!record.vlan && record.ip) {
      record.vlan = ipService.lookupVlanByIp(record.ip);
    }
    record.status = normalizeStatus(record.status);
    record.sunlogin_id = normalizeSunloginId(record.sunlogin_id);

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

    const vlanToken = record.vlan ? `plan:${getPlanIdByVlan(record.vlan)}` : null;
    if (!canManageVlan(req, vlanToken || record.vlan)) {
      errors.push(`第${i + 2}行: 无权管理VLAN ${record.vlan || '(自动)'}`);
      skip++;
      continue;
    }

    try {
      if (vlanToken) ipService.validateIpForVlan(record.ip, vlanToken);
    } catch (e) {
      errors.push(`第${i + 2}行: ${e.message}`);
      skip++;
      continue;
    }

    const existing = db.prepare('SELECT id FROM ip_records WHERE ip = ?').get(record.ip);
    if (existing) {
      if (strategy === 'skip') {
        errors.push(`第${i + 2}行: IP ${record.ip} 已存在，按"跳过"策略未导入`);
        skip++;
        continue;
      } else if (strategy === 'update') {
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

  const fileName = req.file ? Buffer.from(req.file.originalname, 'latin1').toString('utf8') : '未知';
  dictService.auditLog(user, 'import_data', `导入文件: ${fileName}，成功${success}条，更新${updated}条，跳过${skip}条${errors.length > 0 ? `，错误${errors.length}条` : ''}`, { target_type: 'import' });
  return { success, updated, skip, errors: errors.slice(0, 20), totalErrors: errors.length };
}

function getPlanIdByVlan(vlan) {
  const plan = db.prepare('SELECT id FROM vlan_plans WHERE vlan = ?').get(String(vlan));
  return plan ? plan.id : null;
}

router.post('/excel', requireAuth, requireRole('superadmin', 'admin'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择文件' });
  const strategy = req.body.strategy || 'skip';
  try {
    const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
    const result = processRows(rows, req, strategy);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: '解析Excel失败: ' + e.message });
  }
});

router.post('/csv', requireAuth, requireRole('superadmin', 'admin'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择文件' });
  const strategy = req.body.strategy || 'skip';
  parse(req.file.buffer.toString('utf-8'), { columns: true, skip_empty_lines: true }, (err, rows) => {
    if (err) return res.status(400).json({ error: '解析CSV失败: ' + err.message });
    const result = processRows(rows, req, strategy);
    res.json(result);
  });
});

module.exports = router;
