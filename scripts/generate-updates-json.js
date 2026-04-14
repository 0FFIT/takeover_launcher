#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { signManifest } = require('../manifest-security');

const version = process.argv[2];
if (!version) { console.error('[!] Error: Version argument required'); process.exit(1); }

const changelog = (process.env.CHANGELOG || 'Maintenance update')
  .split('|').map(s => s.trim()).filter(Boolean);
const publicBaseUrl = (process.env.BUNNY_PUBLIC_BASE_URL || 'https://aimtrain.b-cdn.net').replace(/\/+$/, '');

const projectRoot = path.join(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const exeFileName = 'takeover_launcher.exe';
const exePath = path.join(distDir, exeFileName);

if (!fs.existsSync(exePath)) {
  console.error(`[!] Error: ${exeFileName} not found in dist/`);
  process.exit(1);
}

// Streaming SHA256 (no full-file memory load)
const hash = crypto.createHash('sha256');
const stream = fs.createReadStream(exePath);
stream.on('data', chunk => hash.update(chunk));
stream.on('end', () => {
  const sha256 = hash.digest('hex');
  const fileSize = fs.statSync(exePath).size;

  const updatesJson = signManifest({
    version,
    exe_url: `${publicBaseUrl}/launcher/${exeFileName}`,
    sha256,
    changelog,
    timestamp: new Date().toISOString(),
  });

  const updatesPath = path.join(distDir, 'updates.json');
  fs.writeFileSync(updatesPath, JSON.stringify(updatesJson, null, 2), 'utf8');

  console.log('[+] updates.json generated');
  console.log(`    Version: ${version}`);
  console.log(`    Changelog: ${changelog.join(' | ')}`);
  console.log(`    SHA256: ${sha256.substring(0, 16)}...`);
  console.log(`    Location: dist/updates.json`);
});
stream.on('error', (e) => { console.error(`[!] Error: ${e.message}`); process.exit(1); });
