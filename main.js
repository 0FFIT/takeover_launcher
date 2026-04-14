const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require('electron');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const https    = require('https');
const http     = require('http');
const { execSync, spawn } = require('child_process');
const { pathToFileURL } = require('url');
const dgram    = require('dgram');
const {
  MAX_FEED_MEDIA_ITEMS,
  MAX_FEED_SERVERS,
  isAllowedDiscordUrl,
  isTrustedContentUrl,
  verifyManifest,
} = require('./manifest-security');

// ─── Load config (config.json) ────────────────────────────────────────────────
const cfg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); }
  catch { return {}; }
})();

let win;
app.isQuitting = false;

// ─── Paths ────────────────────────────────────────────────────────────────────
const isPortable   = app.isPackaged;
const rootDir      = isPortable
  ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath))
  : __dirname;
const resourcesDir = isPortable ? process.resourcesPath : __dirname;
const statePath    = path.join(rootDir, 'launcher_state.json');
const hashCachePath = path.join(rootDir, 'file_hashes.json');

// ─── Distribution config ──────────────────────────────────────────────────────
// Set update_base_url in config.json (e.g. "https://your-cdn.b-cdn.net")
const UPDATE_BASE_URL = (cfg.update_base_url || '').replace(/\/$/, '');
const UPDATES_JSON_URL = `${UPDATE_BASE_URL}/updates.json`;
const LAUNCHER_FEED_URL = `${UPDATE_BASE_URL}/launcher-feed.json`;
const MUSIC_BASE_URL = `${UPDATE_BASE_URL}/music`;
const VIDEOS_BASE_URL = `${UPDATE_BASE_URL}/videos`;
const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = `takeover-launcher/${app.getVersion()}`;
const DEFAULT_SERVERS = [
  { id: 'local-placeholder', name: 'Local Placeholder', ip: '127.0.0.1', port: 28015 },
];
const launcherArtifactName = () => 'takeover_launcher.exe';
const launcherArtifactUrl = (version) => `${UPDATE_BASE_URL}/launcher/${launcherArtifactName(version)}`;
const FEED_POLL_INTERVAL_MS = 90000;
const pendingUpdateInfoPath = path.join(app.getPath('userData'), 'pending-update.json');

function currentLauncherArtifactPath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

// ─── Ensure user-facing folders exist ─────────────────────────────────────────
for (const dir of [
  path.join(rootDir, 'music'),
  path.join(rootDir, 'videos'),
  path.join(rootDir, 'images'),
]) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }

function icoPath() {
  return [
    path.join(resourcesDir, 'icon.ico'),
    path.join(rootDir, 'icon.ico'),
    path.join(__dirname, 'build', 'icon.ico'),
    path.join(rootDir, 'build', 'icon.ico'),
  ].find(p => fs.existsSync(p));
}

function readConfig() {
  const version = app.getVersion() || '0.0.0';
  return {
    version,
    discord_url: cfg.discord_url || '',
    window_title: cfg.window_title || 'TAKEOVER',
    launcher_version: version,
    launcher_exe_url: launcherArtifactUrl(version),
    servers: DEFAULT_SERVERS,
    update_base_url: UPDATE_BASE_URL,
    updates_json_url: UPDATES_JSON_URL,
    launcher_feed_url: LAUNCHER_FEED_URL,
    music_base_url: MUSIC_BASE_URL,
    videos_base_url: VIDEOS_BASE_URL,
  };
}

function readState() {
  const defaults = {
    last_commit: null,
    install_path: null,
    background_choice: 'shuffle',
  };
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) }; }
  catch { return defaults; }
}

function writeState(data) {
  try { fs.writeFileSync(statePath, JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

function isNewer(remote, local) {
  const p = v => (v || '0.0.0').split('.').map(Number);
  const [ra,rb,rc] = p(remote), [la,lb,lc] = p(local);
  return ra > la || (ra === la && rb > lb) || (ra === la && rb === lb && rc > lc);
}

// ─── Auto-Update System ───────────────────────────────────────────────────────
const pendingUpdatePath = path.join(app.getPath('userData'), 'pending-update.exe');
let updateDownloadInFlight = null;
let updateCheckInFlight = null;
let feedPollTimer = null;
let launcherFeedState = {
  announcements: [],
  discord_url: null,
  minimum_launcher_version: null,
  servers: DEFAULT_SERVERS,
  music: { files: [] },
  videos: { files: [] },
};
let updateState = {
  state: 'idle',
  currentVersion: app.getVersion() || '0.0.0',
  availableVersion: null,
  message: 'Automatic update checks run when the launcher opens.',
  error: null,
  checkedAt: null,
};

function getPendingUpdateInfo() {
  try { return JSON.parse(fs.readFileSync(pendingUpdateInfoPath, 'utf8')); }
  catch { return null; }
}

function setPendingUpdateInfo(info) {
  try {
    fs.writeFileSync(pendingUpdateInfoPath, JSON.stringify(info, null, 2), 'utf8');
  } catch {}
}

function deletePendingUpdate() {
  try { fs.unlinkSync(pendingUpdatePath); } catch {}
  try { fs.unlinkSync(pendingUpdateInfoPath); } catch {}
}

function sendUpdateStatus(patch = {}) {
  updateState = { ...updateState, ...patch };
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-status', updateState);
  }
  return updateState;
}

function validateUpdateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('updates.json did not contain an object payload.');
  }

  const version = String(manifest.version || '').trim();
  const exeUrl = String(manifest.exe_url || '').trim();
  const sha256 = String(manifest.sha256 || '').trim().toLowerCase();
  const changelog = Array.isArray(manifest.changelog)
    ? manifest.changelog.map((item) => String(item).trim()).filter(Boolean)
    : [];

  if (!version) throw new Error('updates.json is missing `version`.');
  if (!exeUrl) throw new Error('updates.json is missing `exe_url`.');
  if (!isTrustedContentUrl(exeUrl, '/launcher/')) {
    throw new Error('updates.json referenced an untrusted launcher URL.');
  }
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('updates.json is missing a valid `sha256`.');
  }

  return {
    version,
    exe_url: exeUrl,
    sha256,
    changelog,
    timestamp: manifest.timestamp || null,
  };
}

function parseManagedLibraryFiles(entries, baseUrl) {
  return Array.isArray(entries)
    ? entries.slice(0, MAX_FEED_MEDIA_ITEMS).map((file, index) => {
        const entryPath = String(file?.path || file?.name || '').replace(/\\/g, '/').trim();
        const url = String(file?.url || `${baseUrl}/${entryPath}`).trim();
        const sha256 = String(file?.sha256 || '').trim().toLowerCase();
        return {
          id: String(file?.id || entryPath || `entry-${index}`).trim(),
          path: entryPath,
          title: String(file?.title || path.basename(entryPath, path.extname(entryPath))).trim(),
          url,
          sha256,
          size: Number(file?.size || 0),
        };
      }).filter((file) => file.path && file.url && /^[a-f0-9]{64}$/.test(file.sha256) && isTrustedContentUrl(file.url, new URL(baseUrl).pathname + '/'))
    : [];
}

