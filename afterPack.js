// afterPack.js - stamps icon/name onto exe and prunes junk to shrink build size

const path   = require('path');
const fs     = require('fs');
const rcedit = require('rcedit');

function rm(p) { try { fs.unlinkSync(p); } catch {} }
function sizeKB(dir) {
  let total = 0;
  const walk = d => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : total += fs.statSync(f).size; } } catch {} };
  walk(dir); return Math.round(total / 1024);
}

exports.default = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const icoPath   = path.join(__dirname, 'build', 'icon.ico');

  const before = sizeKB(appOutDir);

  // ── Stamp icon + name onto exe ───────────────────────────────────────────────
  if (fs.existsSync(icoPath)) {
    const exeFile = fs.readdirSync(appOutDir).find(f => f.toLowerCase().endsWith('.exe'));
    if (exeFile) {
      try {
        await rcedit(path.join(appOutDir, exeFile), {
          icon: icoPath,
          'product-name': 'Takeover',
          'file-description': 'Takeover Launcher',
          'version-string': {
            ProductName:     'Takeover',
            FileDescription: 'Takeover Launcher',
            CompanyName:     'Takeover',
            LegalCopyright:  '',
          },
        });
        console.log(`afterPack: icon + name stamped onto ${exeFile}`);
      } catch (e) { console.warn('afterPack: rcedit failed:', e.message); }
    }
  }

  // ── Prune locales — keep English only (~35–50 MB saved) ─────────────────────
  const localesDir = path.join(appOutDir, 'locales');
  if (fs.existsSync(localesDir)) {
    let pruned = 0;
    for (const f of fs.readdirSync(localesDir)) {
      if (f !== 'en-US.pak') { rm(path.join(localesDir, f)); pruned++; }
    }
    console.log(`afterPack: pruned ${pruned} locale files (kept en-US.pak)`);
  }

  // ── Remove Vulkan software renderer (~15-20 MB, not needed on gaming PCs) ────
  const vulkan = ['vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll'];
  for (const f of vulkan) {
    const fp = path.join(appOutDir, f);
    if (fs.existsSync(fp)) { rm(fp); console.log(`afterPack: removed ${f}`); }
  }

  // ── Remove other unnecessary files ───────────────────────────────────────────
  const junk = [
    'LICENSES.chromium.html',
    'LICENSE.electron.txt',
    'chrome_100_percent.pak',
    'chrome_200_percent.pak',
    'chrome_crashpad_handler.exe',  // crash reporter
  ];
  for (const f of junk) {
    const fp = path.join(appOutDir, f);
    if (fs.existsSync(fp)) { rm(fp); console.log(`afterPack: removed ${f}`); }
  }

  const after = sizeKB(appOutDir);
  console.log(`afterPack: ${Math.round(before/1024)} MB → ${Math.round(after/1024)} MB (saved ${Math.round((before-after)/1024)} MB)`);
};
