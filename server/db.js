const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const CONFIG_DIR = process.env.CONFIG_DIR || path.join(__dirname, '../config');
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

const DB_PATH = path.join(CONFIG_DIR, 'autobackup.db');
const db = new sqlite3.Database(DB_PATH);

// Initialize DB schema & performance PRAGMAs
db.serialize(() => {
  // Performance optimizations
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA busy_timeout = 5000;");
  db.run("PRAGMA cache_size = -64000;"); // 64MB memory cache
  db.run("PRAGMA temp_store = MEMORY;");

  // Remotes table
  db.run(`
    CREATE TABLE IF NOT EXISTS remotes (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      config TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Backup tasks table
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_path TEXT NOT NULL,
      target_remote TEXT NOT NULL,
      target_path TEXT NOT NULL,
      mode TEXT DEFAULT 'copy',
      cron_schedule TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      conflict_mode TEXT DEFAULT 'smart',
      last_run DATETIME,
      next_run DATETIME,
      last_status TEXT DEFAULT 'idle',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: ensure conflict_mode column exists in tasks if created earlier
  db.run("ALTER TABLE tasks ADD COLUMN conflict_mode TEXT DEFAULT 'smart'", (err) => {});

  // Migration: ensure priority column exists in tasks if created earlier
  db.run("ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT 'normal'", (err) => {});

  // Migration: ensure bw_limit column exists in tasks if created earlier
  db.run("ALTER TABLE tasks ADD COLUMN bw_limit TEXT DEFAULT ''", (err) => {});

  // Settings table for storing Discord webhook URL and global config
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Backup execution logs
  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_name TEXT NOT NULL,
      start_time DATETIME NOT NULL,
      end_time DATETIME,
      status TEXT NOT NULL,
      bytes_transferred TEXT DEFAULT '0 B',
      files_transferred INTEGER DEFAULT 0,
      output TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Indexes for high-speed queries on large datasets
  db.run("CREATE INDEX IF NOT EXISTS idx_logs_task_id ON logs(task_id);");
  db.run("CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC);");
  db.run("CREATE INDEX IF NOT EXISTS idx_tasks_enabled ON tasks(enabled);");
  db.run("CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks(next_run);");

  // User-defined source folders (persisted across container restarts, no docker-compose edit needed)
  db.run(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host_path TEXT NOT NULL,
      container_path TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Database helper functions using Promises
const dbHelper = {
  all(query, params = []) {
    return new Promise((resolve, reject) => {
      db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  },

  get(query, params = []) {
    return new Promise((resolve, reject) => {
      db.get(query, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },

  run(query, params = []) {
    return new Promise((resolve, reject) => {
      db.run(query, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }
};

module.exports = dbHelper;
