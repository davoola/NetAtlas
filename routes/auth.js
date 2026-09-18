const express = require('express');
const router = express.Router();
const userService = require('../services/userService');
const dictService = require('../services/dictService');

const loginAttempts = new Map();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('pages/login', { layout: false, siteName: dictService.getSetting('site_name', '网图·IP管家'), error: null, user: null });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const siteName = dictService.getSetting('site_name', '网图·IP管家');

  const key = req.ip;
  const attempts = loginAttempts.get(key) || { count: 0, last: 0 };
  const now = Date.now();
  if (now - attempts.last < 300000 && attempts.count >= 5) {
    return res.status(429).render('pages/login', { layout: false, siteName, error: '登录尝试过多，请5分钟后再试', user: null });
  }

  const user = userService.findByUsername(username);
  if (!user || !user.enabled || !userService.verifyPassword(user, password)) {
    attempts.count = (now - attempts.last < 300000) ? attempts.count + 1 : 1;
    attempts.last = now;
    loginAttempts.set(key, attempts);
    return res.status(401).render('pages/login', { layout: false, siteName, error: '用户名或密码错误', user: null });
  }

  attempts.count = 0;
  loginAttempts.set(key, attempts);

  req.session.user = { id: user.id, username: user.username, role: user.role, display_name: user.display_name };
  dictService.auditLog(req.session.user, 'login', `用户 ${user.username} 登录`);
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('pages/login', { layout: false, siteName, error: '会话初始化失败', user: null });
    req.session.user = { id: user.id, username: user.username, role: user.role, display_name: user.display_name };
    res.redirect('/');
  });
});

router.post('/logout', (req, res) => {
  if (req.session.user) {
    dictService.auditLog(req.session.user, 'logout', `用户 ${req.session.user.username} 退出`);
  }
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
