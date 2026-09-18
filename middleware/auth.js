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
    const resolved = resolveVlanToken(vlan);
    const perm = db.prepare('SELECT 1 FROM admin_vlan_permissions WHERE user_id = ? AND (vlan = ? OR vlan = ?)').get(req.session.user.id, token, resolved);
    return !!perm;
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

module.exports = { requireAuth, requireRole, canManageVlan, canManageVlanMiddleware, getReadableVlanScope };