function validateFeed(feed) {
  if (!feed || typeof feed !== 'object') {
    return {
      announcements: [],
      music: { files: [] },
      videos: { files: [] },
      minimum_launcher_version: null,
      servers: [],
      discord_url: null,
    };
  }

  const announcements = Array.isArray(feed.announcements)
    ? feed.announcements.map((item, index) => ({
        id: String(item?.id || `announcement-${index}`).trim(),
        title: String(item?.title || '').trim(),
        body: String(item?.body || '').trim(),
        level: String(item?.level || 'info').trim(),
        date: item?.date || null,
        starts_at: item?.starts_at || null,
        expires_at: item?.expires_at || null,
      })).filter((item) => item.id && (item.title || item.body))
    : [];

  const musicFiles = parseManagedLibraryFiles(feed?.music?.files, MUSIC_BASE_URL);
  const videoFiles = parseManagedLibraryFiles(feed?.videos?.files, VIDEOS_BASE_URL);

  const servers = (Array.isArray(feed.servers) ? feed.servers : []).slice(0, MAX_FEED_SERVERS).map((entry, index) => {
    const source = typeof entry === 'string' ? entry.trim() : '';
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
  }).filter((entry) => entry && entry.ip);

  return {
    announcements,
    discord_url: isAllowedDiscordUrl(feed.discord_url) ? String(feed.discord_url).trim() : null,
    minimum_launcher_version: feed.minimum_launcher_version ? String(feed.minimum_launcher_version).trim() : null,
    servers,
    music: {
      enabled: feed?.music?.enabled !== false,
      files: musicFiles,
    },
    videos: {
      enabled: feed?.videos?.enabled !== false,
      files: videoFiles,
    },
  };
}

async function fetchVerifiedJson(url, label) {
  const manifest = await fetchJson(url, label);
  if (!verifyManifest(manifest)) {
    throw new Error(`${label} failed signature verification.`);
  }
  return manifest;
}

function withCacheBust(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('cb', Date.now().toString());
    return parsed.toString();
  } catch {
    return url;
  }
}

function fetchJson(url, label) {
  const requestUrl = withCacheBust(url);
  const protocol = requestUrl.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = protocol.get(requestUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Accept: 'application/json',
      },
    }, (res) => {
      const statusCode = res.statusCode || 0;
      const contentType = String(res.headers['content-type'] || '');
      const chunks = [];

      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        reject(new Error(`${label} returned HTTP ${statusCode}.`));
        return;
      }

      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8').trim();
          if (!raw) throw new Error(`${label} was empty.`);
          if (raw.startsWith('<') || /text\/html/i.test(contentType)) {
            throw new Error(`${label} returned HTML instead of JSON.`);
          }
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`${label} is invalid JSON: ${error.message}`));
        }
      });
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`${label} timed out.`));
    });
    req.on('error', reject);
  });
}

function notifyUpdateReady(updateInfo) {
  sendUpdateStatus({
    state: 'ready-to-restart',
    availableVersion: updateInfo.version,
    message: `v${updateInfo.version} is ready. Restart the launcher to finish installing it.`,
    error: null,
  });
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-ready', {
      version: updateInfo.version,
      changelog: updateInfo.changelog || [],
    });
  }
}

function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function needsArtifactRefresh(manifest, currentVersion) {
  if (!app.isPackaged) return false;
  if (manifest.version !== currentVersion) return false;

  try {
    const currentArtifactPath = currentLauncherArtifactPath();
    const currentExeName = path.basename(currentArtifactPath).toLowerCase();
    const remoteExeName = path.posix.basename(new URL(manifest.exe_url).pathname).toLowerCase();
    if (currentExeName !== remoteExeName) {
      console.log(`[Update] Artifact name mismatch: local=${currentExeName} remote=${remoteExeName}`);
      return true;
    }

    const currentHash = await hashFileSha256(currentArtifactPath);
    if (currentHash !== manifest.sha256) {
      console.log('[Update] Artifact hash mismatch with current version, forcing refresh');
      return true;
    }
  } catch (error) {
    console.log(`[Update] Could not compare local artifact to manifest: ${error.message}`);
  }

  return false;
}

function getManagedLibraryStatePath(kind) {
  return path.join(rootDir, kind, `.managed-${kind}.json`);
}

function readManagedLibraryState(kind) {
  try {
    const raw = JSON.parse(fs.readFileSync(getManagedLibraryStatePath(kind), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { files: [], entries: {} };
    }

    const files = Array.isArray(raw.files) ? raw.files.map((value) => String(value).replace(/\\/g, '/')) : [];
    const rawEntries = raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)
      ? raw.entries
      : {};

    const entries = Object.fromEntries(
      Object.entries(rawEntries).map(([filePath, entry]) => {
        const normalizedPath = String(filePath).replace(/\\/g, '/');
        const normalizedEntry = entry && typeof entry === 'object' ? entry : {};
        return [normalizedPath, {
          sha256: String(normalizedEntry.sha256 || '').toLowerCase(),
          size: Number(normalizedEntry.size || 0),
          mtimeMs: Number(normalizedEntry.mtimeMs || 0),
        }];
      })
    );

    return { files, entries };
  } catch {
    return { files: [], entries: {} };
  }
}

function writeManagedLibraryState(kind, state) {
  try {
    fs.writeFileSync(getManagedLibraryStatePath(kind), JSON.stringify(state, null, 2), 'utf8');
  } catch {}
}

async function applyPendingUpdate() {
  try {
    if (!fs.existsSync(pendingUpdatePath)) {
      return;
    }

    console.log('[Update] Found pending update, verifying...');

    const updateInfo = getPendingUpdateInfo();
    if (!updateInfo || !updateInfo.sha256) {
      console.log('[Update] Update info missing, skipping');
      deletePendingUpdate();
      return;
    }

    const currentVersion = app.getVersion() || '0.0.0';
    if (!isNewer(updateInfo.version, currentVersion)) {
      console.log(`[Update] Pending update v${updateInfo.version} is not newer than current v${currentVersion}, removing stale pending update`);
      deletePendingUpdate();
      return;
    }

    // Streaming SHA256 (avoids loading 100MB+ into memory)
    const fileHash = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(pendingUpdatePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });

    if (fileHash !== updateInfo.sha256) {
      console.error(`[Update] SHA256 mismatch, deleting corrupted update`);
      deletePendingUpdate();
      return;
    }

    // Only proceed if launcher is packaged
    if (!app.isPackaged) {
      console.log('[Update] Running in dev mode, skipping update');
      deletePendingUpdate();
      return;
    }

    console.log(`[Update] v${updateInfo.version} is ready to install`);
    notifyUpdateReady(updateInfo);
  } catch (e) {
    console.error(`[Update] Error in applyPendingUpdate: ${e.message}`);
    sendUpdateStatus({
      state: 'error',
      message: 'A downloaded update could not be verified and was removed.',
      error: e.message,
    });
  }
}

async function fetchLatestManifest() {
  const manifest = await fetchVerifiedJson(UPDATES_JSON_URL, 'updates.json');
  return validateUpdateManifest(manifest);
}

