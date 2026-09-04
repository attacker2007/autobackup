const fs = require('fs');
const path = require('path');
const os = require('os');
const archiverMod = require('archiver');
const db = require('./db');

function createZipArchive(options = {}) {
  if (typeof archiverMod === 'function') {
    return archiverMod('zip', options);
  }
  if (archiverMod && archiverMod.ZipArchive) {
    return new archiverMod.ZipArchive(options);
  }
  if (archiverMod && archiverMod.default) {
    if (typeof archiverMod.default === 'function') {
      return archiverMod.default('zip', options);
    }
    if (archiverMod.default.ZipArchive) {
      return new archiverMod.default.ZipArchive(options);
    }
  }
  throw new Error('Unsupported archiver module structure');
}

const BUNDLE_DIR = path.join(os.tmpdir(), 'autobackup-bundles');
if (!fs.existsSync(BUNDLE_DIR)) {
  try { fs.mkdirSync(BUNDLE_DIR, { recursive: true }); } catch (e) {}
}

// Default exclusion glob patterns for code/project directories
const DEFAULT_EXCLUSIONS = [
  'node_modules',
  '.next',
  'dist',
  'build',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.turbo',
  '.DS_Store',
  'Thumbs.db'
];

/**
 * Check if a relative path matches any exclusion rule
 */
function isExcluded(relPath, customExclusions = []) {
  const normalized = relPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const patterns = [...DEFAULT_EXCLUSIONS, ...customExclusions];

  for (const part of parts) {
    if (patterns.includes(part)) return true;
  }
  return false;
}

/**
 * Fast directory walker collecting file metadata (relative path, mtime, size)
 */
function scanDirectory(dirPath, baseDir = dirPath, customExclusions = []) {
  const files = [];
  if (!fs.existsSync(dirPath)) return files;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

      if (isExcluded(relPath, customExclusions)) {
        continue;
      }

      if (entry.isDirectory()) {
        const subFiles = scanDirectory(fullPath, baseDir, customExclusions);
        files.push(...subFiles);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          const stat = fs.statSync(fullPath);
          files.push({
            fullPath,
            relPath,
            size: stat.size,
            mtimeMs: Math.floor(stat.mtimeMs)
          });
        } catch (e) {}
      }
    }
  } catch (err) {
    console.warn('[Bundler] Error scanning directory:', dirPath, err.message);
  }

  return files;
}

/**
 * Compare current file scan against previously stored manifest fingerprint
 */
async function detectFolderChanges(taskId, sourcePath, currentFiles) {
  const manifestKey = `manifest_${taskId}_${Buffer.from(sourcePath).toString('base64').slice(0, 32)}`;
  
  let previousManifest = null;
  try {
    const row = await db.get('SELECT value FROM settings WHERE key = ?', [manifestKey]);
    if (row && row.value) {
      previousManifest = JSON.parse(row.value);
    }
  } catch (e) {}

  const currentMap = new Map();
  let totalBytes = 0;
  for (const f of currentFiles) {
    currentMap.set(f.relPath, { size: f.size, mtimeMs: f.mtimeMs });
    totalBytes += f.size;
  }

  if (!previousManifest) {
    // First time backing up this folder
    return {
      changed: true,
      reason: 'initial_backup',
      modifiedCount: currentFiles.length,
      totalFiles: currentFiles.length,
      totalBytes,
      manifestKey,
      currentMap
    };
  }

  const prevMap = new Map(Object.entries(previousManifest.files || {}));
  const added = [];
  const modified = [];
  const deleted = [];

  for (const [relPath, info] of currentMap.entries()) {
    if (!prevMap.has(relPath)) {
      added.push(relPath);
    } else {
      const prev = prevMap.get(relPath);
      if (prev.size !== info.size || prev.mtimeMs !== info.mtimeMs) {
        modified.push(relPath);
      }
    }
  }

  for (const relPath of prevMap.keys()) {
    if (!currentMap.has(relPath)) {
      deleted.push(relPath);
    }
  }

  const hasChanges = (added.length > 0 || modified.length > 0 || deleted.length > 0);

  return {
    changed: hasChanges,
    reason: hasChanges ? `${added.length} added, ${modified.length} modified, ${deleted.length} deleted` : 'unchanged',
    added,
    modified,
    deleted,
    totalFiles: currentFiles.length,
    totalBytes,
    manifestKey,
    currentMap
  };
}

