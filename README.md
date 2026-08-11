# Zong

Shared worship songs, setlists, chord charts, metronome and piano tools that remain usable without internet. The supplied prototype UI is preserved in `src/App.jsx`; its songs and setlists live in IndexedDB on every device.

## Run and deploy

1. Install dependencies with `npm install`, then use `npm run dev`.
2. Set up the Google Apps Script backend: create a Google Sheet, open **Extensions → Apps Script**, paste in [`apps-script/Code.gs`](apps-script/Code.gs), set its `ZONG_ACCESS_KEY` Script Property, and deploy it as a Web app.
3. Copy `.env.example` to `.env` and set the web-app `/exec` URL. For Vercel, add the same `VITE_ZONG_SYNC_URL` environment variable in the project settings and deploy the repository.

Each musician opens **Settings → Shared library** and enters the shared access code once. The code stays only on that device. Zong checks for updates every 30 seconds and immediately after reconnecting. Library updates are revision-checked: simultaneous edits are never silently overwritten; a rejected version is saved in local storage as `zong:conflict-backup` for recovery.

## Icon asset

The supplied Apple Icon Composer package is included as its two source layers in `public/zong-yellow.png` and `public/zong-blue.png`. `icon.svg` uses both layers for the browser favicon; the included PNG app variants are derived from the supplied artwork. `scripts/render-icon.swift` can regenerate fully composited app icons on a Mac with a matching Xcode toolchain.

## Replacing the prototype

The supplied prototype is already installed in `src/App.jsx`.
