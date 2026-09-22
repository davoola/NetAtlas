const express = require('express');
const router = express.Router();
const { requireAuth, requireRole, canManageVlan, getReadableVlanScope } = require('../middleware/auth');
const ipService = require('../services/ipService');
const dictService = require('../services/dictService');
const userService = require('../services/userService');
const db = require('../db');
const sessionStore = require('../middleware/sessionStore');
const { UserError, publicMessage, logError } = require('../utils/errors');
const { limitedName, clampInt, checkStringFields } = require('../utils/validate');

const DICT_LIMITS = { name: 100, description: 500, vlan: 50, subnet: 50, mask: 50, gateway: 45, address_pool_note: 200, prefix: 50, default_vlan: 50 };
// 字典类接口的输入长度/类型校验；不合法时抛出业务错误
function checkDictBody(body) {
  if (!body || typeof body !== 'object') throw new UserError('请求参数不正确');
  checkStringFields(body, DICT_LIMITS, { name: '名称', description: '描述', vlan: 'VLAN', subnet: '网段', mask: '掩码', gateway: '网关', address_pool_note: '地址池说明', prefix: 'IP前缀', default_vlan: '默认VLAN' });
}

// 统一的 catch 处理：业务错误返回原文，内部错误只返回通用提示并记录服务端日志
function fail(req, res, e, status = 400, fallback = '操作失败，请稍后重试') {
  const msg = publicMessage(e, fallback);
  if (msg === fallback) logError(req, e, 'api'); // 被屏蔽的内部错误才记录详细日志
  const st = e && e.expose && e.status ? e.status : status;
  return res.status(st).json({ error: msg, requestId: req.id });
}

// --- Dashboard stats ---
router.get('/stats', requireAuth, (req, res) => {
  const scope = getReadableVlanScope(req);
  const kpi = ipService.getDashboardStats(scope);
  const vlanStats = ipService.getVlanStats(scope);
  const deptStats = ipService.getDepartmentStats(scope);
  const deviceStats = ipService.getDeviceTypeStats(scope);
  res.json({ kpi, vlanStats, deptStats, deviceStats });
});

// --- Dictionary data (read for all logged-in users) ---
router.get('/dict/device-types', requireAuth, (req, res) => res.json(dictService.getDeviceTypes()));
router.get('/dict/statuses', requireAuth, (req, res) => res.json(dictService.getStatuses()));
router.get('/dict/departments', requireAuth, (req, res) => res.json(dictService.getDepartments()));
// VLAN 规划 / 网关映射属于网络拓扑信息：受限管理员只能看到自己有权限的 VLAN
router.get('/dict/vlan-plans', requireAuth, (req, res) => {
  const scope = getReadableVlanScope(req);
  res.json(dictService.getVlanPlans().filter(p => ipService.planInScope(scope, p)));
});
router.get('/dict/prefix-gateways', requireAuth, (req, res) => {
  const scope = getReadableVlanScope(req);
  const all = dictService.getPrefixGateways();
  if (scope.all) return res.json(all);
  const allowedPrefixes = new Set(
    dictService.getVlanPlans().filter(p => ipService.planInScope(scope, p) && p.subnet)
      .map(p => p.subnet.split('/')[0].split('.').slice(0, 3).join('.'))
  );
  res.json(all.filter(g => allowedPrefixes.has(g.prefix) || (g.default_vlan && scope.vlans.includes(String(g.default_vlan)))));
});

// --- Gateway lookup ---
router.get('/gateway-lookup', requireAuth, (req, res) => {
  const { ip } = req.query;
  if (!ip || typeof ip !== 'string' || ip.length > 45) return res.json({ gateway: null, vlan: null, planId: null });
  const plan = ipService.lookupPlanByIp(ip);
  const vlan = plan ? plan.vlan : null;
  const planId = plan ? plan.id : null;
  const scope = getReadableVlanScope(req);
  if (!scope.all && (!vlan || !scope.vlans.includes(String(vlan)))) {
    return res.json({ gateway: null, vlan: null, planId: null });
  }
  res.json({ gateway: ipService.lookupGateway(ip), vlan, planId });
});

