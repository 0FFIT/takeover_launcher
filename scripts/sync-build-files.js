#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Get version from command line argument
const version = process.argv[2];
if (!version) {
  console.error('[!] Error: Version argument required');
  process.exit(1);
}

try {
  const projectRoot = path.join(__dirname, '..');
  const publicBaseUrl = String(process.env.BUNNY_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');

  // 1. Update package.json
  const pkgPath = path.join(projectRoot, 'package.json');
  let pkgContent = fs.readFileSync(pkgPath, 'utf8');
  pkgContent = pkgContent.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`);
  fs.writeFileSync(pkgPath, pkgContent, 'utf8');

  // 2. Update config.json
  const cfgPath = path.join(projectRoot, 'config.json');
  let config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  config.version = version;
  config.launcher_version = version;
  config.launcher_exe_url = publicBaseUrl ? `${publicBaseUrl}/launcher/takeover_launcher.exe` : (config.launcher_exe_url || '');
  config.update_base_url = publicBaseUrl || (config.update_base_url || '');
  config.updates_json_url = publicBaseUrl ? `${publicBaseUrl}/updates.json` : (config.updates_json_url || '');
  config.launcher_feed_url = publicBaseUrl ? `${publicBaseUrl}/launcher-feed.json` : (config.launcher_feed_url || '');
  config.music_base_url = publicBaseUrl ? `${publicBaseUrl}/music` : (config.music_base_url || '');
  config.videos_base_url = publicBaseUrl ? `${publicBaseUrl}/videos` : (config.videos_base_url || '');
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');

  console.log('[+] All files synced successfully');
  process.exit(0);
} catch (error) {
  console.error(`[!] Error: ${error.message}`);
  process.exit(1);
}
