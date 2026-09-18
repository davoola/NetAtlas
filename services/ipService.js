const db = require('../db');

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isValidIp(ip) {
  return IPV4_RE.test(String(ip || ''));
}

function ipToInt(ip) {
  if (!isValidIp(ip)) return null;
  const [a, b, c, d] = ip.split('.').map(Number);
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

function lookupGateway(ip) {
  if (!ip) return null;
  const parts = ip.split('.');
  if (parts.length < 3) return null;
  const prefix = parts.slice(0, 3).join('.');
  const row = db.prepare('SELECT gateway FROM ip_prefix_gateways WHERE prefix = ?').get(prefix);
  return row ? row.gateway : null;
}

function lookupVlanByIp(ip) {
  if (!ip) return null;
  const parts = ip.split('.');
  if (parts.length < 3) return null;
  const prefix = parts.slice(0, 3).join('.');
  const row = db.prepare('SELECT default_vlan FROM ip_prefix_gateways WHERE prefix = ?').get(prefix);
  return row ? row.default_vlan : null;
}

function getDuplicateIpSet() {
  const rows = db.prepare(`
    SELECT ip FROM ip_records WHERE ip IS NOT NULL AND ip != ''
    GROUP BY ip HAVING COUNT(*) > 1
  `).all();
  return new Set(rows.map(r => r.ip));
}

function getMacConflictMacSet() {
  const rows = db.prepare(`
    SELECT mac FROM ip_records WHERE mac IS NOT NULL AND mac != ''
    GROUP BY mac HAVING COUNT(DISTINCT ip) > 1
  `).all();
  return new Set(rows.map(r => r.mac));
}

function listRecords({ page = 1, perPage = 20, search = '', vlan = '', department = '', status = '', deviceType = '', sort = 'updated_at', order = 'desc', scope = null, onlyDuplicate = '', onlyMacConflict = '' }) {
  const offset = (page - 1) * perPage;
  const where = [];
  const params = [];

  if (search) {
    where.push('(ip LIKE ? OR device_name LIKE ? OR user_name LIKE ? OR mac LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (vlan) {
    const planMatch = String(vlan).match(/^plan:(\d+)$/);
    if (planMatch) {
      const plan = db.prepare('SELECT vlan, subnet FROM vlan_plans WHERE id = ?').get(Number(planMatch[1]));
      if (plan) {
        where.push('vlan = ?'); params.push(plan.vlan);
        const prefix = plan.subnet ? plan.subnet.split('/')[0].split('.').slice(0, 3).join('.') : '';
        if (prefix) { where.push('ip LIKE ?'); params.push(`${prefix}.%`); }
      }
    } else {
      where.push('vlan = ?'); params.push(vlan);
    }
  }
  if (department) { where.push('department = ?'); params.push(department); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (deviceType) { where.push('device_type = ?'); params.push(deviceType); }
  if (scope && !scope.all) {
    if (scope.vlans.length === 0) {
      where.push('1 = 0');
    } else {
      const placeholders = scope.vlans.map(() => '?').join(',');
      where.push(`vlan IN (${placeholders})`);
      params.push(...scope.vlans);
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
  if (onlyMacConflict === '1') {
    const conflictMacs = [...getMacConflictMacSet()];
    if (conflictMacs.length === 0) {
      where.push('1 = 0');
    } else {
      const placeholders = conflictMacs.map(() => '?').join(',');
      where.push(`mac IN (${placeholders})`);
      params.push(...conflictMacs);
    }
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const validSorts = ['ip','device_name','user_name','updated_at','registered_at','vlan','status','department','device_type'];
  let sortCol = validSorts.includes(sort) ? sort : 'updated_at';
  if (sortCol === 'ip') sortCol = 'ip_sort';
  const sortDir = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM ip_records ${whereClause}`).get(...params).cnt;
  const rows = db.prepare(`
    SELECT * FROM ip_records ${whereClause}
    ORDER BY ${sortCol} ${sortDir}
    LIMIT ? OFFSET ?
  `).all(...params, perPage, offset);

  const dupSet = getDuplicateIpSet();
  const macConflictSet = getMacConflictMacSet();
  rows.forEach(r => { r.is_duplicate = dupSet.has(r.ip); r.is_mac_conflict = macConflictSet.has(r.mac); });

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

function parsePoolRangeServer(plan) {
  let rangeStart = 1, rangeEnd = 254;
  if (plan && plan.address_pool_note) {
    const m = plan.address_pool_note.match(/\.?(\d{1,3})\s*[-–~至到]\s*\.?(\d{1,3})/);
    if (m) { rangeStart = parseInt(m[1], 10); rangeEnd = parseInt(m[2], 10); }
  }
  return { rangeStart, rangeEnd };
}

function validateIpForVlan(ip, vlanToken) {
  if (!ip || !vlanToken) return null;
  const plan = getPlanForVlanToken(vlanToken);
  if (plan && plan.subnet) {
    const prefix = plan.subnet.split('/')[0].split('.').slice(0, 3).join('.');
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip)) || !String(ip).startsWith(prefix + '.')) {
      throw new Error(`IP地址必须属于所选VLAN网段（${prefix}.x）`);
    }
    const { rangeStart, rangeEnd } = parsePoolRangeServer(plan);
    const host = parseInt(String(ip).split('.')[3], 10);
    const gatewayHost = plan.gateway && plan.gateway !== '-' ? parseInt(String(plan.gateway).split('.')[3], 10) : null;
    if (host !== gatewayHost && (host < rangeStart || host > rangeEnd)) {
      throw new Error(`IP地址超出该VLAN可用池范围（${prefix}.${rangeStart}-${rangeEnd}）`);
    }
    return plan;
  }
  const plans = db.prepare('SELECT * FROM vlan_plans WHERE vlan = ?').all(String(vlanToken));
  if (plans.length > 0) {
    const matched = plans.find(candidate => {
      if (!candidate.subnet) return false;
      const prefix = candidate.subnet.split('/')[0].split('.').slice(0, 3).join('.');
      return String(ip).startsWith(prefix + '.');
    });
    if (!matched) throw new Error('IP地址与所选VLAN的子网不一致');
    const { rangeStart, rangeEnd } = parsePoolRangeServer(matched);
    const host = parseInt(String(ip).split('.')[3], 10);
    const gatewayHost = matched.gateway && matched.gateway !== '-' ? parseInt(String(matched.gateway).split('.')[3], 10) : null;
    if (host !== gatewayHost && (host < rangeStart || host > rangeEnd)) {
      const prefix = matched.subnet.split('/')[0].split('.').slice(0, 3).join('.');
      throw new Error(`IP地址超出该VLAN可用池范围（${prefix}.${rangeStart}-${rangeEnd}）`);
    }
    return matched;
  }
  return null;
}

function createRecord(data) {
  if (!data.ip || !String(data.ip).trim()) {
    throw new Error('IP地址为必填项');
  }
  if (data.ip && !isValidIp(data.ip)) {
    throw new Error('IP地址格式不合法');
  }
  const gateway = data.gateway || lookupGateway(data.ip);
  const vlan = resolveVlanToken(data.vlan) || lookupVlanByIp(data.ip);
  const ipSort = ipToInt(data.ip);
  db.prepare(`
    INSERT INTO ip_records (vlan, ip, ip_sort, mac, device_type, device_name, location, department, user_name, remark, status, registered_at, upper_switch, switch_port, sunlogin_id, gateway)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    vlan || null, data.ip || null, ipSort, data.mac || null, data.device_type || null,
    data.device_name || null, data.location || null, data.department || null,
    data.user_name || null, data.remark || null, data.status || null,
    data.registered_at || new Date().toISOString().slice(0,10),
    data.upper_switch || null, data.switch_port || null,
    data.sunlogin_id || null, gateway
  );
  return db.prepare('SELECT * FROM ip_records ORDER BY id DESC LIMIT 1').get();
}

function updateRecord(id, data) {
  const existing = getRecord(id);
  if (!existing) return null;
  if (!data.ip || !String(data.ip).trim()) {
    throw new Error('IP地址为必填项');
  }
  if (data.ip && !isValidIp(data.ip)) {
    throw new Error('IP地址格式不合法');
  }
  const gateway = data.gateway !== undefined ? data.gateway : lookupGateway(data.ip);
  const vlan = resolveVlanToken(data.vlan) || existing.vlan;
  const ipSort = ipToInt(data.ip || existing.ip);
  db.prepare(`
    UPDATE ip_records SET
      vlan=?, ip=?, ip_sort=?, mac=?, device_type=?, device_name=?, location=?, department=?, user_name=?, remark=?, status=?, registered_at=?, upper_switch=?, switch_port=?, sunlogin_id=?, gateway=?, updated_at=datetime('now','localtime')
    WHERE id=?
  `).run(
    vlan, data.ip || null, ipSort, data.mac || null, data.device_type || null,
    data.device_name || null, data.location || null, data.department || null,
    data.user_name || null, data.remark || null, data.status || null,
    data.registered_at || existing.registered_at,
    data.upper_switch || null, data.switch_port || null,
    data.sunlogin_id || null, gateway, id
  );
  return getRecord(id);
}

function deleteRecord(id) {
  return db.prepare('DELETE FROM ip_records WHERE id = ?').run(id);
}

function getDashboardStats() {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM ip_records').get().cnt;
  const used = db.prepare("SELECT COUNT(*) as cnt FROM ip_records WHERE status = '已使用'").get().cnt;
  const reserved = db.prepare("SELECT COUNT(*) as cnt FROM ip_records WHERE status = '预留/备用'").get().cnt;
  const deprecated = db.prepare("SELECT COUNT(*) as cnt FROM ip_records WHERE status = '已废弃'").get().cnt;
  const withMac = db.prepare("SELECT COUNT(*) as cnt FROM ip_records WHERE mac IS NOT NULL AND mac != ''").get().cnt;
  const withSunlogin = db.prepare("SELECT COUNT(*) as cnt FROM ip_records WHERE sunlogin_id IS NOT NULL AND sunlogin_id != ''").get().cnt;
  const dupIps = db.prepare("SELECT COUNT(*) as cnt FROM (SELECT ip FROM ip_records WHERE ip IS NOT NULL AND ip != '' GROUP BY ip HAVING COUNT(*) > 1)").get().cnt;
  const macConflictIps = db.prepare("SELECT COUNT(*) as cnt FROM (SELECT mac FROM ip_records WHERE mac IS NOT NULL AND mac != '' GROUP BY mac HAVING COUNT(DISTINCT ip) > 1)").get().cnt;
  const activeVlans = db.prepare("SELECT COUNT(DISTINCT vlan) as cnt FROM ip_records WHERE vlan IS NOT NULL AND vlan != ''").get().cnt;

  return { total, used, reserved, deprecated, withMac, withSunlogin, dupIps, macConflictIps, activeVlans };
}

function getVlanStats() {
  const plans = db.prepare('SELECT * FROM vlan_plans ORDER BY sort_order, id').all();

  const result = [];

  for (const plan of plans) {
    const prefix = plan.subnet ? plan.subnet.split('/')[0].split('.').slice(0, 3).join('.') : '';
    let cnt;
    if (prefix) {
      cnt = db.prepare('SELECT COUNT(*) as cnt FROM ip_records WHERE vlan = ? AND ip LIKE ?').get(plan.vlan, `${prefix}.%`).cnt;
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

function getDepartmentStats() {
  const rows = db.prepare(`
    SELECT department, COUNT(*) as cnt
    FROM ip_records WHERE department IS NOT NULL AND department != ''
    GROUP BY department ORDER BY cnt DESC
  `).all();
  const total = rows.reduce((s, r) => s + r.cnt, 0);
  return rows.map(r => ({ ...r, percentage: total > 0 ? ((r.cnt / total) * 100).toFixed(1) : 0 }));
}

function getDeviceTypeStats() {
  const rows = db.prepare(`
    SELECT device_type, COUNT(*) as cnt
    FROM ip_records WHERE device_type IS NOT NULL AND device_type != ''
    GROUP BY device_type ORDER BY cnt DESC
  `).all();
  const total = rows.reduce((s, r) => s + r.cnt, 0);
  return rows.map(r => ({ ...r, percentage: total > 0 ? ((r.cnt / total) * 100).toFixed(1) : 0 }));
}

function getSubnetRecords(prefix, sort = 'ip', order = 'asc') {
  const likePattern = prefix + '.%';
  const validSorts = ['ip','device_name','user_name','status','department','device_type','registered_at','updated_at'];
  let sortCol = validSorts.includes(sort) ? sort : 'ip';
  if (sortCol === 'ip') sortCol = 'ip_sort';
  const sortDir = order.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const rows = db.prepare(`
    SELECT * FROM ip_records WHERE ip LIKE ?
    ORDER BY ${sortCol} ${sortDir}
  `).all(likePattern);
  const dupSet = getDuplicateIpSet();
  const macConflictSet = getMacConflictMacSet();
  rows.forEach(r => { r.is_duplicate = dupSet.has(r.ip); r.is_mac_conflict = macConflictSet.has(r.mac); });
  return rows;
}

module.exports = {
  lookupGateway, lookupVlanByIp, getDuplicateIpSet, getMacConflictMacSet, validateIpForVlan, isValidIp, ipToInt, parsePoolRangeServer,
  listRecords, getRecord, createRecord, updateRecord, deleteRecord,
  getDashboardStats, getVlanStats, getDepartmentStats, getDeviceTypeStats,
  getSubnetRecords,
};
