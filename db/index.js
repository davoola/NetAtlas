const Database = require('./wrapper');
const path = require('path');

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'ipam.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Keep the running database schema compatible with newer application fields.
// This is intentionally limited to additive, idempotent migrations so startup
// never deletes or rewrites existing inventory data.
try {
  db.prepare('SELECT is_dynamic FROM vlan_plans LIMIT 1').get();
} catch (error) {
  if (String(error.message).includes('no such column')) {
    db.exec('ALTER TABLE vlan_plans ADD COLUMN is_dynamic INTEGER NOT NULL DEFAULT 0');
  } else {
    throw error;
  }
}
try {
  db.prepare('SELECT must_change_password FROM users LIMIT 1').get();
} catch (error) {
  if (String(error.message).includes('no such column')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  } else {
    throw error;
  }
}
db.exec('CREATE INDEX IF NOT EXISTS idx_ip_records_mac ON ip_records(mac)');
db.exec('CREATE INDEX IF NOT EXISTS idx_ip_records_vlan_sort ON ip_records(vlan, ip_sort)');
db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at, id)');


// 历史裸 VLAN 编号授权 → 展开为当前该编号下全部 plan:ID（幂等；新建规划不再自动获得）
try {
  const bare = db.prepare("SELECT id, user_id, vlan FROM admin_vlan_permissions WHERE vlan NOT LIKE 'plan:%'").all();
  if (bare.length) {
    const insert = db.prepare('INSERT OR IGNORE INTO admin_vlan_permissions (user_id, vlan) VALUES (?, ?)');
    const del = db.prepare('DELETE FROM admin_vlan_permissions WHERE id = ?');
    const plansByVlan = db.prepare('SELECT id FROM vlan_plans WHERE vlan = ?');
    // 本项目 db.transaction(fn) 会立即执行回调并提交，不返回可调用函数
    db.transaction(() => {
      for (const b of bare) {
        for (const p of plansByVlan.all(String(b.vlan))) {
          insert.run(b.user_id, 'plan:' + p.id);
        }
        del.run(b.id);
      }
    });
    console.log('[migrate] 已将 ' + bare.length + ' 条裸 VLAN 授权展开为 plan:ID');
  }
} catch (e) {
  if (!String(e.message).includes('no such table')) {
    console.warn('[migrate] 裸 VLAN 授权迁移跳过:', e.message);
  }
}

module.exports = db;
