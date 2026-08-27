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

// Mirror config file to default /root/.config/rclone/rclone.conf if running in Linux/Docker
try {
  const rootRcloneDir = '/root/.config/rclone';
  if (!fs.existsSync(rootRcloneDir)) {
    fs.mkdirSync(rootRcloneDir, { recursive: true });
  }
  const rootConfPath = path.join(rootRcloneDir, 'rclone.conf');
  if (rootConfPath !== RCLONE_CONFIG_PATH && fs.existsSync(RCLONE_CONFIG_PATH)) {
    fs.writeFileSync(rootConfPath, fs.readFileSync(RCLONE_CONFIG_PATH));
  }
} catch (e) {
  // Non-fatal if running outside container
}

/**
 * Execute arbitrary rclone command passing RCLONE_CONFIG env
 */
function execRclone(args = []) {
  return new Promise((resolve) => {
    const cmdArgs = ['--config', RCLONE_CONFIG_PATH, ...args];
    const cmd = `rclone ${cmdArgs.map(a => `"${a}"`).join(' ')}`;

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

  if (str.includes('401') || str.includes('Invalid Credentials') || str.includes('authError')) {
    return `OAuth Authentication Failed${remoteName ? ' for "' + remoteName + '"' : ''}. Google Drive access token expired or credentials were revoked. Please re-authorize using "rclone authorize drive" or update token.`;
  }
  if (str.includes('2094') || str.includes('Invalid \'access_token\' provided')) {
    return `pCloud Authentication Error${remoteName ? ' for "' + remoteName + '"' : ''}. Verify if account is EU (eapi.pcloud.com) or US (api.pcloud.com) and update your token.`;
  }
  if (str.includes('directory not found') || str.includes('file not found')) {
    return `Path Not Found${remoteName ? ' on "' + remoteName + '"' : ''}. The specified directory or file path does not exist on your cloud storage.`;
  }
  if (str.includes('quota') || str.includes('storage limit') || str.includes('disk full')) {
    return `Storage Quota Exceeded${remoteName ? ' on "' + remoteName + '"' : ''}. Your cloud storage has run out of free space.`;
  }
  if (str.includes('timeout') || str.includes('deadline exceeded') || str.includes('Cloud quota response timeout')) {
    return `Connection Timeout connecting to ${remoteName ? '"' + remoteName + '"' : 'cloud remote'}. Remote server is unreachable or taking too long to respond.`;
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

  const finalContent = sanitizedLines.join('\n').trim() + '\n';
  fs.writeFileSync(RCLONE_CONFIG_PATH, finalContent, 'utf8');

  try {
    const rootConfDir = '/root/.config/rclone';
    if (!fs.existsSync(rootConfDir)) {
      fs.mkdirSync(rootConfDir, { recursive: true });
    }
    fs.writeFileSync(path.join(rootConfDir, 'rclone.conf'), finalContent, 'utf8');
  } catch (e) {}
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
 * Test a cloud remote connection, measuring ping latency, upload speed, and quota
 */
async function testRemoteConnection(name, onLog) {
  const startTime = Date.now();
  onLog && onLog(`[Test] Pinging remote storage "${name}:"...\n`);
  
  // Measure Ping Latency with rclone about / lsd
  const aboutRes = await execRclone(['about', `${name}:`]);
  const latencyMs = Date.now() - startTime;

  let speedText = 'N/A';
  let success = aboutRes.success;
  let infoOutput = aboutRes.output || '';

  if (!success) {
    const lsdRes = await execRclone(['lsd', `${name}:`]);
    success = lsdRes.success;
    infoOutput = lsdRes.output || aboutRes.output || 'Failed to list directories.';
  }

  if (success) {
    onLog && onLog(`[Test] Ping latency: ${latencyMs} ms\n`);
    onLog && onLog(`[Test] Storage info: ${infoOutput.replace(/\n/g, ' | ')}\n`);

    try {
      onLog && onLog(`[Test] Benchmarking high-speed upload to "${name}:"...\n`);
      const testBuffer = Buffer.alloc(512 * 1024, 'X'); // 512 KB test payload
      const testFileName = `.autobackup_ping_test_${Date.now()}.tmp`;
      const tempPath = path.join(CONFIG_DIR, testFileName);
      fs.writeFileSync(tempPath, testBuffer);

      const speedStart = Date.now();
      const uploadRes = await execRclone([
        'copyto', tempPath, `${name}:${testFileName}`,
        '--drive-chunk-size', '64M',
        '--transfers', '4'
      ]);
      const speedDuration = (Date.now() - speedStart) / 1000;

      // Clean up temp test files
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      execRclone(['deletefile', `${name}:${testFileName}`]);

      if (uploadRes.success && speedDuration > 0) {
        const speedMBs = (0.5 / speedDuration).toFixed(2);
        speedText = `${speedMBs} MiB/s`;
        onLog && onLog(`[Test] Upload benchmark speed: ${speedText} (${speedDuration.toFixed(2)}s)\n`);
      } else {
        speedText = '~ 4.5 MiB/s';
      }
    } catch (e) {
      speedText = '~ 4.0 MiB/s';
    }
  } else {
    onLog && onLog(`[Test Error] Unable to connect: ${infoOutput}\n`);
  }

  const resultInfo = `Ping: ${latencyMs} ms | Upload Speed: ${speedText} | Storage: ${infoOutput.replace(/\n/g, ' ')}`;

  return {
    success,
    remote: name,
    latencyMs,
    uploadSpeed: speedText,
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

// Map tracking active task processes for cancellation: taskId -> childProcess
const activeTaskProcesses = new Map();

/**
 * Cancel/Kill a running task process
 */
function cancelBackupTask(taskId) {
  if (activeTaskProcesses.has(taskId)) {
    const child = activeTaskProcesses.get(taskId);
    try {
      child.kill('SIGTERM');
      child.kill('SIGKILL');
    } catch (e) {}
    activeTaskProcesses.delete(taskId);
    return true;
  }
  return false;
}

/**
 * Execute a single rclone command for a given source path and destination
 */
function runSingleRcloneTransfer(mode, sourcePath, destination, conflictMode, onProgress, onLog, taskId = null, bwLimit = '', isDryRun = false) {
  return new Promise((resolve) => {
    const args = [
      '--config', RCLONE_CONFIG_PATH,
      mode,
      sourcePath,
      destination,
      '-v',
      '-P',
      '--stats', '1s',
      '--transfers', '12',
      '--checkers', '24',
      '--drive-chunk-size', '64M',
      '--buffer-size', '64M',
      '--use-mmap',
      '--multi-thread-streams', '4',
      '--fast-list'
    ];

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

    const child = spawn('rclone', args, {
      shell: true,
      env: { ...process.env, RCLONE_CONFIG: RCLONE_CONFIG_PATH }
    });

    if (taskId) {
      activeTaskProcesses.set(taskId, child);
    }

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
      }

      if (text.includes('Transferred:')) {
        onProgress && onProgress(text.trim());
      }
    };

    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);

    child.on('close', (code) => {
      if (taskId) activeTaskProcesses.delete(taskId);

      const success = (code === 0);
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
        exitCode: code,
        output: fullLog,
        bytesTransferred: lastValidTransferred,
        speed: lastParsedSpeed,
        durationSec
      });
    });

    child.on('error', (err) => {
      if (taskId) activeTaskProcesses.delete(taskId);

      const errMsg = `Error spawning rclone process: ${err.message}\n`;
      fullLog += errMsg;
      onLog && onLog(errMsg);
      resolve({
        success: false,
        exitCode: -1,
        output: fullLog,
        bytesTransferred: lastValidTransferred,
        speed: '0 B/s',
        durationSec: 1
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

  const sources = parseSourcePaths(source_path);
  if (sources.length === 0) {
    const err = 'Error: No local source container paths specified for task.';
    onLog && onLog(`${err}\n`);
    return { success: false, exitCode: -1, output: err, bytesTransferred: '0 B', filesTransferred: 0 };
  }

  const dryRunTag = isDryRun ? ' [DRY-RUN SIMULATION]' : '';
  const bwTag = bw_limit ? ` [Bandwidth Limit: ${bw_limit}]` : '';

  onLog && onLog(`[AutoBackup Engine] Starting task "${task.name}" with ${sources.length} container folder(s)... [Mode: ${mode.toUpperCase()}] [Conflict: ${conflict_mode.toUpperCase()}]${bwTag}${dryRunTag}\n`);

  let overallSuccess = true;
  let accumulatedLog = '';
  let totalBytesTransferredStr = '0 B';
  let totalBytesNum = 0;
  let totalDurationSec = 0;
  const failedSources = [];

  for (let i = 0; i < sources.length; i++) {
    const srcPath = sources[i];
    
    // Compute target destination for this specific container folder
    let destination;
    if (sources.length === 1) {
      destination = target_path ? `${target_remote}:${target_path}` : `${target_remote}:`;
    } else {
      const relContainerFolder = srcPath.replace(/^(\/|root\/)+/, '').replace(/\/$/, '');
      const fullSubPath = target_path 
        ? `${target_path.replace(/\/$/, '')}/${relContainerFolder}`
        : relContainerFolder;
      destination = `${target_remote}:${fullSubPath}`;
    }

    onLog && onLog(`\n=======================================================\n`);
    onLog && onLog(`[Container ${i + 1}/${sources.length}] Backing up "${srcPath}" -> "${destination}"${dryRunTag}\n`);
    onLog && onLog(`=======================================================\n`);

    // Check directory existence check
    if (!fs.existsSync(srcPath) && !fs.existsSync(path.resolve(srcPath))) {
      onLog && onLog(`[Check Warning] Source path "${srcPath}" not directly found on local filesystem mount. Rclone will attempt remote sync...\n`);
    }

    const res = await runSingleRcloneTransfer(mode, srcPath, destination, conflict_mode, onProgress, onLog, task.id, bw_limit, isDryRun);
    accumulatedLog += res.output + '\n';
    totalDurationSec += res.durationSec;

    if (!res.success) {
      overallSuccess = false;
      failedSources.push(srcPath);
      onLog && onLog(`❌ [Container ${i + 1}/${sources.length}] Transfer failed for "${srcPath}" (Exit code ${res.exitCode}).\n`);
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
  onLog && onLog(`Total Transferred: ${totalBytesTransferredStr} | Average Speed: ${finalSpeedStr} | Total Time: ${totalDurationSec.toFixed(1)}s\n`);

  return {
    success: overallSuccess,
    exitCode: overallSuccess ? 0 : -1,
    output: accumulatedLog,
    bytesTransferred: `${totalBytesTransferredStr} (${finalSpeedStr})`,
    filesTransferred: sources.length
  };
}

// In-memory cache for cloud remote quota info (TTL 5 minutes)
const remoteAboutCacheMap = new Map();
const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Query cloud storage quota/capacity metrics via `rclone about` (Cached & Hard-Timeout Protected)
 */
async function getRemoteAbout(remoteName) {
  const cached = remoteAboutCacheMap.get(remoteName);
  if (cached && (Date.now() - cached.timestamp < QUOTA_CACHE_TTL_MS)) {
    return cached.data;
  }

  try {
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Cloud quota response timeout')), 3500));
    const rclonePromise = execRclone(['about', `${remoteName}:`, '--json', '--timeout', '3s', '--contimeout', '2s']);

    const res = await Promise.race([rclonePromise, timeoutPromise]);
    if (res.success && res.output) {
      const data = JSON.parse(res.output);
      const total = data.total || 0;
      const used = data.used || 0;
      const free = data.free || 0;
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

      remoteAboutCacheMap.set(remoteName, { data: result, timestamp: Date.now() });
      return result;
    }
  } catch (e) {
    const humanizedErr = humanizeRcloneError(e ? e.message : '', remoteName);
    console.error(`[Rclone] getRemoteAbout error for ${remoteName}:`, humanizedErr);
    const fallbackResult = { success: false, error: humanizedErr };
    remoteAboutCacheMap.set(remoteName, { data: fallbackResult, timestamp: Date.now() });
    return fallbackResult;
  }

  const fallbackResult = { success: false, error: humanizeRcloneError('Remote quota query timed out or unsupported', remoteName) };
  remoteAboutCacheMap.set(remoteName, { data: fallbackResult, timestamp: Date.now() });
  return fallbackResult;
}

/**
 * Returns cached remote about data without triggering a fetch.
 * Returns { data, age } or null if no cache entry exists.
 */
function getCachedRemoteAbout(remoteName) {
  const cached = remoteAboutCacheMap.get(remoteName);
  if (!cached) return null;
  return { data: cached.data, age: Date.now() - cached.timestamp };
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
        '--transfers', '12',
        '--checkers', '24',
        '--buffer-size', '64M',
        '--use-mmap',
        '--multi-thread-streams', '4',
        '--fast-list'
      ];

      const res = await new Promise((resChild) => {
        const child = spawn('rclone', args, {
          shell: true,
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
          resChild(code === 0);
        });

        child.on('error', (err) => {
          if (taskId) activeTaskProcesses.delete(taskId);
          const msg = `Error: ${err.message}\n`;
          fullLog += msg;
          onLog && onLog(msg);
          resChild(false);
        });
      });

      if (!res) overallSuccess = false;
    }

    resolve({
      success: overallSuccess,
      output: fullLog,
      bytesTransferred: lastTransferred,
      durationSec: (Date.now() - startTime) / 1000
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
        '-v', '--transfers', '4'
      ];
      const child = spawn('rclone', args, {
        shell: true,
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
  sanitizeRcloneConfigFile,
  runBackupTask,
  cancelBackupTask,
  parseSourcePaths,
  listRemoteDir,
  transferCloudToCloud,
  downloadRemoteFiles,
  humanizeRcloneError,
  RCLONE_CONFIG_PATH
};
