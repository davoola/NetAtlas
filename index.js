try { process.loadEnvFile(); } catch (e) { /* .env not present or unsupported */ }
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const dictService = require('./services/dictService');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:;");
  next();
});

const SESSION_SECRET = process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('警告: 未设置 SESSION_SECRET 环境变量，已生成随机密钥（重启后已登录用户需重新登录）。生产环境请务必配置固定密钥。');
}

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' },
}));

app.use(flash());

app.use((req, res, next) => {
  res.locals.siteName = dictService.getSetting('site_name', '网图·IP管家');
  res.locals.user = req.session.user || null;
  res.locals.activePage = '';
  res.locals.extraScript = null;
  next();
});

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/pages'));
app.use('/api', require('./routes/api'));
app.use('/api/import', require('./routes/import'));

app.use((req, res) => {
  res.status(404).render('pages/error', {
    title: '页面不存在',
    message: '您访问的页面不存在',
  });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('pages/error', {
    title: '系统错误',
    message: '系统内部错误，请联系管理员',
  });
});

app.listen(PORT, () => {
  console.log(`NetAtlas[网图·IP管家]系统已启动: http://localhost:${PORT}`);
});
