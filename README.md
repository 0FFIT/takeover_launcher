# Takeover Launcher

## Build

```
npm install
npm run build
```

Output: `dist/win-unpacked/` — copy this entire folder wherever you want.
Run `takeover.exe` inside it to launch.

**Give users the whole `win-unpacked` folder.** Rename it to "Takeover Launcher" or anything you like.
The `takeover.exe` inside is a real standalone Electron exe — no NSIS wrapper, no installer, no UAC.

---

## Folder layout (inside win-unpacked, next to takeover.exe)

```
takeover.exe             <- run this
config.json              <- edit Discord link, GitHub repo, title
assets/
  icons/takeover.ico
  videos/                <- .mp4 / .mkv - auto-rotate background
  images/                <- .jpg / .png - rotate with videos
scripts/
  auto_paste.py
```

---

## Bundling videos before build

Drop .mp4 / .mkv files into `assets/videos/` BEFORE running `npm run build`.
They get packed inside and play on any machine with no extra files needed.

Users can also drop MORE videos into the `assets/videos/` folder next to
the exe after receiving it — both locations are checked and merged.

---

## config.json

```json
{
  "version": "1.0.0",
  "discord_url": "https://discord.gg/YOUR_INVITE",
  "github_repo": "YOUR_USERNAME/YOUR_REPO",
  "github_branch": "main",
  "window_title": "TAKEOVER"
}
```

## GitHub Auto-Update

Push changes to your repo (new videos, updated config.json).
Launcher checks for new commits on startup and shows a green Update banner.
Only downloads assets/ and config.json — no full rebuild needed.

## Dev

```
npm install
npm start
```
