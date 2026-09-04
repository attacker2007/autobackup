const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const CONFIG_DIR = process.env.CONFIG_DIR || path.join(__dirname, '../config');
const RCLONE_CONFIG_PATH = process.env.RCLONE_CONFIG || path.join(CONFIG_DIR, 'rclone.conf');

// Ensure config dir and rclone.conf exist
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}
if (!fs.existsSync(RCLONE_CONFIG_PATH)) {
  fs.writeFileSync(RCLONE_CONFIG_PATH, '', 'utf8');
}

/**
 * Detect the appropriate rclone executable binary.
 * Supports packaged Electron app (extraResources), local development (bin/), or system PATH.
 */
function getRcloneBinaryPath() {
  if (process.env.RCLONE_PATH && fs.existsSync(process.env.RCLONE_PATH)) {
    return process.env.RCLONE_PATH;
  }

  if (process.resourcesPath) {
    const resPath = path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'rclone.exe' : 'rclone');
    if (fs.existsSync(resPath)) return resPath;
    const directResPath = path.join(process.resourcesPath, process.platform === 'win32' ? 'rclone.exe' : 'rclone');
    if (fs.existsSync(directResPath)) return directResPath;
  }

  const localBin = path.join(__dirname, '../bin', process.platform === 'win32' ? 'rclone.exe' : 'rclone');
  if (fs.existsSync(localBin)) {
    return localBin;
  }

  return process.platform === 'win32' ? 'rclone.exe' : 'rclone';
}

let sourcesPathCache = {};
let sourcesPathCacheTime = 0;

/**
 * Refresh in-memory mapping from sources table in database
 */
async function refreshSourcesPathCache() {
  try {
    const dbHelper = require('./db');
    const rows = await dbHelper.all('SELECT container_path, host_path, name FROM sources');
    const newMap = {};
    for (const r of rows) {
      if (r.container_path && r.host_path) {
        newMap[r.container_path.trim().toLowerCase()] = r.host_path.trim();
        newMap[r.container_path.trim()] = r.host_path.trim();
      }
    }
    sourcesPathCache = newMap;
    sourcesPathCacheTime = Date.now();
  } catch (e) {}
}

// Preload cache asynchronously
refreshSourcesPathCache().catch(() => {});

/**
 * Resolves a source path, seamlessly mapping legacy container paths (/hostfs/F/..., /Documents/Important)
 * to native Windows drive paths if running natively on Windows.
 */
function resolveSourcePath(rawPath) {
  if (!rawPath) return rawPath;
  let normalized = rawPath.replace(/\\/g, '/');

  // Direct native existence check
  if (fs.existsSync(normalized) || fs.existsSync(rawPath)) {
    return rawPath;
  }

  // 1. Convert Docker container host mounts (/hostfs/F/foo -> F:/foo)
  const hostfsMatch = normalized.match(/^\/hostfs\/([A-Za-z])(?:\/(.*))?$/);
  if (hostfsMatch) {
    const drive = hostfsMatch[1].toUpperCase();
    const rest = hostfsMatch[2] || '';
    const winPath = rest ? `${drive}:/${rest}` : `${drive}:/`;
    return winPath;
  }

  // 2. Check dynamic database sources table mapping
  const lowNorm = normalized.toLowerCase();
  if (sourcesPathCache[lowNorm]) {
    const mapped = sourcesPathCache[lowNorm].replace(/\\/g, '/');
    return mapped;
  }
  if (sourcesPathCache[rawPath]) {
    const mapped = sourcesPathCache[rawPath].replace(/\\/g, '/');
    return mapped;
  }

  // 3. Check Windows user profile standard folders & OneDrive redirects
  if (process.platform === 'win32' && process.env.USERPROFILE) {
    const userProfile = process.env.USERPROFILE.replace(/\\/g, '/');
    
    // Check if OneDrive redirects exist
    const oneDriveDocs = `${userProfile}/OneDrive/Documents`;
    const oneDrivePics = `${userProfile}/OneDrive/Pictures`;
    const localDocs = `${userProfile}/Documents`;
    const localPics = `${userProfile}/Pictures`;

    const directMappings = {
      '/Documents/Important': fs.existsSync(`${localDocs}/Important`) ? `${localDocs}/Important` : `${oneDriveDocs}/Important`,
      '/Documents/Others': fs.existsSync(oneDriveDocs) ? oneDriveDocs : localDocs,
      '/Pictures': fs.existsSync(oneDrivePics) ? oneDrivePics : localPics,
      '/Work/MST': `${userProfile}/Downloads/product-catalog-node_5_1`,
      '/Code/espsniffer': `${userProfile}/Downloads/esp32_sniffer`,
      '/Games/Pokemon/SolarEclipse': `${userProfile}/Downloads/Solar Eclipse (v1.9.0)`,
      '/Work/QuranMerge': `${userProfile}/Downloads/Quran_MergeWords`,
      '/Code/autobackup': 'F:/autobackup',
      '/Code/wlancomm': 'F:/interwlancommunicator'
    };

    if (directMappings[normalized]) {
      return directMappings[normalized];
    }
  }

  return rawPath;
}

/**
 * Execute arbitrary rclone command passing RCLONE_CONFIG env
 */
function execRclone(args = []) {
  return new Promise((resolve) => {
    const rcloneBin = getRcloneBinaryPath();
    const quotedBin = rcloneBin.includes(' ') ? `"${rcloneBin}"` : rcloneBin;
    const cmdArgs = ['--config', RCLONE_CONFIG_PATH, ...args];
    const cmd = `${quotedBin} ${cmdArgs.map(a => `"${a}"`).join(' ')}`;

    exec(cmd, { 
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, RCLONE_CONFIG: RCLONE_CONFIG_PATH }
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, output: stderr || stdout || error.message, error });
      } else {
        resolve({ success: true, output: stdout.trim(), stderr });
      }
    });
  });
}

// Cache for listRemotes to avoid repeated subprocess spawning
let listRemotesCache = null;
let listRemotesCacheTime = 0;
const LIST_REMOTES_CACHE_TTL_MS = 30 * 1000; // 30 seconds

/**
 * Get list of configured rclone remotes
 */
async function listRemotes() {
  // Serve from cache if fresh
  if (listRemotesCache && (Date.now() - listRemotesCacheTime < LIST_REMOTES_CACHE_TTL_MS)) {
    return listRemotesCache;
  }

  const remotesSet = new Set();

  // Always parse config file directly first (no subprocess needed)
  if (fs.existsSync(RCLONE_CONFIG_PATH)) {
    try {
      const content = fs.readFileSync(RCLONE_CONFIG_PATH, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          const remoteName = trimmed.slice(1, -1).trim();
          if (remoteName) remotesSet.add(remoteName);
        }
      }
    } catch (e) {
      console.error('Error reading rclone.conf directly:', e);
    }
  }

  // Supplement with rclone listremotes (may add env-based remotes not in config file)
  try {
    const res = await execRclone(['listremotes']);
    if (res.success && res.output) {
      res.output
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .forEach(name => remotesSet.add(name.replace(/:$/, '')));
    }
  } catch (e) {}

  const result = Array.from(remotesSet);
  listRemotesCache = result;
  listRemotesCacheTime = Date.now();
  return result;
}

