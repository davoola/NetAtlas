const db = require('../db');
const { UserError } = require('../utils/errors');
const { checkStringFields, clampInt } = require('../utils/validate');

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isValidIp(ip) {
  return IPV4_RE.test(String(ip || ''));
}

function ipToInt(ip) {
  if (!isValidIp(ip)) return null;
  const [a, b, c, d] = ip.split('.').map(Number);
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

function parseCidr(cidr) {
  if (!cidr || typeof cidr !== 'string') return null;
  const m = cidr.match(/^(.+?)\/(\d+)$/);
  if (!m) return null;
  const base = ipToInt(m[1]);
  const prefix = parseInt(m[2], 10);
  if (base === null || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  const network = (base & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { network, broadcast, prefix, mask };
}

function ipInCidr(ip, cidr) {
  const intIp = ipToInt(ip);
  const parsed = parseCidr(cidr);
  if (intIp === null || !parsed) return false;
  return intIp >= parsed.network && intIp <= parsed.broadcast;
}

/** Expand IPv6 to 8 zero-padded hextets; returns array or null. */
function expandIpv6(addr) {
  if (!addr || typeof addr !== 'string') return null;
  let s = addr.trim().toLowerCase();
  if (s.includes('%')) s = s.split('%')[0]; // zone id
  if (s.includes('/')) return null;
  if (!/^[0-9a-f:]+$/.test(s)) return null;
  if (s.includes(':::') || (s.match(/::/g) || []).length > 1) return null;
  let head, tail;
  if (s.includes('::')) {
    const parts = s.split('::');
    head = parts[0] ? parts[0].split(':') : [];
    tail = parts[1] ? parts[1].split(':') : [];
  } else {
    head = s.split(':');
    tail = [];
  }
  head = head.filter(x => x !== '');
  tail = tail.filter(x => x !== '');
  if (head.some(h => h.length > 4) || tail.some(h => h.length > 4)) return null;
  if (head.some(h => !/^[0-9a-f]{1,4}$/.test(h)) || tail.some(h => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  if (!s.includes('::') && missing !== 0) return null;
  if (s.includes('::') && missing === 0 && head.length + tail.length !== 8) return null;
  const mid = Array(Math.max(missing, 0)).fill('0000');
  const groups = [...head, ...mid, ...tail].map(h => h.padStart(4, '0'));
  if (groups.length !== 8) return null;
  return groups;
}

function isValidIpv6(addr) {
  return expandIpv6(addr) !== null;
}

function ipv6SortKey(addr) {
  const g = expandIpv6(addr);
  return g ? g.join('') : null;
}

function isValidIpv6Cidr(cidr) {
  if (!cidr || typeof cidr !== 'string') return false;
  const m = cidr.trim().match(/^(.+?)\/(\d{1,3})$/);
  if (!m) return false;
  const prefix = parseInt(m[2], 10);
  if (prefix < 0 || prefix > 128) return false;
  return isValidIpv6(m[1]);
}

/** Convert expanded IPv6 to BigInt for prefix comparison. */
function ipv6ToBigInt(addr) {
  const groups = expandIpv6(addr);
  if (!groups) return null;
  let n = 0n;
  for (const h of groups) {
    n = (n << 16n) + BigInt(parseInt(h, 16));
  }
  return n;
}

/** Check whether addr is inside cidr (e.g. 2001:250:5401:101::/64). */
function ipv6InCidr(addr, cidr) {
  if (!cidr || typeof cidr !== 'string') return false;
  const m = cidr.trim().match(/^(.+?)\/(\d{1,3})$/);
  if (!m) return false;
  const prefix = parseInt(m[2], 10);
  if (prefix < 0 || prefix > 128) return false;
  const net = ipv6ToBigInt(m[1]);
  const ip = ipv6ToBigInt(addr);
  if (net === null || ip === null) return false;
  if (prefix === 0) return true;
  const shift = 128n - BigInt(prefix);
  return (ip >> shift) === (net >> shift);
}


function lookupGateway(ip) {
  if (!ip) return null;
  const parts = ip.split('.');
  if (parts.length < 3) return null;
  const prefix = parts.slice(0, 3).join('.');
  const row = db.prepare('SELECT gateway FROM ip_prefix_gateways WHERE prefix = ?').get(prefix);
  return row ? row.gateway : null;
}

/** 按 IP 所属子网匹配 VLAN 规划（同一 VLAN 编号可有多条不同网段）。 */
function lookupPlanByIp(ip) {
  if (!ip) return null;
  const plans = db.prepare('SELECT * FROM vlan_plans ORDER BY sort_order, id').all();
  for (const plan of plans) {
    if (plan.subnet && ipInCidr(ip, plan.subnet)) return plan;
  }
  return null;
}

function lookupVlanByIp(ip) {
  const plan = lookupPlanByIp(ip);
  return plan ? plan.vlan : null;
}

function getDuplicateIpv6Set() {
  const rows = db.prepare(`
    SELECT ipv6_sort FROM ip_records WHERE ipv6_sort IS NOT NULL AND ipv6_sort != ''
    GROUP BY ipv6_sort HAVING COUNT(*) > 1
  `).all();
  return new Set(rows.map(r => r.ipv6_sort));
}

function getDuplicateIpSet() {
  const rows = db.prepare(`
    SELECT ip FROM ip_records WHERE ip IS NOT NULL AND ip != ''
    GROUP BY ip HAVING COUNT(*) > 1
  `).all();
  return new Set(rows.map(r => r.ip));
}

/** 用于冲突比较的规范化键：仅保留十六进制并小写。 */
function macKey(mac) {
  return String(mac || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

/**
 * 统一 MAC 存储格式：大写，每 4 位一组，用 '-' 连接。
 * 例：D8CB8AD3E0C3 / d8:cb:8a:d3:e0:c3 / D8-CB-8A-D3-E0-C3 → D8CB-8AD3-E0C3
 */
function normalizeMac(mac) {
  if (mac === null || mac === undefined) return null;
  const hex = String(mac).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!hex) return null;
  if (hex.length !== 12) return hex; // 非标准长度时仍保存清洗后的大写十六进制
  return hex.slice(0, 4) + '-' + hex.slice(4, 8) + '-' + hex.slice(8, 12);
}

function getMacConflictMacSet() {
  const rows = db.prepare(`
    SELECT mac FROM ip_records
    WHERE mac IS NOT NULL AND trim(mac) != ''
  `).all();
  const counts = new Map();
  for (const r of rows) {
    const k = macKey(r.mac);
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k));
}

function listRecords({ page = 1, perPage = 20, search = '', vlan = '', department = '', status = '', deviceType = '', sort = 'updated_at', order = 'desc', scope = null, onlyDuplicate = '', onlyMacConflict = '', onlyDuplicateIpv6 = '' }) {
  page = clampInt(page, 1, 1, 1000000);
  perPage = clampInt(perPage, 20, 1, 5000);
  const offset = (page - 1) * perPage;
  const where = [];
  const params = [];
  search = search === undefined || search === null ? '' : String(search).slice(0, 200);

  if (search) {
    where.push('(ip LIKE ? OR ipv6 LIKE ? OR device_name LIKE ? OR user_name LIKE ? OR mac LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (vlan) {
    const planMatch = String(vlan).match(/^plan:(\d+)$/);
    if (planMatch) {
      // 同一 VLAN 编号可有多条不同网段：按规划 ID 同时限制 vlan 编号与子网范围
      const plan = db.prepare('SELECT * FROM vlan_plans WHERE id = ?').get(Number(planMatch[1]));
      if (plan) {
        where.push('vlan = ?');
        params.push(plan.vlan);
        if (plan.subnet) {
          const parsed = parseCidr(plan.subnet);
          if (parsed) {
            if (plan.enable_ipv6) {
              where.push('((ip_sort IS NOT NULL AND ip_sort >= ? AND ip_sort <= ?) OR (ipv6 IS NOT NULL AND trim(ipv6) != \'\'))');
              params.push(parsed.network, parsed.broadcast);
            } else {
              where.push('ip_sort IS NOT NULL AND ip_sort >= ? AND ip_sort <= ?');
              params.push(parsed.network, parsed.broadcast);
            }
          }
        }
      }
    } else {
      where.push('vlan = ?');
      params.push(vlan);
    }
  }
  if (department) { where.push('department = ?'); params.push(department); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (deviceType) { where.push('device_type = ?'); params.push(deviceType); }
  if (scope && !scope.all) {
    const scopeParts = [];
    const scopeParams = [];
    const fullVlans = scope.fullVlans || [];
    const planIds = scope.planIds || [];
    // 兼容旧 scope：仅有 vlans、无 fullVlans/planIds 时按原逻辑（裸编号 + plan 令牌）
    if (!scope.fullVlans && !scope.planIds && scope.vlans && scope.vlans.length) {
      for (const tok of scope.vlans) {
        const m = String(tok).match(/^plan:(\d+)$/);
        if (m) planIds.push(Number(m[1]));
        else fullVlans.push(String(tok));
      }
    }
    if (fullVlans.length) {
      scopeParts.push(`vlan IN (${fullVlans.map(() => '?').join(',')})`);
      scopeParams.push(...fullVlans);
    }
    for (const pid of planIds) {
      const plan = db.prepare('SELECT * FROM vlan_plans WHERE id = ?').get(pid);
      if (!plan) continue;
      if (plan.subnet) {
        const parsed = parseCidr(plan.subnet);
        if (parsed) {
          scopeParts.push('(vlan = ? AND ip_sort IS NOT NULL AND ip_sort >= ? AND ip_sort <= ?)');
          scopeParams.push(plan.vlan, parsed.network, parsed.broadcast);
        } else {
          scopeParts.push('vlan = ?');
          scopeParams.push(plan.vlan);
        }
      } else {
        // 动态池：该 VLAN 下无 IPv4 或不在其它同号有网段规划范围内的记录较难精确切分，按 vlan 收窄
        scopeParts.push('vlan = ?');
        scopeParams.push(plan.vlan);
      }
    }
    if (scopeParts.length === 0) {
      where.push('1 = 0');
    } else {
      where.push('(' + scopeParts.join(' OR ') + ')');
      params.push(...scopeParams);
    }
  }
  if (onlyDuplicate === '1') {
    const dupIps = [...getDuplicateIpSet()];
    if (dupIps.length === 0) {
      where.push('1 = 0');
    } else {
      const placeholders = dupIps.map(() => '?').join(',');
      where.push(`ip IN (${placeholders})`);
      params.push(...dupIps);
    }
  }
  if (onlyDuplicateIpv6 === '1') {
    const dupKeys = [...getDuplicateIpv6Set()];
    if (dupKeys.length === 0) {
      where.push('1 = 0');
    } else {
      const placeholders = dupKeys.map(() => '?').join(',');
      where.push(`ipv6_sort IN (${placeholders})`);
      params.push(...dupKeys);
    }
  }
  if (onlyMacConflict === '1') {
    const conflictKeys = getMacConflictMacSet();
    if (conflictKeys.size === 0) {
      where.push('1 = 0');
    } else {
      // 库中可能存在多种历史 MAC 写法：用十六进制键在内存中筛出冲突行 ID
      const allMacRows = db.prepare("SELECT id, mac FROM ip_records WHERE mac IS NOT NULL AND trim(mac) != ''").all();
      const conflictIds = allMacRows.filter(r => conflictKeys.has(macKey(r.mac))).map(r => r.id);
      if (conflictIds.length === 0) {
        where.push('1 = 0');
      } else {
        const placeholders = conflictIds.map(() => '?').join(',');
        where.push(`id IN (${placeholders})`);
        params.push(...conflictIds);
      }
    }
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const validSorts = ['ip','ipv6','mac','device_name','user_name','updated_at','registered_at','vlan','status','department','device_type'];
  let sortCol = validSorts.includes(sort) ? sort : 'updated_at';
  if (sortCol === 'ip') sortCol = 'ip_sort';
  if (sortCol === 'ipv6') sortCol = 'ipv6_sort';
  const sortDir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM ip_records ${whereClause}`).get(...params).cnt;
  const rows = db.prepare(`
    SELECT * FROM ip_records ${whereClause}
    ORDER BY ${sortCol} ${sortDir}
    LIMIT ? OFFSET ?
  `).all(...params, perPage, offset);

  const dupSet = getDuplicateIpSet();
  const macConflictSet = getMacConflictMacSet();
  const dupIpv6Set = getDuplicateIpv6Set();
  rows.forEach(r => { r.is_duplicate = Boolean(r.ip) && dupSet.has(r.ip); r.is_mac_conflict = macConflictSet.has(macKey(r.mac)); r.is_duplicate_ipv6 = Boolean(r.ipv6_sort) && dupIpv6Set.has(r.ipv6_sort); });

  return { rows, total, page, perPage, totalPages: Math.ceil(total / perPage) };
}

function getRecord(id) {
  return db.prepare('SELECT * FROM ip_records WHERE id = ?').get(id);
}

function resolveVlanToken(token) {
  if (!token) return null;
  const m = String(token).match(/^plan:(\d+)$/);
  if (m) {
    const plan = db.prepare('SELECT vlan, subnet FROM vlan_plans WHERE id = ?').get(Number(m[1]));
    return plan ? plan.vlan : null;
  }
  return token;
}

function getPlanForVlanToken(token) {
  const m = String(token || '').match(/^plan:(\d+)$/);
  if (m) return db.prepare('SELECT * FROM vlan_plans WHERE id = ?').get(Number(m[1]));
  return null;
}

function parsePoolRangeServer(plan, parsed) {
  let rangeStart = 1, rangeEnd = 254;
  if (plan && plan.address_pool_note) {
    const m = plan.address_pool_note.match(/\.?(\d{1,3})\s*[-–~至到]\s*\.?(\d{1,3})/);
    if (m) { rangeStart = parseInt(m[1], 10); rangeEnd = parseInt(m[2], 10); }
  } else if (parsed) {
    const totalHosts = parsed.broadcast - parsed.network;
    rangeEnd = totalHosts > 2 ? totalHosts - 1 : totalHosts;
  }
  return { rangeStart, rangeEnd };
}

function validateIpForVlan(ip, vlanToken) {
  if (!ip) return null;
  if (!vlanToken || !String(vlanToken).trim()) {
    const planByIp = lookupPlanByIp(ip);
    if (!planByIp) {
      throw new UserError('该 IP 不属于任何已规划的网段，请手动选择 VLAN');
    }
    vlanToken = `plan:${planByIp.id}`;
  }
  const plan = getPlanForVlanToken(vlanToken);
  if (plan && plan.subnet) {
    if (!isValidIp(ip) || !ipInCidr(ip, plan.subnet)) {
      throw new UserError(`IP地址必须在所选VLAN网段（${plan.subnet}）范围内`);
    }
    const parsed = parseCidr(plan.subnet);
    const { rangeStart, rangeEnd } = parsePoolRangeServer(plan, parsed);
    const hostOffset = (ipToInt(ip) - parsed.network) >>> 0;
    const gatewayInt = plan.gateway && plan.gateway !== '-' ? ipToInt(plan.gateway) : null;
    const gatewayOffset = gatewayInt !== null ? (gatewayInt - parsed.network) >>> 0 : null;
    if (hostOffset !== gatewayOffset && (hostOffset < rangeStart || hostOffset > rangeEnd)) {
      throw new UserError(`IP地址超出该VLAN可用池范围（${rangeStart}-${rangeEnd}）`);
    }
    return plan;
  }
  const plans = db.prepare('SELECT * FROM vlan_plans WHERE vlan = ?').all(String(vlanToken));
  if (plans.length > 0) {
    const matched = plans.find(candidate => candidate.subnet && ipInCidr(ip, candidate.subnet));
    if (!matched) {
      const subnets = plans.map(p => p.subnet).filter(Boolean).join(', ');
      throw new UserError(`IP地址必须在所选VLAN网段（${subnets}）范围内`);
    }
    const parsed = parseCidr(matched.subnet);
    const { rangeStart, rangeEnd } = parsePoolRangeServer(matched, parsed);
    const hostOffset = (ipToInt(ip) - parsed.network) >>> 0;
    const gatewayInt = matched.gateway && matched.gateway !== '-' ? ipToInt(matched.gateway) : null;
    const gatewayOffset = gatewayInt !== null ? (gatewayInt - parsed.network) >>> 0 : null;
    if (hostOffset !== gatewayOffset && (hostOffset < rangeStart || hostOffset > rangeEnd)) {
      throw new UserError(`IP地址超出该VLAN可用池范围（${rangeStart}-${rangeEnd}）`);
    }
    return matched;
  }
  return null;
}

function isDynamicVlanToken(vlanToken) {
  if (!vlanToken) return false;
  const plan = getPlanForVlanToken(vlanToken);
  if (plan) return !!plan.is_dynamic;
  const resolved = resolveVlanToken(vlanToken);
  if (resolved) {
    const p = db.prepare('SELECT is_dynamic FROM vlan_plans WHERE vlan = ? LIMIT 1').get(resolved);
    return p ? !!p.is_dynamic : false;
  }
  return false;
}

function planEnablesIpv6(vlanToken) {
  const m = String(vlanToken || '').match(/^plan:(\d+)$/);
  if (m) {
    const plan = db.prepare('SELECT enable_ipv6 FROM vlan_plans WHERE id = ?').get(Number(m[1]));
    return !!(plan && plan.enable_ipv6);
  }
  const vlan = resolveVlanToken(vlanToken) || vlanToken;
  if (!vlan) return false;
  const row = db.prepare('SELECT enable_ipv6 FROM vlan_plans WHERE vlan = ? AND enable_ipv6 = 1 LIMIT 1').get(vlan);
  return !!row;
}

function getVlanPlanForToken(vlanToken) {
  const m = String(vlanToken || '').match(/^plan:(\d+)$/);
  if (m) return db.prepare('SELECT * FROM vlan_plans WHERE id = ?').get(Number(m[1])) || null;
  const vlan = resolveVlanToken(vlanToken) || vlanToken;
  if (!vlan) return null;
  return db.prepare('SELECT * FROM vlan_plans WHERE vlan = ? AND enable_ipv6 = 1 LIMIT 1').get(vlan)
    || db.prepare('SELECT * FROM vlan_plans WHERE vlan = ? LIMIT 1').get(vlan)
    || null;
}

function normalizeRecordIpv6(data, vlanToken) {
  let ipv6 = data.ipv6 !== undefined && data.ipv6 !== null ? String(data.ipv6).trim() : '';
  const plan = getVlanPlanForToken(vlanToken);
  if (!plan || !plan.enable_ipv6) {
    return { ipv6: null, ipv6Sort: null };
  }
  if (!ipv6) return { ipv6: null, ipv6Sort: null };
  if (!isValidIpv6(ipv6)) throw new UserError('IPv6 地址格式不合法');
  if (plan.ipv6_subnet) {
    if (!isValidIpv6Cidr(plan.ipv6_subnet)) {
      throw new UserError('该 VLAN 的 IPv6 网段配置无效，请先在数据字典中修正');
    }
    if (!ipv6InCidr(ipv6, plan.ipv6_subnet)) {
      throw new UserError(`IPv6 地址必须在所选 VLAN 网段（${plan.ipv6_subnet}）范围内`);
    }
  }
  return { ipv6, ipv6Sort: ipv6SortKey(ipv6) };
}

function createRecord(data) {
  checkStringFields(data);
  const isDynamic = isDynamicVlanToken(data.vlan);
  if (data.mac !== undefined && data.mac !== null && String(data.mac).trim() !== '') data.mac = normalizeMac(data.mac);
  else if (data.mac !== undefined) data.mac = null;
  if (!isDynamic) {
    if (!data.ip || !String(data.ip).trim()) {
      throw new UserError('IP地址为必填项');
    }
    if (data.ip && !isValidIp(data.ip)) {
      throw new UserError('IP地址格式不合法');
    }
  } else if (data.ip && !isValidIp(data.ip)) {
    throw new UserError('IP地址格式不合法');
  }
  const gateway = data.gateway || (data.ip ? lookupGateway(data.ip) : null);
  const vlan = resolveVlanToken(data.vlan) || (data.ip ? lookupVlanByIp(data.ip) : null);
  const ipSort = data.ip ? ipToInt(data.ip) : null;
  const { ipv6, ipv6Sort } = normalizeRecordIpv6(data, data.vlan);
  const insertResult = db.prepare(`
    INSERT INTO ip_records (vlan, ip, ip_sort, ipv6, ipv6_sort, mac, device_type, device_name, location, department, user_name, remark, status, registered_at, upper_switch, switch_port, sunlogin_id, gateway)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    vlan || null, data.ip || null, ipSort, ipv6, ipv6Sort, data.mac || null, data.device_type || null,
    data.device_name || null, data.location || null, data.department || null,
    data.user_name || null, data.remark || null, data.status || null,
    data.registered_at || new Date().toISOString().slice(0,10),
    data.upper_switch || null, data.switch_port || null,
    data.sunlogin_id || null, gateway
  );
  return getRecord(insertResult.lastInsertRowid);
}

function updateRecord(id, data) {
  checkStringFields(data);
  const existing = getRecord(id);
  if (!existing) return null;
  // H-1: undefined = 未提供（保留旧值）；显式 ''/null = 清空
  const pick = (field) => (data[field] !== undefined ? (data[field] || null) : existing[field]);
  if (data.mac !== undefined && data.mac !== null && String(data.mac).trim() !== '') data.mac = normalizeMac(data.mac);
  else if (data.mac !== undefined) data.mac = null;
  const nextIp = data.ip !== undefined ? (data.ip || null) : existing.ip;
  const nextVlanToken = data.vlan !== undefined ? data.vlan : existing.vlan;
  const isDynamic = isDynamicVlanToken(nextVlanToken);
  if (!isDynamic) {
    if (!nextIp || !String(nextIp).trim()) {
      throw new UserError('IP地址为必填项');
    }
    if (nextIp && !isValidIp(nextIp)) {
      throw new UserError('IP地址格式不合法');
    }
  } else if (nextIp && !isValidIp(nextIp)) {
    throw new UserError('IP地址格式不合法');
  }
  const gateway = data.gateway !== undefined ? (data.gateway || null) : (existing.gateway || (nextIp ? lookupGateway(nextIp) : null));
  const vlan = resolveVlanToken(nextVlanToken) || existing.vlan;
  const ipSort = nextIp ? ipToInt(nextIp) : null;
  const { ipv6, ipv6Sort } = normalizeRecordIpv6(
    { ipv6: data.ipv6 !== undefined ? data.ipv6 : existing.ipv6 },
    nextVlanToken
  );
  const mac = data.mac !== undefined ? data.mac : existing.mac;
  db.prepare(`
    UPDATE ip_records SET
      vlan=?, ip=?, ip_sort=?, ipv6=?, ipv6_sort=?, mac=?, device_type=?, device_name=?, location=?, department=?, user_name=?, remark=?, status=?, registered_at=?, upper_switch=?, switch_port=?, sunlogin_id=?, gateway=?, updated_at=datetime('now','localtime')
    WHERE id=?
  `).run(
    vlan, nextIp, ipSort, ipv6, ipv6Sort, mac, pick('device_type'),
    pick('device_name'), pick('location'), pick('department'),
    pick('user_name'), pick('remark'), pick('status'),
    data.registered_at !== undefined ? (data.registered_at || existing.registered_at) : existing.registered_at,
    pick('upper_switch'), pick('switch_port'),
    pick('sunlogin_id'), gateway, id
  );
  return getRecord(id);
}

function deleteRecord(id) {
  return db.prepare('DELETE FROM ip_records WHERE id = ?').run(id);
}

// --- 权限范围（scope）辅助：统计、字典等查询统一使用 ---
function buildScopeOrClause(scope, column = 'vlan') {
  if (!scope || scope.all) return { clause: '', params: [] };
  const parts = [];
  const params = [];
  const fullVlans = [...(scope.fullVlans || [])];
  const planIds = [...(scope.planIds || [])];
  if (!scope.fullVlans && !scope.planIds && scope.vlans && scope.vlans.length) {
    for (const tok of scope.vlans) {
      const m = String(tok).match(/^plan:(\d+)$/);
      if (m) planIds.push(Number(m[1]));
      else fullVlans.push(String(tok));
    }
  }
  if (fullVlans.length) {
    parts.push(`${column} IN (${fullVlans.map(() => '?').join(',')})`);
    params.push(...fullVlans);
  }
  for (const pid of planIds) {
    const plan = db.prepare('SELECT * FROM vlan_plans WHERE id = ?').get(pid);
    if (!plan) continue;
    if (plan.subnet) {
      const parsed = parseCidr(plan.subnet);
      if (parsed) {
        parts.push(`(${column} = ? AND ip_sort IS NOT NULL AND ip_sort >= ? AND ip_sort <= ?)`);
        params.push(plan.vlan, parsed.network, parsed.broadcast);
      } else {
        parts.push(`${column} = ?`);
        params.push(plan.vlan);
      }
    } else {
      parts.push(`${column} = ?`);
      params.push(plan.vlan);
    }
  }
  if (!parts.length) return { clause: ' AND 1 = 0', params: [] };
  return { clause: ' AND (' + parts.join(' OR ') + ')', params };
}

function scopeClause(scope, column = 'vlan') {
  return buildScopeOrClause(scope, column);
}

function planInScope(scope, plan) {
  if (!scope || scope.all) return true;
  if (!plan) return false;
  const fullVlans = scope.fullVlans || [];
  const planIds = scope.planIds || [];
  if (fullVlans.includes(String(plan.vlan))) return true;
  if (planIds.includes(Number(plan.id))) return true;
  return false;
}

/** 单条 IP 记录是否在管理员可读/可管范围内（网段级） */
function recordInScope(scope, record) {
  if (!scope || scope.all) return true;
  if (!record) return false;
  const fullVlans = scope.fullVlans || [];
  if (fullVlans.includes(String(record.vlan))) return true;
  const planIds = scope.planIds || [];
  for (const pid of planIds) {
    const plan = db.prepare('SELECT * FROM vlan_plans WHERE id = ?').get(pid);
    if (!plan || String(plan.vlan) !== String(record.vlan)) continue;
    if (plan.subnet) {
      const parsed = parseCidr(plan.subnet);
      if (parsed && record.ip_sort != null && record.ip_sort >= parsed.network && record.ip_sort <= parsed.broadcast) return true;
      // 无 ip_sort 时尝试用 IP 字符串
      if (parsed && record.ip && isValidIp(record.ip) && ipInCidr(record.ip, plan.subnet)) return true;
    } else if (!record.ip) {
      return true;
    }
  }
  return false;
}

function getDashboardStats(scope = null) {
  const w = scopeClause(scope);
  const count = (extraWhere = '1=1') => db.prepare(`SELECT COUNT(*) as cnt FROM ip_records WHERE ${extraWhere}${w.clause}`).get(...w.params).cnt;
  const total = count();
  const used = db.prepare(`SELECT COUNT(*) as cnt FROM ip_records WHERE status = ?${w.clause}`).get('已使用', ...w.params).cnt;
  const reserved = db.prepare(`SELECT COUNT(*) as cnt FROM ip_records WHERE status = ?${w.clause}`).get('预留/备用', ...w.params).cnt;
  const deprecated = db.prepare(`SELECT COUNT(*) as cnt FROM ip_records WHERE status = ?${w.clause}`).get('已废弃', ...w.params).cnt;
  const withMac = count("mac IS NOT NULL AND mac != ''");
  const withSunlogin = count("sunlogin_id IS NOT NULL AND sunlogin_id != ''");
  const dupIps = db.prepare(`SELECT COUNT(*) as cnt FROM (SELECT ip FROM ip_records WHERE ip IS NOT NULL AND ip != ''${w.clause} GROUP BY ip HAVING COUNT(*) > 1)`).get(...w.params).cnt;
  // 按规范化十六进制键统计存在冲突的 MAC 种类数
  const macRowsForKpi = db.prepare(`SELECT mac FROM ip_records WHERE mac IS NOT NULL AND trim(mac) != ''${w.clause}`).all(...w.params);
  const macCountMap = new Map();
  for (const r of macRowsForKpi) {
    const k = macKey(r.mac);
    if (!k) continue;
    macCountMap.set(k, (macCountMap.get(k) || 0) + 1);
  }
  const macConflictIps = [...macCountMap.values()].filter(c => c > 1).length;
  // 按「VLAN 规划」计数（同一 VLAN 编号多网段算多条），有登记记录的规划才计入
  let activeVlans = 0;
  const plansForKpi = db.prepare('SELECT * FROM vlan_plans').all().filter(p => planInScope(scope, p));
  for (const plan of plansForKpi) {
    let cnt = 0;
    if (plan.subnet) {
      const parsed = parseCidr(plan.subnet);
      if (parsed) {
        cnt = db.prepare('SELECT COUNT(*) as cnt FROM ip_records WHERE vlan = ? AND ip_sort IS NOT NULL AND ip_sort >= ? AND ip_sort <= ?').get(plan.vlan, parsed.network, parsed.broadcast).cnt;
      }
    } else {
      cnt = db.prepare("SELECT COUNT(*) as cnt FROM ip_records WHERE vlan = ? AND vlan IS NOT NULL AND vlan != ''").get(plan.vlan).cnt;
    }
    if (cnt > 0) activeVlans += 1;
  }

  return { total, used, reserved, deprecated, withMac, withSunlogin, dupIps, macConflictIps, activeVlans };
}

function getVlanStats(scope = null) {
  const plans = db.prepare('SELECT * FROM vlan_plans ORDER BY sort_order, id').all().filter(p => planInScope(scope, p));

  const result = [];

  for (const plan of plans) {
    const parsed = plan.subnet ? parseCidr(plan.subnet) : null;
    let cnt;
    if (parsed) {
      cnt = db.prepare('SELECT COUNT(*) as cnt FROM ip_records WHERE vlan = ? AND ip_sort >= ? AND ip_sort <= ?').get(plan.vlan, parsed.network, parsed.broadcast).cnt;
    } else {
      cnt = db.prepare('SELECT COUNT(*) as cnt FROM ip_records WHERE vlan = ?').get(plan.vlan).cnt;
    }
    result.push({
      vlan: plan.vlan,
      name: plan.name,
      subnet: plan.subnet,
      mask: plan.mask,
      gateway: plan.gateway,
      count: cnt,
      description: plan.description,
      address_pool_note: plan.address_pool_note,
    });
  }

  return result;
}

function getDepartmentStats(scope = null) {
  const w = scopeClause(scope);
  const rows = db.prepare(`
    SELECT department, COUNT(*) as cnt
    FROM ip_records WHERE department IS NOT NULL AND department != ''${w.clause}
    GROUP BY department ORDER BY cnt DESC
  `).all(...w.params);
  const total = rows.reduce((s, r) => s + r.cnt, 0);
  return rows.map(r => ({ ...r, percentage: total > 0 ? ((r.cnt / total) * 100).toFixed(1) : 0 }));
}

function getDeviceTypeStats(scope = null) {
  const w = scopeClause(scope);
  const rows = db.prepare(`
    SELECT device_type, COUNT(*) as cnt
    FROM ip_records WHERE device_type IS NOT NULL AND device_type != ''${w.clause}
    GROUP BY device_type ORDER BY cnt DESC
  `).all(...w.params);
  const total = rows.reduce((s, r) => s + r.cnt, 0);
  return rows.map(r => ({ ...r, percentage: total > 0 ? ((r.cnt / total) * 100).toFixed(1) : 0 }));
}

function getSubnetRecords(prefix, sort = 'ip', order = 'asc', vlan = null) {
  const validSorts = ['ip','ipv6','device_name','user_name','status','department','device_type','registered_at','updated_at'];
  let sortCol = validSorts.includes(sort) ? sort : 'ip';
  if (sortCol === 'ip') sortCol = 'ip_sort';
  if (sortCol === 'ipv6') sortCol = 'ipv6_sort';
  const sortDir = order.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const prefixParts = String(prefix).split('.').filter(Boolean);
  let rows;
  if (prefixParts.length === 3) {
    const baseInt = ipToInt(prefixParts.join('.') + '.0');
    if (baseInt !== null) {
      const bcastInt = (baseInt | 0x000000FF) >>> 0;
      if (vlan) {
        rows = db.prepare(`SELECT * FROM ip_records WHERE vlan = ? AND ip_sort >= ? AND ip_sort <= ? ORDER BY ${sortCol} ${sortDir}`).all(vlan, baseInt, bcastInt);
      } else {
        rows = db.prepare(`SELECT * FROM ip_records WHERE ip_sort >= ? AND ip_sort <= ? ORDER BY ${sortCol} ${sortDir}`).all(baseInt, bcastInt);
      }
    } else {
      rows = [];
    }
  } else {
    if (vlan) {
      rows = db.prepare(`SELECT * FROM ip_records WHERE vlan = ? AND ip LIKE ? ORDER BY ${sortCol} ${sortDir}`).all(vlan, `${prefix}.%`);
    } else {
      rows = db.prepare(`SELECT * FROM ip_records WHERE ip LIKE ? ORDER BY ${sortCol} ${sortDir}`).all(`${prefix}.%`);
    }
  }
  const dupSet = getDuplicateIpSet();
  const macConflictSet = getMacConflictMacSet();
  const dupIpv6Set = getDuplicateIpv6Set();
  rows.forEach(r => { r.is_duplicate = Boolean(r.ip) && dupSet.has(r.ip); r.is_mac_conflict = macConflictSet.has(macKey(r.mac)); r.is_duplicate_ipv6 = Boolean(r.ipv6_sort) && dupIpv6Set.has(r.ipv6_sort); });
  return rows;
}

function getSubnetRecordsByCidr(cidr, sort = 'ip', order = 'asc', vlan = null) {
  const validSorts = ['ip','ipv6','device_name','user_name','status','department','device_type','registered_at','updated_at'];
  let sortCol = validSorts.includes(sort) ? sort : 'ip';
  if (sortCol === 'ip') sortCol = 'ip_sort';
  if (sortCol === 'ipv6') sortCol = 'ipv6_sort';
  const sortDir = order.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const parsed = parseCidr(cidr);
  if (!parsed) return [];
  let rows;
  if (vlan) {
    rows = db.prepare(`SELECT * FROM ip_records WHERE vlan = ? AND ip_sort >= ? AND ip_sort <= ? ORDER BY ${sortCol} ${sortDir}`).all(vlan, parsed.network, parsed.broadcast);
  } else {
    rows = db.prepare(`SELECT * FROM ip_records WHERE ip_sort >= ? AND ip_sort <= ? ORDER BY ${sortCol} ${sortDir}`).all(parsed.network, parsed.broadcast);
  }
  const dupSet = getDuplicateIpSet();
  const macConflictSet = getMacConflictMacSet();
  const dupIpv6Set = getDuplicateIpv6Set();
  rows.forEach(r => { r.is_duplicate = Boolean(r.ip) && dupSet.has(r.ip); r.is_mac_conflict = macConflictSet.has(macKey(r.mac)); r.is_duplicate_ipv6 = Boolean(r.ipv6_sort) && dupIpv6Set.has(r.ipv6_sort); });
  return rows;
}

function getVlanRecords(vlan, sort = 'ip', order = 'asc') {
  const validSorts = ['ip','ipv6','device_name','user_name','status','department','device_type','registered_at','updated_at'];
  let sortCol = validSorts.includes(sort) ? sort : 'ip';
  if (sortCol === 'ip') sortCol = 'ip_sort';
  if (sortCol === 'ipv6') sortCol = 'ipv6_sort';
  const sortDir = order.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const rows = db.prepare(`SELECT * FROM ip_records WHERE vlan = ? ORDER BY ${sortCol} ${sortDir}`).all(vlan);
  const dupSet = getDuplicateIpSet();
  const macConflictSet = getMacConflictMacSet();
  const dupIpv6Set = getDuplicateIpv6Set();
  rows.forEach(r => { r.is_duplicate = Boolean(r.ip) && dupSet.has(r.ip); r.is_mac_conflict = macConflictSet.has(macKey(r.mac)); r.is_duplicate_ipv6 = Boolean(r.ipv6_sort) && dupIpv6Set.has(r.ipv6_sort); });
  return rows;
}

module.exports = {
  scopeClause, planInScope, recordInScope, buildScopeOrClause,
  lookupGateway, lookupVlanByIp, lookupPlanByIp, getDuplicateIpSet, getDuplicateIpv6Set, getMacConflictMacSet, normalizeMac, macKey, validateIpForVlan, isValidIp, isValidIpv6, isValidIpv6Cidr, ipv6InCidr, ipv6SortKey, ipToInt, parseCidr, ipInCidr, parsePoolRangeServer,
  listRecords, getRecord, createRecord, updateRecord, deleteRecord,
  getDashboardStats, getVlanStats, getDepartmentStats, getDeviceTypeStats,
  getSubnetRecords, getSubnetRecordsByCidr, getVlanRecords,
};