// --- IP records list ---
router.get('/records', requireAuth, (req, res) => {
  const scope = getReadableVlanScope(req);
  const result = ipService.listRecords({
    page: clampInt(req.query.page, 1, 1, 1000000),
    perPage: clampInt(req.query.perPage, 20, 1, 200),
    search: typeof req.query.search === 'string' ? req.query.search : '',
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
  // 先鉴权再校验，避免未授权用户通过校验错误信息探测 VLAN 网段规划
  if (!canManageVlan(req, vlan)) {
    return res.status(403).json({ error: '您没有管理该 VLAN 的权限' });
  }
  try {
    ipService.validateIpForVlan(req.body.ip, req.body.vlan);
  } catch (e) {
    return fail(req, res, e, 400);
  }
  try {
    const record = ipService.createRecord(req.body);
    dictService.auditLog(req.session.user, 'create_record', `新增IP记录: ${record.ip || 'N/A'} (ID:${record.id})`, { target_type: 'ip_record', target_id: record.id, ip_address: record.ip });
    res.status(201).json(record);
  } catch (e) {
    const msg = publicMessage(e, '请检查输入内容');
    if (msg === '请检查输入内容') logError(req, e, 'create_record');
    res.status(400).json({ error: '创建失败: ' + msg, requestId: req.id });
  }
});

// --- Update record ---
router.put('/records/:id', requireAuth, (req, res) => {
  const existing = ipService.getRecord(req.params.id);
  if (!existing) return res.status(404).json({ error: '记录不存在' });
  const newVlan = req.body.vlan || existing.vlan;
  if (!canManageVlan(req, newVlan) || !canManageVlan(req, existing.vlan)) {
    return res.status(403).json({ error: '您没有管理该 VLAN 的权限' });
  }
  try {
    ipService.validateIpForVlan(req.body.ip, req.body.vlan);
  } catch (e) {
    return fail(req, res, e, 400);
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
    const msg = publicMessage(e, '请检查输入内容');
    if (msg === '请检查输入内容') logError(req, e, 'update_record');
    res.status(400).json({ error: '修改失败: ' + msg, requestId: req.id });
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
  try {
    const raw = decodeURIComponent(req.params.prefix);
    const scope = getReadableVlanScope(req);
    let plan, records;
    const sort = req.query.sort || 'ip';
    const order = req.query.order || 'asc';
    if (raw.startsWith('plan:')) {
      const token = raw.slice(5); // either a CIDR (large subnet) or a numeric plan id (dynamic VLAN)
      if (token.includes('/')) {
        // Large subnet: token is CIDR string
        plan = dictService.getVlanPlans().find(p => p.subnet === token);
        if (!plan) return res.status(404).json({ error: '未找到该网段规划' });
        if (!scope.all && !scope.vlans.includes(plan.vlan)) {
          return res.status(403).json({ error: '您没有查看该网段的权限' });
        }
        records = ipService.getSubnetRecordsByCidr(token, sort, order, plan.vlan);
      } else {
        // Plan-id token: dynamic VLAN with no subnet
        const planId = Number(token);
        plan = dictService.getVlanPlanById(planId);
        if (!plan) return res.status(404).json({ error: '未找到该网段规划' });
        if (!scope.all && !scope.vlans.includes(plan.vlan)) {
          return res.status(403).json({ error: '您没有查看该网段的权限' });
        }
        records = ipService.getVlanRecords(plan.vlan, sort, order);
      }
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
      records = ipService.getSubnetRecords(prefix, sort, order, plan ? plan.vlan : null);
    }
    res.json({ prefix: raw, records, plan: plan || null });
  } catch (e) {
    logError(req, e, 'subnet');
    res.status(500).json({ error: '加载网段明细失败', requestId: req.id });
  }
});

router.get('/my-vlan-permissions', requireAuth, (req, res) => {
  if (req.session.user.role === 'superadmin' || req.session.user.role === 'viewer') {
    return res.json({ all: true, vlans: dictService.getVlanPlans().map(p => `plan:${p.id}`) });
  }
  res.json({ all: false, vlans: userService.getAdminVlanPermissions(req.session.user.id) });
});

// --- Dictionary management (superadmin only) ---
router.post('/dict/device-types', requireRole('superadmin'), (req, res) => {
  try { checkDictBody(req.body); limitedName(req.body.name, '名称'); } catch (e) { return fail(req, res, e); }
  try {
    dictService.addDeviceType(req.body.name, req.body.description);
    dictService.auditLog(req.session.user, 'add_device_type', `新增设备类型: ${req.body.name}`, { target_type: 'device_type' });
    res.json(dictService.getDeviceTypes());
  } catch (e) { fail(req, res, e); }
});
router.put('/dict/device-types/:id', requireRole('superadmin'), (req, res) => {
  try { checkDictBody(req.body); limitedName(req.body.name, '名称'); } catch (e) { return fail(req, res, e); }
  try { dictService.updateDeviceType(req.params.id, req.body); } catch (e) { return fail(req, res, e); }
  dictService.auditLog(req.session.user, 'update_device_type', `修改设备类型: ${req.body.name}`, { target_type: 'device_type', target_id: req.params.id });
  res.json(dictService.getDeviceTypes());
});
router.delete('/dict/device-types/:id', requireRole('superadmin'), (req, res) => {
  try {
    dictService.deleteDeviceType(req.params.id);
    dictService.auditLog(req.session.user, 'delete_device_type', `ID:${req.params.id}`, { target_type: 'device_type', target_id: req.params.id });
    res.json({ success: true });
  } catch (e) { fail(req, res, e); }
});

router.post('/dict/statuses', requireRole('superadmin'), (req, res) => {
  try { checkDictBody(req.body); limitedName(req.body.name, '名称'); } catch (e) { return fail(req, res, e); }
  try {
    dictService.addStatus(req.body.name, req.body.description);
    dictService.auditLog(req.session.user, 'add_status', `新增使用状态: ${req.body.name}`, { target_type: 'status' });
    res.json(dictService.getStatuses());
  } catch (e) { fail(req, res, e); }
});
router.put('/dict/statuses/:id', requireRole('superadmin'), (req, res) => {
  try { checkDictBody(req.body); limitedName(req.body.name, '名称'); } catch (e) { return fail(req, res, e); }
  try { dictService.updateStatus(req.params.id, req.body); } catch (e) { return fail(req, res, e); }
  dictService.auditLog(req.session.user, 'update_status', `修改使用状态: ${req.body.name}`, { target_type: 'status', target_id: req.params.id });
  res.json(dictService.getStatuses());
});
router.delete('/dict/statuses/:id', requireRole('superadmin'), (req, res) => {
  try {
    dictService.deleteStatus(req.params.id);
    dictService.auditLog(req.session.user, 'delete_status', `ID:${req.params.id}`, { target_type: 'status', target_id: req.params.id });
    res.json({ success: true });
  } catch (e) { fail(req, res, e); }
});

router.post('/dict/departments', requireRole('superadmin'), (req, res) => {
  try { checkDictBody(req.body); limitedName(req.body.name, '名称'); } catch (e) { return fail(req, res, e); }
  try {
    dictService.addDepartment(req.body.name);
    dictService.auditLog(req.session.user, 'add_department', `新增部门: ${req.body.name}`, { target_type: 'department' });
    res.json(dictService.getDepartments());
  } catch (e) { fail(req, res, e); }
});
router.put('/dict/departments/:id', requireRole('superadmin'), (req, res) => {
  try { checkDictBody(req.body); limitedName(req.body.name, '名称'); } catch (e) { return fail(req, res, e); }
  try { dictService.updateDepartment(req.params.id, req.body); } catch (e) { return fail(req, res, e); }
  dictService.auditLog(req.session.user, 'update_department', `修改部门: ${req.body.name}`, { target_type: 'department', target_id: req.params.id });
  res.json(dictService.getDepartments());
});
router.delete('/dict/departments/:id', requireRole('superadmin'), (req, res) => {
  try {
    dictService.deleteDepartment(req.params.id);
    dictService.auditLog(req.session.user, 'delete_department', `ID:${req.params.id}`, { target_type: 'department', target_id: req.params.id });
    res.json({ success: true });
  } catch (e) { fail(req, res, e); }
});

router.post('/dict/vlan-plans', requireRole('superadmin'), (req, res) => {
  try {
    checkDictBody(req.body);
    dictService.addVlanPlan(req.body);
    dictService.auditLog(req.session.user, 'add_vlan_plan', `新增VLAN规划: VLAN ${req.body.vlan} (${req.body.name || '-'}) 网段 ${req.body.subnet}`, { target_type: 'vlan_plan' });
    res.json(dictService.getVlanPlans());
  } catch (e) { fail(req, res, e); }
});
router.put('/dict/vlan-plans/:id', requireRole('superadmin'), (req, res) => {
  try {
    checkDictBody(req.body);
    dictService.updateVlanPlan(req.params.id, req.body);
    dictService.auditLog(req.session.user, 'update_vlan_plan', `修改VLAN规划: VLAN ${req.body.vlan} (${req.body.name || '-'}) 网段 ${req.body.subnet}`, { target_type: 'vlan_plan', target_id: req.params.id });
    res.json(dictService.getVlanPlans());
  } catch (e) { fail(req, res, e); }
});
router.delete('/dict/vlan-plans/:id', requireRole('superadmin'), (req, res) => {
  try {
    dictService.deleteVlanPlan(req.params.id);
    dictService.auditLog(req.session.user, 'delete_vlan_plan', `ID:${req.params.id}`, { target_type: 'vlan_plan', target_id: req.params.id });
    res.json({ success: true });
  } catch (e) { fail(req, res, e); }
});

router.post('/dict/prefix-gateways', requireRole('superadmin'), (req, res) => {
  try {
    checkDictBody(req.body);
    dictService.addPrefixGateway(req.body.prefix, req.body.gateway, req.body.default_vlan);
    dictService.auditLog(req.session.user, 'add_prefix_gateway', `新增网关映射: ${req.body.prefix} → ${req.body.gateway}`, { target_type: 'prefix_gateway' });
    res.json(dictService.getPrefixGateways());
  } catch (e) { fail(req, res, e); }
});
router.put('/dict/prefix-gateways/:id', requireRole('superadmin'), (req, res) => {
  try {
    checkDictBody(req.body);
    dictService.updatePrefixGateway(req.params.id, req.body.prefix, req.body.gateway, req.body.default_vlan);
    dictService.auditLog(req.session.user, 'update_prefix_gateway', `修改网关映射: ${req.body.prefix} → ${req.body.gateway}`, { target_type: 'prefix_gateway', target_id: req.params.id });
    res.json(dictService.getPrefixGateways());
  } catch (e) { fail(req, res, e); }
});
router.delete('/dict/prefix-gateways/:id', requireRole('superadmin'), (req, res) => {
  try {
    dictService.deletePrefixGateway(req.params.id);
    dictService.auditLog(req.session.user, 'delete_prefix_gateway', `ID:${req.params.id}`, { target_type: 'prefix_gateway', target_id: req.params.id });
    res.json({ success: true });
  } catch (e) { fail(req, res, e); }
});

// --- Database checkpoint (superadmin only) ---
router.post('/system/checkpoint', requireRole('superadmin'), (req, res) => {
  try {
    const result = dictService.checkpointDatabase();
    dictService.auditLog(req.session.user, 'db_checkpoint', '手动执行数据库Checkpoint');
    res.json(result);
  } catch (e) {
    fail(req, res, e, 500, '数据库 Checkpoint 失败');
  }
});

// --- System settings ---
const ALLOWED_SETTINGS = { site_name: 100 };
router.get('/settings/:key', requireAuth, (req, res) => {
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_SETTINGS, req.params.key)) return res.status(404).json({ error: '配置项不存在' });
  res.json({ key: req.params.key, value: dictService.getSetting(req.params.key) });
});
router.put('/settings/:key', requireRole('superadmin'), (req, res) => {
  const key = req.params.key;
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_SETTINGS, key)) return res.status(404).json({ error: '配置项不存在' });
  const value = req.body.value;
  if (typeof value !== 'string' || !value.trim()) return res.status(400).json({ error: '配置值不能为空' });
  if (value.length > ALLOWED_SETTINGS[key]) return res.status(400).json({ error: `配置值过长（最多 ${ALLOWED_SETTINGS[key]} 个字符）` });
  dictService.setSetting(key, value.trim());
  dictService.auditLog(req.session.user, 'update_setting', `${key} = ${value.trim()}`);
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
    dictService.auditLog(req.session.user, 'create_user', `创建用户: ${String(username).trim()} (${role})`);
    res.status(201).json({ id, username: String(username).trim(), role, display_name, enabled: 1 });
  } catch (e) {
    if (e.expose) return fail(req, res, e);
    // 用户名唯一约束冲突是此处最常见的失败原因
    if (/UNIQUE/i.test(String(e.message))) return res.status(400).json({ error: '用户名已存在' });
    fail(req, res, e);
  }
});

