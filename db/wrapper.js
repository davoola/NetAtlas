const { DatabaseSync } = require('node:sqlite');

class Database {
  constructor(dbPath) {
    this._db = new DatabaseSync(dbPath);
  }

  exec(sql) {
    this._db.exec(sql);
  }

  prepare(sql) {
    return this._db.prepare(sql);
  }

  pragma(str) {
    this._db.exec('PRAGMA ' + str);
  }

  close() {
    this._db.close();
  }
}

module.exports = Database;
