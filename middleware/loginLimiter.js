// 登录限速：按 "IP+账号" 与 "IP" 两个维度计数，带过期清理，防止内存无限增长。
const WINDOW_MS = 5 * 60 * 1000;
const MAX_PER_USER = 5;   // 同一 IP 对同一账号
const MAX_PER_IP = 30;    // 同一 IP 的总失败次数
const MAX_ENTRIES = 50000;

const store = new Map();

function keyUser(ip, username) { return `u|${ip}|${String(username || '').toLowerCase().slice(0, 64)}`; }
function keyIp(ip) { return `i|${ip}`; }

function live(entry, now) { return entry && now - entry.last < WINDOW_MS; }

function isBlocked(ip, username) {
  const now = Date.now();
  const u = store.get(keyUser(ip, username));
  const i = store.get(keyIp(ip));
  return (live(u, now) && u.count >= MAX_PER_USER) || (live(i, now) && i.count >= MAX_PER_IP);
}

function bump(key, now) {
  const e = store.get(key);
  if (live(e, now)) { e.count += 1; e.last = now; } else { store.set(key, { count: 1, last: now }); }
}

function recordFailure(ip, username) {
  const now = Date.now();
  bump(keyUser(ip, username), now);
  bump(keyIp(ip), now);
  if (store.size > MAX_ENTRIES) {
    for (const k of store.keys()) { store.delete(k); if (store.size <= MAX_ENTRIES * 0.9) break; }
  }
}

function recordSuccess(ip, username) {
  store.delete(keyUser(ip, username));
}

const timer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (!live(v, now)) store.delete(k);
}, 60 * 1000);
timer.unref();

module.exports = { isBlocked, recordFailure, recordSuccess, _store: store };
