const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function ensureToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Synchronizer Token 模式的 CSRF 防护（令牌保存在服务端 Session）。
 * - 视图中通过 res.locals.csrfToken 使用
 * - 非安全方法需带 X-CSRF-Token 请求头或 _csrf 表单字段
 */
function csrfProtection(req, res, next) {
  // 已登录用户的每个页面都需要令牌；匿名请求仅在渲染登录页时才生成（避免为爬虫/404 创建会话）
  if (req.session && req.session.user) res.locals.csrfToken = ensureToken(req);
  if (SAFE_METHODS.has(req.method)) return next();

  const sent = req.get('x-csrf-token') || (req.body && typeof req.body === 'object' ? req.body._csrf : '');
  const expected = req.session && req.session.csrfToken;
  if (expected && safeEqual(sent, expected)) return next();

  // 校验失败：按请求类型返回合适的响应
  if (req.path === '/login') {
    res.locals.csrfToken = ensureToken(req);
    return res.status(403).render('pages/login', {
      layout: false, siteName: res.locals.siteName, user: null,
      error: '页面已过期，请重新输入后再试',
    });
  }
  if (req.path === '/logout') return res.redirect('/login');
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: '未登录或会话已过期' });
  }
  return res.status(403).json({ error: '请求校验失败（CSRF），请刷新页面后重试' });
}

module.exports = { csrfProtection, ensureToken };
