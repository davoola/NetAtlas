const session = require('express-session');
const db = require('../db');

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * 基于 SQLite 的 Session Store：重启不丢会话，并支持按用户批量撤销会话
 * （改密、禁用、降权、删除用户后使旧会话立即失效）。
 */
class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expire INTEGER NOT NULL,
        user_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    `);
    this.cleanup();
    this._timer = setInterval(() => this.cleanup(), 15 * 60 * 1000);
    this._timer.unref();
  }

  cleanup() {
    try { db.prepare('DELETE FROM sessions WHERE expire < ?').run(Date.now()); } catch (e) { /* ignore */ }
  }

  get(sid, cb) {
    let result, err;
    try {
      const row = db.prepare('SELECT sess, expire FROM sessions WHERE sid = ?').get(sid);
      if (!row) result = null;
      else if (row.expire < Date.now()) {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        result = null;
      } else {
        result = JSON.parse(row.sess);
      }
    } catch (e) { err = e; }
    if (err) return cb(err);
    return cb(null, result);
  }

  set(sid, sess, cb) {
    let err;
    try {
      const expire = sess && sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).getTime() : Date.now() + DEFAULT_TTL_MS;
      const userId = sess && sess.user ? sess.user.id : null;
      db.prepare('INSERT INTO sessions (sid, sess, expire, user_id) VALUES (?,?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expire=excluded.expire, user_id=excluded.user_id')
        .run(sid, JSON.stringify(sess), expire, userId);
    } catch (e) { err = e; }
    if (cb) cb(err || null);
  }

  destroy(sid, cb) {
    let err;
    try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); } catch (e) { err = e; }
    if (cb) cb(err || null);
  }

  /** 撤销某用户的全部会话（可保留当前会话）。 */
  destroyUser(userId, exceptSid = null) {
    if (exceptSid) db.prepare('DELETE FROM sessions WHERE user_id = ? AND sid != ?').run(userId, exceptSid);
    else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

module.exports = new SqliteSessionStore();
