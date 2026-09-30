const fs = require('fs');
const path = require('path');
const db = require('../db');
const { UserError } = require('../utils/errors');
const { getAuditLogRetentionDays } = require('../utils/retention');

/** 排序值：缺省为 0；必须为 0–999999 的整数 */
function normalizeSortOrder(v, fallback = 0) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0 || n > 999999) {
    throw new UserError('排序值必须为 0-999999 之间的整数');
  }
  return n;
}

function getDeviceTypes() {
  return db.prepare('SELECT * FROM dict_device_types ORDER BY sort_order, name').all();
}
function addDeviceType(name, description) {
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM dict_device_types').get().m || 0;
  const result = db.prepare('INSERT OR IGNORE INTO dict_device_types (name, description, sort_order) VALUES (?,?,?)').run(name, description || null, maxOrder + 1);
  if (result.changes === 0) throw new UserError(`设备类型"${name}"已存在`);
  return getDeviceTypes();
}
function updateDeviceType(id, data) {
  const old = db.prepare('SELECT name FROM dict_device_types WHERE id = ?').get(id);
  if (!old) throw new UserError('设备类型不存在');
  db.transaction(() => {
    db.prepare('UPDATE dict_device_types SET name=?, description=?, sort_order=? WHERE id=?').run(
      data.name, data.description || null, normalizeSortOrder(data.sort_order, 0), id
    );
    if (old.name !== data.name) db.prepare('UPDATE ip_records SET device_type=? WHERE device_type=?').run(data.name, old.name);
  });
  return getDeviceTypes();
}
function deleteDeviceType(id) {
  const row = db.prepare('SELECT name FROM dict_device_types WHERE id = ?').get(id);
  if (!row) throw new UserError('设备类型不存在');
  const count = db.prepare("SELECT COUNT(*) as cnt FROM ip_records WHERE device_type = ?").get(row.name).cnt;
  if (count > 0) throw new UserError(`该设备类型下还有 ${count} 条IP登记记录，请先迁移或清空后再删除`);
  db.prepare('DELETE FROM dict_device_types WHERE id = ?').run(id);
}

function getStatuses() {
  return db.prepare('SELECT * FROM dict_statuses ORDER BY sort_order, name').all();
}
function addStatus(name, description) {
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM dict_statuses').get().m || 0;
  const result = db.prepare('INSERT OR IGNORE INTO dict_statuses (name, description, sort_order) VALUES (?,?,?)').run(name, description || null, maxOrder + 1);
  if (result.changes === 0) throw new UserError(`使用状态"${name}"已存在`);
  return getStatuses();
}
function updateStatus(id, data) {
  const old = db.prepare('SELECT name FROM dict_statuses WHERE id = ?').get(id);
  if (!old) throw new UserError('使用状态不存在');
  db.transaction(() => {
    db.prepare('UPDATE dict_statuses SET name=?, description=?, sort_order=? WHERE id=?').run(
      data.name, data.description || null, normalizeSortOrder(data.sort_order, 0), id
    );
    if (old.name !== data.name) db.prepare('UPDATE ip_records SET status=? WHERE status=?').run(data.name, old.name);
  });
  return getStatuses();
}
function deleteStatus(id) {
  const row = db.prepare('SELECT name FROM dict_statuses WHERE id = ?').get(id);
  if (!row) throw new UserError('使用状态不存在');
  const count = db.prepare("SELECT COUNT(*) as cnt FROM ip_records WHERE status = ?").get(row.name).cnt;
  if (count > 0) throw new UserError(`该状态下还有 ${count} 条IP登记记录，请先迁移或清空后再删除`);
  db.prepare('DELETE FROM dict_statuses WHERE id = ?').run(id);
}