router.put('/users/:id', requireRole('superadmin'), (req, res) => {
  if (req.body.username !== undefined && !String(req.body.username).trim()) return res.status(400).json({ error: '用户名不能为空' });
  let user;
  try {
    user = userService.updateUser(req.params.id, req.body, req.session.user.id);
  } catch (e) {
    if (!e.expose && /UNIQUE/i.test(String(e.message))) return res.status(400).json({ error: '用户名已存在' });
    return fail(req, res, e);
  }
  if (!user) return res.status(404).json({ error: '用户不存在' });
  dictService.auditLog(req.session.user, 'update_user', `修改用户: ${user.username}`);
  const isSelf = parseInt(req.params.id, 10) === req.session.user.id;
  if (isSelf) {
    req.session.user.username = user.username;
    req.session.user.display_name = user.display_name;
    req.session.user.role = user.role;
  } else if (user._securityChanged) {
    // 角色/启用状态变更后立即撤销该用户的旧会话
    sessionStore.destroyUser(user.id);
  }
  delete user._securityChanged;
  res.json(user);
});

router.post('/users/:id/reset-password', requireRole('superadmin'), (req, res) => {
  const { password } = req.body;
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: '密码为必填项' });
  let found;
  try {
    found = userService.resetPassword(req.params.id, password);
  } catch (e) {
    return fail(req, res, e);
  }
  if (!found) return res.status(404).json({ error: '用户不存在' });
  // 重置密码后，撤销目标用户的全部现有会话
  const targetId = parseInt(req.params.id, 10);
  if (targetId === req.session.user.id) sessionStore.destroyUser(targetId, req.sessionID);
  else sessionStore.destroyUser(targetId);
  dictService.auditLog(req.session.user, 'reset_password', `重置用户ID:${req.params.id}密码`);
  res.json({ success: true });
});

