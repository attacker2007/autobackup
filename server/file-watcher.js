const fs = require('fs');
const path = require('path');

class FileWatcherService {
  constructor() {
    this.watchers = new Map(); // taskId -> { watchers: [], timer: null, task: null }
    this.onTriggerCallback = null;
    this.broadcastCallback = null;
    this.debounceMs = 5000; // 5s debounce window for write stabilization
  }

  setTriggerCallback(fn) {
    this.onTriggerCallback = fn;
  }

  setBroadcastCallback(fn) {
    this.broadcastCallback = fn;
  }

  /**
   * Helper to parse source_path string or array
   */
  parseSourcePaths(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input;
    const str = String(input).trim();
    if (!str) return [];
    if (str.startsWith('[')) {
      try {
        const arr = JSON.parse(str);
        if (Array.isArray(arr)) return arr;
      } catch (e) {}
    }
    if (str.includes(',')) {
      return str.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [str];
  }

  /**
   * Resolve container or virtual paths to local host filesystem path
   */
  resolveLocalPath(p) {
    if (!p) return null;
    let normalized = String(p).trim();

    // Convert /hostfs/F/... to F:\...
    const hostfsMatch = normalized.match(/^\/?hostfs\/([A-Za-z])\/(.*)$/i);
    if (hostfsMatch) {
      normalized = `${hostfsMatch[1].toUpperCase()}:\\${hostfsMatch[2].replace(/\//g, '\\')}`;
    }

    if (fs.existsSync(normalized)) {
      return normalized;
    }
    return null;
  }

  /**
   * Check if a changed file is a temporary, lock, or hidden metadata file
   */
  isIgnoredFile(filename) {
    if (!filename) return false;
    const base = path.basename(filename);
    if (base.startsWith('~$') || base.startsWith('.~') || base.endsWith('.tmp') || base.endsWith('.swp') || base.endsWith('.part')) {
      return true;
    }
    if (base === 'thumbs.db' || base === 'desktop.ini' || base === '.DS_Store') {
      return true;
    }
    if (filename.includes('.git\\') || filename.includes('.git/') || filename.includes('node_modules\\') || filename.includes('node_modules/')) {
      return true;
    }
    return false;
  }

  /**
   * Start watching all folders belonging to a task
   */
  watchTask(task) {
    this.unwatchTask(task.id);

    if (!task || !task.realtime_watch || !task.enabled) {
      return;
    }

    const rawPaths = this.parseSourcePaths(task.source_path);
    const validPaths = rawPaths.map(p => this.resolveLocalPath(p)).filter(Boolean);

    if (validPaths.length === 0) {
      return;
    }

    const taskEntry = {
      watchers: [],
      timer: null,
      task: task,
      watchedPaths: validPaths
    };

    validPaths.forEach(folderPath => {
      try {
        const watcher = fs.watch(folderPath, { recursive: true }, (eventType, filename) => {
          if (filename && this.isIgnoredFile(filename)) {
            return;
          }

          // Debounce execution
          if (taskEntry.timer) {
            clearTimeout(taskEntry.timer);
          }

          const fileInfo = filename ? path.basename(filename) : 'files';
          const now = Date.now();

          // Throttle notification broadcast so bulk file saves don't flood the UI
          if (this.broadcastCallback && (!taskEntry.lastBroadcast || (now - taskEntry.lastBroadcast > 3000))) {
            taskEntry.lastBroadcast = now;
            this.broadcastCallback({
              type: 'watcher_event',
              data: {
                taskId: task.id,
                taskName: task.name,
                folderPath,
                filename,
                eventType,
                message: `Change detected (${fileInfo}). Stabilizing before backup...`
              }
            });
          }

          taskEntry.timer = setTimeout(() => {
            taskEntry.timer = null;
            if (this.broadcastCallback) {
              this.broadcastCallback({
                type: 'watcher_event',
                data: {
                  taskId: task.id,
                  taskName: task.name,
                  message: `⚡ Real-time trigger: Launching instant backup for "${task.name}"`
                }
              });
            }
            if (this.onTriggerCallback) {
              this.onTriggerCallback(task.id, { reason: 'realtime_change', changedFile: filename });
            }
          }, this.debounceMs);
        });

        watcher.on('error', (err) => {
          console.warn(`[FileWatcher] Error watching ${folderPath}:`, err.message);
        });

        taskEntry.watchers.push(watcher);
      } catch (err) {
        console.warn(`[FileWatcher] Failed to watch ${folderPath}:`, err.message);
      }
    });

    if (taskEntry.watchers.length > 0) {
      this.watchers.set(task.id, taskEntry);
      console.log(`[FileWatcher] 👁️ Watching ${taskEntry.watchers.length} folder(s) for task "${task.name}" (ID: ${task.id})`);
    }
  }

  /**
   * Stop watching a task
   */
  unwatchTask(taskId) {
    const entry = this.watchers.get(taskId);
    if (!entry) return;

    if (entry.timer) {
      clearTimeout(entry.timer);
    }

    entry.watchers.forEach(w => {
      try { w.close(); } catch (e) {}
    });

    this.watchers.delete(taskId);
  }

  /**
   * Synchronize all tasks against database task list
   */
  syncAll(tasks) {
    const activeTaskIds = new Set(tasks.map(t => t.id));

    // Remove watchers for deleted tasks
    for (const taskId of this.watchers.keys()) {
      if (!activeTaskIds.has(taskId)) {
        this.unwatchTask(taskId);
      }
    }

    // Update or add watchers
    tasks.forEach(task => {
      if (task.realtime_watch && task.enabled) {
        this.watchTask(task);
      } else {
        this.unwatchTask(task.id);
      }
    });
  }

  /**
   * Close all watchers (on shutdown)
   */
  closeAll() {
    for (const taskId of this.watchers.keys()) {
      this.unwatchTask(taskId);
    }
  }

  /**
   * Return list of currently watched task IDs and folder counts
   */
  getStatus() {
    const list = [];
    for (const [taskId, entry] of this.watchers.entries()) {
      list.push({
        taskId,
        taskName: entry.task?.name,
        foldersCount: entry.watchedPaths.length,
        folders: entry.watchedPaths
      });
    }
    return list;
  }
}

const fileWatcher = new FileWatcherService();
module.exports = fileWatcher;