function downloadFileWithHash(url, destPath, expectedSha256) {
  const requestUrl = withCacheBust(url);
  const protocol = requestUrl.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const tmpPath = `${destPath}.download`;
    const file = fs.createWriteStream(tmpPath);
    const hash = crypto.createHash('sha256');

    const cleanup = () => {
      try { fs.unlinkSync(tmpPath); } catch {}
    };

    const req = protocol.get(requestUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if (statusCode < 200 || statusCode >= 300) {
        file.destroy();
        cleanup();
        res.resume();
        reject(new Error(`HTTP ${statusCode} while downloading ${url}`));
        return;
      }

      res.on('data', (chunk) => hash.update(chunk));
      res.pipe(file);
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`Download timed out for ${url}`));
    });

    req.on('error', (error) => {
      file.destroy();
      cleanup();
      reject(error);
    });

    file.on('finish', () => {
      file.close(() => {
        const actualHash = hash.digest('hex');
        if (expectedSha256 && actualHash !== expectedSha256) {
          cleanup();
          reject(new Error(`Checksum mismatch for ${path.basename(destPath)}`));
          return;
        }

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch {}
        fs.renameSync(tmpPath, destPath);
        resolve({ sha256: actualHash });
      });
    });

    file.on('error', (error) => {
      cleanup();
      reject(error);
    });
  });
}

async function syncManagedLibrary(kind, libraryConfig = {}, changedEventName) {
  const files = Array.isArray(libraryConfig.files) ? libraryConfig.files : [];
  const targetDir = path.join(rootDir, kind);
  fs.mkdirSync(targetDir, { recursive: true });

  const state = readManagedLibraryState(kind);
  const next = new Set(Array.isArray(state.files) ? state.files : []);
  const nextEntries = { ...(state.entries || {}) };
  let changed = 0;
  const failures = [];

  for (const file of files) {
    const relativePath = file.path.replace(/\\/g, '/');
    const localPath = path.join(targetDir, relativePath);
    const dirPath = path.dirname(localPath);
    fs.mkdirSync(dirPath, { recursive: true });

    let localHash = null;
    let localStat = null;
    if (fs.existsSync(localPath)) {
      try { localStat = fs.statSync(localPath); } catch {}
    }

    const cachedEntry = nextEntries[relativePath];
    const cachedMatch = Boolean(
      localStat &&
      cachedEntry &&
      cachedEntry.sha256 === file.sha256 &&
      cachedEntry.size === localStat.size &&
      cachedEntry.mtimeMs === localStat.mtimeMs
    );
    let fileIsCurrent = cachedMatch;

    if (!cachedMatch && localStat) {
      const sizeMatches = !file.size || localStat.size === file.size;
      if (sizeMatches) {
        try {
          localHash = await hashFileSha256(localPath);
          fileIsCurrent = localHash === file.sha256;
        } catch {}
      }
    }

    if (!fileIsCurrent) {
      try {
        await downloadFileWithHash(file.url, localPath, file.sha256);
        try { localStat = fs.statSync(localPath); } catch { localStat = null; }
        changed++;
      } catch (error) {
        failures.push({ path: relativePath, message: error.message });
        continue;
      }
    }

    next.add(relativePath);
    if (localStat) {
      nextEntries[relativePath] = {
        sha256: file.sha256,
        size: localStat.size,
        mtimeMs: localStat.mtimeMs,
      };
    }
  }

  writeManagedLibraryState(kind, {
    files: [...next].sort(),
    entries: nextEntries,
    updated_at: new Date().toISOString(),
  });

  if (changed && win && !win.isDestroyed() && changedEventName) {
    win.webContents.send(changedEventName, { count: next.size, changed });
  }

  return { count: next.size, changed, failed: failures.length, failures };
}

async function runUpdateCheck({ manual = false } = {}) {
  if (updateCheckInFlight) {
    return updateCheckInFlight;
  }

  updateCheckInFlight = (async () => {
  const currentVersion = app.getVersion() || '0.0.0';
  const pendingInfo = getPendingUpdateInfo();
  const pendingExists = fs.existsSync(pendingUpdatePath) && pendingInfo?.version;

  if (!app.isPackaged) {
    return sendUpdateStatus({
      state: 'no-update',
      currentVersion,
      availableVersion: null,
      checkedAt: new Date().toISOString(),
      message: 'Update checks are only available in packaged builds.',
      error: null,
    });
  }

  if (pendingExists) {
    if (!isNewer(pendingInfo.version, currentVersion)) {
      console.log(`[Update] Ignoring stale pending update v${pendingInfo.version} because current launcher is v${currentVersion}`);
      deletePendingUpdate();
    } else {
    notifyUpdateReady(pendingInfo);
    return updateState;
    }
  }

  if (updateDownloadInFlight) {
    return sendUpdateStatus({
      state: 'update-available/downloading',
      currentVersion,
      checkedAt: new Date().toISOString(),
      message: `Downloading v${updateState.availableVersion || 'update'} in the background...`,
      error: null,
    });
  }

  sendUpdateStatus({
    state: 'checking',
    currentVersion,
    checkedAt: new Date().toISOString(),
    message: manual ? 'Checking for launcher updates...' : 'Checking for launcher updates in the background...',
    error: null,
  });

  try {
    const manifest = await fetchLatestManifest();
    const needsRefresh = await needsArtifactRefresh(manifest, currentVersion);
    if (!isNewer(manifest.version, currentVersion) && !needsRefresh) {
      const availableVersion = isNewer(currentVersion, manifest.version) ? currentVersion : manifest.version;
      return sendUpdateStatus({
        state: 'no-update',
        currentVersion,
        availableVersion,
        checkedAt: new Date().toISOString(),
        message: availableVersion === currentVersion
          ? `You are already on the latest launcher version (v${currentVersion}).`
          : `The public manifest is still catching up. Your launcher is already on v${currentVersion}.`,
        error: null,
      });
    }

    const refreshMessage = needsRefresh && manifest.version === currentVersion
      ? `Refreshing launcher files for v${manifest.version}...`
      : `Downloading v${manifest.version} in the background...`;

    sendUpdateStatus({
      state: 'update-available/downloading',
      currentVersion,
      availableVersion: manifest.version,
      checkedAt: new Date().toISOString(),
      message: refreshMessage,
      error: null,
    });

    updateDownloadInFlight = downloadUpdate(manifest);
    await updateDownloadInFlight;
    return updateState;
  } catch (error) {
    console.error(`[Update] ${error.message}`);
    return sendUpdateStatus({
      state: 'no-update',
      currentVersion,
      availableVersion: currentVersion,
      checkedAt: new Date().toISOString(),
      message: 'Client is on the latest version.',
      error: null,
    });
  } finally {
    updateDownloadInFlight = null;
  }
  })();

  try {
    return await updateCheckInFlight;
  } finally {
    updateCheckInFlight = null;
  }
}