/** Invalidate the listRemotes cache (call after add/delete remote) */
function invalidateListRemotesCache() {
  listRemotesCache = null;
  listRemotesCacheTime = 0;
}

/**
 * Get detailed remote metadata from rclone.conf
 */
function getRemotesDetails() {
  if (!fs.existsSync(RCLONE_CONFIG_PATH)) return [];
  const content = fs.readFileSync(RCLONE_CONFIG_PATH, 'utf8');
  const lines = content.split('\n');
  
  const remotes = [];
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      if (current) remotes.push(current);
      current = { name: trimmed.slice(1, -1).trim(), type: 'unknown', details: {} };
    } else if (current && trimmed.includes('=')) {
      const [key, ...valParts] = trimmed.split('=');
      const k = key.trim();
      const v = valParts.join('=').trim();
      if (k === 'type') {
        current.type = v;
      } else {
        current.details[k] = v;
      }
    }
  }
  if (current) remotes.push(current);
  return remotes;
}

/**
 * Check if rclone CLI is available in system
 */
async function checkRcloneInstalled() {
  const res = await execRclone(['version']);
  return res.success;
}

/**
 * Humanize rclone CLI errors into clear, actionable messages for the user.
 */
function humanizeRcloneError(errMessage, remoteName = '') {
  if (!errMessage) return 'An unknown error occurred.';
  const str = String(errMessage);

  if (str.includes('401') || str.includes('Invalid Credentials') || str.includes('authError') || str.includes('invalid_grant')) {
    return `OAuth Authentication Failed${remoteName ? ' for "' + remoteName + '"' : ''}. Access token expired or credentials were revoked. Please re-authorize using the Re-Auth button.`;
  }
  if (str.includes('2094') || str.includes('Invalid \'access_token\' provided')) {
    return `pCloud Authentication Error${remoteName ? ' for "' + remoteName + '"' : ''}. Verify if account is EU (eapi.pcloud.com) or US (api.pcloud.com) and update your token.`;
  }
  if (str.includes('userRateLimitExceeded') || str.includes('rateLimitExceeded') || str.includes('rate limit') || str.includes('Queries per 100') || str.includes('usageLimits')) {
    return `Cloud API Rate Limit exceeded for ${remoteName ? '"' + remoteName + '"' : 'remote'}. Google/Cloud provider temporarily throttled API requests. Automatic retry will resume shortly.`;
  }
  if (str.includes('storage limit') || str.includes('disk full') || str.includes('insufficient storage') || str.includes('user has exceeded their storage quota') || (str.includes('storage') && str.includes('quota'))) {
    return `Storage Quota Exceeded${remoteName ? ' on "' + remoteName + '"' : ''}. Your cloud storage has run out of free space.`;
  }
  if (str.includes('directory not found') || str.includes('file not found')) {
    return `Path Not Found${remoteName ? ' on "' + remoteName + '"' : ''}. The specified directory or file path does not exist on your cloud storage.`;
  }
  if (str.includes('timeout') || str.includes('deadline exceeded') || str.includes('Cloud quota response timeout')) {
    return `Connection Timeout connecting to ${remoteName ? '"' + remoteName + '"' : 'cloud remote'}. Remote server took too long to respond.`;
  }

  return str;
}

/**
 * Sanitize and write rclone.conf content to both RCLONE_CONFIG_PATH and /root/.config/rclone/rclone.conf
 */
function sanitizeAndWriteRcloneConfig(rawContent) {
  if (!rawContent) return;
  const lines = rawContent.split('\n');
  const sanitizedLines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('token =') || trimmed.startsWith('token=')) {
      const eqIdx = line.indexOf('=');
      const prefix = line.substring(0, eqIdx + 1);
      let val = line.substring(eqIdx + 1).trim();

      let rawVal = val.replace(/^['"]|['"]$/g, '').trim();

      // If user provided a raw access token string without JSON wrapper
      if (!rawVal.startsWith('{') && rawVal.length > 10) {
        rawVal = JSON.stringify({ access_token: rawVal, token_type: 'bearer' });
      }

      try {
        const obj = JSON.parse(rawVal);
        const hasRefreshToken = !!(obj.refresh_token && String(obj.refresh_token).trim());

        if (hasRefreshToken) {
          // For services WITH refresh_token (Google Drive, Dropbox, OneDrive, Box):
          // rclone REQUIRES the expiry timestamp to determine when to trigger token refresh.
          // If expiry is missing, invalid, or year 0001, set to past date so rclone triggers automatic OAuth refresh!
          if (!obj.expiry || String(obj.expiry).startsWith('0001-01-01') || new Date(obj.expiry).getFullYear() < 2000) {
            obj.expiry = '2000-01-01T00:00:00Z';
            rawVal = JSON.stringify(obj);
          }
        } else {
          // For services WITHOUT refresh_token (pCloud, non-expiring bearer tokens):
          // Delete year 0001 or invalid expiry so rclone treats token as non-expiring bearer token.
          if (obj.expiry) {
            const expStr = String(obj.expiry);
            const expYear = new Date(expStr).getFullYear();
            if (expStr.startsWith('0001-01-01') || expStr.startsWith('1970-01-01') || isNaN(expYear) || expYear < 2000) {
              delete obj.expiry;
              rawVal = JSON.stringify(obj);
            }
          }
        }
        return `${prefix} ${rawVal}`;
      } catch (e) {
        return line;
      }
    }
    return line;
  });

  // Write config file
  const finalContent = sanitizedLines.join('\n');
  fs.writeFileSync(RCLONE_CONFIG_PATH, finalContent, 'utf8');
}

function sanitizeRcloneConfigFile() {
  if (fs.existsSync(RCLONE_CONFIG_PATH)) {
    const content = fs.readFileSync(RCLONE_CONFIG_PATH, 'utf8');
    sanitizeAndWriteRcloneConfig(content);
  }
}

/**
 * Add or update remote configuration in rclone.conf
 */
async function addRemoteConfig(name, type, options = {}) {
  let content = '';
  if (fs.existsSync(RCLONE_CONFIG_PATH)) {
    content = fs.readFileSync(RCLONE_CONFIG_PATH, 'utf8');
  }

  const sectionHeader = `[${name}]`;
  const lines = content.split('\n');
  const newLines = [];
  let inSection = false;

  for (const line of lines) {
    if (line.trim().startsWith('[') && line.trim().endsWith(']')) {
      inSection = (line.trim() === sectionHeader);
    }
    if (!inSection) {
      newLines.push(line);
    }
  }

  const sectionLines = [sectionHeader, `type = ${type}`];
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== null && value !== '') {
      sectionLines.push(`${key} = ${value}`);
    }
  }

  const updatedContent = newLines.join('\n').trim() + '\n\n' + sectionLines.join('\n') + '\n';
  sanitizeAndWriteRcloneConfig(updatedContent);

  return await testRemoteConnection(name);
}

/**
 * Test a cloud remote connection, measuring ping latency and connectivity
 */
