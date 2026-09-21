const express = require('express');
const router = express.Router();
const userService = require('../services/userService');
const dictService = require('../services/dictService');
const limiter = require('../middleware/loginLimiter');
const { ensureToken } = require('../middleware/csrf');
const { DEFAULT_SITE_NAME } = require('../config/site');

function renderLogin(res, status, siteName, error) {
  res.locals.csrfToken = ensureToken(res.req);
  return res.status(status).render('pages/login', { layout: false, siteName, error, user: null });
}

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.locals.csrfToken = ensureToken(req);
  res.render('pages/login', { layout: false, siteName: dictService.getSetting('site_name', DEFAULT_SITE_NAME), error: null, user: null });
});

router.post('/login', (req, res) => {
  const siteName = dictService.getSetting('site_name', DEFAULT_SITE_NAME);
  const { username, password } = req.body || {};

  // 只接受字符串，防止 extended urlencoded/JSON 传入对象造成异常
  if (typeof username !== 'string' || typeof password !== 'string' || !username || username.length > 64 || password.length > 128) {
    return renderLogin(res, 401, siteName, '用户名或密码错误');
  }

  const ip = req.ip || 'unknown';
  if (limiter.isBlocked(ip, username)) {
    return renderLogin(res, 429, siteName, '登录尝试过多，请5分钟后再试');
  }

  const user = userService.findByUsername(username);
  let ok = false;
  if (user) ok = userService.verifyPassword(user, password);
  else userService.burnPasswordHash(password); // 恒定成本，避免通过耗时枚举用户名

  if (!user || !user.enabled || !ok) {
    limiter.recordFailure(ip, username);
    try { dictService.auditLog(null, 'login_failed', `登录失败: 用户名 ${username.slice(0, 64)}，来源 ${ip}`); } catch (e) { /* ignore */ }
    return renderLogin(res, 401, siteName, '用户名或密码错误');
  }

  limiter.recordSuccess(ip, username);
  const mustChange = !!user.must_change_password || userService.isKnownDefaultPassword(password);
  const sessionUser = { id: user.id, username: user.username, role: user.role, display_name: user.display_name, mustChangePassword: mustChange };

  // 登录成功后重新生成会话（防会话固定），再写入用户信息
  req.session.regenerate((err) => {
    if (err) return renderLogin(res, 500, siteName, '会话初始化失败');
    req.session.user = sessionUser;
    req.session.save((saveErr) => {
      if (saveErr) return renderLogin(res, 500, siteName, '会话初始化失败');
      dictService.auditLog(sessionUser, 'login', `用户 ${user.username} 登录`);
      res.redirect('/');
    });
  });
});

router.post('/logout', (req, res) => {
  if (req.session.user) {
    dictService.auditLog(req.session.user, 'logout', `用户 ${req.session.user.username} 退出`);
  }
  req.session.destroy((err) => {
    if (err) console.error('会话销毁失败:', err.message);
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

module.exports = router;
