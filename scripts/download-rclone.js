const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const binDir = path.join(__dirname, '../bin');
const rcloneExe = path.join(binDir, 'rclone.exe');

if (fs.existsSync(rcloneExe)) {
  console.log('[Setup] rclone.exe already exists at', rcloneExe);
  process.exit(0);
}

if (!fs.existsSync(binDir)) {
  fs.mkdirSync(binDir, { recursive: true });
}

console.log('[Setup] Downloading official Windows rclone.exe...');
const downloadUrl = 'https://downloads.rclone.org/rclone-current-windows-amd64.zip';
const zipPath = path.join(binDir, 'rclone.zip');

try {
  // Use PowerShell on Windows for fast downloading and zip extraction
  const psCmd = `powershell -Command "Invoke-WebRequest -Uri '${downloadUrl}' -OutFile '${zipPath}'; Expand-Archive -Path '${zipPath}' -DestinationPath '${path.join(binDir, 'temp')}' -Force; Get-ChildItem -Path '${path.join(binDir, 'temp')}' -Recurse -Filter 'rclone.exe' | Copy-Item -Destination '${rcloneExe}'; Remove-Item -Recurse -Force '${path.join(binDir, 'temp')}', '${zipPath}'"`;
  execSync(psCmd, { stdio: 'inherit' });
  console.log('[Setup] rclone.exe successfully downloaded and installed to', rcloneExe);
} catch (err) {
  console.error('[Setup] Error downloading rclone.exe:', err.message);
  process.exit(1);
}
