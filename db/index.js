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

module.exports = db;
