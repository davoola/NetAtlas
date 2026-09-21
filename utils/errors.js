// 统一错误处理：区分"可展示给用户的业务错误"和"不应泄露细节的内部错误"。
class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserError';
    this.expose = true;
    this.status = status;
  }
}

const INTERNAL_TYPES = [TypeError, RangeError, ReferenceError, SyntaxError];

function isSqliteError(e) {
  if (!e) return false;
  if (typeof e.code === 'string' && e.code.startsWith('ERR_SQLITE')) return true;
  return /SQLITE_|constraint failed|no such (table|column)|syntax error|database is locked/i.test(String(e.message));
}

/**
 * 返回可以安全展示给客户端的错误信息（不含 SQL 结构、路径等内部细节）。
 * 业务校验错误（UserError 或代码中主动抛出的普通 Error）保留原文以保持既有提示不变。
 */
function publicMessage(e, fallback = '操作失败，请稍后重试') {
  if (!e) return fallback;
  if (e.expose) return e.message;
  if (isSqliteError(e)) {
    const msg = String(e.message);
    if (/UNIQUE constraint/i.test(msg)) return '数据已存在（违反唯一性约束）';
    if (/FOREIGN KEY/i.test(msg)) return '存在关联数据，操作被拒绝';
    return fallback;
  }
  if (INTERNAL_TYPES.some(T => e instanceof T)) return fallback;
  if (e.code && typeof e.code === 'string' && /^(E[A-Z]+|ERR_)/.test(e.code)) return fallback; // 文件系统/Node 内部错误
  return e.message || fallback;
}

function logError(req, e, label = '') {
  const id = req && req.id ? req.id : '-';
  console.error(JSON.stringify({
    ts: new Date().toISOString(), level: 'error', requestId: id, label,
    method: req && req.method, path: req && req.path,
    user: req && req.session && req.session.user ? req.session.user.username : null,
    message: e && e.message, stack: e && e.stack,
  }));
}

module.exports = { UserError, publicMessage, logError, isSqliteError };
