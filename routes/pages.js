const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const dictService = require('../services/dictService');
const { DEFAULT_SITE_NAME } = require('../config/site');

router.use((req, res, next) => {
  res.locals.siteName = dictService.getSetting('site_name', DEFAULT_SITE_NAME);
  res.locals.user = req.session.user;
  next();
});

router.get('/', requireAuth, (req, res) => {
  res.redirect('/dashboard');
});

router.get('/dashboard', requireAuth, (req, res) => {
  res.render('pages/dashboard', { title: '仪表板与统计', activePage: 'dashboard', extraScript: '/js/dashboard.js' });
});

router.get('/records', requireAuth, (req, res) => {
  res.render('pages/records', { title: 'IP登记台账', activePage: 'records', extraScript: '/js/records.js' });
});

router.get('/subnets', requireAuth, (req, res) => {
  res.render('pages/subnets', { title: '网段使用明细', activePage: 'subnets', extraScript: '/js/subnets.js' });
});

router.get('/dictionary', requireAuth, (req, res) => {
  res.render('pages/dictionary', { title: '数据字典', activePage: 'dictionary', extraScript: '/js/dictionary.js' });
});

router.get('/users', requireAuth, requireRole('superadmin'), (req, res) => {
  res.render('pages/users', { title: '用户管理', activePage: 'users', extraScript: '/js/users.js' });
});

router.get('/import', requireAuth, requireRole('superadmin', 'admin'), (req, res) => {
  res.render('pages/import', { title: '数据导入', activePage: 'import', extraScript: '/js/import.js' });
});

router.get('/audit-log', requireAuth, requireRole('superadmin'), (req, res) => {
  res.render('pages/audit-log', { title: '操作审计日志', activePage: 'audit-log', extraScript: '/js/audit-log.js' });
});

module.exports = router;
