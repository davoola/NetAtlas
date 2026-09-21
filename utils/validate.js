const { UserError } = require('./errors');

// 字段长度上限（字符数）。仅在写入时校验，不影响既有数据的读取。
const RECORD_LIMITS = {
  vlan: 50, ip: 45, mac: 64, device_type: 100, device_name: 200, location: 200,
  department: 100, user_name: 100, remark: 1000, status: 50, registered_at: 32,
  upper_switch: 100, switch_port: 100, sunlogin_id: 100, gateway: 45,
};

const FIELD_LABELS = {
  vlan: 'VLAN', ip: 'IP地址', mac: 'MAC地址', device_type: '设备类型', device_name: '设备名称',
  location: '物理位置', department: '部门', user_name: '使用人', remark: '备注', status: '状态',
  registered_at: '登记日期', upper_switch: '上层交换机', switch_port: '交换机端口',
  sunlogin_id: '向日葵ID', gateway: '网关',
};

/** 校验字符串字段的类型与长度；值为 null/undefined/Date 时跳过。 */
function checkStringFields(data, limits = RECORD_LIMITS, labels = FIELD_LABELS) {
  for (const [field, max] of Object.entries(limits)) {
    const v = data[field];
    if (v === undefined || v === null || v instanceof Date) continue;
    if (typeof v === 'object' || typeof v === 'function') {
      throw new UserError(`${labels[field] || field}格式不正确`);
    }
    if (String(v).length > max) {
      throw new UserError(`${labels[field] || field}过长（最多 ${max} 个字符）`);
    }
  }
}

function limitedName(v, label, max = 100) {
  if (v === undefined || v === null || !String(v).trim()) throw new UserError(`${label}为必填项`);
  if (typeof v === 'object') throw new UserError(`${label}格式不正确`);
  if (String(v).trim().length > max) throw new UserError(`${label}过长（最多 ${max} 个字符）`);
  return String(v).trim();
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

module.exports = { RECORD_LIMITS, checkStringFields, limitedName, clampInt };
