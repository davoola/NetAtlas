// ---可导入测试字典数据---

try { process.loadEnvFile(); } catch (e) { /* .env 不存在时忽略 */ }
const Database = require('./wrapper');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } = require('../config/password');
const { DEFAULT_SITE_NAME } = require('../config/site');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'ipam.db');

function initDatabase() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // --- Users ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('superadmin','admin','viewer')),
      display_name TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);

  // --- Admin VLAN permissions ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_vlan_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      vlan TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, vlan)
    );
  `);

  // --- Dictionary: device types ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS dict_device_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);

  // --- Dictionary: statuses ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS dict_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);

  // --- Dictionary: departments ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS dict_departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);

  // --- VLAN plans ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS vlan_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vlan TEXT NOT NULL,
      name TEXT,
      subnet TEXT,
      mask TEXT,
      gateway TEXT,
      description TEXT,
      address_pool_note TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);

  // --- IP prefix to gateway mapping ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS ip_prefix_gateways (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prefix TEXT UNIQUE NOT NULL,
      gateway TEXT NOT NULL,
      default_vlan TEXT
    );
  `);

  // --- IP records (main table) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS ip_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vlan TEXT,
      ip TEXT,
      ip_sort INTEGER,
      mac TEXT,
      device_type TEXT,
      device_name TEXT,
      location TEXT,
      department TEXT,
      user_name TEXT,
      remark TEXT,
      status TEXT,
      registered_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      upper_switch TEXT,
      switch_port TEXT,
      sunlogin_id TEXT,
      gateway TEXT
    );
  `);

  // Normalize legacy Excel serial dates that may have been imported as plain numbers.
  const legacyDateRows = db.prepare("SELECT id, registered_at FROM ip_records WHERE registered_at GLOB '[0-9]*.[0-9]*'").all();
  const updateLegacyDate = db.prepare('UPDATE ip_records SET registered_at = ? WHERE id = ?');
  for (const row of legacyDateRows) {
    const serial = Number(row.registered_at);
    if (Number.isFinite(serial) && serial > 0 && serial < 100000) {
      const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      if (!Number.isNaN(date.getTime())) updateLegacyDate.run(date.toISOString().slice(0, 10), row.id);
    }
  }

  // Migration: add ip_sort column if missing (safe for existing DBs)
  try {
    db.prepare("SELECT ip_sort FROM ip_records LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE ip_records ADD COLUMN ip_sort INTEGER");
  }
  // Backfill ip_sort for existing rows using JS
  const rowsToBackfill = db.prepare("SELECT id, ip FROM ip_records WHERE ip_sort IS NULL AND ip IS NOT NULL AND ip != ''").all();
  if (rowsToBackfill.length > 0) {
    const updateStmt = db.prepare("UPDATE ip_records SET ip_sort = ? WHERE id = ?");
    for (const row of rowsToBackfill) {
      const parts = row.ip.split('.');
      if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
        const [a, b, c, d] = parts.map(Number);
        if (a <= 255 && b <= 255 && c <= 255 && d <= 255) {
          updateStmt.run(((a << 24) >>> 0) + (b << 16) + (c << 8) + d, row.id);
        }
      }
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ip_records_ip ON ip_records(ip);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ip_records_ip_sort ON ip_records(ip_sort);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ip_records_vlan ON ip_records(vlan);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ip_records_status ON ip_records(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ip_records_department ON ip_records(department);`);

  // Migration: add is_dynamic column to vlan_plans if missing
  try {
    db.prepare("SELECT is_dynamic FROM vlan_plans LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE vlan_plans ADD COLUMN is_dynamic INTEGER DEFAULT 0");
  }

  // Unique constraint for vlan_plans (vlan + subnet)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vlan_plan_unique ON vlan_plans(vlan, subnet);`);

  // --- System settings ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // --- Audit log ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT,
      detail TEXT,
      target_type TEXT,
      target_id INTEGER,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);

  // Migration: add columns if missing (safe for existing DBs)
  try {
    db.prepare("SELECT target_type FROM audit_log LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE audit_log ADD COLUMN target_type TEXT");
  }
  try {
    db.prepare("SELECT target_id FROM audit_log LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE audit_log ADD COLUMN target_id INTEGER");
  }
  try {
    db.prepare("SELECT ip_address FROM audit_log LIMIT 1").get();
  } catch (e) {
    db.exec("ALTER TABLE audit_log ADD COLUMN ip_address TEXT");
  }

  // Migration: users.must_change_password (safe for existing DBs)
  try {
    db.prepare('SELECT must_change_password FROM users LIMIT 1').get();
  } catch (e) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  }

  // --- Seed: initial superadmin (no fixed default password) ---
  let generatedPassword = null;
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
  if (existing.cnt === 0) {
    const envPassword = process.env.ADMIN_INITIAL_PASSWORD;
    let password;
    let mustChange = 0;
    if (envPassword) {
      if (envPassword.length < PASSWORD_MIN_LENGTH || envPassword.length > PASSWORD_MAX_LENGTH || envPassword === 'admin123') {
        console.error(`错误: ADMIN_INITIAL_PASSWORD 长度必须为 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位，且不能是 admin123 等已知弱口令。init-db 已中止。`);
        db.close();
        process.exit(1);
      }
      password = envPassword;
    } else {
      // 随机一次性初始密码，首次登录强制修改
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
      password = Array.from(crypto.randomBytes(16), b => alphabet[b % alphabet.length]).join('');
      generatedPassword = password;
      mustChange = 1;
    }
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`INSERT INTO users (username, password_hash, role, display_name, must_change_password) VALUES (?,?,?,?,?)`).run('admin', hash, 'superadmin', '超级管理员', mustChange);
  }
  
  // --- Seed: statuses ---
  db.prepare("UPDATE ip_records SET status = '已使用' WHERE status = 'DHCP动态'").run();
  db.prepare("DELETE FROM dict_statuses WHERE name = 'DHCP动态'").run();
  const statusSeed = [
    ['已使用', 'IP地址已分配给具体设备使用', 1],
    ['预留/备用', 'IP地址保留，暂未分配但已规划用途', 2],
    ['已废弃', 'IP地址不再使用，待回收', 3],
  ];
  const stStmt = db.prepare('INSERT OR IGNORE INTO dict_statuses (name, description, sort_order) VALUES (?,?,?)');
  statusSeed.forEach(s => stStmt.run(s[0], s[1], s[2]));

  // --- Seed: device types ---
  const deviceTypeSeed = [
    ['核心IT与网络基础设备', '服务器、交换机、路由器、防火墙等核心网络与IT基础设施', 1],
    ['办公与会议终端外设', '办公电脑、打印机、会议室终端、检索查询机等终端设备', 2],
    ['安防监控与通道管理', '安防监控摄像头、门禁闸机、存包柜等安防与通道管理设备', 3],
  ];
  const dtStmt = db.prepare('INSERT OR IGNORE INTO dict_device_types (name, description, sort_order) VALUES (?,?,?)');
  deviceTypeSeed.forEach(s => dtStmt.run(s[0], s[1], s[2]));

  // --- Seed: departments ---
  const deptSeed = ['清云宗','天剑宗','魔界'];
  const depStmt = db.prepare('INSERT OR IGNORE INTO dict_departments (name, sort_order) VALUES (?,?)');
  deptSeed.forEach((n, i) => depStmt.run(n, i));

  // --- Seed: VLAN plans ---
  db.prepare("DELETE FROM vlan_plans WHERE vlan = 'DHCP'").run();
  db.prepare("UPDATE ip_records SET vlan = NULL WHERE vlan = 'DHCP'").run();
  const existingPlans = db.prepare('SELECT COUNT(*) as cnt FROM vlan_plans').get();
  if (existingPlans.cnt === 0) {
  const vlanPlans = [
    ['10','10.10.10.0/24','清云宗内网','255.255.255.0','10.10.10.1','清云宗核心网络',null,1],
    ['20','172.20.20.0/24','天剑宗内网','255.255.255.0','172.20.20.1','天剑宗核心网络',null,2],
    ['30','192.168.30.0/24','魔界内网','255.255.255.0','192.168.30.1','魔界核心网络',null,3],
    ['99','10.99.99.0/24','公共网段','255.255.255.0','10.99.99.1','三宗共用公共网段','可用池 .10–.200',4],
  ];
  const vpStmt = db.prepare(`INSERT INTO vlan_plans (vlan, subnet, name, mask, gateway, description, address_pool_note, sort_order) VALUES (?,?,?,?,?,?,?,?)`);
  vlanPlans.forEach(v => vpStmt.run(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]));
  }

  // --- Seed: IP prefix gateways ---
  const prefixGateways = [
    ['10.10.10','10.10.10.1','10'],
    ['172.20.20','172.20.20.1','20'],
    ['192.168.30','192.168.30.1','30'],
    ['10.99.99','10.99.99.1','99'],
  ];
  const pgStmt = db.prepare('INSERT OR IGNORE INTO ip_prefix_gateways (prefix, gateway, default_vlan) VALUES (?,?,?)');
  prefixGateways.forEach(g => pgStmt.run(g[0], g[1], g[2]));

  // --- Seed: system settings ---
  const ssStmt = db.prepare('INSERT OR IGNORE INTO system_settings (key, value) VALUES (?,?)');
  ssStmt.run('site_name', DEFAULT_SITE_NAME);

  db.close();
  console.log('Database initialized successfully at:', DB_PATH);
  if (generatedPassword) {
    console.log('已创建初始超级管理员：username=admin');
    console.log('一次性初始密码（仅显示这一次，请立即记录；首次登录将强制修改）：' + generatedPassword);
  } else if (existing.cnt === 0) {
    console.log('已使用 ADMIN_INITIAL_PASSWORD 创建初始超级管理员：username=admin');
  }
  console.log('Note: dictionary / VLAN / gateway tables are empty — configure them in the UI.');
}

initDatabase();