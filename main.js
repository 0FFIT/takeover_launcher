const { app, BrowserWindow, ipcMain, shell, dialog, screen, Tray, Menu, nativeImage } = require('electron');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const https    = require('https');
const http     = require('http');
const { execSync, spawn } = require('child_process');
const { pathToFileURL } = require('url');
const dgram    = require('dgram');

let win;
let tray = null;
app.isQuitting = false;

// ─── Paths ────────────────────────────────────────────────────────────────────
const isPortable   = app.isPackaged;
const rootDir      = isPortable
  ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath))
  : __dirname;
const resourcesDir = isPortable ? process.resourcesPath : __dirname;
const configPath   = path.join(rootDir, 'config.json');
const statePath    = path.join(rootDir, 'launcher_state.json');
const hashCachePath = path.join(rootDir, 'file_hashes.json');

// ─── Ensure user-facing folders exist ─────────────────────────────────────────
for (const dir of [
  path.join(rootDir, 'assets', 'audio'),
  path.join(rootDir, 'assets', 'videos'),
  path.join(rootDir, 'assets', 'images'),
]) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }

function icoPath() {
  return [
    path.join(resourcesDir, 'assets', 'icons', 'takeover.ico'),
    path.join(rootDir,      'assets', 'icons', 'takeover.ico'),
  ].find(p => fs.existsSync(p));
}

function readConfig() {
  const fallbacks = [configPath, path.join(resourcesDir, 'config.json')];
  for (const p of fallbacks) {
    try { const d = JSON.parse(fs.readFileSync(p, 'utf8')); if (d) return d; } catch {}
  }
  return { version:'1.0.0', discord_url:'', github_repo:'', github_branch:'main', window_title:'TAKEOVER' };
}

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch { return { last_commit: null, install_path: null }; }
}

function writeState(data) {
  try { fs.writeFileSync(statePath, JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

function isNewer(remote, local) {
  const p = v => (v || '0.0.0').split('.').map(Number);
  const [ra,rb,rc] = p(remote), [la,lb,lc] = p(local);
  return ra > la || (ra === la && rb > lb) || (ra === la && rb === lb && rc > lc);
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
    savePos();
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    setupTray();
    const cfg   = readConfig();
    const state = readState();
    win.webContents.send('config', cfg);
    // Tell renderer if game is already installed
    if (state.install_path && fs.existsSync(path.join(state.install_path, 'takeover.ico'))) {
      win.webContents.send('already-installed', state.install_path);
    }
    if (cfg.github_repo && cfg.github_repo !== 'YOUR_USERNAME/YOUR_REPO') {
      checkGithubUpdate(cfg);
    }
  });
}

// ─── Single instance lock ─────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
  app.on('second-instance', () => { if (win) { win.show(); if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => { createWindow(); });
}
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { app.isQuitting = true; if (tray) { tray.destroy(); tray = null; } });

// ─── Window controls ──────────────────────────────────────────────────────────
ipcMain.on('window-minimize', () => win.minimize());
ipcMain.on('window-close',    () => win.hide());    // minimize to tray
ipcMain.on('window-quit',     () => { app.isQuitting = true; app.quit(); });

// ─── System tray ─────────────────────────────────────────────────────────────
function setupTray() {
  if (tray) return;
  try {
    const ico  = icoPath();
    const icon = ico ? nativeImage.createFromPath(ico) : nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.setToolTip(readConfig().window_title || 'TAKEOVER');
    const menu = Menu.buildFromTemplate([
      { label: 'Open Launcher', click: () => { win.show(); win.focus(); } },
      { type: 'separator' },
      { label: 'Quit',          click: () => { app.isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', () => { win.show(); win.focus(); });
  } catch {}
}

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

// ─── Media files ──────────────────────────────────────────────────────────────
ipcMain.handle('get-media-files', () => {
  const toURLs = (dirs, re) => {
    const seen = new Set(); const results = [];
    for (const dir of dirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (!re.test(f) || seen.has(f)) continue;
          seen.add(f);
          results.push(pathToFileURL(path.join(dir, f)).href);
        }
      } catch {}
    }
    return results;
  };
  return {
    videos: toURLs([
      path.join(resourcesDir,'assets','videos'),
      path.join(rootDir,'assets','videos'),
    ], /\.(mp4|mkv|webm|mov)$/i),
    images: toURLs([
      path.join(resourcesDir,'assets','images'),
      path.join(rootDir,'assets','images'),
    ], /\.(jpg|jpeg|png|gif|webp)$/i),
  };
});

// ─── Audio files ─────────────────────────────────────────────────────────────
ipcMain.handle('get-audio-files', () => {
  const dirs = [
    path.join(rootDir, 'assets', 'audio'),
    path.join(resourcesDir, 'assets', 'audio'),
  ];
  const re = /\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i;
  const seen = new Set();
  const results = [];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!re.test(f) || seen.has(f)) continue;
        seen.add(f);
        results.push(pathToFileURL(path.join(dir, f)).href);
      }
    } catch {}
  }
  return results;
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
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end',  () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
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
      const rel      = path.relative(base, src);
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
    fs.writeFileSync(hashCachePath, JSON.stringify(hashCache, null, 2), 'utf8');

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
  let cached = {};
  try { cached = JSON.parse(fs.readFileSync(hashCachePath, 'utf8')); } catch {}

  let ok = 0, missing = 0, changed = 0;
  for (const filePath of allFiles) {
    const rel = path.relative(installPath, filePath);
    if (!fs.existsSync(filePath)) {
      send('bad', `MISSING: ${rel}`);
      missing++;
      continue;
    }
    if (cached[rel]) {
      try {
        const actual = await hashFile(filePath);
        if (actual === cached[rel]) {
          ok++;
          send('ok', `OK: ${rel}`);
        } else {
          send('bad', `CHANGED: ${rel}`);
          changed++;
        }
      } catch {
        ok++; // can't hash, assume ok
      }
    } else {
      ok++; // no cached hash, just confirm file exists
      send('ok', `EXISTS: ${rel}`);
    }
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
    // Minimize launcher to tray while the game is running
    setTimeout(() => win.hide(), 1500);
    return { success: true };
  } catch(e) {
    return { success: false, error: e.message };
  }
});

