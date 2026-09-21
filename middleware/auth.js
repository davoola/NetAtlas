const db = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.user) {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(401).json({ error: '未登录或会话已过期' });
    }
    return res.redirect('/login');
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) {
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(401).json({ error: '未登录或会话已过期' });
      }
      return res.redirect('/login');
    }
    if (!roles.includes(req.session.user.role)) {
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.status(403).json({ error: '权限不足' });
      }
      return res.status(403).render('pages/error', { title: '权限不足', message: '您没有权限访问此页面' });
    }
    next();
  };
}

// 使用初始/默认密码登录的账号，必须先修改密码才能访问业务接口
function enforcePasswordChange(req, res, next) {
  const u = req.session && req.session.user;
  if (!u || !u.mustChangePassword) return next();
  if (req.method === 'POST' && (req.path === '/api/change-password' || req.path === '/logout')) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ error: '请先修改初始密码', code: 'PASSWORD_CHANGE_REQUIRED' });
  }
  next();
}

function resolveVlanToken(token) {
  if (!token) return null;
  const m = String(token).match(/^plan:(\d+)$/);
  if (m) {
    const plan = db.prepare('SELECT vlan FROM vlan_plans WHERE id = ?').get(Number(m[1]));
    return plan ? plan.vlan : null;
  }
  return token;
}

function canManageVlan(req, vlan) {
  if (!req.session.user) return false;
  if (req.session.user.role === 'superadmin') return true;
  if (req.session.user.role === 'admin') {
    const token = String(vlan || '');
    if (!token) return false;
    const resolved = resolveVlanToken(vlan);
    // 授权项既可能以 VLAN 编号保存，也可能以 plan:ID 令牌保存（用户管理界面保存的是后者），统一解析为 VLAN 编号后比较
    const perms = db.prepare('SELECT vlan FROM admin_vlan_permissions WHERE user_id = ?').all(req.session.user.id);
    return perms.some(p => p.vlan === token || (resolved !== null && (p.vlan === resolved || resolveVlanToken(p.vlan) === resolved)));
  }
  return false;
}

function canManageVlanMiddleware(req, res, next) {
  const vlan = req.body.vlan || req.params.vlan;
  if (!canManageVlan(req, vlan)) {
    return res.status(403).json({ error: '您没有管理该 VLAN 的权限' });
  }
  next();
}

function getReadableVlanScope(req) {
  if (!req.session.user) return { all: false, vlans: [] };
  const role = req.session.user.role;
  if (role === 'superadmin' || role === 'viewer') return { all: true };
  if (role === 'admin') {
    const rows = db.prepare('SELECT vlan FROM admin_vlan_permissions WHERE user_id = ?').all(req.session.user.id);
    const vlans = rows.map(r => r.vlan);
    const resolved = vlans.map(v => resolveVlanToken(v)).filter(Boolean);
    return { all: false, vlans: [...new Set([...vlans, ...resolved])] };
  }
  return { all: false, vlans: [] };
}

module.exports = { enforcePasswordChange, requireAuth, requireRole, canManageVlan, canManageVlanMiddleware, getReadableVlanScope };
