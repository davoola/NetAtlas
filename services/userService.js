const db = require('../db');
const bcrypt = require('bcryptjs');
const dictService = require('./dictService');

function findByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function findById(id) {
  return db.prepare('SELECT id, username, role, display_name, enabled, created_at FROM users WHERE id = ?').get(id);
}

function listUsers() {
  return db.prepare('SELECT id, username, role, display_name, enabled, created_at FROM users ORDER BY id').all();
}

function createUser(username, password, role, displayName) {
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)').run(username, hash, role, displayName);
  return result.lastInsertRowid;
}

function updateUser(id, { username, role, display_name, enabled }) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return null;
  const newUsername = username !== undefined ? username : user.username;
  if (newUsername !== user.username) {
    const dup = db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(newUsername, Number(id));
    if (dup) throw new Error('用户名已存在');
  }
  db.prepare("UPDATE users SET username=?, role=?, display_name=?, enabled=?, updated_at=datetime('now','localtime') WHERE id=?").run(
    newUsername,
    role !== undefined ? role : user.role,
    display_name !== undefined ? display_name : user.display_name,
    enabled !== undefined ? enabled : user.enabled,
    id
  );
  return findById(id);
}

function changeOwnPassword(userId, oldPassword, newPassword) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('用户不存在');
  if (!bcrypt.compareSync(oldPassword, user.password_hash)) throw new Error('旧密码不正确');
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash=?, updated_at=datetime('now','localtime') WHERE id=?").run(hash, userId);
}

function resetPassword(id, newPassword) {
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash=?, updated_at=datetime('now','localtime') WHERE id=?").run(hash, id);
}

function verifyPassword(user, password) {
  return bcrypt.compareSync(password, user.password_hash);
}

function getAdminVlanPermissions(userId) {
  return db.prepare('SELECT vlan FROM admin_vlan_permissions WHERE user_id = ? ORDER BY vlan').all(userId).map(r => r.vlan);
}

function setAdminVlanPermissions(userId, vlans) {
  db.prepare('DELETE FROM admin_vlan_permissions WHERE user_id = ?').run(userId);
  const stmt = db.prepare('INSERT OR IGNORE INTO admin_vlan_permissions (user_id, vlan) VALUES (?,?)');
  vlans.forEach(v => stmt.run(userId, v));
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
  findByUsername, findById, listUsers, createUser, updateUser, resetPassword,
  verifyPassword, getAdminVlanPermissions, setAdminVlanPermissions, getVlanOptions, changeOwnPassword,
};