router.put('/users/:id/permissions', requireRole('superadmin'), (req, res) => {
  const { vlans } = req.body;
  if (!Array.isArray(vlans)) return res.status(400).json({ error: 'vlans 必须为数组' }); // 避免缺参数时误清空全部授权
  try {
    userService.setAdminVlanPermissions(req.params.id, vlans);
  } catch (e) {
    return fail(req, res, e);
  }
  // 权限范围变化：撤销目标用户旧会话，使其重新登录
  const targetId = parseInt(req.params.id, 10);
  if (targetId !== req.session.user.id) sessionStore.destroyUser(targetId);
  dictService.auditLog(req.session.user, 'update_permissions', `修改用户ID:${req.params.id} VLAN权限`);
  res.json({ success: true });
});

router.delete('/users/:id', requireRole('superadmin'), (req, res) => {
  if (parseInt(req.params.id) === req.session.user.id) {
    return res.status(400).json({ error: '不能删除自己' });
  }
  const user = userService.findById(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  try {
    userService.deleteUser(req.params.id);
  } catch (e) {
    return fail(req, res, e);
  }
  sessionStore.destroyUser(user.id);
  dictService.auditLog(req.session.user, 'delete_user', `删除用户: ${user.username}`);
  res.json({ success: true });
});

// --- Self change password ---
router.post('/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (typeof newPassword !== 'string' || !newPassword) return res.status(400).json({ error: '新密码为必填项' });
  try {
    userService.changeOwnPassword(req.session.user.id, oldPassword, newPassword);
  } catch (e) {
    return fail(req, res, e);
  }
  // 改密后撤销该用户的其他会话，保留当前会话；并解除"必须改密"状态
  sessionStore.destroyUser(req.session.user.id, req.sessionID);
  req.session.user.mustChangePassword = false;
  dictService.auditLog(req.session.user, 'change_password', '修改自身密码');
  res.json({ success: true });
});

