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

  // Integrity quick check
  db.get("PRAGMA quick_check;", (err, row) => {
    if (err || (row && row.quick_check !== 'ok')) {
      console.warn('[DB] ⚠️ Database integrity issue detected:', err ? err.message : row?.quick_check);
    }
  });

  // Hourly WAL checkpoint to keep DB size lean and prevent file bloat
  setInterval(() => {
    db.run("PRAGMA wal_checkpoint(TRUNCATE);", () => {});
  }, 3600000).unref();

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

  // Migration: ensure realtime_watch column exists in tasks
  db.run("ALTER TABLE tasks ADD COLUMN realtime_watch INTEGER DEFAULT 0", (err) => {});

  // Migration: ensure encrypt_backup column exists in tasks
  db.run("ALTER TABLE tasks ADD COLUMN encrypt_backup INTEGER DEFAULT 0", (err) => {});

  // Migration: ensure bundle_archive column exists in tasks (automated local zip before upload)
  db.run("ALTER TABLE tasks ADD COLUMN bundle_archive INTEGER DEFAULT 0", (err) => {});

  // Migration: ensure smart_code_filter column exists in tasks (auto-exclude node_modules & build caches)
  db.run("ALTER TABLE tasks ADD COLUMN smart_code_filter INTEGER DEFAULT 1", (err) => {});

  // Migration: ensure created_at exists in logs and tasks
  db.run("ALTER TABLE logs ADD COLUMN created_at DATETIME", (err) => {});
  db.run("ALTER TABLE tasks ADD COLUMN created_at DATETIME", (err) => {});

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
      tags TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: ensure tags column exists in sources if created earlier
  db.run("ALTER TABLE sources ADD COLUMN tags TEXT DEFAULT ''", (err) => {});

  // Failed / Skipped files tracking table (for fault-tolerant continuation & targeted retries)
  db.run(`
    CREATE TABLE IF NOT EXISTS failed_files (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_name TEXT,
      log_id TEXT,
      file_path TEXT NOT NULL,
      error_reason TEXT,
      source_path TEXT,
      target_remote TEXT,
      target_path TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME
    )
  `);
  // Linked Devices (for tablet / mobile device linking via code)
  db.run(`
    CREATE TABLE IF NOT EXISTS linked_devices (
      id TEXT PRIMARY KEY,
      device_name TEXT NOT NULL,
      platform TEXT DEFAULT 'unknown',
      ip_address TEXT DEFAULT '',
      token TEXT UNIQUE NOT NULL,
      linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_active DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_linked_devices_token ON linked_devices(token);");
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
  },

  /**
   * Fully checkpoint and truncate SQLite WAL to ensure 100% data persistence to disk
   */
  flushWalCheckpoint() {
    return new Promise((resolve) => {
      db.run("PRAGMA wal_checkpoint(FULL);", (err) => {
        if (err) {
          console.warn('[DB] WAL checkpoint notice:', err.message);
        } else {
          console.log('[DB] 💾 Database WAL fully checkpointed to disk.');
        }
        resolve(true);
      });
    });
  },

  /**
   * Fast in-memory / query helper to map container paths to native host paths
   */
  async getSourcePathMap() {
    try {
      const rows = await this.all('SELECT container_path, host_path, name FROM sources');
      const map = {};
      for (const r of rows) {
        if (r.container_path && r.host_path) {
          map[r.container_path.trim()] = r.host_path.trim();
        }
      }
      return map;
    } catch (e) {
      return {};
    }
  },

  dbInstance: db,
  DB_PATH,
  CONFIG_DIR
};

// Automatic cleanup & WAL flush on process termination
const cleanupOnExit = () => {
  try {
    db.run("PRAGMA wal_checkpoint(FULL);", () => {});
  } catch (e) {}
};

process.on('SIGINT', cleanupOnExit);
process.on('SIGTERM', cleanupOnExit);
process.on('beforeExit', cleanupOnExit);

module.exports = dbHelper;
