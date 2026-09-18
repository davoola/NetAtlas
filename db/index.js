const Database = require('./wrapper');
const path = require('path');

const db = new Database(path.join(__dirname, 'ipam.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