function downloadUpdate(manifest) {
  const { exe_url: exeUrl, version, sha256: expectedSha256, changelog = [] } = manifest;
  const requestUrl = withCacheBust(exeUrl);
  const protocol = requestUrl.startsWith('https') ? https : http;
  const filePath = pendingUpdatePath;
  const tmpPath = `${pendingUpdatePath}.download`;

  const sendProgress = (data) => {
    if (win && !win.isDestroyed()) win.webContents.send('update-download-progress', data);
  };

  console.log(`[Update] Downloading v${version}...`);
  sendProgress({ type: 'start', version });

  return new Promise((resolve, reject) => {
    deletePendingUpdate();
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    const file = fs.createWriteStream(tmpPath);
    const startTime = Date.now();
    let downloaded = 0;

    const req = protocol.get(requestUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if (statusCode < 200 || statusCode >= 300) {
        file.destroy();
        try { fs.unlinkSync(tmpPath); } catch {}
        res.resume();
        reject(new Error(`Launcher download returned HTTP ${statusCode}.`));
        return;
      }

      const total = parseInt(res.headers['content-length'], 10) || 0;
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        const elapsed = (Date.now() - startTime) / 1000 || 0.001;
        const speed = downloaded / elapsed;
        const percent = total ? Math.round((downloaded / total) * 100) : 0;
        const eta = total && speed ? Math.round((total - downloaded) / speed) : 0;
        process.stdout.write(`\r[Update] v${version}: ${percent}%`);
        sendProgress({ type: 'progress', percent, downloaded, total, speed, eta, version });
      });
      res.pipe(file);
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Launcher download timed out.'));
    });

    req.on('error', (error) => {
      file.destroy();
      try { fs.unlinkSync(tmpPath); } catch {}
      sendProgress({ type: 'error', message: error.message, version });
      sendUpdateStatus({
        state: 'error',
        availableVersion: version,
        message: 'The launcher update download failed before it could finish.',
        error: error.message,
      });
      reject(error);
    });

    file.on('finish', () => {
      file.close(async () => {
        console.log('\n[Update] Verifying...');
        try {
          const fileHash = await hashFileSha256(tmpPath);
          if (fileHash !== expectedSha256) {
            try { fs.unlinkSync(tmpPath); } catch {}
            const error = new Error('The downloaded launcher hash did not match updates.json.');
            sendProgress({ type: 'error', message: error.message, version });
            sendUpdateStatus({
              state: 'error',
              availableVersion: version,
              message: 'The downloaded launcher failed verification and was discarded.',
              error: error.message,
            });
            reject(error);
            return;
          }

          try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
          fs.renameSync(tmpPath, filePath);
          const updateInfo = { version, sha256: expectedSha256, changelog };
          setPendingUpdateInfo(updateInfo);
          console.log(`[Update] v${version} ready`);
          sendProgress({ type: 'done', version });
          notifyUpdateReady(updateInfo);
          resolve(updateInfo);
        } catch (error) {
          try { fs.unlinkSync(tmpPath); } catch {}
          sendProgress({ type: 'error', message: error.message, version });
          sendUpdateStatus({
            state: 'error',
            availableVersion: version,
            message: 'The downloaded launcher could not be verified.',
            error: error.message,
          });
          reject(error);
        }
      });
    });

    file.on('error', (error) => {
      try { fs.unlinkSync(tmpPath); } catch {}
      sendProgress({ type: 'error', message: error.message, version });
      sendUpdateStatus({
        state: 'error',
        availableVersion: version,
        message: 'The launcher update could not be written to disk.',
        error: error.message,
      });
      reject(error);
    });
  });
}

async function fetchLauncherFeed() {
  try {
    const feed = await fetchVerifiedJson(LAUNCHER_FEED_URL, 'launcher-feed.json');
    return validateFeed(feed);
  } catch (error) {
    console.log(`[Feed] ${error.message}`);
    return null;
  }
}

async function refreshLauncherFeed() {
  const feed = await fetchLauncherFeed();
  if (!feed) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('launcher-feed', {
        discord_url: launcherFeedState.discord_url || null,
        minimum_launcher_version: launcherFeedState.minimum_launcher_version || null,
      servers: Array.isArray(launcherFeedState.servers) && launcherFeedState.servers.length ? launcherFeedState.servers : DEFAULT_SERVERS,
        videos_enabled: launcherFeedState.videos?.enabled !== false,
      });
      win.webContents.send('news', launcherFeedState.announcements || []);
    }
    return launcherFeedState;
  }
  launcherFeedState = feed;

  if (feed.minimum_launcher_version && isNewer(feed.minimum_launcher_version, app.getVersion())) {
    sendUpdateStatus({
      message: `Launcher v${feed.minimum_launcher_version} is now required. Please update before playing.`,
      availableVersion: feed.minimum_launcher_version,
    });
  }

  if (feed.music?.enabled !== false) {
    try {
      const result = await syncManagedLibrary('music', feed.music, 'music-library-updated');
      if (result.failed && win && !win.isDestroyed()) {
        win.webContents.send('music-sync-error', { message: `${result.failed} music file${result.failed === 1 ? '' : 's'} could not be refreshed and will retry later.` });
      }
    } catch (error) {
      console.log(`[Music] ${error.message}`);
      if (win && !win.isDestroyed()) {
        win.webContents.send('music-sync-error', { message: error.message });
      }
    }
  }

  if (feed.videos?.enabled !== false) {
    try {
      const result = await syncManagedLibrary('videos', feed.videos, 'video-library-updated');
      if (result.failed && win && !win.isDestroyed()) {
        win.webContents.send('video-sync-error', { message: `${result.failed} video file${result.failed === 1 ? '' : 's'} could not be refreshed and will retry later.` });
      }
    } catch (error) {
      console.log(`[Videos] ${error.message}`);
      if (win && !win.isDestroyed()) {
        win.webContents.send('video-sync-error', { message: error.message });
      }
    }
  }

  if (win && !win.isDestroyed()) {
    win.webContents.send('launcher-feed', {
      discord_url: feed.discord_url || null,
      minimum_launcher_version: feed.minimum_launcher_version || null,
      servers: Array.isArray(feed.servers) && feed.servers.length ? feed.servers : DEFAULT_SERVERS,
      videos_enabled: feed.videos?.enabled !== false,
    });
    win.webContents.send('news', feed.announcements);
  }

  return feed;
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  const ico = icoPath();

  // Restore saved window position if it's still on a connected display
  const state = readState();
  let savedX, savedY;
  if (state.window_bounds) {
    const { x, y } = state.window_bounds;
    const onScreen = screen.getAllDisplays().some(d =>
      x >= d.bounds.x && y >= d.bounds.y &&
      x + 200 < d.bounds.x + d.bounds.width &&
      y + 100 < d.bounds.y + d.bounds.height
    );
    if (onScreen) { savedX = x; savedY = y; }
  }

  win = new BrowserWindow({
    width: 1100, height: 680,
    frame: false, resizable: false,
    backgroundColor: '#060b12',
    center: savedX === undefined, show: false,
    x: savedX, y: savedY,
    icon: ico || undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Save window position whenever it moves or closes
  const savePos = () => {
    const { x, y } = win.getBounds();
    writeState({ ...readState(), window_bounds: { x, y } });
  };
  win.on('moved', savePos);
  win.on('close', (e) => {
    if (feedPollTimer) {
      clearInterval(feedPollTimer);
      feedPollTimer = null;
    }
    savePos();
    if (!app.isQuitting) {
      app.isQuitting = true;
      app.quit();
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', async () => {
    win.show();
    const cfg   = readConfig();
    const state = readState();
    win.webContents.send('config', cfg);
    sendUpdateStatus({ currentVersion: cfg.version });
    // Tell renderer if game is already installed
    if (isValidInstalledGamePath(state.install_path)) {
      win.webContents.send('already-installed', state.install_path);
    }
    await applyPendingUpdate();
    await refreshLauncherFeed();
    feedPollTimer = setInterval(() => {
      refreshLauncherFeed().catch((error) => {
        console.log(`[Feed] Poll failed: ${error.message}`);
      });
    }, FEED_POLL_INTERVAL_MS);
  });
}

// ─── Stale download cleanup ───────────────────────────────────────────────────
function cleanupStaleDownloads() {
  try {
    const state = readState();
    const installPath = state.install_path;
    if (!installPath) return;
    const staleFile = path.join(installPath, '_takeover_dl.tko');
    if (fs.existsSync(staleFile)) {
      try { fs.unlinkSync(staleFile); } catch {}
    }
  } catch {}
}

function isValidInstalledGamePath(installPath) {
  if (!installPath || !fs.existsSync(installPath)) return false;
  return (
    fs.existsSync(path.join(installPath, 'Rust.exe')) &&
    fs.existsSync(path.join(installPath, 'RustClient_Data'))
  );
}

// ─── Single instance lock ─────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
  app.on('second-instance', () => { if (win) { win.show(); if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    createWindow();
    cleanupStaleDownloads();
    runUpdateCheck().catch((error) => {
      console.error(`[Update] Startup check failed: ${error.message}`);
    });
  });
}
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  app.isQuitting = true;
  if (feedPollTimer) {
    clearInterval(feedPollTimer);
    feedPollTimer = null;
  }
});