// ─── Check install state ──────────────────────────────────────────────────────
ipcMain.handle('check-install', async () => {
  const state = readState();

  // Check saved path first
  if (state.install_path) {
    if (fs.existsSync(path.join(state.install_path, 'takeover.ico'))) {
      return { installed: true, path: state.install_path };
    }
  }

  // Auto-detect: scan common locations for an existing install
  const candidates = [
    path.join(app.getPath('desktop'), 'takeover'),
    path.join(app.getPath('desktop'), 'Takeover'),
    'C:\\takeover', 'D:\\takeover', 'E:\\takeover',
    'C:\\Games\\takeover', 'D:\\Games\\takeover',
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'takeover.ico'))) {
      writeState({ ...readState(), install_path: dir });
      return { installed: true, path: dir };
    }
  }

  return { installed: false };
});

// ─── Embedded Python ──────────────────────────────────────────────────────────
const pythonDir    = path.join(rootDir, 'python-embed');
const pythonExe    = path.join(pythonDir, 'python.exe');
const getPipUrl    = 'https://bootstrap.pypa.io/get-pip.py';
const pythonZipUrl = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip';

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    file.on('error', reject);
    file.on('finish', () => file.close(resolve));
    const request = (u) => {
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(u, { headers:{ 'User-Agent':'takeover-launcher' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          res.resume(); // drain redirect body, keep file open
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.destroy();
          return reject(new Error(`HTTP ${res.statusCode} — ${u}`));
        }
        const total = parseInt(res.headers['content-length'], 10);
        let received = 0;
        if (onProgress && total) {
          res.on('data', chunk => {
            received += chunk.length;
            onProgress(Math.round(received / total * 100));
          });
        }
        res.pipe(file);
      });
      req.setTimeout(30000, () => req.destroy(new Error('Download timed out')));
      req.on('error', err => { file.destroy(); reject(err); });
    };
    request(url);
  });
}

