const db = require('../db');

function getDeviceTypes() {
  return db.prepare('SELECT * FROM dict_device_types ORDER BY sort_order, name').all();
}
function addDeviceType(name, description) {
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM dict_device_types').get().m || 0;
  const result = db.prepare('INSERT OR IGNORE INTO dict_device_types (name, description, sort_order) VALUES (?,?,?)').run(name, description || null, maxOrder + 1);
  if (result.changes === 0) throw new Error(`设备类型"${name}"已存在`);
  return getDeviceTypes();
}
function updateDeviceType(id, data) {
  db.prepare('UPDATE dict_device_types SET name=?, description=?, sort_order=? WHERE id=?').run(
    data.name, data.description || null, data.sort_order !== undefined ? data.sort_order : 0, id
  );
  return getDeviceTypes();
}
function deleteDeviceType(id) {
  const row = db.prepare('SELECT name FROM dict_device_types WHERE id = ?').get(id);
  if (!row) throw new Error('设备类型不存在');
  const count = db.prepare("SELECT COUNT(*) as cnt FROM ip_records WHERE device_type = ?").get(row.name).cnt;
  if (count > 0) throw new Error(`该设备类型下还有 ${count} 条IP登记记录，请先迁移或清空后再删除`);
  db.prepare('DELETE FROM dict_device_types WHERE id = ?').run(id);
}

function getStatuses() {
  return db.prepare('SELECT * FROM dict_statuses ORDER BY sort_order, name').all();
}
function addStatus(name, description) {
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM dict_statuses').get().m || 0;
  const result = db.prepare('INSERT OR IGNORE INTO dict_statuses (name, description, sort_order) VALUES (?,?,?)').run(name, description || null, maxOrder + 1);
  if (result.changes === 0) throw new Error(`使用状态"${name}"已存在`);
  return getStatuses();
}
function updateStatus(id, data) {
  db.prepare('UPDATE dict_statuses SET name=?, description=?, sort_order=? WHERE id=?').run(
    data.name, data.description || null, data.sort_order !== undefined ? data.sort_order : 0, id
  );
  return getStatuses();
}
function deleteStatus(id) {
  const row = db.prepare('SELECT name FROM dict_statuses WHERE id = ?').get(id);
  if (!row) throw new Error('使用状态不存在');
  const count = db.prepare("SELECT COUNT(*) as cnt FROM ip_records WHERE status = ?").get(row.name).cnt;
  if (count > 0) throw new Error(`该状态下还有 ${count} 条IP登记记录，请先迁移或清空后再删除`);
  db.prepare('DELETE FROM dict_statuses WHERE id = ?').run(id);
}

function getDepartments() {
  return db.prepare('SELECT * FROM dict_departments ORDER BY sort_order, name').all();
}
function addDepartment(name) {
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM dict_departments').get().m || 0;
  const result = db.prepare('INSERT OR IGNORE INTO dict_departments (name, sort_order) VALUES (?,?)').run(name, maxOrder + 1);
  if (result.changes === 0) throw new Error(`部门"${name}"已存在`);
  return getDepartments();
}
function updateDepartment(id, data) {
  db.prepare('UPDATE dict_departments SET name=?, sort_order=? WHERE id=?').run(
    data.name, data.sort_order !== undefined ? data.sort_order : 0, id
  );
  return getDepartments();
}
function deleteDepartment(id) {
  const row = db.prepare('SELECT name FROM dict_departments WHERE id = ?').get(id);
  if (!row) throw new Error('部门不存在');
  const count = db.prepare("SELECT COUNT(*) as cnt FROM ip_records WHERE department = ?").get(row.name).cnt;
  if (count > 0) throw new Error(`该部门下还有 ${count} 条IP登记记录，请先迁移或清空后再删除`);
  db.prepare('DELETE FROM dict_departments WHERE id = ?').run(id);
}

