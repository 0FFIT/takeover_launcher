#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { buildLauncherFeed } = require('./feed-utils');
const { signManifest } = require('../manifest-security');

async function main() {
  const projectRoot = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const version = process.argv[2] || pkg.version;
  const publicBaseUrl = (process.env.BUNNY_PUBLIC_BASE_URL || 'https://aimtrain.b-cdn.net').replace(/\/+$/, '');
  const distDir = path.join(projectRoot, 'dist');

  fs.mkdirSync(distDir, { recursive: true });

  const feed = signManifest(await buildLauncherFeed({ projectRoot, publicBaseUrl, version }));
  const outPath = path.join(distDir, 'launcher-feed.json');
  fs.writeFileSync(outPath, JSON.stringify(feed, null, 2), 'utf8');

  console.log('[+] launcher-feed.json generated');
  console.log(`    Version: ${version}`);
  console.log(`    Announcements: ${feed.announcements.length}`);
  console.log(`    Music files: ${feed.music.files.length}`);
  console.log(`    Video files: ${feed.videos.files.length}`);
  console.log(`    Servers: ${feed.servers.length}`);
  console.log(`    Location: ${outPath}`);
}

main().catch((error) => {
  console.error(`[!] Error: ${error.message}`);
  process.exit(1);
});