function unzip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
      '-Command',
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`,
    ]);
    ps.on('close', code => code === 0 ? resolve() : reject(new Error(`Unzip failed: ${code}`)));
    ps.on('error', reject);
  });
}

function runPython(args, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonExe, args, { cwd: pythonDir });
    proc.stdout.on('data', chunk => {
      for (const raw of chunk.toString('utf8').split('\n')) {
        const line = raw.trim(); if (line) onLine(line);
      }
    });
    proc.stderr.on('data', chunk => {
      const t = chunk.toString('utf8').trim();
      if (t) onLine('ERR:' + t.split('\n')[0]);
    });
    proc.on('error', reject);
    proc.on('close', resolve);
  });
}

async function ensureEmbeddedPython(onStatus) {
  if (fs.existsSync(pythonExe)) return true;
  onStatus('Setting up Python (one-time, ~30s)...');
  fs.mkdirSync(pythonDir, { recursive: true });
  const zipDest = path.join(pythonDir, 'python-embed.zip');
  onStatus('Downloading Python (~25 MB)...');
  await downloadFile(pythonZipUrl, zipDest);
  onStatus('Extracting Python...');
  await unzip(zipDest, pythonDir);
  fs.unlinkSync(zipDest);
  const pthFile = path.join(pythonDir, 'python311._pth');
  if (fs.existsSync(pthFile)) {
    let pth = fs.readFileSync(pthFile, 'utf8');
    pth = pth.replace('#import site', 'import site');
    fs.writeFileSync(pthFile, pth, 'utf8');
  }
  onStatus('Installing pip...');
  const getPipDest = path.join(pythonDir, 'get-pip.py');
  await downloadFile(getPipUrl, getPipDest);
  await runPython([getPipDest, '--no-warn-script-location'], l => {
    if (l.includes('Successfully') || l.includes('Installing')) onStatus(l.slice(0,60));
  });
  onStatus('Installing pyautogui, pyperclip...');
  await runPython(['-m','pip','install','--no-warn-script-location',
    'pyautogui','pyperclip'], l => {
    if (l.includes('Successfully') || l.includes('Installing')) onStatus(l.slice(0,60));
  });
  return fs.existsSync(pythonExe);
}

// ─── Auto-paste ───────────────────────────────────────────────────────────────
ipcMain.handle('run-auto-paste', () => new Promise(async resolve => {
  const emit = (type, extra={}) => win.webContents.send('auto-paste-status', { type, ...extra });

  const scriptPath = isPortable
    ? path.join(resourcesDir, 'scripts', 'auto_paste.py')
    : path.join(__dirname, 'scripts', 'auto_paste.py');

  win.minimize();
  await shell.openExternal('steam://open/console');

  try {
    await ensureEmbeddedPython(msg => emit('status', { message: msg }));
  } catch(e) {
    win.restore(); emit('error', { message: `Setup failed: ${e.message}` });
    return resolve({ code:-1 });
  }

  if (!fs.existsSync(pythonExe)) {
    win.restore(); emit('error', { message: 'Python setup failed. Check internet.' });
    return resolve({ code:-1 });
  }

  const proc = spawn(pythonExe, [scriptPath]);
  proc.stdout.on('data', chunk => {
    for (const raw of chunk.toString('utf8').split('\n')) {
      const line = raw.trim(); if (!line) continue;
      if      (line.startsWith('STATUS:')) emit('status',  { message: line.slice(7) });
      else if (line.startsWith('ERROR:'))  emit('error',   { message: line.slice(6) });
      else if (line === 'DONE') { win.restore(); emit('done'); }
    }
  });
  proc.stderr.on('data', chunk => {
    const msg = chunk.toString('utf8').trim();
    if (msg && !msg.includes('Warning')) emit('error', { message: msg.split('\n')[0] });
  });
  proc.on('error', err => { win.restore(); emit('error', { message: err.message }); resolve({ code:-1 }); });
  proc.on('close', code => resolve({ code }));
}));

// ─── GitHub Update ────────────────────────────────────────────────────────────
function ghGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent':'takeover-launcher', 'Accept':'application/vnd.github.v3+json' }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } });
    }).on('error', reject);
  });
}

function ghDownload(rawUrl, destPath) {
  return new Promise((resolve, reject) => {
    const get = (u) => https.get(u, { headers:{ 'User-Agent':'takeover-launcher' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) { get(res.headers.location); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        fs.mkdirSync(path.dirname(destPath), { recursive:true });
        fs.writeFileSync(destPath, Buffer.concat(chunks));
        resolve();
      });
    }).on('error', reject);
    get(rawUrl);
  });
}

async function checkGithubUpdate(cfg) {
  let found = false;
  try {
    const [owner, repo] = cfg.github_repo.split('/');
    const branch = cfg.github_branch || 'main';
    const state  = readState();

    // Asset / config update check (commit-based)
    const data = await ghGet(`https://api.github.com/repos/${owner}/${repo}/commits/${branch}`);
    if (!data || !data.sha) return found;
    if (data.sha !== state.last_commit) {
      const rawMsg = data.commit?.message || '';
      const subject = rawMsg.split('\n')[0].trim() || 'New update available';
      win.webContents.send('update-available', {
        sha: data.sha, message: subject,
        owner, repo, branch,
      });
      found = true;
    }

    // Launcher exe update check — single "version" field in remote config
    const remoteCfg = await ghGet(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/config.json`);
    const remoteVer = remoteCfg?.launcher_version || remoteCfg?.version;
    const exeUrl    = remoteCfg?.launcher_exe_url;
    if (remoteVer && exeUrl && isNewer(remoteVer, app.getVersion())) {
      // Auto-update: download and restart without user prompt
      win.webContents.send('launcher-update-available', { version: remoteVer, url: exeUrl, auto: true });
      autoUpdateLauncher(exeUrl, remoteVer);
      found = true;
    }
  } catch {}
  return found;
}

async function autoUpdateLauncher(url, version) {
  if (!isPortable) return; // dev mode — skip
  const send = msg => win.webContents.send('launcher-update-progress', msg);
  try {
    const exePath     = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const exeDir      = path.dirname(exePath);
    const tmpExe      = path.join(exeDir, 'takeover_new.exe');
    const updaterPath = path.join(exeDir, 'updater.bat');

    send(`Downloading v${version}...`);
    await downloadFile(url, tmpExe, pct => send(`PROGRESS:${pct}`));

    send('Preparing updater...');
    const bat = [
      '@echo off',
      'timeout /t 3 /nobreak > nul',
      ':retry',
      `move /y "${tmpExe}" "${exePath}" 2>nul`,
      `if exist "${tmpExe}" (`,
      '  timeout /t 1 /nobreak > nul',
      '  goto :retry',
      ')',
      `start "" "${exePath}"`,
      'del "%~0"',
    ].join('\r\n');
    fs.writeFileSync(updaterPath, bat, 'utf8');

    send('Restarting...');
    spawn('cmd.exe', ['/c', updaterPath], { detached: true, stdio: 'ignore', windowsHide: true, cwd: exeDir }).unref();
    setTimeout(() => app.quit(), 1000);
  } catch(e) {
    send(`ERROR: ${e.message}`);
  }
}

ipcMain.handle('apply-github-update', async (event, { owner, repo, branch, sha }) => {
  const send = (msg) => win.webContents.send('update-progress', msg);
  try {
    send('Fetching file list from GitHub...');
    const treeData = await ghGet(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);
    if (!treeData?.tree) throw new Error('Could not read repo tree');
    const syncable = treeData.tree.filter(item =>
      item.type === 'blob' &&
      (item.path === 'config.json' || item.path.startsWith('assets/')) &&
      !/\.(mp4|mkv|webm|mov)$/i.test(item.path)
    );
    send(`Downloading ${syncable.length} files...`);
    for (const item of syncable) {
      send(`Updating: ${item.path}`);
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${item.path}`;
      await ghDownload(rawUrl, path.join(rootDir, item.path));
    }
    writeState({ ...readState(), last_commit: sha });
    send('DONE');
    return { success: true };
  } catch(e) {
    send(`ERROR: ${e.message}`);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('open-external', async (e, url) => shell.openExternal(url));
ipcMain.handle('open-folder',   async (e, p)   => shell.openPath(p));
ipcMain.handle('check-update',  async ()        => { const cfg = readConfig(); if (cfg.github_repo && cfg.github_repo !== 'YOUR_USERNAME/YOUR_REPO') return await checkGithubUpdate(cfg); return false; });

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

// ─── Launcher self-update ─────────────────────────────────────────────────────
ipcMain.handle('apply-launcher-update', async (event, { url }) => {
  const send = msg => win.webContents.send('launcher-update-progress', msg);
  try {
    if (!isPortable) throw new Error('Self-update only works in packaged builds.');
    const exePath    = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const exeDir     = path.dirname(exePath);
    const tmpExe     = path.join(exeDir, 'takeover_new.exe');
    const updaterPath = path.join(exeDir, 'updater.bat');

    send('Downloading new launcher...');
    await downloadFile(url, tmpExe, pct => send(`PROGRESS:${pct}`));

    send('Preparing updater...');
    const bat = [
      '@echo off',
      'timeout /t 3 /nobreak > nul',
      ':retry',
      `move /y "${tmpExe}" "${exePath}" 2>nul`,
      `if exist "${tmpExe}" (`,
      '  timeout /t 1 /nobreak > nul',
      '  goto :retry',
      ')',
      `start "" "${exePath}"`,
      'del "%~0"',
    ].join('\r\n');
    fs.writeFileSync(updaterPath, bat, 'utf8');

    send('Restarting...');
    spawn('cmd.exe', ['/c', updaterPath], { detached: true, stdio: 'ignore', windowsHide: true, cwd: exeDir }).unref();
    setTimeout(() => app.quit(), 1000);
    return { success: true };
  } catch(e) {
    send(`ERROR: ${e.message}`);
    return { success: false, error: e.message };
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
  const servers = cfg.servers || [];
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
    setTimeout(() => win.hide(), 1500);
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
});