async function testRemoteConnection(name, onLog) {
  const startTime = Date.now();
  onLog && onLog(`[Test] Pinging cloud remote "${name}:"...\n`);
  
  // Fast probe using lsf to measure real network roundtrip latency
  const probeRes = await execRclone(['lsf', '--max-depth', '1', `${name}:`]);
  const latencyMs = Date.now() - startTime;

  let success = probeRes.success;
  let infoOutput = probeRes.output || '';

  if (!success) {
    // Fallback probe
    const lsdRes = await execRclone(['lsd', `${name}:`]);
    success = lsdRes.success;
    infoOutput = lsdRes.output || probeRes.output || 'Failed to list root directory.';
  }

  if (success) {
    onLog && onLog(`[Test] ✅ Connected! Ping latency: ${latencyMs} ms\n`);
  } else {
    onLog && onLog(`[Test Error] ❌ Unable to connect: ${infoOutput}\n`);
  }

  const resultInfo = success 
    ? `⚡ Latency: ${latencyMs} ms | Status: Online & Authenticated`
    : `❌ Error: ${infoOutput.replace(/\n/g, ' ').slice(0, 120)}`;

  return {
    success,
    remote: name,
    latencyMs,
    uploadSpeed: 'High Speed (Multi-Threaded)',
    info: resultInfo,
    raw: infoOutput,
    error: success ? null : infoOutput
  };
}

/**
 * Delete remote configuration from rclone.conf
 */
function deleteRemoteConfig(name) {
  if (!fs.existsSync(RCLONE_CONFIG_PATH)) return true;
  const content = fs.readFileSync(RCLONE_CONFIG_PATH, 'utf8');
  const sectionHeader = `[${name}]`;
  const lines = content.split('\n');
  const newLines = [];
  let inSection = false;

  for (const line of lines) {
    if (line.trim().startsWith('[') && line.trim().endsWith(']')) {
      inSection = (line.trim() === sectionHeader);
    }
    if (!inSection) {
      newLines.push(line);
    }
  }

  const updatedContent = newLines.join('\n').trim() + '\n';
  fs.writeFileSync(RCLONE_CONFIG_PATH, updatedContent, 'utf8');

  try {
    if (fs.existsSync('/root/.config/rclone/rclone.conf')) {
      fs.writeFileSync('/root/.config/rclone/rclone.conf', updatedContent, 'utf8');
    }
  } catch (e) {}

  return true;
}

/**
 * Parse single, comma-separated, or JSON array string of source paths
 */
function parseSourcePaths(sourcePathInput) {
  if (!sourcePathInput) return [];
  if (Array.isArray(sourcePathInput)) {
    return sourcePathInput.map(p => String(p).trim()).filter(Boolean);
  }
  const trimmed = String(sourcePathInput).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(p => String(p).trim()).filter(Boolean);
      }
    } catch (e) {}
  }
  if (trimmed.includes(',')) {
    return trimmed.split(',').map(p => p.trim()).filter(Boolean);
  }
  return [trimmed];
}

const activeTaskProcesses = new Map(); // taskId -> childProcess
const pausedTasks = new Set(); // taskId -> boolean
const cancelledTasks = new Set(); // taskId -> boolean

/**
 * Robustly kill a process and all its children on Windows/Unix
 */
function killProcessTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch (e) {
    try { child.kill('SIGKILL'); } catch (err) {}
  }
}

/**
 * Pause a running backup task gracefully
 */
function pauseBackupTask(taskId) {
  pausedTasks.add(taskId);
  if (activeTaskProcesses.has(taskId)) {
    const child = activeTaskProcesses.get(taskId);
    killProcessTree(child);
    activeTaskProcesses.delete(taskId);
    return true;
  }
  return false;
}

/**
 * Resume/Unpause a backup task
 */
function unpauseTask(taskId) {
  pausedTasks.delete(taskId);
}

/**
 * Check if a task is currently flagged as paused
 */
function isTaskPaused(taskId) {
  return pausedTasks.has(taskId);
}

/**
 * Check if a task is currently flagged as cancelled
 */
function isTaskCancelled(taskId) {
  return cancelledTasks.has(taskId);
}

/**
 * Clear cancellation flag for a task
 */
function clearTaskCancelled(taskId) {
  cancelledTasks.delete(taskId);
}

/**
 * Obscure a plaintext password using rclone binary
 */
function obscurePassword(password) {
  if (!password) return '';
  try {
    const { execFileSync } = require('child_process');
    const rcloneBin = getRcloneBinaryPath();
    const stdout = execFileSync(rcloneBin, ['obscure', password], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000
    });
    return stdout ? stdout.trim() : '';
  } catch (err) {
    console.error('[Rclone] Failed to obscure password:', err.message);
    return password;
  }
}

/**
 * Ensure an rclone crypt wrapper remote exists in rclone.conf
 * e.g. for remote "abdul_GDrive", creates or updates [crypt_abdul_GDrive]
 */
function ensureCryptRemote(baseRemote, password, salt = '', options = {}) {
  if (!baseRemote || !password) return baseRemote;

  const cryptRemoteName = `crypt_${baseRemote}`;
  const obscuredPassword = obscurePassword(password);
  const obscuredSalt = salt ? obscurePassword(salt) : '';

  const filenameEncryption = options.filenameEncryption || 'standard';
  const directoryNameEncryption = options.directoryNameEncryption !== false ? 'true' : 'false';

  let configContent = '';
  if (fs.existsSync(RCLONE_CONFIG_PATH)) {
    configContent = fs.readFileSync(RCLONE_CONFIG_PATH, 'utf8');
  }

  const sectionHeader = `[${cryptRemoteName}]`;
  const blockLines = [
    `[${cryptRemoteName}]`,
    `type = crypt`,
    `remote = ${baseRemote}:encrypted_vault`,
    `password = ${obscuredPassword}`,
    obscuredSalt ? `password2 = ${obscuredSalt}` : '',
    `filename_encryption = ${filenameEncryption}`,
    `directory_name_encryption = ${directoryNameEncryption}`
  ].filter(Boolean).join('\n');

  if (configContent.includes(sectionHeader)) {
    const regex = new RegExp(`\\[${cryptRemoteName}\\][\\s\\S]*?(?=\\n\\[|$)`, 'g');
    configContent = configContent.replace(regex, blockLines + '\n');
  } else {
    configContent = configContent.trim() + '\n\n' + blockLines + '\n';
  }

  sanitizeAndWriteRcloneConfig(configContent);
  console.log(`[Encryption] 🔒 Ensured crypt wrapper remote "${cryptRemoteName}" for base "${baseRemote}"`);
  return cryptRemoteName;
}

/**
 * Cancel/Kill a running task process
 */
function cancelBackupTask(taskId) {
  pausedTasks.delete(taskId);
  cancelledTasks.add(taskId);
  let wasRunning = false;
  if (activeTaskProcesses.has(taskId)) {
    const child = activeTaskProcesses.get(taskId);
    killProcessTree(child);
    activeTaskProcesses.delete(taskId);
    wasRunning = true;
  }
  return wasRunning;
}

/**
 * Helper to parse speed strings like '45.2 KiB/s' or '3.1 MiB/s' to KiB/s
 */
function parseSpeedToKiB(spdStr) {
  if (!spdStr) return 0;
  const m = spdStr.match(/([0-9.]+)\s*([a-zA-Z]+)\/s/i);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit.startsWith('G')) return num * 1024 * 1024;
  if (unit.startsWith('M')) return num * 1024;
  if (unit.startsWith('K')) return num;
  return num / 1024;
}

/**
 * Extract individual failed file records from rclone output log
 */
