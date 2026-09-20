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

  transaction(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('transaction callback must be a function');
    }

    this._db.exec('BEGIN');
    try {
      const result = callback();
      this._db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this._db.exec('ROLLBACK');
      } catch {
        // Preserve the original database error if rollback also fails.
      }
      throw error;
    }
  }

  close() {
    this._db.close();
  }
}

module.exports = Database;
