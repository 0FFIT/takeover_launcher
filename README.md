# Takeover Launcher (Open Source)

This package is the Steam-only open-source launcher build.

## What is included

- Steam install flow only (no direct-download path)
- Electron launcher source
- Launcher feed support (announcements, servers, media)

## Quick start

1. Install dependencies:
   - `npm install`
2. Run in dev:
   - `npm start`
3. Build exe:
   - Run `build.bat`
   - Output: `dist/takeover_launcher.exe`

## Feed / announcements setup

To enable remote announcements and feed content, set your host URL in `config.json`:

- `update_base_url`: your CDN/base URL (for example `https://your-cdn.example.com`)

The launcher reads:

- `updates.json` from `<update_base_url>/updates.json`
- `launcher-feed.json` from `<update_base_url>/launcher-feed.json`

## GitHub upload checklist

- `node_modules` and `dist` are excluded by `.gitignore`
- private key files are excluded by `.gitignore`
- no Bunny upload script is included
- no Auto-Paste script is included