// --- Audit logs (superadmin only) ---
router.post('/audit-logs/cleanup', requireRole('superadmin'), (req, res) => {
  const beforeDate = typeof req.body.beforeDate === 'string' ? req.body.beforeDate.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(beforeDate)) {
    return res.status(400).json({ error: '请输入有效的清理截止日期' });
  }
  const deleted = dictService.cleanupAuditLogs(beforeDate);
  dictService.auditLog(req.session.user, 'cleanup_audit_logs', `清理 ${beforeDate} 之前的审计日志，共 ${deleted} 条`, { target_type: 'audit_log' });
  res.json({ success: true, deleted, message: `已清理 ${deleted} 条审计日志` });
});

router.get('/audit-logs', requireRole('superadmin'), (req, res) => {
  const page = clampInt(req.query.page, 1, 1, 1000000);
  const perPage = clampInt(req.query.perPage, 20, 1, 200);
  const str = (v) => (typeof v === 'string' ? v.slice(0, 200) : '');
  const search = str(req.query.search);
  const startDate = str(req.query.startDate);
  const endDate = str(req.query.endDate);
  const targetType = str(req.query.target_type);
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

const EXPORT_MAX_ROWS = parseInt(process.env.EXPORT_MAX_ROWS, 10) || 200000;
const EXPORT_CHUNK = 2000;

router.get('/export/records', requireAuth, (req, res) => {
  const scope = getReadableVlanScope(req);
  const q = (k) => (typeof req.query[k] === 'string' ? req.query[k] : '');
  const filters = { search: q('search'), vlan: q('vlan'), department: q('department'), status: q('status'), deviceType: q('deviceType'), sort: 'ip', order: 'asc', scope, onlyDuplicate: q('onlyDuplicate'), onlyMacConflict: q('onlyMacConflict') };
  const headers = ['ID','IP地址','VLAN','MAC地址','设备类型','设备名称','物理位置','部门','使用人','状态','登记日期','上层交换机','交换机端口','向日葵ID','网关','备注','更新日期'];
  const cols = ['id','ip','vlan','mac','device_type','device_name','location','department','user_name','status','registered_at','upper_switch','switch_port','sunlogin_id','gateway','remark','updated_at'];

  const first = ipService.listRecords({ ...filters, page: 1, perPage: EXPORT_CHUNK });
  if (first.total > EXPORT_MAX_ROWS) {
    return res.status(400).json({ error: `导出数据量（${first.total} 条）超过上限（${EXPORT_MAX_ROWS} 条），请缩小筛选范围后再导出` });
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ip_records_${new Date().toISOString().slice(0,10)}.csv"`);
  // 分块输出，避免一次性把全部数据拼成超大字符串
  res.write('\uFEFF' + headers.join(',') + '\n');
  let page = 1, result = first;
  for (;;) {
    res.write(result.rows.map(r => cols.map(c => csvEscape(r[c])).join(',')).join('\n') + (result.rows.length ? '\n' : ''));
    if (page >= result.totalPages) break;
    page += 1;
    result = ipService.listRecords({ ...filters, page, perPage: EXPORT_CHUNK });
  }
  res.end();
  try {
    dictService.auditLog(req.session.user, 'export_records', `导出IP记录 ${first.total} 条（筛选: ${JSON.stringify(Object.fromEntries(Object.entries(filters).filter(([k, v]) => v && !['sort','order','scope'].includes(k)))).slice(0, 300)}）`, { target_type: 'ip_record' });
  } catch (e) { logError(req, e, 'export-audit'); }
});

// --- Export subnet records (CSV) ---
router.get('/export/subnet/:prefix', requireAuth, (req, res) => {
  const raw = decodeURIComponent(req.params.prefix);
  const scope = getReadableVlanScope(req);
  let plan, records;
  let fileLabel = raw.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  if (raw.startsWith('plan:')) {
    const token = raw.slice(5);
    if (token.includes('/')) {
      // Large subnet
      plan = dictService.getVlanPlans().find(p => p.subnet === token);
      if (!plan) return res.status(404).json({ error: '未找到该网段规划' });
      if (!scope.all && !scope.vlans.includes(plan.vlan)) {
        return res.status(403).json({ error: '您没有导出该网段的权限' });
      }
      records = ipService.getSubnetRecordsByCidr(token, 'ip', 'asc', plan.vlan);
      fileLabel = token.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    } else {
      // Dynamic VLAN with no subnet
      const planId = Number(token);
      plan = dictService.getVlanPlanById(planId);
      if (!plan) return res.status(404).json({ error: '未找到该网段规划' });
      if (!scope.all && !scope.vlans.includes(plan.vlan)) {
        return res.status(403).json({ error: '您没有导出该网段的权限' });
      }
      records = ipService.getVlanRecords(plan.vlan, 'ip', 'asc');
      fileLabel = `vlan_${plan.vlan}`;
    }
  } else {
    const prefix = raw;
    fileLabel = prefix;
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
    records = ipService.getSubnetRecords(prefix, 'ip', 'asc', plan ? plan.vlan : null);
  }
  const headers = ['主机号','IP地址','设备名称','部门','使用人','状态','MAC地址','网关','VLAN','设备类型','物理位置','上层交换机','交换机端口','向日葵ID','登记日期','备注'];
  const cols = ['host','ip','device_name','department','user_name','status','mac','gateway','vlan','device_type','location','upper_switch','switch_port','sunlogin_id','registered_at','remark'];
  let csv = '\uFEFF' + headers.join(',') + '\n';
  records.forEach(r => {
    const row = { ...r, host: r.ip ? r.ip.split('.')[3] : '' };
    csv += cols.map(c => csvEscape(row[c])).join(',') + '\n';
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="subnet_${fileLabel}_${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

module.exports = router;
