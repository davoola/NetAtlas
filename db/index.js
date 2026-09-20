const Database = require('./wrapper');
const path = require('path');

const db = new Database(path.join(__dirname, 'ipam.db'));
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
db.exec('CREATE INDEX IF NOT EXISTS idx_ip_records_mac ON ip_records(mac)');

module.exports = db;