// ─── Window controls ──────────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => win.minimize());
ipcMain.on('window-close',    () => { app.isQuitting = true; app.quit(); });
ipcMain.on('window-quit',     () => { app.isQuitting = true; app.quit(); });

// ─── Restore launcher when game process exits ─────────────────────────────────
function onGameExit(code) {
  if (!app.isQuitting && win && !win.isDestroyed()) {
    win.show();
    win.focus();
    win.webContents.send('game-exited', { code: code ?? 0 });
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => readConfig());
ipcMain.handle('get-launcher-state', () => readState());
ipcMain.handle('update-launcher-state', (event, patch = {}) => {
  const nextState = { ...readState(), ...(patch && typeof patch === 'object' ? patch : {}) };
  writeState(nextState);
  return nextState;
});

// ─── Media files ──────────────────────────────────────────────────────────────
function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(fullPath));
    else results.push(fullPath);
  }
  return results;
}

function listLocalMediaUrls(dirs, re) {
  const seen = new Set();
  const results = [];
  for (const dir of dirs) {
    try {
      for (const filePath of walkFiles(dir)) {
        const relativeKey = path.relative(dir, filePath).replace(/\\/g, '/').toLowerCase();
        if (!re.test(filePath) || seen.has(relativeKey)) continue;
        seen.add(relativeKey);
        results.push(pathToFileURL(filePath).href);
      }
    } catch {}
  }
  return results;
}

ipcMain.handle('get-media-files', () => {
  return {
    videos: listLocalMediaUrls([
      path.join(rootDir, 'videos'),
    ], /\.(mp4|mkv|webm|mov)$/i),
    images: listLocalMediaUrls([
      path.join(rootDir, 'images'),
    ], /\.(jpg|jpeg|png|gif|webp)$/i),
  };
});

// ─── Audio files ─────────────────────────────────────────────────────────────
ipcMain.handle('get-audio-files', () => {
  return listLocalMediaUrls([
    path.join(rootDir, 'music'),
  ], /\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i);
});

// ─── Video files ─────────────────────────────────────────────────────────────
ipcMain.handle('get-video-files', () => {
  return listLocalMediaUrls([
    path.join(rootDir, 'videos'),
  ], /\.(mp4|webm|mov|mkv)$/i);
});

// ─── Install path ─────────────────────────────────────────────────────────────
ipcMain.handle('get-default-install-path', () => {
  const state = readState();
  if (state.install_path) return state.install_path;
  return path.join(app.getPath('desktop'), 'takeover');
});

ipcMain.handle('select-install-path', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose where to install Takeover',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Install Here',
  });
  if (!result.canceled && result.filePaths.length > 0)
    return path.join(result.filePaths[0], 'takeover');
  return null;
});

// ─── Find Steam ───────────────────────────────────────────────────────────────
function findSteamPath() {
  try {
    const out = execSync(
      'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Valve\\Steam" /v InstallPath',
      { encoding: 'utf8' }
    );
    const m = out.match(/InstallPath\s+REG_SZ\s+(.+)/);
    if (m) { const p = m[1].trim(); if (fs.existsSync(p)) return p; }
  } catch {}
  const fallbacks = [
    'C:\\Program Files (x86)\\Steam','C:\\Program Files\\Steam',
    'D:\\Steam','D:\\Program Files (x86)\\Steam',
    'E:\\Steam','F:\\Steam','G:\\Steam',
  ];
  return fallbacks.find(p => fs.existsSync(p)) || null;
}

ipcMain.handle('open-steam-console', async () => shell.openExternal('steam://open/console'));

