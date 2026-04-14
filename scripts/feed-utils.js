const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv']);

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

function calculateSHA256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function encodeUrlPath(relativePath) {
  return relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function normalizeServerEntry(entry, index) {
  const raw = typeof entry === 'string' ? entry.trim() : '';
  const source = raw || '';
  const objectEntry = entry && typeof entry === 'object' ? entry : null;
  const ip = String(objectEntry?.ip || objectEntry?.host || '').trim() || (source.includes(':') ? source.slice(0, source.lastIndexOf(':')).trim() : source);
  const portValue = objectEntry?.port ?? (source.includes(':') ? source.slice(source.lastIndexOf(':') + 1).trim() : '');
  const port = Number.parseInt(portValue, 10);
  const name = String(objectEntry?.name || objectEntry?.title || '').trim();

  if (!ip) return null;

  return {
    id: String(objectEntry?.id || `${ip}:${Number.isFinite(port) ? port : 28015}` || `server-${index}`).trim(),
    name,
    ip,
    port: Number.isFinite(port) ? port : 28015,
  };
}

function normalizeServers(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map(normalizeServerEntry)
    .filter((entry) => entry && entry.ip);
}

async function buildLauncherFeed({ projectRoot, publicBaseUrl, version }) {
  const feedPath = path.join(projectRoot, 'launcher-feed.json');
  const musicDir = path.join(projectRoot, 'music');
  const videosDir = path.join(projectRoot, 'videos');
  let baseFeed = {};

  if (fs.existsSync(feedPath)) {
    baseFeed = JSON.parse(fs.readFileSync(feedPath, 'utf8'));
  }

  const musicFiles = walkFiles(musicDir)
    .filter((filePath) => AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  const files = [];
  for (const filePath of musicFiles) {
    const relativePath = path.relative(musicDir, filePath).replace(/\\/g, '/');
    const sha256 = await calculateSHA256(filePath);
    const stat = fs.statSync(filePath);
    files.push({
      id: relativePath,
      path: relativePath,
      title: path.basename(relativePath, path.extname(relativePath)),
      url: `${publicBaseUrl}/music/${encodeUrlPath(relativePath)}`,
      sha256,
      size: stat.size,
    });
  }

  const videoFiles = walkFiles(videosDir)
    .filter((filePath) => VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  const videos = [];
  for (const filePath of videoFiles) {
    const relativePath = path.relative(videosDir, filePath).replace(/\\/g, '/');
    const sha256 = await calculateSHA256(filePath);
    const stat = fs.statSync(filePath);
    videos.push({
      id: relativePath,
      path: relativePath,
      title: path.basename(relativePath, path.extname(relativePath)),
      url: `${publicBaseUrl}/videos/${encodeUrlPath(relativePath)}`,
      sha256,
      size: stat.size,
    });
  }

  return {
    announcements: Array.isArray(baseFeed.announcements) ? baseFeed.announcements : [],
    discord_url: baseFeed.discord_url ? String(baseFeed.discord_url).trim() : null,
    minimum_launcher_version: baseFeed.minimum_launcher_version || null,
    servers: normalizeServers(baseFeed.servers),
    music: {
      enabled: baseFeed?.music?.enabled !== false,
      files,
    },
    videos: {
      enabled: baseFeed?.videos?.enabled !== false,
      files: videos,
    },
    generated_at: new Date().toISOString(),
    generated_for_version: version,
  };
}

module.exports = {
  buildLauncherFeed,
  calculateSHA256,
  encodeUrlPath,
  normalizeServers,
};