function extractFailedFiles(logText, sourcePath = '') {
  if (!logText) return [];
  const failed = [];
  const lines = logText.split('\n');

  for (const line of lines) {
    const errorMatch = line.match(/ERROR\s*:\s*([^:\r\n]+?)\s*:\s*(?:Failed to (?:copy|sync|move|open|transfer)|corrupted on transfer)\s*:\s*([^\r\n]+)/i);
    if (errorMatch) {
      let relPath = errorMatch[1].trim();
      let reason = errorMatch[2].trim();

      // Skip non-file logs or system warnings
      if (!relPath || relPath.startsWith('rclone:') || relPath.toLowerCase().includes('fatal error') || relPath.toLowerCase().startsWith('attempt ') || relPath === 'Failed to copy') {
        continue;
      }

      // Clean up common Windows error messages
      if (reason.includes('used by another process') || reason.includes('being used')) {
        reason = 'File in use / locked by another application';
      } else if (reason.includes('Access is denied') || reason.includes('permission denied') || reason.includes('access is denied')) {
        reason = 'Access denied / permission error';
      } else if (reason.includes('file name too long')) {
        reason = 'File path too long for Windows API';
      } else if (reason.includes('quota') || reason.includes('storage limit')) {
        reason = 'Cloud storage quota exceeded';
      } else if (reason.includes('rateLimitExceeded') || reason.includes('userRateLimitExceeded')) {
        reason = 'Cloud provider API rate limit exceeded';
      }

      if (!failed.some(item => item.filePath.toLowerCase() === relPath.toLowerCase())) {
        failed.push({
          filePath: relPath,
          errorReason: reason,
          sourcePath: sourcePath || ''
        });
      }
    }
  }

  return failed;
}

/**
 * Execute a single rclone command for a given source path and destination
 */
function runSingleRcloneTransfer(mode, sourcePath, destination, conflictMode, onProgress, onLog, taskId = null, bwLimit = '', isDryRun = false, options = {}) {
  return new Promise((resolve) => {
    const args = [
      '--config', RCLONE_CONFIG_PATH,
      mode,
      sourcePath,
      destination,
      '-v',
      '-P',
      '--stats', '1s',
      '--transfers', '4',
      '--checkers', '8',
      '--drive-chunk-size', '64M',
      '--buffer-size', '16M',
      '--use-mmap',
      '--multi-thread-streams', '4',
      '--multi-thread-cutoff', '64M',
      '--max-backlog', '200000',
      '--fast-list',
      '--ignore-errors',
      '--timeout', '30s',
      '--contimeout', '15s',
      '--low-level-retries', '10',
      '--retries', '2',
      '--retries-sleep', '2s'
    ];

    if (options && options.filesFrom && fs.existsSync(options.filesFrom)) {
      args.push('--files-from-raw', options.filesFrom);
    }

    if (bwLimit && bwLimit !== 'unlimited') {
      args.push('--bwlimit', bwLimit);
    }
    if (isDryRun) {
      args.push('--dry-run');
    }

    if (conflictMode === 'overwrite') {
      args.push('--ignore-times');
    } else if (conflictMode === 'skip') {
      args.push('--ignore-existing');
    }

    let fullLog = '';
    let lastValidTransferred = '0 B';
    let lastParsedSpeed = '0 KiB/s';
    const startTime = Date.now();

    function extractTransferredBytes(text) {
      const match = text.match(/Transferred:\s+([0-9.]+\s*(?:KiB|MiB|GiB|TiB|B|Bytes|MB|GB|KB))/i);
      if (match && match[1]) {
        return match[1].trim();
      }
      return null;
    }

    function extractCurrentSpeed(text) {
      const match = text.match(/([0-9.]+\s*(?:KiB|MiB|GiB|B)\/s)/i);
      if (match && match[1]) {
        return match[1].trim();
      }
      return null;
    }

    const rcloneBin = getRcloneBinaryPath();
    const child = spawn(rcloneBin, args, {
      shell: false,
      windowsHide: true,
      env: { ...process.env, RCLONE_CONFIG: RCLONE_CONFIG_PATH }
    });

    if (taskId) {
      activeTaskProcesses.set(taskId, child);
    }

    let consecutiveSlowCount = 0;
    let slowdownWarningSent = false;

    const handleData = (data) => {
      const text = data.toString();
      fullLog += text;
      onLog && onLog(text);

      const parsedBytes = extractTransferredBytes(text);
      if (parsedBytes && parsedBytes !== '0 B' && parsedBytes !== '0') {
        lastValidTransferred = parsedBytes;
      }

      const parsedSpd = extractCurrentSpeed(text);
      if (parsedSpd) {
        lastParsedSpeed = parsedSpd;
        const kib = parseSpeedToKiB(parsedSpd);
        const elapsedSec = (Date.now() - startTime) / 1000;
        if (elapsedSec > 10 && kib < 30) {
          consecutiveSlowCount++;
          if (consecutiveSlowCount >= 5 && !slowdownWarningSent) {
            slowdownWarningSent = true;
            const slowNotice = `\n⚠️ [AutoBackup Network Watchdog] Network speed dropped significantly (${parsedSpd}). Rclone retry buffers active.\n`;
            onLog && onLog(slowNotice);
            options.onSlowdown && options.onSlowdown({ speed: parsedSpd, taskId });
          }
        } else if (kib >= 60) {
          consecutiveSlowCount = 0;
          slowdownWarningSent = false;
        }
      }

      if (text.includes('Transferred:')) {
        onProgress && onProgress(text.trim());
      }
    };

    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);

    child.on('close', (code) => {
      if (taskId) activeTaskProcesses.delete(taskId);

      if (taskId && cancelledTasks.has(taskId)) {
        resolve({
          success: false,
          isStopped: true,
          failedFiles: [],
          exitCode: 0,
          output: fullLog + '\n[Task execution stopped by user]',
          bytesTransferred: lastValidTransferred,
          speed: '0 B/s',
          durationSec: Math.max(1, (Date.now() - startTime) / 1000)
        });
        return;
      }

      const failedFiles = extractFailedFiles(fullLog, sourcePath);
      let success = (code === 0);
      let isPartial = false;

      // If rclone exited with error (e.g. code 1, 6, 9) due to individual locked/failed files,
      // treat as PARTIAL success so the task is NOT discarded!
      if (!success && failedFiles.length > 0) {
        isPartial = true;
        success = true;
      }

      const durationSec = Math.max(1, (Date.now() - startTime) / 1000);

      const matches = [...fullLog.matchAll(/Transferred:\s+([0-9.]+\s*(?:KiB|MiB|GiB|TiB|B|Bytes|MB|GB|KB))/gi)];
      if (matches.length > 0) {
        const lastMatch = matches[matches.length - 1];
        if (lastMatch && lastMatch[1]) {
          lastValidTransferred = lastMatch[1].trim();
        }
      }

      resolve({
        success,
        isPartial,
        failedFiles,
        exitCode: code,
        output: fullLog,
        bytesTransferred: lastValidTransferred,
        speed: lastParsedSpeed,
        durationSec
      });
    });

    child.on('error', (err) => {
      if (taskId) activeTaskProcesses.delete(taskId);

      if (taskId && cancelledTasks.has(taskId)) {
        resolve({
          success: false,
          isStopped: true,
          failedFiles: [],
          exitCode: 0,
          output: fullLog + '\n[Task execution stopped by user]',
          bytesTransferred: lastValidTransferred,
          speed: '0 B/s',
          durationSec: Math.max(1, (Date.now() - startTime) / 1000)
        });
        return;
      }

      const errMsg = `Error spawning rclone process: ${err.message}\n`;
      fullLog += errMsg;
      onLog && onLog(errMsg);
      resolve({
        success: false,
        isPartial: false,
        failedFiles: [],
        exitCode: -1,
        output: fullLog,
        bytesTransferred: lastValidTransferred,
        speed: '0 B/s',
      });
    });
  });
}