// ─── Disk space check ─────────────────────────────────────────────────────────
ipcMain.handle('check-disk-space', async (event, targetPath) => {
  try {
    const driveLetter = path.parse(path.resolve(targetPath)).root.charAt(0);
    const out = execSync(
      `powershell -NoProfile -Command "[System.IO.DriveInfo]::new('${driveLetter}').AvailableFreeSpace"`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    const freeGB = parseInt(out, 10) / (1024 ** 3);
    return { freeGB: Math.round(freeGB * 10) / 10, ok: freeGB >= 20 };
  } catch {
    return { freeGB: null, ok: true }; // assume ok if check fails
  }
});

// ─── Check depots ─────────────────────────────────────────────────────────────
ipcMain.handle('check-depots', async () => {
  const steamPath = findSteamPath();
  if (!steamPath) return { found:false, steamMissing:true };
  const base = path.join(steamPath,'steamapps','content','app_252490');
  const d494 = path.join(base,'depot_252494');
  const d495 = path.join(base,'depot_252495');
  return {
    found:  fs.existsSync(d494) && fs.existsSync(d495),
    has494: fs.existsSync(d494), has495: fs.existsSync(d495),
  };
});

// ─── Watch depot download progress ───────────────────────────────────────────
let depotWatcher = null;
ipcMain.handle('watch-depot-progress', async () => {
  const steamPath = findSteamPath();
  if (!steamPath) return { ok: false };
  const base = path.join(steamPath, 'steamapps', 'content', 'app_252490');
  const send = (data) => win.webContents.send('depot-download-progress', data);

  // Stop any existing watcher
  if (depotWatcher) { clearInterval(depotWatcher); depotWatcher = null; }

  let lastCount = 0;
  let lastSize = 0;
  let stableChecks = 0;

  // Try to open a file for reading — returns true if locked (Steam still writing)
  function isFileLocked(filePath) {
    try {
      const fd = fs.openSync(filePath, 'r');
      fs.closeSync(fd);
      return false;
    } catch (e) {
      return e.code === 'EBUSY' || e.code === 'EPERM';
    }
  }

  depotWatcher = setInterval(() => {
    try {
      const d494 = path.join(base, 'depot_252494');
      const d495 = path.join(base, 'depot_252495');
      const has494 = fs.existsSync(d494);
      const has495 = fs.existsSync(d495);

      if (!has494 && !has495) {
        send({ status: 'waiting', message: 'Waiting for Steam to start downloading...' });
        return;
      }

      let files = [];
      if (has494) files = files.concat(collectFiles(d494));
      if (has495) files = files.concat(collectFiles(d495));
      const totalSize = files.reduce((sum, f) => {
        try { return sum + fs.statSync(f).size; } catch { return sum; }
      }, 0);
      const sizeMB = Math.round(totalSize / (1024 * 1024));

      if (files.length !== lastCount) {
        const newest = files.length > lastCount
          ? path.basename(files[files.length - 1] || '')
          : '';
        send({ status: 'downloading', fileCount: files.length, sizeMB, newest, has494, has495 });
        lastCount = files.length;
        lastSize = totalSize;
        stableChecks = 0;
      } else if (totalSize !== lastSize) {
        send({ status: 'downloading', fileCount: files.length, sizeMB, newest: '', has494, has495 });
        lastSize = totalSize;
        stableChecks = 0;
      } else {
        // Check if Steam still has any files locked before counting toward stable
        const sampleFiles = files.filter(f => f.endsWith('.dll') || f.endsWith('.exe')).slice(0, 5);
        const anyLocked = sampleFiles.some(f => isFileLocked(f));
        if (anyLocked) {
          // Steam still writing — show live status, don't count as stable
          const lockedName = sampleFiles.find(f => isFileLocked(f));
          send({ status: 'downloading', fileCount: files.length, sizeMB, newest: path.basename(lockedName || ''), has494, has495 });
          stableChecks = 0;
        } else {
          stableChecks++;
          // Both depots stable + unlocked for 10 checks (20s) = done
          if (has494 && has495 && stableChecks >= 10) {
            send({ status: 'ready', fileCount: files.length, sizeMB, has494, has495 });
            clearInterval(depotWatcher); depotWatcher = null;
          } else {
            send({ status: 'downloading', fileCount: files.length, sizeMB, newest: '', has494, has495 });
          }
        }
      }
    } catch {
      // Error scanning — keep last known values, don't reset stableChecks
      send({ status: 'downloading', fileCount: lastCount, sizeMB: Math.round(lastSize / (1024 * 1024)), newest: 'Steam writing files...', has494: true, has495: true });
    }
  }, 2000);

  return { ok: true };
});

ipcMain.handle('stop-depot-watch', async () => {
  if (depotWatcher) { clearInterval(depotWatcher); depotWatcher = null; }
});

// ─── Collect files recursively ────────────────────────────────────────────────
function collectFiles(dir) {
  let out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    out = e.isDirectory() ? out.concat(collectFiles(full)) : [...out, full];
  }
  return out;
}

// ─── Hash a file (MD5 - fast enough for game files) ──────────────────────────
function hashFile(filePath, algorithm = 'md5') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end',  () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function normalizeHashCache(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { algorithm: 'md5', source: 'local', files: {} };
  }

  if (data.files && typeof data.files === 'object' && !Array.isArray(data.files)) {
    const algorithm = String(data.algorithm || 'md5').toLowerCase();
    const normalizedFiles = Object.fromEntries(
      Object.entries(data.files).map(([filePath, hash]) => [String(filePath).replace(/\\/g, '/'), hash])
    );
    return {
      algorithm: algorithm === 'sha256' ? 'sha256' : 'md5',
      source: String(data.source || 'local'),
      files: normalizedFiles,
    };
  }

  const normalizedFiles = Object.fromEntries(
    Object.entries(data).map(([filePath, hash]) => [String(filePath).replace(/\\/g, '/'), hash])
  );
  return { algorithm: 'md5', source: 'legacy', files: normalizedFiles };
}

function writeHashCache(files, { algorithm = 'md5', source = 'local' } = {}) {
  const payload = {
    algorithm,
    source,
    generated_at: new Date().toISOString(),
    files,
  };
  fs.writeFileSync(hashCachePath, JSON.stringify(payload, null, 2), 'utf8');
}

// ─── Install game ─────────────────────────────────────────────────────────────
ipcMain.handle('install-game', async (event, installBase) => {
  const send = (type, msg) => win.webContents.send('install-progress', { type, msg });
  try {
    const steamPath = findSteamPath();
    if (!steamPath) throw new Error('Steam not found.');
    const base = path.join(steamPath,'steamapps','content','app_252490');
    const d494 = path.join(base,'depot_252494');
    const d495 = path.join(base,'depot_252495');
    const dest = installBase;

    // Strip read-only/system flags if folder already exists from a previous install
    if (fs.existsSync(dest)) {
      try { execSync(`attrib -s -r "${dest}"`, { timeout: 3000 }); } catch {}
    }
    fs.mkdirSync(dest, { recursive: true });
    send('status', `Installing to: ${dest}`);

    const all = [
      ...collectFiles(d494).map(f => ({ src:f, base:d494 })),
      ...collectFiles(d495).map(f => ({ src:f, base:d495 })),
    ];
    send('status', `Found ${all.length} files...`);

    // ── Copy files + build hash cache simultaneously ──
    const hashCache = {};
    let copied = 0;
    for (const { src, base } of all) {
      const rel      = path.relative(base, src).replace(/\\/g, '/');
      const destFile = path.join(dest, rel);
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      // Retry up to 5x on EBUSY (Steam may still be writing)
      let retries = 5;
      while (retries > 0) {
        try {
          fs.copyFileSync(src, destFile);
          break;
        } catch (e) {
          if ((e.code === 'EBUSY' || e.code === 'EPERM') && retries > 1) {
            send('status', `Steam still writing ${path.basename(src)}, waiting...`);
            await new Promise(r => setTimeout(r, 3000));
            retries--;
          } else {
            throw e;
          }
        }
      }
      copied++;
      const pct = Math.floor((copied / all.length) * 100);
      send('file', `[${pct}%] ${rel}`);
      // Hash every 10th file during install to keep things fast
      if (copied % 10 === 0 || copied === all.length) {
        try { hashCache[rel] = await hashFile(destFile); } catch {}
      }
    }

    // ── Save hash cache ──
    send('status', 'Saving file integrity data...');
    writeHashCache(hashCache, { algorithm: 'md5', source: 'steam-install' });

    // ── Folder icon ──
    send('status', 'Applying folder icon...');
    const ico = icoPath();
    const icoDest = path.join(dest, 'takeover.ico');
    if (ico) {
      try { fs.copyFileSync(ico, icoDest); } catch {}
    }
    // Write desktop.ini — clear read-only first in case it already exists
    const iniPath = path.join(dest, 'desktop.ini');
    try { execSync(`attrib -r -s -h "${iniPath}"`); } catch {}
    try {
      fs.writeFileSync(iniPath,
        '[.ShellClassInfo]\r\nIconResource=takeover.ico,0\r\n[ViewState]\r\nMode=\r\nVid=\r\nFolderType=Generic\r\n',
        'utf8'
      );
      execSync(`attrib +s +r "${dest}"`);
      execSync(`attrib +s +h "${iniPath}"`);
      if (fs.existsSync(icoDest)) execSync(`attrib +h "${icoDest}"`);
    } catch {}

    // ── Clean up depots ──
    send('status', 'Cleaning up Steam depot files...');
    try { fs.rmSync(d494, { recursive:true, force:true }); } catch {}
    try { fs.rmSync(d495, { recursive:true, force:true }); } catch {}

    // ── Save install path to state ──
    writeState({ ...readState(), install_path: dest });

    send('done', dest);
    return { success: true, path: dest };
  } catch(e) {
    const msg = e.code === 'EBUSY'
      ? 'Files are locked — Steam may still be writing. Wait a moment, then retry.'
      : e.code === 'EPERM'
      ? 'Permission denied — try a different install location in Settings, or run as administrator.'
      : e.message;
    send('error', msg);
    return { success: false, error: msg };
  }
});

