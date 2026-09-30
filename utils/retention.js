/**
 * 审计日志最短保留天数（环境变量 AUDIT_LOG_RETENTION_DAYS）。
 * 仅接受 1–3650 的纯整数字符串；未配置或非法写法（如 1e3、30days、45.9）回退为 90。
 * 本模块不依赖数据库，可供服务层与单元测试共用。
 */
function getAuditLogRetentionDays() {
  const raw = String(process.env.AUDIT_LOG_RETENTION_DAYS ?? '').trim();
  if (!/^\d{1,4}$/.test(raw)) return 90;
  const n = Number(raw);
  return n >= 1 && n <= 3650 ? n : 90;
}

module.exports = { getAuditLogRetentionDays };