function getVlanPlans() {
  return db.prepare('SELECT * FROM vlan_plans ORDER BY sort_order, id').all();
}
function getVlanPlanById(id) {
  return db.prepare('SELECT * FROM vlan_plans WHERE id = ?').get(Number(id));
}
function addVlanPlan(data) {
  if (!data.vlan || !String(data.vlan).trim()) throw new Error('VLAN编号为必填项');
  if (!data.subnet || !String(data.subnet).trim()) throw new Error('网段为必填项');
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(String(data.subnet))) throw new Error('网段格式不正确，应为如 192.168.10.0/24');
  if (data.gateway && data.gateway !== '-' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(data.gateway))) throw new Error('网关IP格式不正确');
  try {
    db.prepare(`INSERT INTO vlan_plans (vlan, name, subnet, mask, gateway, description, address_pool_note, sort_order)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      data.vlan, data.name || null, data.subnet || null, data.mask || null,
      data.gateway || null, data.description || null, data.address_pool_note || null,
      data.sort_order || 0
    );
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new Error('该VLAN在此网段下的规划已存在');
    throw e;
  }
  return getVlanPlans();
}
function updateVlanPlan(id, data) {
  if (!data.vlan || !String(data.vlan).trim()) throw new Error('VLAN编号为必填项');
  if (!data.subnet || !String(data.subnet).trim()) throw new Error('网段为必填项');
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(String(data.subnet))) throw new Error('网段格式不正确，应为如 192.168.10.0/24');
  if (data.gateway && data.gateway !== '-' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(data.gateway))) throw new Error('网关IP格式不正确');
  db.prepare(`UPDATE vlan_plans SET vlan=?, name=?, subnet=?, mask=?, gateway=?, description=?, address_pool_note=?, sort_order=? WHERE id=?`).run(
    data.vlan, data.name || null, data.subnet || null, data.mask || null,
    data.gateway || null, data.description || null, data.address_pool_note || null,
    data.sort_order || 0, id
  );
  return getVlanPlans();
}
function deleteVlanPlan(id) {
  const plan = db.prepare('SELECT vlan, subnet FROM vlan_plans WHERE id = ?').get(id);
  if (!plan) throw new Error('VLAN规划不存在');
  const prefix = plan.subnet ? plan.subnet.split('/')[0].split('.').slice(0, 3).join('.') : '';
  let count;
  if (prefix) {
    count = db.prepare('SELECT COUNT(*) as cnt FROM ip_records WHERE vlan = ? AND ip LIKE ?').get(plan.vlan, `${prefix}.%`).cnt;
  } else {
    count = db.prepare('SELECT COUNT(*) as cnt FROM ip_records WHERE vlan = ?').get(plan.vlan).cnt;
  }
  if (count > 0) throw new Error(`该VLAN下还有 ${count} 条IP登记记录，请先迁移或清空后再删除`);
  db.prepare('DELETE FROM vlan_plans WHERE id = ?').run(id);
}

function getPrefixGateways() {
  return db.prepare('SELECT * FROM ip_prefix_gateways ORDER BY prefix').all();
}
function addPrefixGateway(prefix, gateway, default_vlan) {
  if (!prefix || !String(prefix).trim()) throw new Error('IP前缀为必填项');
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(prefix))) throw new Error('前缀格式不正确，应为如 192.168.10');
  if (!gateway || !String(gateway).trim()) throw new Error('网关为必填项');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(gateway))) throw new Error('网关IP格式不正确');
  const result = db.prepare('INSERT OR IGNORE INTO ip_prefix_gateways (prefix, gateway, default_vlan) VALUES (?,?,?)').run(prefix, gateway, default_vlan || null);
  if (result.changes === 0) throw new Error(`IP前缀"${prefix}"的网关映射已存在`);
  return getPrefixGateways();
}
function updatePrefixGateway(id, prefix, gateway, default_vlan) {
  if (!prefix || !String(prefix).trim()) throw new Error('IP前缀为必填项');
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(prefix))) throw new Error('前缀格式不正确，应为如 192.168.10');
  if (!gateway || !String(gateway).trim()) throw new Error('网关为必填项');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(gateway))) throw new Error('网关IP格式不正确');
  db.prepare('UPDATE ip_prefix_gateways SET prefix=?, gateway=?, default_vlan=? WHERE id=?').run(prefix, gateway, default_vlan || null, id);
  return getPrefixGateways();
}
function deletePrefixGateway(id) {
  const row = db.prepare('SELECT prefix FROM ip_prefix_gateways WHERE id = ?').get(id);
  if (!row) throw new Error('网关映射不存在');
  const count = db.prepare('SELECT COUNT(*) as cnt FROM ip_records WHERE ip LIKE ?').get(`${row.prefix}.%`).cnt;
  if (count > 0) throw new Error(`该前缀下还有 ${count} 条IP登记记录，请先迁移或清空后再删除`);
  db.prepare('DELETE FROM ip_prefix_gateways WHERE id = ?').run(id);
}

function getSetting(key, defaultVal) {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
  return row ? row.value : defaultVal;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO system_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, value, value);
}

function auditLog(user, action, detail, opts = {}) {
  db.prepare('INSERT INTO audit_log (user_id, username, action, detail, target_type, target_id, ip_address) VALUES (?,?,?,?,?,?,?)').run(
    user ? user.id : null, user ? user.username : null, action, detail || null,
    opts.target_type || null, opts.target_id || null, opts.ip_address || null
  );
}

module.exports = {
  getDeviceTypes, addDeviceType, updateDeviceType, deleteDeviceType,
  getStatuses, addStatus, updateStatus, deleteStatus,
  getDepartments, addDepartment, updateDepartment, deleteDepartment,
  getVlanPlans, getVlanPlanById, addVlanPlan, updateVlanPlan, deleteVlanPlan,
  getPrefixGateways, addPrefixGateway, updatePrefixGateway, deletePrefixGateway,
  getSetting, setSetting, auditLog,
};