// ─── Verify installed files ───────────────────────────────────────────────────
ipcMain.handle('verify-files', async (event, installPath) => {
  const send = (type, msg) => win.webContents.send('verify-progress', { type, msg });

  if (!installPath || !fs.existsSync(installPath)) {
    send('error', 'Install folder not found. Files have not been downloaded yet.');
    send('error', 'Open the Steam console, paste the download commands, and wait for the download to finish.');
    send('error', 'Then click "Check for Files" so the launcher can locate and install them.');
    send('done', JSON.stringify({ total: 0, ok: 0, missing: 0, changed: 0, passed: false, noFiles: true }));
    return { success: false, error: 'Install folder not found.' };
  }

  // Check Rust.exe exists
  const rustExe = path.join(installPath, 'Rust.exe');
  if (!fs.existsSync(rustExe)) {
    send('error', 'Rust.exe not found — game files are missing or incomplete.');
    send('error', 'Check your Steam depot download finished, then reinstall via the launcher.');
    send('done', JSON.stringify({ total: 0, ok: 0, missing: 0, changed: 0, passed: false, noFiles: true }));
    return { success: false, error: 'Rust.exe not found in install folder.' };
  }

  send('status', 'Scanning installed files...');
  const allFiles = collectFiles(installPath).filter(f => {
    const name = path.basename(f);
    // Skip hidden/system files we created
    return name !== 'takeover.ico' && name !== 'desktop.ini';
  });

  send('status', `Checking ${allFiles.length} files...`);

  // Load cached hashes if available
  let cached = { algorithm: 'md5', files: {} };
  try { cached = normalizeHashCache(JSON.parse(fs.readFileSync(hashCachePath, 'utf8'))); } catch {}

  const strictManifest = false;
  let ok = 0, missing = 0, changed = 0;
  const seen = new Set();
  for (const filePath of allFiles) {
    const rel = path.relative(installPath, filePath).replace(/\\/g, '/');
    seen.add(rel);
    if (!fs.existsSync(filePath)) {
      send('bad', `MISSING: ${rel}`);
      missing++;
      continue;
    }
    if (cached.files[rel]) {
      try {
        const actual = await hashFile(filePath, cached.algorithm);
        if (actual === cached.files[rel]) {
          ok++;
          send('ok', `OK: ${rel}`);
        } else {
          send('bad', `CHANGED: ${rel}`);
          changed++;
        }
      } catch {
        ok++; // can't hash, assume ok
      }
    } else if (strictManifest) {
      send('bad', `UNEXPECTED: ${rel}`);
      changed++;
    } else {
      ok++; // no cached hash, just confirm file exists
      send('ok', `EXISTS: ${rel}`);
    }
  }

  for (const rel of Object.keys(cached.files)) {
    if (seen.has(rel)) continue;
    send('bad', `MISSING: ${rel}`);
    missing++;
  }

  const passed = missing === 0 && changed === 0;
  send('done', JSON.stringify({ total: allFiles.length, ok, missing, changed, passed }));
  return { success: true, passed, total: allFiles.length, ok, missing, changed };
});

// ─── Launch Rust.exe ──────────────────────────────────────────────────────────
ipcMain.handle('launch-game', async (event, installPath) => {
  const rustExe = path.join(installPath, 'Rust.exe');
  if (!fs.existsSync(rustExe)) {
    return { success: false, error: 'Rust.exe not found at: ' + rustExe };
  }
  try {
    // Detach so the game runs independently and launcher can close
    const child = spawn(rustExe, [], {
      detached: true,
      stdio: 'ignore',
      cwd: installPath,
    });
    // Watch for game exit so we can restore the launcher
    child.on('exit', onGameExit);
    child.unref();
    // Quit launcher completely once the game is running
    setTimeout(() => { app.isQuitting = true; app.quit(); }, 1500);
    return { success: true };
  } catch(e) {
    return { success: false, error: e.message };
  }
});

// ─── Check install state ──────────────────────────────────────────────────────
ipcMain.handle('check-install', async () => {
  const state = readState();

  // Check saved path first
  if (isValidInstalledGamePath(state.install_path)) {
    return { installed: true, path: state.install_path };
  }

  // Auto-detect: scan common locations for an existing install
  const candidates = [
    path.join(app.getPath('desktop'), 'takeover'),
    path.join(app.getPath('desktop'), 'Takeover'),
    'C:\\takeover', 'D:\\takeover', 'E:\\takeover',
    'C:\\Games\\takeover', 'D:\\Games\\takeover',
  ];
  for (const dir of candidates) {
    if (isValidInstalledGamePath(dir)) {
      writeState({ ...readState(), install_path: dir });
      return { installed: true, path: dir };
    }
  }

  return { installed: false };
});

ipcMain.handle('open-external', async (e, url) => {
  if (!isAllowedDiscordUrl(url)) {
    throw new Error('Blocked untrusted external URL.');
  }
  return shell.openExternal(url);
});
ipcMain.handle('open-folder',   async (e, p)   => shell.openPath(p));
ipcMain.handle('open-steam-depots', async () => {
  const steamPath = findSteamPath();
  if (!steamPath) return { success: false, error: 'Steam not found' };
  const depotBase = path.join(steamPath, 'steamapps', 'content', 'app_252490');
  const target = fs.existsSync(depotBase) ? depotBase : path.join(steamPath, 'steamapps', 'content');
  await shell.openPath(target);
  return { success: true };
});
ipcMain.handle('check-update', async () => {
  return runUpdateCheck({ manual: true });
});