/**
 * Save current folder file fingerprint into SQLite settings table
 */
async function saveFolderManifest(manifestKey, currentMap, totalBytes) {
  try {
    const filesObj = {};
    for (const [relPath, info] of currentMap.entries()) {
      filesObj[relPath] = info;
    }
    const payload = JSON.stringify({
      updatedAt: new Date().toISOString(),
      totalFiles: currentMap.size,
      totalBytes,
      files: filesObj
    });
    await db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [manifestKey, payload]
    );
  } catch (e) {
    console.warn('[Bundler] Failed saving folder manifest:', e.message);
  }
}

/**
 * Compress directory into a single local .zip archive with embedded manifest
 */
async function createLocalBundle(taskId, taskName, sourcePath, options = {}) {
  const startTime = Date.now();
  const folderName = path.basename(sourcePath.replace(/[\\\/]+$/, '')) || 'project';
  const customExclusions = options.customExclusions || [];
  const force = !!options.force;

  // 1. Scan directory with smart code exclusions
  const currentFiles = scanDirectory(sourcePath, sourcePath, customExclusions);

  // 2. Perform change detection against previous backup run
  const changeResult = await detectFolderChanges(taskId, sourcePath, currentFiles);

  if (!changeResult.changed && !force) {
    return {
      changed: false,
      reason: 'No files have been modified since last backup.',
      totalFiles: currentFiles.length,
      totalBytes: changeResult.totalBytes,
      durationMs: Date.now() - startTime
    };
  }

  // 3. Prepare unique output zip path in OS temp bundles folder
  const dateStr = new Date().toISOString().slice(0, 10);
  const timeStr = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  const zipFileName = `${folderName}_${dateStr}_${timeStr}.zip`;
  const zipPath = path.join(BUNDLE_DIR, zipFileName);

  // 4. Stream archive creation
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = createZipArchive({
      zlib: { level: 6 } // Balanced high-speed deflate compression
    });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    // Embed AutoBackup provenance manifest inside the root of the .zip
    const manifestContent = JSON.stringify({
      app: 'AutoBackup',
      taskId,
      taskName,
      sourcePath,
      createdAt: new Date().toISOString(),
      totalFiles: currentFiles.length,
      totalBytes: changeResult.totalBytes,
      changeSummary: changeResult.reason,
      files: currentFiles.map(f => ({ path: f.relPath, size: f.size, mtime: new Date(f.mtimeMs).toISOString() }))
    }, null, 2);

    archive.append(manifestContent, { name: '.autobackup-manifest.json' });

    // Append all selected project files
    for (const file of currentFiles) {
      archive.file(file.fullPath, { name: file.relPath });
    }

    archive.finalize();
  });

  const zipStat = fs.statSync(zipPath);
  const durationMs = Date.now() - startTime;

  // 5. Update saved manifest state
  await saveFolderManifest(changeResult.manifestKey, changeResult.currentMap, changeResult.totalBytes);

  return {
    changed: true,
    zipPath,
    zipFileName,
    originalBytes: changeResult.totalBytes,
    bundleBytes: zipStat.size,
    totalFiles: currentFiles.length,
    durationMs,
    changeReason: changeResult.reason
  };
}

/**
 * Remove temporary bundle archive after successful cloud transfer
 */
function cleanupBundle(zipPath) {
  if (zipPath && fs.existsSync(zipPath)) {
    try {
      fs.unlinkSync(zipPath);
      return true;
    } catch (e) {
      console.warn('[Bundler] Failed to remove temporary bundle:', e.message);
      return false;
    }
  }
  return false;
}

/**
 * Prune stale bundles older than 2 hours in temp directory
 */
function pruneStaleBundles() {
  try {
    if (!fs.existsSync(BUNDLE_DIR)) return;
    const now = Date.now();
    const files = fs.readdirSync(BUNDLE_DIR);
    for (const file of files) {
      if (file.endsWith('.zip')) {
        const fullPath = path.join(BUNDLE_DIR, file);
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > 2 * 60 * 60 * 1000) {
          fs.unlinkSync(fullPath);
        }
      }
    }
  } catch (e) {}
}

// Run cleanup on startup
pruneStaleBundles();

module.exports = {
  scanDirectory,
  detectFolderChanges,
  createLocalBundle,
  cleanupBundle,
  pruneStaleBundles,
  BUNDLE_DIR
};
