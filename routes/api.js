const express = require('express');
const router = express.Router();
const { requireAuth, requireRole, canManageVlan, getReadableVlanScope } = require('../middleware/auth');
const ipService = require('../services/ipService');
const dictService = require('../services/dictService');
const userService = require('../services/userService');
const db = require('../db');

// --- Dashboard stats ---
router.get('/stats', requireAuth, (req, res) => {
  const kpi = ipService.getDashboardStats();
  const vlanStats = ipService.getVlanStats();
  const deptStats = ipService.getDepartmentStats();
  const deviceStats = ipService.getDeviceTypeStats();
  res.json({ kpi, vlanStats, deptStats, deviceStats });
});

// --- Dictionary data (read for all logged-in users) ---
router.get('/dict/device-types', requireAuth, (req, res) => res.json(dictService.getDeviceTypes()));
router.get('/dict/statuses', requireAuth, (req, res) => res.json(dictService.getStatuses()));
router.get('/dict/departments', requireAuth, (req, res) => res.json(dictService.getDepartments()));
router.get('/dict/vlan-plans', requireAuth, (req, res) => res.json(dictService.getVlanPlans()));
router.get('/dict/prefix-gateways', requireAuth, (req, res) => res.json(dictService.getPrefixGateways()));

// --- Gateway lookup ---
router.get('/gateway-lookup', requireAuth, (req, res) => {
  const { ip } = req.query;
  if (!ip) return res.json({ gateway: null, vlan: null });
  res.json({ gateway: ipService.lookupGateway(ip), vlan: ipService.lookupVlanByIp(ip) });
});

// --- IP records list ---
router.get('/records', requireAuth, (req, res) => {
  const scope = getReadableVlanScope(req);
  const result = ipService.listRecords({
    page: parseInt(req.query.page) || 1,
    perPage: parseInt(req.query.perPage) || 20,
    search: req.query.search || '',
    vlan: req.query.vlan || '',
    department: req.query.department || '',
    status: req.query.status || '',
    deviceType: req.query.deviceType || '',
    sort: req.query.sort || 'updated_at',
    order: req.query.order || 'desc',
    scope,
    onlyDuplicate: req.query.onlyDuplicate || '',
    onlyMacConflict: req.query.onlyMacConflict || '',
  });
  res.json(result);
});

router.get('/records/:id', requireAuth, (req, res) => {
  const record = ipService.getRecord(req.params.id);
  if (!record) return res.status(404).json({ error: '记录不存在' });
  const scope = getReadableVlanScope(req);
  if (!scope.all && !scope.vlans.includes(record.vlan)) {
    return res.status(403).json({ error: '您没有查看该VLAN记录的权限' });
  }
  res.json(record);
});