/**
 * Execute a backup task (supporting single or multi-container sources, bw_limit, and dry-run)
 */
async function runBackupTask(task, onProgress, onLog, options = {}) {
  const { mode = 'copy', source_path, target_remote, target_path, conflict_mode = 'smart', bw_limit = '' } = task;
  const isDryRun = !!options.isDryRun;

  // Pre-flight validation checks
  if (!target_remote) {
    const err = 'Error: Target remote is missing or invalid.';
    onLog && onLog(`${err}\n`);
    return { success: false, exitCode: -1, output: err, bytesTransferred: '0 B', filesTransferred: 0 };
  }

  const isRcloneAvailable = await checkRcloneInstalled();
  if (!isRcloneAvailable) {
    const err = 'Error: Rclone CLI binary is not installed or accessible in system environment PATH.';
    onLog && onLog(`${err}\n`);
    return { success: false, exitCode: -1, output: err, bytesTransferred: '0 B', filesTransferred: 0 };
  }

  const allOriginalSources = parseSourcePaths(source_path);
  let sources = [...allOriginalSources];
  const isMultiFolderTask = (allOriginalSources.length > 1);

  if (Array.isArray(options.selectedSources) && options.selectedSources.length > 0) {
    const rawFilter = options.selectedSources.map(s => String(s).trim().toLowerCase());
    const filtered = sources.filter(s => {
      const low = s.trim().toLowerCase();
      const resolved = resolveSourcePath(s).trim().toLowerCase();
      const bname = path.basename(low);
      const resBname = path.basename(resolved);
      return rawFilter.some(sel => {
        const sTrim = sel.trim();
        return low === sTrim || resolved === sTrim || bname === sTrim || resBname === sTrim || low.includes(sTrim) || resolved.includes(sTrim);
      });
    });
    if (filtered.length > 0) {
      sources = filtered;
      onLog && onLog(`[Partial Task Execution] Running ${sources.length} selected folder(s) only.\n`);
    }
  }

  if (sources.length === 0) {
    const err = 'Error: No local source container paths specified for task.';
    onLog && onLog(`${err}\n`);
    return { success: false, exitCode: -1, output: err, bytesTransferred: '0 B', filesTransferred: 0 };
  }

  // Handle granular subfolder/file partial backup via temporary files-from filter
  let tempFilterFile = null;
  if (Array.isArray(options.subPaths) && options.subPaths.length > 0) {
    try {
      const filterDir = path.join(CONFIG_DIR, 'downloads');
      if (!fs.existsSync(filterDir)) fs.mkdirSync(filterDir, { recursive: true });
      tempFilterFile = path.join(filterDir, `partial_${task.id || 'run'}_${Date.now()}.txt`);
      const formattedLines = options.subPaths.map(p => String(p).trim().replace(/\\/g, '/')).filter(Boolean);
      fs.writeFileSync(tempFilterFile, formattedLines.join('\n'), 'utf8');
      options.filesFrom = tempFilterFile;
      onLog && onLog(`[Partial Task Execution] Selective item filter engaged for ${formattedLines.length} item(s).\n`);
    } catch (e) {
      console.warn('[Rclone] Failed creating partial filter file:', e.message);
    }
  }

  const dryRunTag = isDryRun ? ' [DRY-RUN SIMULATION]' : '';
  const bwTag = bw_limit ? ` [Bandwidth Limit: ${bw_limit}]` : '';

  // Zero-Knowledge Client-Side Encryption
  let effectiveRemote = target_remote;
  const isEncrypted = (task.encrypt_backup === 1) || (options.encryptBackup === true);
  if (isEncrypted) {
    try {
      const dbHelper = require('./db');
      const encPassRow = await dbHelper.get("SELECT value FROM settings WHERE key = 'encryption_password'");
      const encSaltRow = await dbHelper.get("SELECT value FROM settings WHERE key = 'encryption_salt'");
      const pass = encPassRow ? encPassRow.value : '';
      const salt = encSaltRow ? encSaltRow.value : '';
      if (pass) {
        effectiveRemote = ensureCryptRemote(target_remote, pass, salt);
        onLog && onLog(`[Encryption] 🔒 Zero-Knowledge Client-Side AES-256 Encryption active via "${effectiveRemote}"\n`);
      } else {
        onLog && onLog(`[Encryption Warning] ⚠️ Task has encryption enabled, but no Encryption Password is set in Settings. Proceeding with standard unencrypted remote.\n`);
      }
    } catch (e) {
      console.warn('[Encryption] Failed checking encryption settings:', e.message);
    }
  }

  onLog && onLog(`[AutoBackup Engine] Starting task "${task.name}" with ${sources.length} folder(s)... [Mode: ${mode.toUpperCase()}] [Conflict: ${conflict_mode.toUpperCase()}]${bwTag}${dryRunTag}\n`);

  let overallSuccess = true;
  let accumulatedLog = '';
  let totalBytesTransferredStr = '0 B';
  let totalBytesNum = 0;
  let totalDurationSec = 0;
  const failedSources = [];
  const allFailedFiles = [];
  let isAnyPartial = false;

  for (let i = 0; i < sources.length; i++) {
    if (cancelledTasks.has(task.id)) {
      cancelledTasks.delete(task.id);
      if (tempFilterFile && fs.existsSync(tempFilterFile)) { try { fs.unlinkSync(tempFilterFile); } catch (e) {} }
      onLog && onLog(`\n🛑 [Task Stopped] Backup task "${task.name}" execution was stopped by user.\n`);
      return {
        success: false,
        isStopped: true,
        exitCode: 0,
        output: accumulatedLog + '\n[Task Stopped by User]',
        bytesTransferred: totalBytesTransferredStr,
        filesTransferred: i
      };
    }

    if (pausedTasks.has(task.id)) {
      if (tempFilterFile && fs.existsSync(tempFilterFile)) { try { fs.unlinkSync(tempFilterFile); } catch (e) {} }
      onLog && onLog(`\n⏸️ [Task Paused] Backup task "${task.name}" was paused. State saved.\n`);
      return {
        success: false,
        isPaused: true,
        exitCode: 0,
        output: accumulatedLog + '\n[Task Paused]',
        bytesTransferred: totalBytesTransferredStr,
        filesTransferred: i
      };
    }

    const rawSrcPath = sources[i];
    const srcPath = resolveSourcePath(rawSrcPath);
    
    // Compute target destination for this specific folder
    let destination;
    if (!isMultiFolderTask && sources.length === 1) {
      destination = target_path ? `${effectiveRemote}:${target_path}` : `${effectiveRemote}:`;
    } else {
      const folderName = path.basename(srcPath.replace(/[\\\/]+$/, '')) || `folder_${i + 1}`;
      const fullSubPath = target_path 
        ? `${target_path.replace(/[\\\/]+$/, '')}/${folderName}`
        : folderName;
      destination = `${effectiveRemote}:${fullSubPath}`;
    }

    onLog && onLog(`\n=======================================================\n`);
    onLog && onLog(`[Folder ${i + 1}/${sources.length}] Backing up "${srcPath}" -> "${destination}"${dryRunTag}\n`);
    onLog && onLog(`=======================================================\n`);

    // Check directory existence check
    if (!fs.existsSync(srcPath) && !fs.existsSync(path.resolve(srcPath))) {
      onLog && onLog(`[Check Warning] Source path "${srcPath}" not directly found on local filesystem mount. Rclone will attempt remote sync...\n`);
    }

    const res = await runSingleRcloneTransfer(mode, srcPath, destination, conflict_mode, onProgress, onLog, task.id, bw_limit, isDryRun, options);
    accumulatedLog += res.output + '\n';
    totalDurationSec += res.durationSec;

    if (res.isStopped || cancelledTasks.has(task.id)) {
      cancelledTasks.delete(task.id);
      if (tempFilterFile && fs.existsSync(tempFilterFile)) { try { fs.unlinkSync(tempFilterFile); } catch (e) {} }
      onLog && onLog(`\n🛑 [Task Stopped] Backup task "${task.name}" execution was stopped by user.\n`);
      return {
        success: false,
        isStopped: true,
        exitCode: 0,
        output: accumulatedLog + '\n[Task Stopped by User]',
        bytesTransferred: totalBytesTransferredStr,
        filesTransferred: i
      };
    }

    if (res.failedFiles && res.failedFiles.length > 0) {
      allFailedFiles.push(...res.failedFiles);
      isAnyPartial = true;
    }

    if (pausedTasks.has(task.id)) {
      onLog && onLog(`\n⏸️ [Task Paused] Backup task "${task.name}" execution paused. Progress preserved.\n`);
      return {
        success: false,
        isPaused: true,
        exitCode: 0,
        output: accumulatedLog + '\n[Task Paused]',
        bytesTransferred: totalBytesTransferredStr,
        filesTransferred: i + (res.success ? 1 : 0)
      };
    }

    if (!res.success) {
      overallSuccess = false;
      failedSources.push(srcPath);
      onLog && onLog(`❌ [Container ${i + 1}/${sources.length}] Transfer failed for "${srcPath}" (Exit code ${res.exitCode}).\n`);
    } else if (res.isPartial || (res.failedFiles && res.failedFiles.length > 0)) {
      onLog && onLog(`⚠️ [Container ${i + 1}/${sources.length}] Container backup completed with ${res.failedFiles.length} skipped file(s). Remaining files secured.${dryRunTag}\n`);
    } else {
      onLog && onLog(`✅ [Container ${i + 1}/${sources.length}] Container backup completed successfully.${dryRunTag}\n`);
    }

    // Parse bytes transferred for summary
    if (res.bytesTransferred && res.bytesTransferred !== '0 B') {
      totalBytesTransferredStr = res.bytesTransferred;
      const numMatch = res.bytesTransferred.match(/([0-9.]+)\s*([a-zA-Z]+)/);
      if (numMatch) {
        const val = parseFloat(numMatch[1]);
        const unit = numMatch[2].toUpperCase();
        let bytes = val;
        if (unit.startsWith('K')) bytes *= 1024;
        if (unit.startsWith('M')) bytes *= 1024 * 1024;
        if (unit.startsWith('G')) bytes *= 1024 * 1024 * 1024;
        totalBytesNum += bytes;
      }
    }
  }

  // Format final summary
  let finalSpeedStr = '0 KiB/s';
  if (totalBytesNum > 0 && totalDurationSec > 0) {
    const bytesPerSec = totalBytesNum / totalDurationSec;
    if (bytesPerSec >= 1024 * 1024) {
      finalSpeedStr = `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MiB/s`;
    } else if (bytesPerSec >= 1024) {
      finalSpeedStr = `${(bytesPerSec / 1024).toFixed(1)} KiB/s`;
    } else {
      finalSpeedStr = `${bytesPerSec.toFixed(0)} B/s`;
    }
  }

  onLog && onLog(`\n=== 📊 MULTI-CONTAINER TASK SUMMARY${dryRunTag} ===\n`);
  onLog && onLog(`Total Containers Processed: ${sources.length}\n`);
  onLog && onLog(`Successful: ${sources.length - failedSources.length} | Failed: ${failedSources.length}\n`);
  if (failedSources.length > 0) {
    onLog && onLog(`Failed Containers: ${failedSources.join(', ')}\n`);
  }
  if (allFailedFiles.length > 0) {
    onLog && onLog(`Skipped / Failed Files: ${allFailedFiles.length} (Check "Failed Files" to retry or resolve)\n`);
  }
  if (tempFilterFile && fs.existsSync(tempFilterFile)) {
    try { fs.unlinkSync(tempFilterFile); } catch (e) {}
  }

  return {
    success: overallSuccess,
    isPartial: isAnyPartial,
    failedFiles: allFailedFiles,
    exitCode: overallSuccess ? 0 : -1,
    output: accumulatedLog,
    bytesTransferred: `${totalBytesTransferredStr} (${finalSpeedStr})`,
    filesTransferred: sources.length
  };
}

