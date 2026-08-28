const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');

const db = require('./db');
const rclone = require('./rclone');
const scheduler = require('./scheduler');

const compression = require('compression');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(compression());
app.use(express.json({ limit: '250mb' }));
app.use(express.urlencoded({ extended: true, limit: '250mb' }));

// Handle invalid JSON in body requests gracefully
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON payload: ' + err.message });
  }
  next(err);
});

// Static assets - no-cache so UI changes are always picked up immediately
app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    }
  }
}));

// Set up WebSocket broadcasting with heartbeat to keep connections healthy
const connectedSockets = new Set();

wss.on('connection', (ws) => {
  ws.isAlive = true;
  connectedSockets.add(ws);
  
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.send(JSON.stringify({ type: 'connected', data: { message: 'Connected to AutoBackup Hub live stream' } }));

  ws.on('close', () => {
    connectedSockets.delete(ws);
  });

  ws.on('error', () => {
    connectedSockets.delete(ws);
  });
});

// Periodic heartbeat to clean up disconnected/stale sockets
const wsHeartbeatInterval = setInterval(() => {
  for (const ws of connectedSockets) {
    if (ws.isAlive === false) {
      connectedSockets.delete(ws);
      try { ws.terminate(); } catch (e) {}
    } else {
      ws.isAlive = false;
      try { ws.ping(); } catch (e) {}
    }
  }
}, 30000);

wss.on('close', () => {
  clearInterval(wsHeartbeatInterval);
});

function broadcastWS(type, data) {
  const messageStr = JSON.stringify({ type, data });
  for (const client of connectedSockets) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(messageStr);
      } catch (e) {
        connectedSockets.delete(client);
      }
    }
  }
}

scheduler.setWebSocketBroadcast((messageStr) => {
  for (const client of connectedSockets) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(messageStr);
      } catch (e) {
        connectedSockets.delete(client);
      }
    }
  }
});

// Sanitize tokens (strip bad expiry dates) on server startup
rclone.sanitizeRcloneConfigFile();

// Initialize scheduler
scheduler.init();

// Pre-warm quota cache in the background so remotes UI is fast on first open
// Pre-warm quota cache for first remote only — fetching all at once exhausts
// libuv's 4-thread pool and blocks backup execution / test connections.
setTimeout(async () => {
  try {
    const remotes = await rclone.listRemotes();
    if (remotes.length > 0) {
      await rclone.getRemoteAbout(remotes[0]).catch(() => {});
    }
  } catch (e) {}
}, 8000);

