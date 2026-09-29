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

function getAdminPermTokens(userId) {
  return db.prepare('SELECT vlan FROM admin_vlan_permissions WHERE user_id = ?').all(userId)
    .map(p => String(p.vlan || '').trim())
    .filter(Boolean);
}

/**
 * 是否可管理指定 VLAN/规划。
 * @param {string} vlanToken  plan:ID 或裸 VLAN 编号
 * @param {string} [ip]       可选；裸编号 + 仅 plan 授权时，用 IP 判断是否落在已授权网段内
 *
 * 规则：
 * - superadmin：全部
 * - 精确命中授权令牌（plan:ID 或裸编号）
 * - plan:ID：若拥有该编号的「裸 VLAN 全量授权」也可
 * - 裸编号：仅当拥有裸编号全量授权，或（提供了 IP）且 IP 落在某个已授权 plan 的网段内
 */
function canManageVlan(req, vlanToken, ip) {
  if (!req.session.user) return false;
  if (req.session.user.role === 'superadmin') return true;
  if (req.session.user.role !== 'admin') return false;

  const token = String(vlanToken || '').trim();
  if (!token) return false;
  const perms = getAdminPermTokens(req.session.user.id);
  if (perms.includes(token)) return true;

  const planMatch = token.match(/^plan:(\d+)$/);
  if (planMatch) {
    const plan = db.prepare('SELECT id, vlan, subnet FROM vlan_plans WHERE id = ?').get(Number(planMatch[1]));
    if (!plan) return false;
    // 裸 VLAN 编号全量授权覆盖该编号下所有规划
    return perms.includes(String(plan.vlan));
  }

  // token 为裸 VLAN 编号：plan 级授权时必须结合 IP 落在对应网段
  if (ip) {
    try {
      const ipService = require('../services/ipService');
      if (!ipService.isValidIp(ip)) return false;
      for (const p of perms) {
        const m = String(p).match(/^plan:(\d+)$/);
        if (!m) continue;
        const plan = db.prepare('SELECT * FROM vlan_plans WHERE id = ?').get(Number(m[1]));
        if (!plan || String(plan.vlan) !== token) continue;
        if (!plan.subnet) return true;
        if (ipService.ipInCidr(ip, plan.subnet)) return true;
      }
    } catch (e) {
      return false;
    }
  }
  return false;
}

/** 是否可管理某条已有登记记录（按规划网段精确判断） */
function canManageRecord(req, record) {
  if (!req.session.user) return false;
  if (req.session.user.role === 'superadmin') return true;
  if (req.session.user.role !== 'admin' || !record) return false;
  const scope = getReadableVlanScope(req);
  const ipService = require('../services/ipService');
  return ipService.recordInScope(scope, record);
}

function canManageVlanMiddleware(req, res, next) {
  const vlan = req.body.vlan || req.params.vlan;
  const ip = req.body.ip;
  if (!canManageVlan(req, vlan, ip)) {
    return res.status(403).json({ error: '您没有管理该 VLAN / 网段的权限' });
  }
  next();
}

/**
 * 可读范围：
 * - fullVlans: 裸 VLAN 编号（覆盖该编号下全部网段）
 * - planIds: 仅这些规划 ID 对应的网段
 * - vlans: 原始令牌列表
 */
function getReadableVlanScope(req) {
  if (!req.session.user) return { all: false, vlans: [], fullVlans: [], planIds: [] };
  const role = req.session.user.role;
  if (role === 'superadmin' || role === 'viewer') return { all: true, vlans: [], fullVlans: [], planIds: [] };
  if (role === 'admin') {
    const rows = getAdminPermTokens(req.session.user.id);
    const fullVlans = [];
    const planIds = [];
    const tokens = [];
    for (const tok of rows) {
      tokens.push(tok);
      const m = tok.match(/^plan:(\d+)$/);
      if (m) planIds.push(Number(m[1]));
      else fullVlans.push(tok);
    }
    return {
      all: false,
      vlans: [...new Set(tokens)],
      fullVlans: [...new Set(fullVlans)],
      planIds: [...new Set(planIds)],
    };
  }
  return { all: false, vlans: [], fullVlans: [], planIds: [] };
}

module.exports = {
  enforcePasswordChange,
  requireAuth,
  requireRole,
  canManageVlan,
  canManageRecord,
  canManageVlanMiddleware,
  getReadableVlanScope,
  resolveVlanToken,
};