/**
 * Retry only specific failed files for a task using rclone's --files-from-raw
 */
async function retryFailedFiles(task, failedFileItems, onProgress, onLog) {
  if (!failedFileItems || failedFileItems.length === 0) {
    return { success: true, message: 'No failed files to retry.', resolvedFiles: [] };
  }

  const { target_remote, target_path } = task;
  const scratchDir = path.join(CONFIG_DIR, 'scratch');
  if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
  }

  // Determine effective remote (crypt or standard)
  let effectiveRemote = target_remote;
  if (task.encrypt_backup === 1) {
    try {
      const dbHelper = require('./db');
      const encPassRow = await dbHelper.get("SELECT value FROM settings WHERE key = 'encryption_password'");
      const encSaltRow = await dbHelper.get("SELECT value FROM settings WHERE key = 'encryption_salt'");
      const pass = encPassRow ? encPassRow.value : '';
      const salt = encSaltRow ? encSaltRow.value : '';
      if (pass) {
        effectiveRemote = ensureCryptRemote(target_remote, pass, salt);
      }
    } catch (e) {}
  }

  // Group failed files by sourcePath
  const bySource = new Map();
  for (const item of failedFileItems) {
    const sPath = item.source_path || (Array.isArray(task.source_path) ? task.source_path[0] : task.source_path);
    const resolvedSrc = resolveSourcePath(sPath);
    if (!bySource.has(resolvedSrc)) {
      bySource.set(resolvedSrc, []);
    }
    bySource.get(resolvedSrc).push(item);
  }

  let totalResolved = [];
  let overallSuccess = true;

  for (const [srcPath, items] of bySource.entries()) {
    const manifestFile = path.join(scratchDir, `retry_${task.id}_${Date.now()}.txt`);
    const relPaths = items.map(it => it.file_path.replace(/\\/g, '/')).join('\n');
    fs.writeFileSync(manifestFile, relPaths, 'utf8');

    let destination = target_path ? `${effectiveRemote}:${target_path}` : `${effectiveRemote}:`;
    if (Array.isArray(task.source_path) && task.source_path.length > 1) {
      const folderName = path.basename(srcPath.replace(/[\\\/]+$/, ''));
      const fullSubPath = target_path ? `${target_path.replace(/[\\\/]+$/, '')}/${folderName}` : folderName;
      destination = `${effectiveRemote}:${fullSubPath}`;
    }

    onLog && onLog(`\n[Targeted Retry] Retrying ${items.length} previously failed file(s) for "${srcPath}" -> "${destination}"...\n`);

    const res = await runSingleRcloneTransfer(
      'copy',
      srcPath,
      destination,
      'smart',
      onProgress,
      onLog,
      task.id,
      task.bw_limit || '',
      false,
      { filesFrom: manifestFile }
    );

    try { fs.unlinkSync(manifestFile); } catch (e) {}

    const stillFailed = (res.failedFiles || []).map(f => f.filePath.toLowerCase().replace(/\\/g, '/'));
    const succeeded = items.filter(it => !stillFailed.includes(it.file_path.toLowerCase().replace(/\\/g, '/')));

    totalResolved.push(...succeeded);
    if (stillFailed.length > 0) {
      overallSuccess = false;
    }
  }

  return {
    success: overallSuccess,
    resolvedFiles: totalResolved,
    remainingFailedCount: failedFileItems.length - totalResolved.length
  };
}