// Helper to parse Docker volume lines supporting Windows drive letters (C:/..., F:/...)
function parseVolumeLine(line) {
  let trimmed = line.trim();
  if (!trimmed.startsWith('-')) return null;

  trimmed = trimmed.replace(/^-\s*/, '').replace(/^[\"']|[\"']$/g, '');
  trimmed = trimmed.replace(/:(ro|rw)$/i, '');

  const lastColonIndex = trimmed.lastIndexOf(':');
  if (lastColonIndex <= 0) return null;

  const hostPath = trimmed.substring(0, lastColonIndex).trim();
  const containerPath = trimmed.substring(lastColonIndex + 1).trim();

  if (!containerPath || containerPath === '/config' || containerPath.includes('./config') || /^\d+$/.test(containerPath)) {
    return null;
  }

  return { hostPath, containerPath };
}

/**
 * Convert a Windows-style host path (C:\Users\Dr\...) to its /hostfs/ equivalent inside the container.
 * e.g. "C:/Users/Dr/Documents" → "/hostfs/C/Users/Dr/Documents"
 *      "F:/autobackup"         → "/hostfs/F/autobackup"
 */
function hostPathToContainerPath(hostPath) {
  // Normalise backslashes
  const normalised = hostPath.replace(/\\/g, '/');
  // Match drive letter  e.g. C:/ or C:
  const driveMatch = normalised.match(/^([A-Za-z]):\/?(.*)$/);
  if (driveMatch) {
    const driveLetter = driveMatch[1].toUpperCase();
    const rest = driveMatch[2].replace(/^\//, '');
    return rest ? `/hostfs/${driveLetter}/${rest}` : `/hostfs/${driveLetter}`;
  }
  // Already a Unix-style path — return as-is
  return normalised;
}

// --- REST API ENDPOINTS ---

/**
 * System status
 */
app.get('/api/status', async (req, res) => {
  try {
    const isRcloneInstalled = await rclone.checkRcloneInstalled();
    const tasksCount = await db.get('SELECT COUNT(*) as count FROM tasks');
    const remotes = await rclone.listRemotes();
    const logsCount = await db.get('SELECT COUNT(*) as count FROM logs');
    const nextRunTask = await db.get('SELECT next_run, cron_schedule FROM tasks WHERE enabled = 1 AND next_run IS NOT NULL ORDER BY next_run ASC LIMIT 1');

    res.json({
      rcloneInstalled: isRcloneInstalled,
      activeTasksCount: tasksCount.count,
      connectedRemotesCount: remotes.length,
      remotesList: remotes,
      totalLogEntries: logsCount.count,
      nextScheduledRun: nextRunTask ? nextRunTask.next_run : null,
      nextScheduledCron: nextRunTask ? nextRunTask.cron_schedule : null,
      configPath: rclone.RCLONE_CONFIG_PATH
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Detect mounted source paths from docker-compose.yml, filesystem, and user-defined DB sources
 */
app.get('/api/sources', async (req, res) => {
  try {
    const sourcesMap = new Map();

    // 1. Parse docker-compose.yml volume mounts
    const composePaths = [
      path.join(__dirname, '../docker-compose.yml'),
      '/app/docker-compose.yml',
      'f:/autobackup/docker-compose.yml'
    ];

    for (const composePath of composePaths) {
      if (fs.existsSync(composePath)) {
        const content = fs.readFileSync(composePath, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          const parsed = parseVolumeLine(line);
          if (parsed) {
            // Skip the hostfs drive mounts themselves (they are base mounts, not sources)
            if (parsed.containerPath.match(/^\/hostfs\/[A-Z]$/)) continue;
            sourcesMap.set(parsed.containerPath, {
              containerPath: parsed.containerPath,
              hostPath: parsed.hostPath,
              label: `${parsed.containerPath}  (Laptop: ${parsed.hostPath})`,
              source: 'compose'
            });
          }
        }
      }
    }

    // 2. Scan /backup_sources/ if it exists
    const BACKUP_SOURCES_DIR = process.env.BACKUP_SOURCES_DIR || '/backup_sources';
    if (fs.existsSync(BACKUP_SOURCES_DIR)) {
      try {
        const items = fs.readdirSync(BACKUP_SOURCES_DIR, { withFileTypes: true });
        for (const item of items) {
          const fullPath = path.join(BACKUP_SOURCES_DIR, item.name).replace(/\\/g, '/');
          if (!sourcesMap.has(fullPath)) {
            sourcesMap.set(fullPath, {
              containerPath: fullPath,
              label: `${fullPath}`,
              source: 'filesystem'
            });
          }
        }
      } catch (e) {
        // Ignore folder scan error
      }
    }

    // 3. Merge user-defined DB sources
    const dbSources = await db.all('SELECT * FROM sources ORDER BY created_at ASC');
    for (const src of dbSources) {
      if (!sourcesMap.has(src.container_path)) {
        sourcesMap.set(src.container_path, {
          id: src.id,
          containerPath: src.container_path,
          hostPath: src.host_path,
          name: src.name,
          label: `${src.container_path}  (${src.name}: ${src.host_path})`,
          source: 'user'
        });
      }
    }

    const sourcesList = Array.from(sourcesMap.values());
    res.json(sourcesList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Add a user-defined source folder (no docker-compose edit needed)
 * Body: { name: "My Project", host_path: "C:/Users/Dr/NewProject" }
 */
app.post('/api/sources', async (req, res) => {
  try {
    const body = req.body;
    const sourcesToAdd = Array.isArray(body.sources) ? body.sources : (body.name && body.host_path ? [body] : []);

    if (sourcesToAdd.length === 0) {
      return res.status(400).json({ error: 'name and host_path (or sources array) are required' });
    }

    const inserted = [];
    for (const item of sourcesToAdd) {
      if (!item.host_path) continue;
      const itemName = item.name || path.basename(item.host_path) || 'Folder';
      const container_path = hostPathToContainerPath(item.host_path);
      const id = uuidv4();
      await db.run(
        'INSERT INTO sources (id, name, host_path, container_path) VALUES (?, ?, ?, ?)',
        [id, itemName.trim(), item.host_path.trim(), container_path]
      );
      inserted.push({ id, name: itemName, host_path: item.host_path, container_path });
    }

    res.json({ success: true, count: inserted.length, sources: inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete a user-defined source by id
 */
app.delete('/api/sources/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM sources WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Browse the local filesystem inside /hostfs/ for the folder picker UI.
 * Query: ?path=/hostfs/C/Users/Dr
 */
app.get('/api/sources/browse', (req, res) => {
  try {
    const requestedPath = req.query.path || '/hostfs';
    // Security: only allow browsing under /hostfs or known backup_sources paths
    const safePaths = ['/hostfs', '/backup_sources'];
    const isSafe = safePaths.some(sp => requestedPath.startsWith(sp));
    if (!isSafe) {
      return res.status(403).json({ error: 'Browse path must be under /hostfs or /backup_sources' });
    }

    if (!fs.existsSync(requestedPath)) {
      return res.json({ path: requestedPath, items: [], exists: false, breadcrumbs: [], parentPath: '/hostfs' });
    }

    // Build clickable breadcrumbs
    const normalized = requestedPath.replace(/\/+/g, '/').replace(/\/$/, '') || '/hostfs';
    const parts = normalized.split('/').filter(Boolean);
    const breadcrumbs = [];
    let accum = '';
    for (const part of parts) {
      accum += '/' + part;
      let label = part;
      if (part === 'hostfs') label = '🏠 Host';
      else if (/^[A-Z]$/.test(part)) label = `💾 ${part}:`;
      breadcrumbs.push({ name: label, path: accum });
    }

    // Calculate parent path
    let parentPath = null;
    if (normalized !== '/hostfs' && normalized !== '/backup_sources') {
      const lastSlash = normalized.lastIndexOf('/');
      parentPath = lastSlash > 0 ? normalized.substring(0, lastSlash) : '/hostfs';
      if (parentPath === '/hostfs/' || !parentPath) parentPath = '/hostfs';
    }

    let items = [];
    try {
      const rawItems = fs.readdirSync(requestedPath, { withFileTypes: true });
      items = rawItems
        .filter(item => item.isDirectory()) // Only show directories for folder picker
        .map(item => ({
          name: item.name,
          path: path.join(requestedPath, item.name).replace(/\\/g, '/'),
          isDir: true
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    } catch (readErr) {
      return res.json({ path: requestedPath, items: [], exists: true, error: readErr.message, breadcrumbs, parentPath });
    }

    res.json({ path: requestedPath, items, exists: true, breadcrumbs, parentPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get all backup tasks
 */
app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await db.all('SELECT * FROM tasks ORDER BY created_at DESC');
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Helper to infer priority from schedule if not provided
 */
function inferPriority(cronSchedule, providedPriority) {
  if (providedPriority && ['critical', 'high', 'medium', 'low', 'normal'].includes(providedPriority)) {
    return providedPriority;
  }
  if (cronSchedule === 'last_friday' || cronSchedule === '0 2 22-31 * 5') return 'critical';
  if (cronSchedule === 'monthly' || cronSchedule === '0 3 1 * *') return 'high';
  if (cronSchedule === 'weekly' || cronSchedule === '0 3 * * 0') return 'medium';
  if (cronSchedule === 'daily' || cronSchedule === '0 2 * * *') return 'low';
  return 'normal';
}

/**
 * Create a new backup task
 */
app.post('/api/tasks', async (req, res) => {
  try {
    let { name, source_path, target_remote, target_path, mode = 'copy', cron_schedule, enabled = 1, conflict_mode = 'smart', priority, bw_limit = '' } = req.body;

    if (Array.isArray(source_path)) {
      source_path = JSON.stringify(source_path);
    }

    if (!name || !source_path || !target_remote || !cron_schedule) {
      return res.status(400).json({ error: 'Missing required fields: name, source_path, target_remote, cron_schedule' });
    }

    const taskPriority = inferPriority(cron_schedule, priority);

    const id = uuidv4();
    await db.run(
      `INSERT INTO tasks (id, name, source_path, target_remote, target_path, mode, cron_schedule, enabled, conflict_mode, priority, bw_limit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, source_path, target_remote, target_path || '', mode, cron_schedule, enabled ? 1 : 0, conflict_mode, taskPriority, bw_limit]
    );

    const newTask = await db.get('SELECT * FROM tasks WHERE id = ?', [id]);
    
    if (enabled) {
      scheduler.scheduleTask(newTask);
    }

    res.json({ success: true, task: newTask });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Update backup task
 */
app.put('/api/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let { name, source_path, target_remote, target_path, mode, cron_schedule, enabled, conflict_mode, priority, bw_limit } = req.body;

    if (Array.isArray(source_path)) {
      source_path = JSON.stringify(source_path);
    }

    const existing = await db.get('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const taskPriority = inferPriority(cron_schedule || existing.cron_schedule, priority || existing.priority);

    await db.run(
      `UPDATE tasks SET 
        name = COALESCE(?, name),
        source_path = COALESCE(?, source_path),
        target_remote = COALESCE(?, target_remote),
        target_path = COALESCE(?, target_path),
        mode = COALESCE(?, mode),
        cron_schedule = COALESCE(?, cron_schedule),
        enabled = COALESCE(?, enabled),
        conflict_mode = COALESCE(?, conflict_mode),
        priority = COALESCE(?, priority),
        bw_limit = COALESCE(?, bw_limit)
       WHERE id = ?`,
      [name, source_path, target_remote, target_path, mode, cron_schedule, enabled, conflict_mode, taskPriority, bw_limit, id]
    );

    const updatedTask = await db.get('SELECT * FROM tasks WHERE id = ?', [id]);

    if (updatedTask.enabled) {
      scheduler.scheduleTask(updatedTask);
    } else {
      scheduler.unscheduleTask(id);
    }

    res.json({ success: true, task: updatedTask });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete backup task
 */
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    scheduler.unscheduleTask(id);
    await db.run('DELETE FROM tasks WHERE id = ?', [id]);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Trigger manual execution of a task (non-blocking)
 */
app.post('/api/tasks/:id/run', (req, res) => {
  try {
    const { id } = req.params;
    scheduler.executeTask(id, false).catch(err => {
      console.error(`[Task Execution Error] Task ${id}:`, err);
    });
    res.json({ success: true, message: `Task ${id} execution started.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Trigger dry-run simulation of a task (non-blocking)
 */
app.post('/api/tasks/:id/dry-run', (req, res) => {
  try {
    const { id } = req.params;
    scheduler.executeTask(id, true).catch(err => {
      console.error(`[Dry-Run Execution Error] Task ${id}:`, err);
    });
    res.json({ success: true, message: `Task ${id} dry-run started.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Stop a running task
 */
app.post('/api/tasks/:id/stop', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await scheduler.stopTask(id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Stop an active transfer or download subprocess by logId
 */
app.post('/api/transfer/:id/stop', (req, res) => {
  try {
    const { id } = req.params;
    const stopped = rclone.cancelBackupTask(id);
    res.json({ success: true, stopped, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Fetch cloud storage quota / about metrics for a remote.
 * Returns cache immediately (non-blocking), triggers background refresh if stale.
 */
app.get('/api/remotes/:name/about', (req, res) => {
  const { name } = req.params;

  // Return cached result immediately if available
  const cached = rclone.getCachedRemoteAbout(name);
  if (cached) {
    // Kick off background refresh if cache is older than 3 minutes
    if (cached.age > 3 * 60 * 1000) {
      rclone.getRemoteAbout(name).catch(() => {});
    }
    return res.json(cached.data);
  }

  // No cache yet — run in background, return pending response immediately
  res.json({ success: false, pending: true, message: 'Quota fetch in progress, retry shortly.' });
  rclone.getRemoteAbout(name).catch(() => {});
});

/**
 * List files in a cloud remote directory (for file browser)
 * GET /api/remotes/:name/ls?path=folder/subfolder
 */
app.get('/api/remotes/:name/ls', async (req, res) => {
  try {
    const { name } = req.params;
    const remotePath = req.query.path || '';
    const items = await rclone.listRemoteDir(name, remotePath);
    res.json({ success: true, remote: name, path: remotePath, items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Get application settings (e.g. Discord webhook URL)
 */
app.get('/api/settings', async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM settings');
    const settingsMap = {};
    rows.forEach(r => { settingsMap[r.key] = r.value; });
    if (!settingsMap.device_name) {
      settingsMap.device_name_default = os.hostname() || 'AutoBackup-Node';
    }
    res.json(settingsMap);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Save application settings
 */
app.post('/api/settings', async (req, res) => {
  try {
    const { discord_webhook_url, ntfy_topic, telegram_bot_token, telegram_chat_id, device_name } = req.body;

    if (device_name !== undefined) {
      await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['device_name', device_name.trim()]);
    }
    if (discord_webhook_url !== undefined) {
      await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['discord_webhook_url', discord_webhook_url.trim()]);
    }
    if (ntfy_topic !== undefined) {
      await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['ntfy_topic', ntfy_topic.trim()]);
    }
    if (telegram_bot_token !== undefined) {
      await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['telegram_bot_token', telegram_bot_token.trim()]);
    }
    if (telegram_chat_id !== undefined) {
      await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['telegram_chat_id', telegram_chat_id.trim()]);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Version control & system information
 */
app.get('/api/version', (req, res) => {
  try {
    const pkg = require('../package.json');
    res.json({
      name: pkg.name,
      version: pkg.version || '2.8.0',
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: Math.floor(process.uptime()),
      dockerImage: 'ghcr.io/attacker2007/autobackup:latest',
      repoUrl: 'https://github.com/attacker2007/autobackup'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Check for updates against remote GitHub repository releases/tags
 */
app.get('/api/version/check', async (req, res) => {
  try {
    const pkg = require('../package.json');
    const currentVersion = pkg.version || '2.8.0';

    const semverCompare = (v1, v2) => {
      const clean = v => (v || '').replace(/^[vV]/, '').trim();
      const p1 = clean(v1).split('.').map(n => parseInt(n, 10) || 0);
      const p2 = clean(v2).split('.').map(n => parseInt(n, 10) || 0);
      for (let i = 0; i < 3; i++) {
        const num1 = p1[i] || 0;
        const num2 = p2[i] || 0;
        if (num1 > num2) return 1;
        if (num1 < num2) return -1;
      }
      return 0;
    };

    let latestVersion = currentVersion;
    let releaseName = `v${currentVersion}`;
    let releaseUrl = 'https://github.com/attacker2007/autobackup/releases';
    let releaseNotes = '';
    let publishedAt = null;

    try {
      const resp = await fetch('https://api.github.com/repos/attacker2007/autobackup/releases/latest', {
        headers: {
          'User-Agent': 'AutoBackup-Hub/' + currentVersion,
          'Accept': 'application/vnd.github.v3+json'
        },
        signal: AbortSignal.timeout(5000)
      });

      if (resp.ok) {
        const data = await resp.json();
        latestVersion = (data.tag_name || '').replace(/^[vV]/, '') || currentVersion;
        releaseName = data.name || data.tag_name || `v${latestVersion}`;
        releaseUrl = data.html_url || releaseUrl;
        releaseNotes = data.body || '';
        publishedAt = data.published_at;
      } else {
        // Fallback to tags if no formal release published yet
        const tagsResp = await fetch('https://api.github.com/repos/attacker2007/autobackup/tags', {
          headers: {
            'User-Agent': 'AutoBackup-Hub/' + currentVersion,
            'Accept': 'application/vnd.github.v3+json'
          },
          signal: AbortSignal.timeout(5000)
        });
        if (tagsResp.ok) {
          const tags = await tagsResp.json();
          if (tags && tags.length > 0) {
            latestVersion = tags[0].name.replace(/^[vV]/, '');
            releaseName = tags[0].name;
          }
        }
      }
    } catch (fetchErr) {
      console.warn('Version check fetch error (offline or rate limited):', fetchErr.message);
    }

    const isLatest = semverCompare(currentVersion, latestVersion) >= 0;

    res.json({
      currentVersion,
      latestVersion,
      isLatest,
      releaseName,
      releaseUrl,
      releaseNotes,
      publishedAt
    });
  } catch (err) {
    res.json({
      currentVersion: require('../package.json').version || '2.8.0',
      latestVersion: require('../package.json').version || '2.8.0',
      isLatest: true,
      error: err.message
    });
  }
});

/**
 * Export complete AutoBackup configuration bundle (tasks, settings, sources, rclone.conf)
 * Enables 1-click migration between local Docker and online/cloud Docker containers.
 */
app.get('/api/backup/export', async (req, res) => {
  try {
    const tasks = await db.all('SELECT * FROM tasks');
    const sources = await db.all('SELECT * FROM sources');
    const settings = await db.all('SELECT * FROM settings');
    
    let rcloneConfig = '';
    if (fs.existsSync(rclone.RCLONE_CONFIG_PATH)) {
      rcloneConfig = fs.readFileSync(rclone.RCLONE_CONFIG_PATH, 'utf8');
    }

    const deviceSetting = settings.find(s => s.key === 'device_name');
    const deviceName = deviceSetting ? deviceSetting.value : (os.hostname() || 'Node');

    const pkg = require('../package.json');
    const exportBundle = {
      version: pkg.version || '2.8.0',
      exportedAt: new Date().toISOString(),
      sourceDevice: deviceName,
      tasks: tasks || [],
      sources: sources || [],
      settings: settings || [],
      rcloneConfig: rcloneConfig || ''
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="autobackup-hub-export-${deviceName}-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(exportBundle);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Import complete AutoBackup configuration bundle
 * Automatically restores tasks, sources, webhooks, and cloud remotes into this instance.
 */
app.post('/api/backup/import', async (req, res) => {
  try {
    const bundle = req.body;
    if (!bundle || (!bundle.tasks && !bundle.rcloneConfig && !bundle.settings)) {
      return res.status(400).json({ error: 'Invalid configuration bundle format.' });
    }

    let settingsImported = 0;
    let tasksImported = 0;
    let sourcesImported = 0;
    let remotesImported = 0;

    // 1. Restore Settings
    if (Array.isArray(bundle.settings)) {
      for (const s of bundle.settings) {
        if (s.key && s.value !== undefined) {
          await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [s.key, s.value]);
          settingsImported++;
        }
      }
    }

    // 2. Restore Sources
    if (Array.isArray(bundle.sources)) {
      for (const src of bundle.sources) {
        if (src.id && src.name && src.host_path) {
          await db.run(
            'INSERT INTO sources (id, name, host_path, container_path) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, host_path=excluded.host_path, container_path=excluded.container_path',
            [src.id, src.name, src.host_path, src.container_path || src.host_path]
          );
          sourcesImported++;
        }
      }
    }

    // 3. Restore Tasks
    if (Array.isArray(bundle.tasks)) {
      for (const t of bundle.tasks) {
        if (t.id && t.name && t.target_remote) {
          await db.run(
            `INSERT INTO tasks (id, name, source_path, target_remote, target_path, mode, cron_schedule, enabled, conflict_mode, priority, bw_limit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               name=excluded.name,
               source_path=excluded.source_path,
               target_remote=excluded.target_remote,
               target_path=excluded.target_path,
               mode=excluded.mode,
               cron_schedule=excluded.cron_schedule,
               enabled=excluded.enabled,
               conflict_mode=excluded.conflict_mode,
               priority=excluded.priority,
               bw_limit=excluded.bw_limit`,
            [
              t.id, t.name, t.source_path, t.target_remote, t.target_path || '',
              t.mode || 'copy', t.cron_schedule, t.enabled !== undefined ? t.enabled : 1,
              t.conflict_mode || 'smart', t.priority || 'normal', t.bw_limit || ''
            ]
          );
          tasksImported++;
        }
      }
    }

    // 4. Restore Rclone Configuration
    if (bundle.rcloneConfig && typeof bundle.rcloneConfig === 'string' && bundle.rcloneConfig.trim()) {
      rclone.sanitizeAndWriteRcloneConfig(bundle.rcloneConfig);
      rclone.invalidateListRemotesCache();
      const remotesList = await rclone.listRemotes();
      remotesImported = remotesList.length;
    }

    // Re-initialize scheduler to immediately activate imported task crons
    await scheduler.init();

    res.json({
      success: true,
      message: `Configuration restored successfully! Restored ${tasksImported} task(s), ${sourcesImported} source(s), ${settingsImported} setting(s), and ${remotesImported} cloud remote(s).`,
      stats: { settingsImported, tasksImported, sourcesImported, remotesImported }
    });
  } catch (err) {
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

/**
 * Trigger manual execution of Monthly Executive Discord Report
 */
app.post('/api/reports/monthly/trigger', async (req, res) => {
  try {
    const result = await scheduler.sendMonthlyDiscordReport();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Trigger test notification for a channel ('discord', 'ntfy', or 'telegram')
 */
app.post('/api/notifications/test', async (req, res) => {
  try {
    const { channel } = req.body;
    const result = await scheduler.testNotificationChannel(channel);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Get Security PIN authentication status
 */
app.get('/api/auth/status', async (req, res) => {
  try {
    const pinSetting = await db.get('SELECT value FROM settings WHERE key = ?', ['app_pin']);
    const pinConfigured = !!(pinSetting && pinSetting.value && pinSetting.value.trim().length > 0);
    res.json({ pinConfigured });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Verify Security PIN
 */
app.post('/api/auth/verify', async (req, res) => {
  try {
    const { pin } = req.body;
    const pinSetting = await db.get('SELECT value FROM settings WHERE key = ?', ['app_pin']);
    if (!pinSetting || !pinSetting.value || pinSetting.value.trim().length === 0) {
      return res.json({ success: true, message: 'No Security PIN enabled.' });
    }

    if (String(pin).trim() === pinSetting.value.trim()) {
      res.json({ success: true, message: 'PIN verified successfully.' });
    } else {
      res.status(401).json({ success: false, error: 'Incorrect Security PIN.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Set or remove Security PIN
 */
app.post('/api/auth/set-pin', async (req, res) => {
  try {
    const { pin, current_pin } = req.body;
    const pinSetting = await db.get('SELECT value FROM settings WHERE key = ?', ['app_pin']);
    
    // If PIN is already configured, verify current PIN first
    if (pinSetting && pinSetting.value && pinSetting.value.trim().length > 0) {
      if (String(current_pin).trim() !== pinSetting.value.trim()) {
        return res.status(401).json({ success: false, error: 'Current Security PIN is incorrect.' });
      }
    }

    const newPin = pin ? String(pin).trim() : '';
    await db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ['app_pin', newPin]
    );

    res.json({ success: true, pinEnabled: newPin.length > 0, message: newPin.length > 0 ? 'Security PIN updated successfully.' : 'Security PIN disabled.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get storage capacity and connection health warning alerts
 */
app.get('/api/remotes/alerts', async (req, res) => {
  try {
    const remotes = await rclone.listRemotes();
    const alerts = [];

    for (const remoteName of remotes) {
      const cached = rclone.getCachedRemoteAbout(remoteName);
      if (cached && cached.data) {
        if (cached.data.success && cached.data.percentage >= 85) {
          alerts.push({
            remote: remoteName,
            type: 'capacity',
            level: cached.data.percentage >= 95 ? 'critical' : 'warning',
            message: `Remote storage "${remoteName}" is ${cached.data.percentage}% full (${cached.data.freeFormatted} free remaining).`,
            percentage: cached.data.percentage,
            freeFormatted: cached.data.freeFormatted,
            totalFormatted: cached.data.totalFormatted
          });
        } else if (!cached.data.success && cached.data.error && !cached.data.pending) {
          const errStr = String(cached.data.error).toLowerCase();
          const isActionableAuthError = errStr.includes('auth') || errStr.includes('token') || errStr.includes('credential');
          if (isActionableAuthError) {
            alerts.push({
              remote: remoteName,
              type: 'health',
              level: 'warning',
              message: `Authentication required for "${remoteName}": ${cached.data.error}`,
              percentage: 0
            });
          }
        }
      }
    }

    res.json({ alerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get connected remotes list
 */
app.get('/api/remotes', async (req, res) => {
  try {
    const remotes = await rclone.listRemotes();
    res.json(remotes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get detailed remotes metadata list
 */
app.get('/api/remotes/details', async (req, res) => {
  try {
    const details = rclone.getRemotesDetails();
    res.json(details);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Test a specific remote connection with live log streaming & history logging
 */
app.post('/api/remotes/:name/test', async (req, res) => {
  try {
    const { name } = req.params;
    const logId = uuidv4();
    const startTime = new Date().toISOString();
    const taskName = `Remote Health Ping: ${name}`;

    broadcastWS('task_started', {
      taskId: `test-${name}`,
      taskName,
      logId,
      startTime
    });

    let logContent = '';
    const result = await rclone.testRemoteConnection(name, (line) => {
      logContent += line;
      broadcastWS('task_log', {
        taskId: `test-${name}`,
        logId,
        logLine: line
      });
    });

    const endTime = new Date().toISOString();
    const finalStatus = result.success ? 'success' : 'failed';
    const transferredText = `Ping: ${result.latencyMs} ms | Speed: ${result.uploadSpeed}`;

    // Save test log to database history
    await db.run(
      `INSERT INTO logs (id, task_id, task_name, start_time, end_time, status, bytes_transferred, files_transferred, output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        logId,
        `test-${name}`,
        taskName,
        startTime,
        endTime,
        finalStatus,
        transferredText,
        0,
        logContent || result.info
      ]
    );

    broadcastWS('task_finished', {
      taskId: `test-${name}`,
      taskName,
      logId,
      status: finalStatus,
      bytesTransferred: transferredText,
      endTime
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Add / Update Cloud Remote config
 */
app.post('/api/remotes', async (req, res) => {
  try {
    const { name, type, options } = req.body;
    if (!name || !type) {
      return res.status(400).json({ error: 'Remote name and provider type are required.' });
    }

    const result = await rclone.addRemoteConfig(name, type, options || {});
    rclone.invalidateListRemotesCache();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Update token and reconnect an existing remote
 */
app.post('/api/remotes/:name/token', async (req, res) => {
  try {
    let { token, stripCustomClient = false } = req.body;
    const remoteName = req.params.name;
    if (!token) {
      return res.status(400).json({ error: 'Token string or JSON is required' });
    }

    // Extract JSON payload if user pasted terminal commentary or multi-line block
    const rawStr = String(token).trim();
    const jsonMatch = rawStr.match(/\{[\s\S]*\}/);
    let cleanedToken = rawStr;
    if (jsonMatch) {
      try {
        cleanedToken = JSON.stringify(JSON.parse(jsonMatch[0]));
      } catch (e) {
        cleanedToken = jsonMatch[0].replace(/\r?\n/g, ' ').trim();
      }
    } else {
      cleanedToken = rawStr.replace(/\r?\n/g, ' ').trim();
    }

    if (!fs.existsSync(rclone.RCLONE_CONFIG_PATH)) {
      return res.status(404).json({ error: 'rclone.conf not found' });
    }

    const content = fs.readFileSync(rclone.RCLONE_CONFIG_PATH, 'utf8');
    const lines = content.split('\n');
    let inSection = false;
    let tokenUpdated = false;
    const newLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        inSection = (trimmed === `[${remoteName}]`);
      }

      if (inSection && stripCustomClient && (trimmed.startsWith('client_id') || trimmed.startsWith('client_secret'))) {
        // Strip custom client_id/secret if switching to standard rclone auth
        continue;
      }

      if (inSection && (trimmed.startsWith('token =') || trimmed.startsWith('token='))) {
        newLines.push(`token = ${cleanedToken}`);
        tokenUpdated = true;
      } else {
        newLines.push(line);
      }
    }

    if (!tokenUpdated) {
      const finalLines = [];
      for (const line of newLines) {
        finalLines.push(line);
        if (line.trim() === `[${remoteName}]`) {
          finalLines.push(`token = ${cleanedToken}`);
        }
      }
      rclone.sanitizeAndWriteRcloneConfig(finalLines.join('\n'));
    } else {
      rclone.sanitizeAndWriteRcloneConfig(newLines.join('\n'));
    }

    rclone.invalidateListRemotesCache();
    const testResult = await rclone.testRemoteConnection(remoteName);
    res.json({ success: true, testResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Import raw rclone.conf section block directly
 * Body: { configText: "[remote_name]\ntype=...\ntoken=..." }
 */
app.post('/api/remotes/import-block', async (req, res) => {
  try {
    const { configText } = req.body;
    if (!configText || !configText.includes('[')) {
      return res.status(400).json({ error: 'Valid rclone.conf section block (containing [remote_name]) is required.' });
    }

    const importedRemotes = rclone.importRawConfigBlock(configText);
    rclone.invalidateListRemotesCache();

    const testRes = importedRemotes.length > 0
      ? await rclone.testRemoteConnection(importedRemotes[0])
      : { success: true };

    res.json({ success: true, importedRemotes, testResult: testRes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Start rclone authorize OAuth flow
 * Body: { type: "drive" | "dropbox" | "pcloud" | "box" }
 */
app.post('/api/remotes/authorize/start', (req, res) => {
  try {
    const { type } = req.body;
    if (!type) return res.status(400).json({ error: 'Provider type is required.' });

    const processId = uuidv4();
    const args = ['--config', rclone.RCLONE_CONFIG_PATH, 'authorize', type, '--bind', '0.0.0.0', '--auth-no-open-browser'];

    const child = spawn('rclone', args, {
      shell: true,
      env: { ...process.env, RCLONE_CONFIG: rclone.RCLONE_CONFIG_PATH }
    });

    let stdoutData = '';
    let authUrlSent = false;

    const handleChunk = (chunk) => {
      const text = chunk.toString();
      stdoutData += text;
      const urlMatch = text.match(/https?:\/\/[^\s"]+/);
      if (urlMatch && !authUrlSent) {
        authUrlSent = true;
        let url = urlMatch[0].replace('127.0.0.1', 'localhost');
        broadcastWS('rclone_auth_url', { processId, authUrl: url });
      }
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);

    child.on('close', () => {
      const jsonMatch = stdoutData.match(/\{[\s\S]*"access_token"[\s\S]*\}/);
      if (jsonMatch) {
        broadcastWS('rclone_auth_success', { processId, token: jsonMatch[0].trim() });
      } else {
        broadcastWS('rclone_auth_error', { processId, output: stdoutData });
      }
    });

    res.json({ success: true, processId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Delete Cloud Remote config
 */
app.delete('/api/remotes/:name', async (req, res) => {
  try {
    const { name } = req.params;
    rclone.deleteRemoteConfig(name);
    rclone.invalidateListRemotesCache();
    res.json({ success: true, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Cloud-to-Cloud transfer
 * POST /api/transfer/cloud-to-cloud
 * Body: { srcRemote, srcPath, dstRemote, dstPath, mode }
 */
app.post('/api/transfer/cloud-to-cloud', async (req, res) => {
  try {
    const { srcRemote, srcPath, srcPaths, dstRemote, dstPath, mode = 'copy' } = req.body;
    const paths = Array.isArray(srcPaths) ? srcPaths : (srcPath ? [srcPath] : ['']);

    if (!srcRemote || !dstRemote) {
      return res.status(400).json({ error: 'srcRemote and dstRemote are required' });
    }

    const logId = uuidv4();
    const startTime = new Date().toISOString();
    const taskName = `Cloud Transfer (${paths.length} item${paths.length > 1 ? 's' : ''}): ${srcRemote} → ${dstRemote}:${dstPath || ''}`;

    broadcastWS('task_started', { taskId: logId, taskName, logId, startTime });

    let logContent = '';
    const result = await rclone.transferCloudToCloud(
      srcRemote, paths, dstRemote, dstPath || '', mode,
      (line) => {
        logContent += line;
        broadcastWS('task_log', { taskId: logId, logId, logLine: line });
      },
      logId
    );

    const endTime = new Date().toISOString();
    const finalStatus = result.success ? 'success' : 'failed';

    await db.run(
      `INSERT INTO logs (id, task_id, task_name, start_time, end_time, status, bytes_transferred, files_transferred, output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [logId, logId, taskName, startTime, endTime, finalStatus, result.bytesTransferred, 0, logContent]
    );

    broadcastWS('task_finished', {
      taskId: logId, taskName, logId,
      status: finalStatus,
      bytesTransferred: result.bytesTransferred,
      endTime
    });

    res.json({ ...result, logId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Cloud-to-Device download
 * POST /api/transfer/cloud-to-local
 * Body: { remote, remotePath, remotePaths }
 * Streams the file or .zip archive to the browser as a download
 */
app.post('/api/transfer/cloud-to-local', async (req, res) => {
  try {
    const { remote, remotePath, remotePaths } = req.body;
    const paths = Array.isArray(remotePaths) ? remotePaths : (remotePath ? [remotePath] : []);

    if (!remote || paths.length === 0) {
      return res.status(400).json({ error: 'remote and remotePath/remotePaths are required' });
    }

    const logId = uuidv4();
    let logContent = '';
    const taskName = `Download (${paths.length} item${paths.length > 1 ? 's' : ''}): ${remote}`;

    broadcastWS('task_started', {
      taskId: logId,
      taskName,
      logId,
      startTime: new Date().toISOString()
    });

    const dlResult = await rclone.downloadRemoteFiles(remote, paths, (line) => {
      logContent += line;
      broadcastWS('task_log', { taskId: logId, logId, logLine: line });
    }, logId);

    const sendFilename = dlResult.filename;
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(sendFilename)}"`);
    res.setHeader('Content-Type', dlResult.isZip ? 'application/zip' : 'application/octet-stream');

    const fileStream = fs.createReadStream(dlResult.localPath);
    fileStream.pipe(res);

    fileStream.on('close', () => {
      try { fs.unlinkSync(dlResult.localPath); } catch (e) {}
      if (dlResult.sessionDir) {
        try { fs.rmdirSync(dlResult.sessionDir, { recursive: true }); } catch (e) {}
      }
      broadcastWS('task_finished', {
        taskId: logId,
        taskName,
        logId,
        status: 'success',
        bytesTransferred: 'Sent to browser',
        endTime: new Date().toISOString()
      });
    });

    fileStream.on('error', (err) => {
      broadcastWS('task_finished', {
        taskId: logId,
        taskName,
        logId,
        status: 'failed',
        bytesTransferred: '0 B',
        endTime: new Date().toISOString()
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Upload local files or complete folder trees from browser directly to Cloud Remote or Backup Source
 */
app.post('/api/transfer/upload-files', async (req, res) => {
  try {
    const { remote, targetPath = '', files = [] } = req.body;
    if (!remote || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'remote and files array are required' });
    }

    const logId = uuidv4();
    const taskName = `Upload (${files.length} file${files.length > 1 ? 's' : ''}): Local → ${remote}`;

    broadcastWS('task_started', {
      taskId: logId,
      taskName,
      logId,
      startTime: new Date().toISOString()
    });

    // Create temp staging directory for uploaded files
    const uploadsTempDir = path.join(CONFIG_DIR, 'uploads', logId);
    fs.mkdirSync(uploadsTempDir, { recursive: true });

    let totalBytes = 0;
    for (const f of files) {
      if (!f.path || !f.data) continue;
      const cleanRelPath = f.path.replace(/^(\.\.[\/\\])+/, '').replace(/^[\\\/]+/, '');
      const fullDest = path.join(uploadsTempDir, cleanRelPath);
      fs.mkdirSync(path.dirname(fullDest), { recursive: true });

      const buffer = Buffer.from(f.data, 'base64');
      fs.writeFileSync(fullDest, buffer);
      totalBytes += buffer.length;
    }

    // Use rclone to copy staging folder to remote:targetPath
    const destSpec = targetPath ? `${remote}:${targetPath}` : `${remote}:`;
    broadcastWS('task_log', { taskId: logId, logId, logLine: `[Upload] Staged ${files.length} file(s) (${(totalBytes / 1024 / 1024).toFixed(2)} MB). Transferring to ${destSpec}...\n` });

    const rcloneRes = await rclone.execRclone([
      'copy', uploadsTempDir, destSpec,
      '--stats', '1s',
      '--transfers', '16',
      '--checkers', '32',
      '--drive-chunk-size', '64M',
      '--buffer-size', '64M',
      '--use-mmap',
      '--fast-list',
      '--multi-thread-streams', '4'
    ]);

    // Clean up staging directory
    try {
      fs.rmSync(uploadsTempDir, { recursive: true, force: true });
    } catch (e) {}

    if (rcloneRes.success) {
      broadcastWS('task_log', { taskId: logId, logId, logLine: `[Upload] ✅ Upload completed successfully to ${destSpec}!\n` });
      broadcastWS('task_finished', {
        taskId: logId,
        taskName,
        logId,
        status: 'success',
        bytesTransferred: `${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
        filesTransferred: files.length,
        endTime: new Date().toISOString()
      });
      return res.json({ success: true, filesUploaded: files.length, totalBytes });
    } else {
      broadcastWS('task_log', { taskId: logId, logId, logLine: `[Upload] ❌ Upload failed: ${rcloneRes.output}\n` });
      broadcastWS('task_finished', {
        taskId: logId,
        taskName,
        logId,
        status: 'failed',
        bytesTransferred: '0 B',
        endTime: new Date().toISOString()
      });
      return res.status(500).json({ error: rcloneRes.output || 'Upload failed' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get execution log history
 */
app.get('/api/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const logs = await db.all(
      'SELECT id, task_id, task_name, start_time, end_time, status, bytes_transferred, files_transferred FROM logs ORDER BY start_time DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );
    const total = await db.get('SELECT COUNT(*) as count FROM logs');
    res.json({ logs, total: total.count, limit, offset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get full log detail for a single execution
 */
app.get('/api/logs/:id', async (req, res) => {
  try {
    const log = await db.get('SELECT * FROM logs WHERE id = ?', [req.params.id]);
    if (!log) return res.status(404).json({ error: 'Log not found' });
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API 404 handler
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
});

// Generic API error handler
app.use('/api', (err, req, res, next) => {
  console.error('[API Error]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[AutoBackup Hub] Server running on http://localhost:${PORT}`);
  // Pre-warm capacity quota metrics for all connected remotes on startup
  rclone.prewarmRemoteAboutCache().catch(() => {});
});

// Process safety: prevent sudden crashes on unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[AutoBackup Hub] Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[AutoBackup Hub] Uncaught Exception:', err);
});

// Graceful shutdown handling
function gracefulShutdown(signal) {
  console.log(`[AutoBackup Hub] Received ${signal}. Shutting down gracefully...`);
  clearInterval(wsHeartbeatInterval);
  for (const client of connectedSockets) {
    try { client.close(1001, 'Server shutting down'); } catch (e) {}
  }
  server.close(() => {
    console.log('[AutoBackup Hub] HTTP & WebSocket servers closed.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[AutoBackup Hub] Forced shutdown after timeout.');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