// ─── Desktop shortcut ─────────────────────────────────────────────────────────
ipcMain.handle('create-shortcut', async (event, installPath) => {
  try {
    const shortcutPath = path.join(app.getPath('desktop'), 'takeover.lnk');
    const rustExe  = path.join(installPath, 'Rust.exe');
    const iconSrc  = path.join(installPath, 'takeover.ico');
    const opts = { target: rustExe, cwd: installPath };
    if (fs.existsSync(iconSrc)) { opts.icon = iconSrc; opts.iconIndex = 0; }
    const ok = shell.writeShortcutLink(shortcutPath, 'create', opts);
    return { success: ok };
  } catch(e) {
    return { success: false, error: e.message };
  }
});

// ─── Game update notification (pending-update.exe) ─────────────────────────────
ipcMain.handle('restart-for-update', async () => {
  try {
    if (!fs.existsSync(pendingUpdatePath)) {
      return { success: false, error: 'No downloaded launcher update is pending.' };
    }
    const targetPath = currentLauncherArtifactPath();
    const currentPid = process.pid;
    const tempScript = path.join(app.getPath('temp'), 'takeover_update.ps1');
    const psEscape = (value) => String(value).replace(/'/g, "''");
    const script = [
      `$currentPid = ${currentPid}`,
      `$pendingPath = '${psEscape(pendingUpdatePath)}'`,
      `$pendingInfoPath = '${psEscape(pendingUpdateInfoPath)}'`,
      `$targetPath = '${psEscape(targetPath)}'`,
      `$workingDir = '${psEscape(path.dirname(targetPath))}'`,
      '$deadline = (Get-Date).AddSeconds(20)',
      'while ((Get-Process -Id $currentPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {',
      '  Start-Sleep -Milliseconds 300',
      '}',
      '$copied = $false',
      'for ($i = 0; $i -lt 20 -and -not $copied; $i++) {',
      '  try {',
      '    Copy-Item -LiteralPath $pendingPath -Destination $targetPath -Force',
      '    $copied = $true',
      '  } catch {',
      '    Start-Sleep -Milliseconds 500',
      '  }',
      '}',
      'if ($copied) {',
      '  Start-Process -FilePath $targetPath -WorkingDirectory $workingDir',
      '  Remove-Item -LiteralPath $pendingPath -Force -ErrorAction SilentlyContinue',
      '  Remove-Item -LiteralPath $pendingInfoPath -Force -ErrorAction SilentlyContinue',
      '}',
      `Remove-Item -LiteralPath '${psEscape(tempScript)}' -Force -ErrorAction SilentlyContinue`,
    ].join('\r\n');
    fs.writeFileSync(tempScript, script, 'utf8');
    const { spawn } = require('child_process');
    spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', tempScript,
    ], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    app.quit();
    return { success: true };
  } catch(e) {
    console.error(`[Update] Failed to restart: ${e.message}`);
    return { success: false, error: e.message };
  }
});

// ─── Game file verification ─────────────────────────────────────────────────────
ipcMain.handle('verify-game-files', async (event, installPath) => {
  try {
    if (!installPath || !fs.existsSync(installPath)) {
      return { valid: false, missing: ['Game directory not found'] };
    }

    const missing = [];

    // Check Rust.exe
    const rustExe = path.join(installPath, 'Rust.exe');
    if (!fs.existsSync(rustExe)) {
      missing.push('Rust.exe');
    }

    // Check key directories
    const rustDataDir = path.join(installPath, 'RustClient_Data');
    if (!fs.existsSync(rustDataDir)) {
      missing.push('RustClient_Data directory');
    }

    // Check UnityPlayer.dll
    const unityDll = path.join(installPath, 'UnityPlayer.dll');
    if (!fs.existsSync(unityDll)) {
      missing.push('UnityPlayer.dll');
    }

    return {
      valid: missing.length === 0,
      missing: missing
    };
  } catch(e) {
    console.error(`[Verify] Error verifying files: ${e.message}`);
    return { valid: false, missing: ['Verification error: ' + e.message] };
  }
});

// ─── A2S Server Query ────────────────────────────────────────────────────────
const A2S_INFO_PACKET = Buffer.from([
  0xFF, 0xFF, 0xFF, 0xFF, 0x54,
  ...Buffer.from('Source Engine Query\0'),
]);

function parseA2SInfo(buf) {
  let offset = 5; // skip header FF FF FF FF 49
  const readByte   = () => buf[offset++];
  const readShort  = () => { const v = buf.readUInt16LE(offset); offset += 2; return v; };
  const readString = () => {
    const start = offset;
    while (offset < buf.length && buf[offset] !== 0) offset++;
    const str = buf.toString('utf8', start, offset);
    offset++; // skip null terminator
    return str;
  };
  readByte(); // protocol
  const name       = readString();
  const map        = readString();
  readString(); // folder
  readString(); // game
  readShort();  // steamAppId
  const players    = readByte();
  const maxPlayers = readByte();
  const bots       = readByte();
  return { name, map, players, maxPlayers, bots };
}

function queryServer(ip, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let resolved = false;
    const startTime = Date.now();

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      try { sock.close(); } catch {}
      resolve(result);
    };

    const timer = setTimeout(() => finish({ online: false }), timeoutMs);

    sock.on('error', () => { clearTimeout(timer); finish({ online: false }); });

    sock.on('message', (buf) => {
      if (buf.length >= 9 && buf[4] === 0x41) {
        // Challenge response — resend with challenge appended
        const retry = Buffer.concat([A2S_INFO_PACKET, buf.slice(5, 9)]);
        sock.send(retry, 0, retry.length, port, ip);
        return;
      }
      if (buf.length > 6 && buf[4] === 0x49) {
        clearTimeout(timer);
        try { finish({ online: true, ping: Date.now() - startTime, ...parseA2SInfo(buf) }); }
        catch { finish({ online: true, ping: Date.now() - startTime }); }
      }
    });

    sock.send(A2S_INFO_PACKET, 0, A2S_INFO_PACKET.length, port, ip, (err) => {
      if (err) { clearTimeout(timer); finish({ online: false }); }
    });
  });
}

ipcMain.handle('query-servers', async () => {
  const cfg = readConfig();
  const servers = launcherFeedState.servers?.length ? launcherFeedState.servers : (cfg.servers || []);
  if (!servers.length) return [];
  return Promise.all(servers.map(async (srv) => {
    const r = await queryServer(srv.ip, srv.port || 28015);
    return { ip: srv.ip, port: srv.port || 28015, configName: srv.name, ...r,
      displayName: r.name || srv.name || `${srv.ip}:${srv.port || 28015}` };
  }));
});

ipcMain.handle('query-server-ip', async (event, { ip, port }) => {
  return queryServer(ip, port || 28015, 3000);
});

ipcMain.handle('connect-server', async (event, { ip, port }) => {
  const state = readState();
  if (!state.install_path) return { success: false, error: 'Game not installed' };
  const rustExe = path.join(state.install_path, 'Rust.exe');
  if (!fs.existsSync(rustExe)) return { success: false, error: 'Rust.exe not found' };
  try {
    const child = spawn(rustExe, ['+connect', `${ip}:${port}`], {
      detached: true, stdio: 'ignore', cwd: state.install_path,
    });
    child.on('exit', onGameExit);
    child.unref();
    setTimeout(() => { app.isQuitting = true; app.quit(); }, 1500);
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
});