// In-memory cache for cloud remote quota info
const remoteAboutCacheMap = new Map();
const SUCCESS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes for valid quota
const ERROR_CACHE_TTL_MS = 15 * 1000;       // 15 seconds for errors/timeouts so it retries quickly

/**
 * Query cloud storage quota/capacity metrics via `rclone about` (Cached & Resilient)
 */
async function getRemoteAbout(remoteName) {
  const cached = remoteAboutCacheMap.get(remoteName);
  if (cached) {
    const ttl = cached.isError ? ERROR_CACHE_TTL_MS : SUCCESS_CACHE_TTL_MS;
    if (Date.now() - cached.timestamp < ttl) {
      return cached.data;
    }
  }

  try {
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Cloud quota response timeout')), 12000));
    const rclonePromise = execRclone(['about', `${remoteName}:`, '--json', '--timeout', '10s', '--contimeout', '6s']);

    const res = await Promise.race([rclonePromise, timeoutPromise]);
    if (res && res.success && res.output) {
      const data = JSON.parse(res.output);
      const total = data.total || 0;
      const used = data.used || 0;
      const free = data.free || (total > used ? total - used : 0);
      const pct = total > 0 ? ((used / total) * 100).toFixed(1) : '0';

      const formatSize = (bytes) => {
        if (!bytes || bytes === 0) return '0 B';
        if (bytes >= 1073741824 * 1024) return `${(bytes / (1073741824 * 1024)).toFixed(1)} TB`;
        if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
        if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
        return `${(bytes / 1024).toFixed(1)} KB`;
      };

      const result = {
        success: true,
        totalBytes: total,
        usedBytes: used,
        freeBytes: free,
        totalFormatted: formatSize(total),
        usedFormatted: formatSize(used),
        freeFormatted: formatSize(free),
        percentage: parseFloat(pct)
      };

      remoteAboutCacheMap.set(remoteName, { data: result, timestamp: Date.now(), isError: false });
      return result;
    }
  } catch (e) {
    const humanizedErr = humanizeRcloneError(e ? e.message : '', remoteName);
    console.error(`[Rclone] getRemoteAbout error for ${remoteName}:`, humanizedErr);
    const fallbackResult = { success: false, error: humanizedErr };
    remoteAboutCacheMap.set(remoteName, { data: fallbackResult, timestamp: Date.now(), isError: true });
    return fallbackResult;
  }

  const fallbackResult = { success: false, error: humanizeRcloneError('Remote quota query timed out or unsupported', remoteName) };
  remoteAboutCacheMap.set(remoteName, { data: fallbackResult, timestamp: Date.now(), isError: true });
  return fallbackResult;
}

/**
 * Returns cached remote about data without triggering a fetch.
 * Returns { data, age } or null if no valid/unexpired cache entry exists.
 */
function getCachedRemoteAbout(remoteName) {
  const cached = remoteAboutCacheMap.get(remoteName);
  if (!cached) return null;
  const ttl = cached.isError ? ERROR_CACHE_TTL_MS : SUCCESS_CACHE_TTL_MS;
  const age = Date.now() - cached.timestamp;
  if (age >= ttl) return null;
  return { data: cached.data, age, isError: cached.isError };
}

/**
 * Pre-warm quota cache for all remotes in the background.
 * Runs remotes SERIALLY to avoid filling libuv's 4-thread pool,
 * which would block all other async I/O in the server.
 */