function getDepartments() {
  return db.prepare('SELECT * FROM dict_departments ORDER BY sort_order, name').all();
}
function addDepartment(name) {
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM dict_departments').get().m || 0;
  const result = db.prepare('INSERT OR IGNORE INTO dict_departments (name, sort_order) VALUES (?,?)').run(name, maxOrder + 1);
  if (result.changes === 0) throw new UserError(`部门"${name}"已存在`);
  return getDepartments();
}
function updateDepartment(id, data) {
  const old = db.prepare('SELECT name FROM dict_departments WHERE id = ?').get(id);
  if (!old) throw new UserError('部门不存在');
  db.transaction(() => {
    db.prepare('UPDATE dict_departments SET name=?, sort_order=? WHERE id=?').run(
      data.name, normalizeSortOrder(data.sort_order, 0), id
    );
    if (old.name !== data.name) db.prepare('UPDATE ip_records SET department=? WHERE department=?').run(data.name, old.name);
  });
  return getDepartments();
}
function deleteDepartment(id) {
  const row = db.prepare('SELECT name FROM dict_departments WHERE id = ?').get(id);
  if (!row) throw new UserError('部门不存在');
  const count = db.prepare("SELECT COUNT(*) as cnt FROM ip_records WHERE department = ?").get(row.name).cnt;
  if (count > 0) throw new UserError(`该部门下还有 ${count} 条IP登记记录，请先迁移或清空后再删除`);
  db.prepare('DELETE FROM dict_departments WHERE id = ?').run(id);
}

function getVlanPlans() {
  return db.prepare('SELECT * FROM vlan_plans ORDER BY sort_order, id').all();
}
function getVlanPlanById(id) {
  return db.prepare('SELECT * FROM vlan_plans WHERE id = ?').get(Number(id));
}

function normalizeVlanIpv6Fields(data) {
  const enableIpv6 = data.enable_ipv6 ? 1 : 0;
  let ipv6Subnet = data.ipv6_subnet ? String(data.ipv6_subnet).trim() : '';
  let ipv6Gateway = data.ipv6_gateway ? String(data.ipv6_gateway).trim() : '';
  if (!enableIpv6) {
    ipv6Subnet = '';
    ipv6Gateway = '';
  } else {
    if (!ipv6Subnet) throw new UserError('启用 IPv6 时必须填写 IPv6 网段');
    const ipService = require('./ipService');
    if (!ipService.isValidIpv6Cidr(ipv6Subnet)) {
      throw new UserError('IPv6 网段格式不正确，应为如 2002:260:5501:102::/64');
    }
    if (ipv6Gateway && !ipService.isValidIpv6(ipv6Gateway)) {
      throw new UserError('IPv6 网关格式不正确');
    }
  }
  return { enableIpv6, ipv6Subnet: ipv6Subnet || null, ipv6Gateway: ipv6Gateway || null };
}

function assertNoSubnetOverlap(subnet, excludeId = null) {
  const ipService = require('./ipService');
  const others = db.prepare("SELECT id, vlan, name, subnet FROM vlan_plans WHERE subnet IS NOT NULL AND TRIM(subnet) != ''").all();
  for (const o of others) {
    if (excludeId != null && Number(o.id) === Number(excludeId)) continue;
    if (ipService.cidrsOverlap(subnet, o.subnet)) {
      throw new UserError(`网段与已有规划重叠：VLAN ${o.vlan} ${o.name || ''}（${o.subnet}）。系统不允许大网套小网或交叉重叠`);
    }
  }
}