// --- Create record ---
router.post('/records', requireAuth, (req, res) => {
  const vlan = req.body.vlan || ipService.lookupVlanByIp(req.body.ip);
  try {
    ipService.validateIpForVlan(req.body.ip, req.body.vlan);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (!canManageVlan(req, vlan)) {
    return res.status(403).json({ error: '您没有管理该 VLAN 的权限' });
  }
  try {
    const record = ipService.createRecord(req.body);
    dictService.auditLog(req.session.user, 'create_record', `新增IP记录: ${record.ip || 'N/A'} (ID:${record.id})`, { target_type: 'ip_record', target_id: record.id, ip_address: record.ip });
    res.status(201).json(record);
  } catch (e) {
    res.status(400).json({ error: '创建失败: ' + e.message });
  }
});

// --- Update record ---
router.put('/records/:id', requireAuth, (req, res) => {
  const existing = ipService.getRecord(req.params.id);
  if (!existing) return res.status(404).json({ error: '记录不存在' });
  try {
    ipService.validateIpForVlan(req.body.ip, req.body.vlan);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const newVlan = req.body.vlan || existing.vlan;
  if (!canManageVlan(req, newVlan)) {
    return res.status(403).json({ error: '您没有管理该 VLAN 的权限' });
  }
  if (!canManageVlan(req, existing.vlan)) {
    return res.status(403).json({ error: '您没有管理该 VLAN 的权限' });
  }
  try {
    const oldRecord = existing;
    const record = ipService.updateRecord(req.params.id, req.body);
    const changes = [];
    for (const k of ['ip','vlan','mac','device_type','device_name','location','department','user_name','status','upper_switch','switch_port','sunlogin_id','gateway','remark']) {
      if (String(oldRecord[k] || '') !== String(record[k] || '')) {
        changes.push(`${k}: ${oldRecord[k] || '空'} → ${record[k] || '空'}`);
      }
    }
    const detail = changes.length ? `修改IP记录: ${record.ip || 'N/A'} (ID:${record.id}) [${changes.join(', ')}]` : `修改IP记录: ${record.ip || 'N/A'} (ID:${record.id})`;
    dictService.auditLog(req.session.user, 'update_record', detail, { target_type: 'ip_record', target_id: record.id, ip_address: record.ip });
    if (oldRecord.mac && record.mac && oldRecord.mac !== record.mac) {
      dictService.auditLog(req.session.user, 'mac_conflict', `IP ${record.ip || 'N/A'} MAC变更: ${oldRecord.mac} → ${record.mac}`, { target_type: 'ip_record', target_id: record.id, ip_address: record.ip });
    }
    res.json(record);
  } catch (e) {
    res.status(400).json({ error: '修改失败: ' + e.message });
  }
});

// --- Delete record ---
router.delete('/records/:id', requireAuth, (req, res) => {
  const existing = ipService.getRecord(req.params.id);
  if (!existing) return res.status(404).json({ error: '记录不存在' });
  if (!canManageVlan(req, existing.vlan)) {
    return res.status(403).json({ error: '您没有管理该 VLAN 的权限' });
  }
  ipService.deleteRecord(req.params.id);
  dictService.auditLog(req.session.user, 'delete_record', `删除IP记录: ${existing.ip || 'N/A'} (ID:${existing.id})`, { target_type: 'ip_record', target_id: existing.id, ip_address: existing.ip });
  res.json({ success: true });
});

// --- Subnet records ---
router.get('/subnet/:prefix', requireAuth, (req, res) => {
  const raw = decodeURIComponent(req.params.prefix);
  const scope = getReadableVlanScope(req);
  let plan, records;
  if (raw.startsWith('plan:')) {
    const cidr = raw.slice(5);
    plan = dictService.getVlanPlans().find(p => p.subnet === cidr);
    if (!plan) return res.status(404).json({ error: '未找到该网段规划' });
    if (!scope.all && !scope.vlans.includes(plan.vlan)) {
      return res.status(403).json({ error: '您没有查看该网段的权限' });
    }
    const sort = req.query.sort || 'ip';
    const order = req.query.order || 'asc';
    records = ipService.getSubnetRecordsByCidr(cidr, sort, order);
  } else {
    const prefix = raw;
    plan = dictService.getVlanPlans().find(p => p.subnet && p.subnet.split('/')[0].split('.').slice(0, 3).join('.') === prefix);
    if (!scope.all) {
      if (plan) {
        if (!scope.vlans.includes(plan.vlan)) {
          return res.status(403).json({ error: '您没有查看该网段的权限' });
        }
      } else {
        return res.status(403).json({ error: '该网段未在规划中，或您没有权限查看' });
      }
    }
    const sort = req.query.sort || 'ip';
    const order = req.query.order || 'asc';
    records = ipService.getSubnetRecords(prefix, sort, order);
  }
  res.json({ prefix: raw, records, plan: plan || null });
});

router.get('/my-vlan-permissions', requireAuth, (req, res) => {
  if (req.session.user.role === 'superadmin' || req.session.user.role === 'viewer') {
    return res.json({ all: true, vlans: dictService.getVlanPlans().map(p => `plan:${p.id}`) });
  }
  res.json({ all: false, vlans: userService.getAdminVlanPermissions(req.session.user.id) });
});

// --- Dictionary management (superadmin only) ---
router.post('/dict/device-types', requireRole('superadmin'), (req, res) => {
  if (!req.body.name || !String(req.body.name).trim()) return res.status(400).json({ error: '名称为必填项' });
  try {
    dictService.addDeviceType(req.body.name, req.body.description);
    dictService.auditLog(req.session.user, 'add_device_type', `新增设备类型: ${req.body.name}`, { target_type: 'device_type' });
    res.json(dictService.getDeviceTypes());
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/dict/device-types/:id', requireRole('superadmin'), (req, res) => {
  if (!req.body.name || !String(req.body.name).trim()) return res.status(400).json({ error: '名称为必填项' });
  dictService.updateDeviceType(req.params.id, req.body);
  dictService.auditLog(req.session.user, 'update_device_type', `修改设备类型: ${req.body.name}`, { target_type: 'device_type', target_id: req.params.id });
  res.json(dictService.getDeviceTypes());
});
router.delete('/dict/device-types/:id', requireRole('superadmin'), (req, res) => {
  try {
    dictService.deleteDeviceType(req.params.id);
    dictService.auditLog(req.session.user, 'delete_device_type', `ID:${req.params.id}`, { target_type: 'device_type', target_id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/dict/statuses', requireRole('superadmin'), (req, res) => {
  if (!req.body.name || !String(req.body.name).trim()) return res.status(400).json({ error: '名称为必填项' });
  try {
    dictService.addStatus(req.body.name, req.body.description);
    dictService.auditLog(req.session.user, 'add_status', `新增使用状态: ${req.body.name}`, { target_type: 'status' });
    res.json(dictService.getStatuses());
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/dict/statuses/:id', requireRole('superadmin'), (req, res) => {
  if (!req.body.name || !String(req.body.name).trim()) return res.status(400).json({ error: '名称为必填项' });
  dictService.updateStatus(req.params.id, req.body);
  dictService.auditLog(req.session.user, 'update_status', `修改使用状态: ${req.body.name}`, { target_type: 'status', target_id: req.params.id });
  res.json(dictService.getStatuses());
});
router.delete('/dict/statuses/:id', requireRole('superadmin'), (req, res) => {
  try {
    dictService.deleteStatus(req.params.id);
    dictService.auditLog(req.session.user, 'delete_status', `ID:${req.params.id}`, { target_type: 'status', target_id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/dict/departments', requireRole('superadmin'), (req, res) => {
  if (!req.body.name || !String(req.body.name).trim()) return res.status(400).json({ error: '名称为必填项' });
  try {
    dictService.addDepartment(req.body.name);
    dictService.auditLog(req.session.user, 'add_department', `新增部门: ${req.body.name}`, { target_type: 'department' });
    res.json(dictService.getDepartments());
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/dict/departments/:id', requireRole('superadmin'), (req, res) => {
  if (!req.body.name || !String(req.body.name).trim()) return res.status(400).json({ error: '名称为必填项' });
  dictService.updateDepartment(req.params.id, req.body);
  dictService.auditLog(req.session.user, 'update_department', `修改部门: ${req.body.name}`, { target_type: 'department', target_id: req.params.id });
  res.json(dictService.getDepartments());
});
router.delete('/dict/departments/:id', requireRole('superadmin'), (req, res) => {
  try {
    dictService.deleteDepartment(req.params.id);
    dictService.auditLog(req.session.user, 'delete_department', `ID:${req.params.id}`, { target_type: 'department', target_id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/dict/vlan-plans', requireRole('superadmin'), (req, res) => {
  try {
    dictService.addVlanPlan(req.body);
    dictService.auditLog(req.session.user, 'add_vlan_plan', `新增VLAN规划: VLAN ${req.body.vlan} (${req.body.name || '-'}) 网段 ${req.body.subnet}`, { target_type: 'vlan_plan' });
    res.json(dictService.getVlanPlans());
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/dict/vlan-plans/:id', requireRole('superadmin'), (req, res) => {
  try {
    dictService.updateVlanPlan(req.params.id, req.body);
    dictService.auditLog(req.session.user, 'update_vlan_plan', `修改VLAN规划: VLAN ${req.body.vlan} (${req.body.name || '-'}) 网段 ${req.body.subnet}`, { target_type: 'vlan_plan', target_id: req.params.id });
    res.json(dictService.getVlanPlans());
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/dict/vlan-plans/:id', requireRole('superadmin'), (req, res) => {
  try {
    dictService.deleteVlanPlan(req.params.id);
    dictService.auditLog(req.session.user, 'delete_vlan_plan', `ID:${req.params.id}`, { target_type: 'vlan_plan', target_id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/dict/prefix-gateways', requireRole('superadmin'), (req, res) => {
  try {
    dictService.addPrefixGateway(req.body.prefix, req.body.gateway, req.body.default_vlan);
    dictService.auditLog(req.session.user, 'add_prefix_gateway', `新增网关映射: ${req.body.prefix} → ${req.body.gateway}`, { target_type: 'prefix_gateway' });
    res.json(dictService.getPrefixGateways());
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/dict/prefix-gateways/:id', requireRole('superadmin'), (req, res) => {
  try {
    dictService.updatePrefixGateway(req.params.id, req.body.prefix, req.body.gateway, req.body.default_vlan);
    dictService.auditLog(req.session.user, 'update_prefix_gateway', `修改网关映射: ${req.body.prefix} → ${req.body.gateway}`, { target_type: 'prefix_gateway', target_id: req.params.id });
    res.json(dictService.getPrefixGateways());
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/dict/prefix-gateways/:id', requireRole('superadmin'), (req, res) => {
  try {
    dictService.deletePrefixGateway(req.params.id);
    dictService.auditLog(req.session.user, 'delete_prefix_gateway', `ID:${req.params.id}`, { target_type: 'prefix_gateway', target_id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --- System settings ---
router.get('/settings/:key', requireAuth, (req, res) => {
  res.json({ key: req.params.key, value: dictService.getSetting(req.params.key) });
});
router.put('/settings/:key', requireRole('superadmin'), (req, res) => {
  dictService.setSetting(req.params.key, req.body.value);
  dictService.auditLog(req.session.user, 'update_setting', `${req.params.key} = ${req.body.value}`);
  res.json({ success: true });
});

// --- User management (superadmin only) ---
router.get('/users', requireRole('superadmin'), (req, res) => {
  const users = userService.listUsers();
  const result = users.map(u => ({
    ...u,
    vlanPermissions: u.role === 'admin' ? userService.getAdminVlanPermissions(u.id) : [],
  }));
  res.json(result);
});

router.post('/users', requireRole('superadmin'), (req, res) => {
  const { username, password, role, display_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  if (!['superadmin', 'admin', 'viewer'].includes(role)) return res.status(400).json({ error: '无效角色' });
  try {
    const id = userService.createUser(username, password, role, display_name);
    dictService.auditLog(req.session.user, 'create_user', `创建用户: ${username} (${role})`);
    res.status(201).json({ id, username, role, display_name, enabled: 1 });
  } catch (e) {
    res.status(400).json({ error: '用户名已存在' });
  }
});

router.put('/users/:id', requireRole('superadmin'), (req, res) => {
  if (req.body.username !== undefined && !String(req.body.username).trim()) return res.status(400).json({ error: '用户名不能为空' });
  let user;
  try {
    user = userService.updateUser(req.params.id, req.body);
  } catch (e) {
    return res.status(400).json({ error: '用户名已存在' });
  }
  if (!user) return res.status(404).json({ error: '用户不存在' });
  dictService.auditLog(req.session.user, 'update_user', `修改用户: ${user.username}`);
  if (parseInt(req.params.id, 10) === req.session.user.id) {
    req.session.user.username = user.username;
    req.session.user.display_name = user.display_name;
    req.session.user.role = user.role;
  }
  res.json(user);
});

router.post('/users/:id/reset-password', requireRole('superadmin'), (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  userService.resetPassword(req.params.id, password);
  dictService.auditLog(req.session.user, 'reset_password', `重置用户ID:${req.params.id}密码`);
  res.json({ success: true });
});

router.put('/users/:id/permissions', requireRole('superadmin'), (req, res) => {
  const { vlans } = req.body;
  userService.setAdminVlanPermissions(req.params.id, vlans || []);
  dictService.auditLog(req.session.user, 'update_permissions', `修改用户ID:${req.params.id} VLAN权限`);
  res.json({ success: true });
});

router.delete('/users/:id', requireRole('superadmin'), (req, res) => {
  if (parseInt(req.params.id) === req.session.user.id) {
    return res.status(400).json({ error: '不能删除自己' });
  }
  const user = userService.findById(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  dictService.auditLog(req.session.user, 'delete_user', `删除用户: ${user.username}`);
  res.json({ success: true });
});

// --- Self change password ---
router.post('/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: '新密码至少6位' });
  try {
    userService.changeOwnPassword(req.session.user.id, oldPassword, newPassword);
    dictService.auditLog(req.session.user, 'change_password', '修改自身密码');
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Audit logs (superadmin only) ---
router.get('/audit-logs', requireRole('superadmin'), (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.perPage) || 20;
  const search = req.query.search || '';
  const startDate = req.query.startDate || '';
  const endDate = req.query.endDate || '';
  const targetType = req.query.target_type || '';
  const offset = (page - 1) * perPage;
  const where = [];
  const params = [];
  if (search) {
    where.push('(username LIKE ? OR action LIKE ? OR detail LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (targetType) {
    where.push('target_type = ?');
    params.push(targetType);
  }
  if (startDate) {
    where.push('date(created_at) >= date(?)');
    params.push(startDate);
  }
  if (endDate) {
    where.push('date(created_at) <= date(?)');
    params.push(endDate);
  }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM audit_log ${whereClause}`).get(...params).cnt;
  const rows = db.prepare(`SELECT * FROM audit_log ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, perPage, offset);
  res.json({ rows, total, page, perPage, totalPages: Math.ceil(total / perPage) });
});

// --- Export records (CSV) ---
function csvEscape(v) {
  let s = String(v || '');
  if (/^[=+\-@\t\r]/.test(s)) s = '\'' + s;
  s = s.replace(/"/g, '""');
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
}

router.get('/export/records', requireAuth, (req, res) => {
  const scope = getReadableVlanScope(req);
  const result = ipService.listRecords({ page: 1, perPage: 999999, search: req.query.search || '', vlan: req.query.vlan || '', department: req.query.department || '', status: req.query.status || '', deviceType: req.query.deviceType || '', sort: 'ip', order: 'asc', scope, onlyDuplicate: req.query.onlyDuplicate || '', onlyMacConflict: req.query.onlyMacConflict || '' });
  const headers = ['ID','IP地址','VLAN','MAC地址','设备类型','设备名称','物理位置','部门','使用人','状态','登记日期','上层交换机','交换机端口','向日葵ID','网关','备注','更新日期'];
  const cols = ['id','ip','vlan','mac','device_type','device_name','location','department','user_name','status','registered_at','upper_switch','switch_port','sunlogin_id','gateway','remark','updated_at'];
  let csv = '\uFEFF' + headers.join(',') + '\n';
  result.rows.forEach(r => {
    csv += cols.map(c => csvEscape(r[c])).join(',') + '\n';
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ip_records_${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

// --- Export subnet (CSV) ---
router.get('/export/subnet/:prefix', requireAuth, (req, res) => {
  const raw = decodeURIComponent(req.params.prefix);
  const scope = getReadableVlanScope(req);
  let plan, records;
  if (raw.startsWith('plan:')) {
    const cidr = raw.slice(5);
    plan = dictService.getVlanPlans().find(p => p.subnet === cidr);
    if (!plan) return res.status(404).json({ error: '未找到该网段规划' });
    if (!scope.all && !scope.vlans.includes(plan.vlan)) {
      return res.status(403).json({ error: '您没有导出该网段的权限' });
    }
    records = ipService.getSubnetRecordsByCidr(cidr);
  } else {
    const prefix = raw;
    plan = dictService.getVlanPlans().find(p => p.subnet && p.subnet.split('/')[0].split('.').slice(0, 3).join('.') === prefix);
    if (!scope.all) {
      if (plan) {
        if (!scope.vlans.includes(plan.vlan)) {
          return res.status(403).json({ error: '您没有导出该网段的权限' });
        }
      } else {
        return res.status(403).json({ error: '该网段未在规划中，或您没有权限导出' });
      }
    }
    records = ipService.getSubnetRecords(prefix);
  }
  const headers = ['主机号','IP地址','设备名称','部门','使用人','状态','MAC地址','网关','VLAN','设备类型','物理位置','上层交换机','交换机端口','向日葵ID','登记日期','备注'];
  const cols = ['host','ip','device_name','department','user_name','status','mac','gateway','vlan','device_type','location','upper_switch','switch_port','sunlogin_id','registered_at','remark'];
  let csv = '\uFEFF' + headers.join(',') + '\n';
  records.forEach(r => {
    const row = { ...r, host: r.ip ? r.ip.split('.')[3] : '' };
    csv += cols.map(c => csvEscape(row[c])).join(',') + '\n';
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="subnet_${prefix}_${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

module.exports = router;