async function prewarmRemoteAboutCache() {
  try {
    const remotes = await listRemotes();
    for (const remote of remotes) {
      await getRemoteAbout(remote).catch(() => {});
      // Generous yield between calls to keep event loop fully responsive
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (e) {}
}

/**
 * List files and directories inside a cloud remote path.
 * Returns an array of { name, path, size, modTime, isDir } objects.
 */
async function listRemoteDir(remoteName, remotePath = '') {
  const target = remotePath ? `${remoteName}:${remotePath}` : `${remoteName}:`;
  const res = await execRclone([
    'lsjson', target,
    '--no-modtime',
    '--timeout', '10s',
    '--contimeout', '5s'
  ]);

  if (!res.success) {
    throw new Error(res.output || 'Failed to list remote directory');
  }

  try {
    const items = JSON.parse(res.output || '[]');
    return items.map(item => ({
      name: item.Name,
      path: remotePath ? `${remotePath}/${item.Name}` : item.Name,
      size: item.Size,
      modTime: item.ModTime,
      isDir: item.IsDir,
      mimeType: item.MimeType
    }));
  } catch (e) {
    throw new Error('Failed to parse remote listing JSON');
  }
}

/**
 * Transfer files/folders from one cloud remote to another (cloud-to-cloud).
 * Accepts single path string or array of paths in srcPaths.
 * Streams live progress to onLog callback.
 */
function transferCloudToCloud(srcRemote, srcPaths, dstRemote, dstPath, mode = 'copy', onLog, taskId = null) {
  return new Promise(async (resolve) => {
    const pathsArr = Array.isArray(srcPaths) ? srcPaths : [srcPaths];
    let fullLog = '';
    let lastTransferred = '0 B';
    const startTime = Date.now();
    let overallSuccess = true;

    for (const sPath of pathsArr) {
      const src = sPath ? `${srcRemote}:${sPath}` : `${srcRemote}:`;
      const dst = dstPath ? `${dstRemote}:${dstPath}` : `${dstRemote}:`;

      const args = [
        '--config', RCLONE_CONFIG_PATH,
        mode, src, dst,
        '-v', '-P',
        '--stats', '1s',
        '--transfers', '4',
        '--checkers', '8',
        '--buffer-size', '16M',
        '--use-mmap',
        '--multi-thread-streams', '4',
        '--multi-thread-cutoff', '64M',
        '--fast-list'
      ];

      const res = await new Promise((resChild) => {
        const rcloneBin = getRcloneBinaryPath();
        const child = spawn(rcloneBin, args, {
          shell: false,
          windowsHide: true,
          env: { ...process.env, RCLONE_CONFIG: RCLONE_CONFIG_PATH }
        });

        if (taskId) activeTaskProcesses.set(taskId, child);

        const handleData = (data) => {
          const text = data.toString();
          fullLog += text;
          onLog && onLog(text);

          const match = text.match(/Transferred:\s+([0-9.]+\s*(?:KiB|MiB|GiB|TiB|B|Bytes|MB|GB|KB))/i);
          if (match && match[1] && match[1] !== '0 B') lastTransferred = match[1].trim();
        };

        child.stdout.on('data', handleData);
        child.stderr.on('data', handleData);

        child.on('close', (code) => {
          if (taskId) activeTaskProcesses.delete(taskId);
          resChild({ success: code === 0, code });
        });

        child.on('error', (err) => {
          if (taskId) activeTaskProcesses.delete(taskId);
          onLog && onLog(`\nTransfer error: ${err.message}\n`);
          resChild({ success: false, code: -1 });
        });
      });

      if (!res.success) overallSuccess = false;
    }

    const durationSec = Math.max(1, (Date.now() - startTime) / 1000);
    resolve({
      success: overallSuccess,
      output: fullLog,
      bytesTransferred: lastTransferred,
      durationSec
    });
  });
}

/**
 * Download one or multiple files/folders from a cloud remote to a local temp path.
 * Automatically packages multiple files or directories into a single .zip file.
 * Returns { localPath, isZip, filename, sessionDir }
 */
async function downloadRemoteFiles(remoteName, remotePaths, onLog, taskId = null) {
  const pathsArr = Array.isArray(remotePaths) ? remotePaths : [remotePaths];
  if (pathsArr.length === 0) throw new Error('No paths specified for download');

  const DOWNLOADS_DIR = path.join(CONFIG_DIR, 'downloads');
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }

  const sessionDir = path.join(DOWNLOADS_DIR, `dl_${Date.now()}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  onLog && onLog(`[Download] Fetching ${pathsArr.length} item(s) from ${remoteName}...\n`);

  for (const rPath of pathsArr) {
    const baseName = path.basename(rPath) || 'root';
    const destTarget = path.join(sessionDir, baseName);
    const src = `${remoteName}:${rPath}`;

    onLog && onLog(` -> Downloading "${src}"...\n`);
    await new Promise((resolve) => {
      const args = [
        '--config', RCLONE_CONFIG_PATH,
        'copy', src, destTarget,
        '-v', '--transfers', '4',
        '--checkers', '8',
        '--buffer-size', '16M',
        '--drive-chunk-size', '64M'
      ];
      const rcloneBin = getRcloneBinaryPath();
      const child = spawn(rcloneBin, args, {
        shell: false,
        windowsHide: true,
        env: { ...process.env, RCLONE_CONFIG: RCLONE_CONFIG_PATH }
      });
      if (taskId) activeTaskProcesses.set(taskId, child);

      child.stdout.on('data', d => onLog && onLog(d.toString()));
      child.stderr.on('data', d => onLog && onLog(d.toString()));
      child.on('close', () => {
        if (taskId) activeTaskProcesses.delete(taskId);
        resolve();
      });
      child.on('error', () => {
        if (taskId) activeTaskProcesses.delete(taskId);
        resolve();
      });
    });
  }

  const downloadedItems = fs.readdirSync(sessionDir);
  if (downloadedItems.length === 0) {
    try { fs.rmdirSync(sessionDir, { recursive: true }); } catch (e) {}
    throw new Error('Download failed: No files retrieved from remote.');
  }

  // If a single file was downloaded, serve directly
  if (downloadedItems.length === 1) {
    const singlePath = path.join(sessionDir, downloadedItems[0]);
    const stat = fs.statSync(singlePath);
    if (stat.isFile()) {
      return { localPath: singlePath, isZip: false, filename: downloadedItems[0], sessionDir };
    }
  }

  // Otherwise (multiple items or folder), zip everything
  const zipFilename = `export_${remoteName}_${Date.now()}.zip`;
  const zipPath = path.join(DOWNLOADS_DIR, zipFilename);

  onLog && onLog(`[Download] Packaging ${downloadedItems.length} item(s) into zip archive...\n`);

  let zipSuccess = false;
  try {
    const archiver = require('archiver');
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(sessionDir, false);
      archive.finalize();
    });
    zipSuccess = true;
  } catch (err) {
    onLog && onLog(`[Download] Archiver fallback: ${err.message}\n`);
  }

  if (!zipSuccess || !fs.existsSync(zipPath)) {
    const tarFilename = `export_${remoteName}_${Date.now()}.tar.gz`;
    const tarPath = path.join(DOWNLOADS_DIR, tarFilename);
    const tarRes = await new Promise((resolve) => {
      exec(`tar -czf "${tarPath}" -C "${sessionDir}" .`, (err) => resolve(!err));
    });
    if (tarRes && fs.existsSync(tarPath)) {
      return { localPath: tarPath, isZip: true, filename: tarFilename, sessionDir };
    }
    throw new Error('Failed to create compressed zip archive of downloaded items.');
  }

  return { localPath: zipPath, isZip: true, filename: zipFilename, sessionDir };
}

/**
 * Import raw rclone.conf section block directly into rclone.conf
 */
function importRawConfigBlock(configText) {
  let content = '';
  if (fs.existsSync(RCLONE_CONFIG_PATH)) {
    content = fs.readFileSync(RCLONE_CONFIG_PATH, 'utf8');
  }

  const sectionNames = [];
  const lines = configText.split('\n');
  lines.forEach(l => {
    const m = l.trim().match(/^\[([a-zA-Z0-9_\-]+)\]$/);
    if (m) sectionNames.push(m[1]);
  });

  if (sectionNames.length === 0) {
    throw new Error('No valid [remote_name] section header found in config text.');
  }

  let existingLines = content.split('\n');
  let newLines = [];
  let inRemovingSection = false;

  for (const line of existingLines) {
    const m = line.trim().match(/^\[([a-zA-Z0-9_\-]+)\]$/);
    if (m) {
      inRemovingSection = sectionNames.includes(m[1]);
    }
    if (!inRemovingSection) {
      newLines.push(line);
    }
  }

  const updatedContent = newLines.join('\n').trim() + '\n\n' + configText.trim() + '\n';
  sanitizeAndWriteRcloneConfig(updatedContent);

  return sectionNames;
}

module.exports = {
  execRclone,
  listRemotes,
  invalidateListRemotesCache,
  getRemotesDetails,
  getRemoteAbout,
  getCachedRemoteAbout,
  prewarmRemoteAboutCache,
  testRemoteConnection,
  checkRcloneInstalled,
  addRemoteConfig,
  deleteRemoteConfig,
  importRawConfigBlock,
  sanitizeAndWriteRcloneConfig,
  sanitizeRcloneConfigFile,
  runBackupTask,
  pauseBackupTask,
  unpauseTask,
  isTaskPaused,
  cancelBackupTask,
  isTaskCancelled,
  clearTaskCancelled,
  parseSourcePaths,
  resolveSourcePath,
  refreshSourcesPathCache,
  listRemoteDir,
  transferCloudToCloud,
  downloadRemoteFiles,
  humanizeRcloneError,
  ensureCryptRemote,
  obscurePassword,
  retryFailedFiles,
  extractFailedFiles,
  RCLONE_CONFIG_PATH,
  CONFIG_DIR
};