function addVlanPlan(data) {
  if (!data.vlan || !String(data.vlan).trim()) throw new UserError('VLAN编号为必填项');
  const vlan = String(data.vlan).trim();
  const isDynamic = data.is_dynamic ? 1 : 0;
  const hasSubnet = data.subnet && String(data.subnet).trim();
  if (!isDynamic && !hasSubnet) throw new UserError('网段为必填项');
  let subnet = null;
  if (hasSubnet) {
    const ipService = require('./ipService');
    subnet = ipService.normalizeSubnetCidr(data.subnet);
    if (!subnet) throw new UserError('网段格式不正确，应为如 192.168.10.0/24');
    assertNoSubnetOverlap(subnet, null);
  }
  if (data.gateway && data.gateway !== '-' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(data.gateway).trim())) throw new UserError('网关IP格式不正确');
  const { enableIpv6, ipv6Subnet, ipv6Gateway } = normalizeVlanIpv6Fields(data);
  // 与其它字典一致：新增时 sort_order 自动取当前最大值 + 1
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM vlan_plans').get().m || 0;
  const sortOrder = maxOrder + 1;
  try {
    db.prepare(`INSERT INTO vlan_plans (vlan, name, subnet, mask, gateway, description, address_pool_note, sort_order, is_dynamic, enable_ipv6, ipv6_subnet, ipv6_gateway)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      vlan, data.name || null, subnet, data.mask || null,
      data.gateway ? String(data.gateway).trim() : null, data.description || null, data.address_pool_note || null,
      sortOrder, isDynamic, enableIpv6, ipv6Subnet, ipv6Gateway
    );
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new UserError('该VLAN在此网段下的规划已存在');
    throw e;
  }
  return getVlanPlans();
}
function updateVlanPlan(id, data) {
  const old = db.prepare('SELECT vlan, subnet FROM vlan_plans WHERE id = ?').get(id);
  if (!old) throw new UserError('VLAN规划不存在');
  if (!data.vlan || !String(data.vlan).trim()) throw new UserError('VLAN编号为必填项');
  const vlan = String(data.vlan).trim();
  const isDynamic = data.is_dynamic ? 1 : 0;
  const hasSubnet = data.subnet && String(data.subnet).trim();
  if (!isDynamic && !hasSubnet) throw new UserError('网段为必填项');
  let subnet = null;
  if (hasSubnet) {
    const ipService = require('./ipService');
    subnet = ipService.normalizeSubnetCidr(data.subnet);
    if (!subnet) throw new UserError('网段格式不正确，应为如 192.168.10.0/24');
    assertNoSubnetOverlap(subnet, id);
    // 修改网段时：原范围内登记记录必须仍落在新网段内
    if (old.subnet) {
      const oldParsed = ipService.parseCidr(old.subnet);
      if (oldParsed) {
        const stuck = db.prepare(
          'SELECT COUNT(*) as cnt FROM ip_records WHERE vlan = ? AND ip_sort IS NOT NULL AND ip_sort >= ? AND ip_sort <= ? AND NOT (ip_sort >= ? AND ip_sort <= ?)'
        ).get(old.vlan, oldParsed.network, oldParsed.broadcast,
              ipService.parseCidr(subnet).network, ipService.parseCidr(subnet).broadcast);
        if (stuck && stuck.cnt > 0) {
          throw new UserError(`无法修改网段：仍有 ${stuck.cnt} 条登记记录落在原网段但不在新网段内，请先迁移或删除这些记录`);
        }
      }
    }
  }
  if (data.gateway && data.gateway !== '-' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(data.gateway).trim())) throw new UserError('网关IP格式不正确');
  const { enableIpv6, ipv6Subnet, ipv6Gateway } = normalizeVlanIpv6Fields(data);
  db.transaction(() => {
    db.prepare(`UPDATE vlan_plans SET vlan=?, name=?, subnet=?, mask=?, gateway=?, description=?, address_pool_note=?, sort_order=?, is_dynamic=?, enable_ipv6=?, ipv6_subnet=?, ipv6_gateway=? WHERE id=?`).run(
      vlan, data.name || null, subnet, data.mask || null,
      data.gateway ? String(data.gateway).trim() : null, data.description || null, data.address_pool_note || null,
      normalizeSortOrder(data.sort_order, 0), isDynamic, enableIpv6, ipv6Subnet, ipv6Gateway, id
    );
    if (old.vlan !== vlan) {
      const ipService = require('./ipService');
      const parsed = old.subnet ? ipService.parseCidr(old.subnet) : null;
      if (parsed) {
        db.prepare('UPDATE ip_records SET vlan=? WHERE vlan=? AND ip_sort IS NOT NULL AND ip_sort >= ? AND ip_sort <= ?').run(vlan, old.vlan, parsed.network, parsed.broadcast);
      } else {
        // 无 IPv4 网段的规划（如纯动态池）：仅当同编号下没有其它规划时才整体改号
        const siblings = db.prepare('SELECT id FROM vlan_plans WHERE vlan = ? AND id != ?').all(old.vlan, id);
        if (siblings.length > 0) throw new UserError('同 VLAN 编号下存在多个规划，无法安全地整体改号，请先处理其它规划');
        db.prepare('UPDATE ip_records SET vlan=? WHERE vlan=?').run(vlan, old.vlan);
      }
    }
  });
  return getVlanPlans();
}
function deleteVlanPlan(id) {
  const plan = db.prepare('SELECT vlan, subnet FROM vlan_plans WHERE id = ?').get(id);
  if (!plan) throw new UserError('VLAN规划不存在');
  let count;
  if (plan.subnet) {
    const ipService = require('./ipService');
    const parsed = ipService.parseCidr(plan.subnet);
    if (parsed) {
      count = db.prepare('SELECT COUNT(*) as cnt FROM ip_records WHERE vlan = ? AND ip_sort >= ? AND ip_sort <= ?').get(plan.vlan, parsed.network, parsed.broadcast).cnt;
    } else {
      count = db.prepare('SELECT COUNT(*) as cnt FROM ip_records WHERE vlan = ?').get(plan.vlan).cnt;
    }
  } else {
    count = db.prepare('SELECT COUNT(*) as cnt FROM ip_records WHERE vlan = ?').get(plan.vlan).cnt;
  }
  if (count > 0) throw new UserError(`该VLAN下还有 ${count} 条IP登记记录，请先迁移或清空后再删除`);
  db.prepare('DELETE FROM vlan_plans WHERE id = ?').run(id);
}

function getPrefixGateways() {
  return db.prepare('SELECT * FROM ip_prefix_gateways ORDER BY prefix').all();
}
function addPrefixGateway(prefix, gateway, default_vlan) {
  if (!prefix || !String(prefix).trim()) throw new UserError('IP前缀为必填项');
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(prefix))) throw new UserError('前缀格式不正确，应为如 192.168.10');
  if (!gateway || !String(gateway).trim()) throw new UserError('网关为必填项');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(gateway))) throw new UserError('网关IP格式不正确');
  const result = db.prepare('INSERT OR IGNORE INTO ip_prefix_gateways (prefix, gateway, default_vlan) VALUES (?,?,?)').run(prefix, gateway, default_vlan || null);
  if (result.changes === 0) throw new UserError(`IP前缀"${prefix}"的网关映射已存在`);
  return getPrefixGateways();
}
function updatePrefixGateway(id, prefix, gateway, default_vlan) {
  if (!prefix || !String(prefix).trim()) throw new UserError('IP前缀为必填项');
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(prefix))) throw new UserError('前缀格式不正确，应为如 192.168.10');
  if (!gateway || !String(gateway).trim()) throw new UserError('网关为必填项');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(gateway))) throw new UserError('网关IP格式不正确');
  db.prepare('UPDATE ip_prefix_gateways SET prefix=?, gateway=?, default_vlan=? WHERE id=?').run(prefix, gateway, default_vlan || null, id);
  return getPrefixGateways();
}
function deletePrefixGateway(id) {
  const row = db.prepare('SELECT prefix FROM ip_prefix_gateways WHERE id = ?').get(id);
  if (!row) throw new UserError('网关映射不存在');
  const count = db.prepare('SELECT COUNT(*) as cnt FROM ip_records WHERE ip LIKE ?').get(`${row.prefix}.%`).cnt;
  if (count > 0) throw new UserError(`该前缀下还有 ${count} 条IP登记记录，请先迁移或清空后再删除`);
  db.prepare('DELETE FROM ip_prefix_gateways WHERE id = ?').run(id);
}

function getSetting(key, defaultVal) {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
  return row ? row.value : defaultVal;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO system_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, value, value);
}
function checkpointDatabase() {
  db.pragma('wal_checkpoint(TRUNCATE)');
  return { success: true, message: '数据库已成功写入主文件' };
}

function getDatabaseFilePath() {
  // 与 db/index.js 保持一致：默认库文件在项目 db/ 目录，而不是 services/
  if (process.env.DB_PATH && String(process.env.DB_PATH).trim()) {
    return path.resolve(String(process.env.DB_PATH).trim());
  }
  return path.resolve(path.join(__dirname, '..', 'db', 'ipam.db'));
}

/**
 * 备份主库到 BACKUP_DIR（.env 配置）。
 * 先 WAL checkpoint，再复制，保证备份一致。
 * 文件名：原库名-YYYYMMDD.db；同日重复备份追加 -HHmmss。
 */
function backupDatabase() {
  const backupDirRaw = process.env.BACKUP_DIR;
  if (!backupDirRaw || !String(backupDirRaw).trim()) {
    throw new UserError('未配置备份目录，请在 .env 中设置 BACKUP_DIR', 400);
  }

  const srcPath = getDatabaseFilePath();
  if (!fs.existsSync(srcPath)) {
    throw new UserError('数据库文件不存在', 500);
  }

  const destDir = path.resolve(String(backupDirRaw).trim());
  fs.mkdirSync(destDir, { recursive: true });

  db.pragma('wal_checkpoint(TRUNCATE)');

  const ext = path.extname(srcPath) || '.db';
  const base = path.basename(srcPath, ext);
  const now = new Date();
  const ymd = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');

  let filename = base + '-' + ymd + ext;
  let destPath = path.join(destDir, filename);
  if (fs.existsSync(destPath)) {
    const hms = [
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('');
    filename = base + '-' + ymd + '-' + hms + ext;
    destPath = path.join(destDir, filename);
  }

  fs.copyFileSync(srcPath, destPath);
  try { fs.chmodSync(destDir, 0o700); } catch (e) { /* ignore */ }
  try { fs.chmodSync(destPath, 0o600); } catch (e) { /* ignore */ }
  const size = fs.statSync(destPath).size;
  // 不向客户端返回绝对路径
  return { success: true, message: '数据库备份成功', filename, size };
}

function cleanupAuditLogs(beforeDate) {
  const MIN_RETENTION_DAYS = getAuditLogRetentionDays();
  const cutoff = new Date(beforeDate + 'T00:00:00');
  if (Number.isNaN(cutoff.getTime())) throw new UserError('请输入有效的清理截止日期');
  const minDate = new Date(Date.now() - MIN_RETENTION_DAYS * 86400000);
  // 只允许清理「最短保留期之前」的日志：beforeDate 必须 <= 今天 - N 天
  if (cutoff > minDate) {
    throw new UserError(`审计日志至少保留 ${MIN_RETENTION_DAYS} 天，不可清理近期日志`);
  }
  const result = db.prepare("DELETE FROM audit_log WHERE created_at < datetime(?, 'start of day')").run(beforeDate);
  return result.changes;
}

function auditLog(user, action, detail, opts = {}) {
  // ip_address 列统一记录操作者来源 IP（actor_ip / req.ip）
  // 业务对象 IP 请写在 detail 文案中，或通过 opts.business_ip 追加到 detail
  const actorIp = opts.actor_ip
    || (opts.req && (opts.req.ip || null))
    || null;
  let detailText = detail == null ? null : String(detail);
  const businessIp = opts.business_ip || null;
  if (businessIp && detailText && !detailText.includes(String(businessIp))) {
    detailText = detailText + ` [对象IP: ${businessIp}]`;
  }
  db.prepare('INSERT INTO audit_log (user_id, username, action, detail, target_type, target_id, ip_address) VALUES (?,?,?,?,?,?,?)').run(
    user ? user.id : null,
    user ? user.username : null,
    action,
    detailText,
    opts.target_type || null,
    opts.target_id || null,
    actorIp
  );
}

module.exports = {
  getDeviceTypes, addDeviceType, updateDeviceType, deleteDeviceType,
  getStatuses, addStatus, updateStatus, deleteStatus,
  getDepartments, addDepartment, updateDepartment, deleteDepartment,
  getVlanPlans, getVlanPlanById, addVlanPlan, updateVlanPlan, deleteVlanPlan,
  getPrefixGateways, addPrefixGateway, updatePrefixGateway, deletePrefixGateway,
  getSetting, setSetting, checkpointDatabase, backupDatabase, cleanupAuditLogs, auditLog,
};
