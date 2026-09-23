try { process.loadEnvFile(); } catch (e) { /* .env not present or unsupported */ }
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const expressLayouts = require('express-ejs-layouts');
const crypto = require('crypto');
const path = require('path');
const dictService = require('./services/dictService');
const userService = require('./services/userService');
const sessionStore = require('./middleware/sessionStore');
const { csrfProtection } = require('./middleware/csrf');
const { enforcePasswordChange } = require('./middleware/auth');
const { publicMessage, logError } = require('./utils/errors');
const { DEFAULT_SITE_NAME } = require('./config/site');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

app.disable('x-powered-by');

// 反向代理后部署时，按实际代理层数配置（如 TRUST_PROXY=1）。不要盲目信任所有代理。
if (process.env.TRUST_PROXY) {
  const v = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(v) ? Number(v) : (v === 'true' ? 1 : v));
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));
// Express 5 在未解析到请求体时 req.body 为 undefined：统一兜底为空对象，避免各处 req.body.xxx 抛错
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
app.use(express.static(path.join(__dirname, 'public')));

// 请求 ID + 结构化访问日志（不记录查询串、请求体、密码）
app.use((req, res, next) => {
  req.id = crypto.randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  if (process.env.ACCESS_LOG !== '0') {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      console.log(JSON.stringify({
        ts: new Date().toISOString(), id: req.id, method: req.method, path: req.path,
        status: res.statusCode, ms: Number((process.hrtime.bigint() - start) / 1000000n),
        user: req.session && req.session.user ? req.session.user.username : null,
      }));
    });
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
  if (IS_PROD && req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// --- Session 密钥：生产环境缺失/过弱直接拒绝启动 ---
let SESSION_SECRET = process.env.SESSION_SECRET;
if (IS_PROD && (!SESSION_SECRET || SESSION_SECRET.length < 32)) {
  console.error('错误: 生产环境必须设置长度不少于 32 位的 SESSION_SECRET（例如: openssl rand -hex 32）。');
  process.exit(1);
}
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('警告: 未设置 SESSION_SECRET 环境变量，已生成随机密钥（重启后签名失效，需重新登录）。生产环境请务必配置固定密钥。');
}

app.use(session({
  store: sessionStore,
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: IS_PROD },
}));

app.use(flash());

app.use((req, res, next) => {
  res.locals.siteName = dictService.getSetting('site_name', DEFAULT_SITE_NAME);
  res.locals.user = req.session.user || null;
  res.locals.activePage = '';
  res.locals.extraScript = null;
  next();
});

app.use(csrfProtection);
app.use(enforcePasswordChange);

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
  if (res.headersSent) return next(err);
  const isClientErr = err && err.status >= 400 && err.status < 500;
  const status = isClientErr ? err.status : 500;
  // 详细错误只写服务端日志；对外仅返回通用信息 + 请求 ID
  if (!isClientErr) logError(req, err, 'unhandled');
  let message;
  if (isClientErr && !err.expose) message = '请求格式不正确';
  else if (isClientErr) message = err.name === 'UserError' ? err.message : '请求格式不正确';
  else message = publicMessage(err, '服务器内部错误');
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: message, requestId: req.id });
  }
  res.status(status).render('pages/error', {
    title: '系统错误',
    message: '系统内部错误，请联系管理员（请求ID: ' + req.id + '）',
  });
});

// 启动自检：仍使用公开默认密码的账号
try {
  const weak = userService.usersWithDefaultPassword();
  if (weak.length) {
    const line = '!'.repeat(72);
    const msg = `账号 [${weak.join(', ')}] 仍在使用公开的已知弱口令（如 admin123）！`;
    if (IS_PROD) {
      console.warn(`\n${line}\n[安全警告][生产环境] ${msg}\n该账号登录后会被强制改密，但在改密前任何人都能凭公开口令登录。\n请立即登录修改，或由超级管理员在“用户管理”中重置该账号密码。\n${line}\n`);
    } else {
      console.warn(`警告: ${msg}登录后将被强制要求修改密码。`);
    }
  }
} catch (e) { /* users 表未初始化时忽略，提示运行 init-db */ }

app.listen(PORT, () => {
  console.log(`NetAtlas[网图·IP管家]系统已启动: http://localhost:${PORT}`);
});
