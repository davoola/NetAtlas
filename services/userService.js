const db = require('../db');
const bcrypt = require('bcryptjs');
const dictService = require('./dictService');
const { UserError } = require('../utils/errors');

const { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } = require('../config/password');
const ROLES = ['superadmin', 'admin', 'viewer'];
const KNOWN_DEFAULT_PASSWORDS = ['admin123'];
// 用于用户不存在时的恒定成本比对，避免通过响应时间枚举用户名
const DUMMY_HASH = bcrypt.hashSync('netatlas-dummy-password', 10);

function findByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username));
}

function findById(id) {
  return db.prepare('SELECT id, username, role, display_name, enabled, must_change_password, created_at FROM users WHERE id = ?').get(id);
}

function listUsers() {
  return db.prepare('SELECT id, username, role, display_name, enabled, must_change_password, created_at FROM users ORDER BY id').all();
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) throw new UserError(`密码至少${PASSWORD_MIN_LENGTH}位`);
  if (password.length > PASSWORD_MAX_LENGTH) throw new UserError(`密码过长（最多 ${PASSWORD_MAX_LENGTH} 位）`);
  if (KNOWN_DEFAULT_PASSWORDS.includes(password)) throw new UserError('该密码为已知的弱口令，请更换');
}

function validateUsername(username) {
  if (typeof username !== 'string' || !username.trim()) throw new UserError('用户名不能为空');
  if (username.trim().length > 64) throw new UserError('用户名过长（最多 64 个字符）');
  return username.trim();
}

function validateDisplayName(name) {
  if (name === undefined || name === null || name === '') return null;
  if (typeof name !== 'string') throw new UserError('显示名称格式不正确');
  if (name.length > 100) throw new UserError('显示名称过长（最多 100 个字符）');
  return name;
}

function normalizeEnabled(v) {
  if (v === 1 || v === '1' || v === true) return 1;
  if (v === 0 || v === '0' || v === false) return 0;
  throw new UserError('enabled 只能为 0 或 1');
}

function countActiveSuperadmins(excludeId = null) {
  if (excludeId === null) return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='superadmin' AND enabled=1").get().c;
  return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='superadmin' AND enabled=1 AND id != ?").get(Number(excludeId)).c;
}

function createUser(username, password, role, displayName) {
  const name = validateUsername(username);
  if (!ROLES.includes(role)) throw new UserError('无效角色');
  validatePassword(password);
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)').run(name, hash, role, validateDisplayName(displayName));
  return result.lastInsertRowid;
}

/**
 * @param {number|string} id
 * @param {object} data
 * @param {number|null} actorId 执行操作的用户 ID（用于禁止误操作自己）
 */
function updateUser(id, { username, role, display_name, enabled }, actorId = null) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return null;

  const newUsername = username !== undefined ? validateUsername(username) : user.username;
  const newRole = role !== undefined ? role : user.role;
  if (!ROLES.includes(newRole)) throw new UserError('无效角色');
  const newEnabled = enabled !== undefined ? normalizeEnabled(enabled) : user.enabled;
  const newDisplay = display_name !== undefined ? validateDisplayName(display_name) : user.display_name;

  const isSelf = actorId !== null && Number(actorId) === user.id;
  if (isSelf && newEnabled === 0 && user.enabled !== 0) throw new UserError('不能禁用自己的账号');
  if (isSelf && newRole !== user.role) throw new UserError('不能修改自己的角色');
  if (user.role === 'superadmin' && user.enabled === 1 && (newRole !== 'superadmin' || newEnabled === 0)) {
    if (countActiveSuperadmins(user.id) === 0) throw new UserError('不能降级或禁用最后一个启用的超级管理员');
  }

  if (newUsername !== user.username) {
    const dup = db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(newUsername, Number(id));
    if (dup) throw new UserError('用户名已存在');
  }
  db.prepare("UPDATE users SET username=?, role=?, display_name=?, enabled=?, updated_at=datetime('now','localtime') WHERE id=?").run(
    newUsername, newRole, newDisplay, newEnabled, id
  );
  const updated = findById(id);
  // 角色/启用状态变化后，会话中缓存的旧角色不再可信
  updated._securityChanged = newRole !== user.role || newEnabled !== user.enabled;
  return updated;
}

function deleteUser(id) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return false;
  if (user.role === 'superadmin' && user.enabled === 1 && countActiveSuperadmins(user.id) === 0) {
    throw new UserError('不能删除最后一个启用的超级管理员');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return true;
}

function changeOwnPassword(userId, oldPassword, newPassword) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new UserError('用户不存在');
  if (typeof oldPassword !== 'string' || !bcrypt.compareSync(oldPassword, user.password_hash)) throw new UserError('旧密码不正确');
  validatePassword(newPassword);
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash=?, must_change_password=0, updated_at=datetime('now','localtime') WHERE id=?").run(hash, userId);
}

function resetPassword(id, newPassword) {
  validatePassword(newPassword);
  const hash = bcrypt.hashSync(newPassword, 10);
  const result = db.prepare("UPDATE users SET password_hash=?, must_change_password=0, updated_at=datetime('now','localtime') WHERE id=?").run(hash, id);
  return result.changes > 0;
}

function verifyPassword(user, password) {
  if (typeof password !== 'string') return false;
  return bcrypt.compareSync(password, user.password_hash);
}

/** 用户不存在时执行一次等价成本的哈希比对，抹平响应时间差异。 */
function burnPasswordHash(password) {
  bcrypt.compareSync(typeof password === 'string' ? password : '', DUMMY_HASH);
}

function isKnownDefaultPassword(password) {
  return KNOWN_DEFAULT_PASSWORDS.includes(password);
}

/** 启动自检：默认管理员是否仍使用公开的默认密码。 */
function usersWithDefaultPassword() {
  const rows = db.prepare('SELECT id, username, password_hash FROM users').all();
  return rows.filter(u => KNOWN_DEFAULT_PASSWORDS.some(p => bcrypt.compareSync(p, u.password_hash))).map(u => u.username);
}

function getAdminVlanPermissions(userId) {
  return db.prepare('SELECT vlan FROM admin_vlan_permissions WHERE user_id = ? ORDER BY vlan').all(userId).map(r => r.vlan);
}

function setAdminVlanPermissions(userId, vlans) {
  if (!Array.isArray(vlans) || vlans.length > 500 || vlans.some(v => typeof v !== 'string' && typeof v !== 'number' || String(v).length > 50)) {
    throw new UserError('VLAN 权限参数不正确');
  }
  if (!findById(userId)) throw new UserError('用户不存在', 404);
  db.transaction(() => {
  db.prepare('DELETE FROM admin_vlan_permissions WHERE user_id = ?').run(userId);
  const stmt = db.prepare('INSERT OR IGNORE INTO admin_vlan_permissions (user_id, vlan) VALUES (?,?)');
  vlans.forEach(v => stmt.run(userId, String(v)));
  });
}

function getVlanOptions() {
  const plans = dictService.getVlanPlans();
  const seen = new Set();
  const vlans = [];
  plans.forEach(p => {
    if (!seen.has(p.vlan)) {
      seen.add(p.vlan);
      vlans.push(p.vlan);
    }
  });
  return vlans;
}

module.exports = {
  findByUsername, findById, listUsers, createUser, updateUser, deleteUser, resetPassword,
  burnPasswordHash, isKnownDefaultPassword, usersWithDefaultPassword,
  verifyPassword, getAdminVlanPermissions, setAdminVlanPermissions, getVlanOptions, changeOwnPassword,
};
