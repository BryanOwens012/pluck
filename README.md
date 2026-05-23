# Pluck

A minimalist macOS desktop app for downloading videos from YouTube, Vimeo, Zoom recordings, Twitter / X, Instagram, TikTok, and the [~1,800 other sites yt-dlp supports](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md). Paste a URL, pick a quality, get a file.

> **Status**: alpha. See [latest release](https://github.com/BryanOwens012/pluck/releases) for the signed + notarized DMG.

---

## Features

- 📥 **One-paste downloads** — paste a video URL, pick a quality, click Download. No CLI needed.
- 🎬 **Smart format selector** — "Best" picks the actual highest non-AV1 quality the source offers (1080p mp4, 4K mkv, etc.). Strict tier choices ("720p mp4", "480p mp4", "360p mp4", "Audio-only mp3") for when compatibility matters more than max quality.
- 🔐 **Sign-in cookies** for age-gated YouTube, protected tweets, private Instagram posts, etc. Pluck pops an inline browser picker on the affected row; pick your signed-in browser and the download retries.
- 🔑 **Zoom recording passwords** prompt automatically and re-attempt without restarting.
- 📚 **Playlist support** — paste a YouTube / Vimeo playlist URL and Pluck asks whether to grab just the one video or all entries (oldest-first or newest-first).
- 🔄 **yt-dlp auto-updates** from GitHub Releases at app start, so YouTube changes don't break Pluck the way they break a stale yt-dlp binary.
- 🎛️ **Developer overrides** for power users — paste your own `yt-dlp` command, tune `-N` concurrent fragments, pick which browser to read cookies from, inspect per-download logs.
- ☑️ **Light, high-contrast UI** that meets WCAG AA, with visible focus rings and screen-reader labels.
- 🔒 **Privacy** — no telemetry, no analytics, no remote logging. API keys (if any) live in the macOS Keychain via Electron's `safeStorage`. Download history stays in `~/Library/Application Support/Pluck/`.

---

## Install

### Pre-built DMG (recommended)

1. Download `pluck-<version>.dmg` from the [latest release](https://github.com/BryanOwens012/pluck/releases).
2. Open the DMG and drag **Pluck** to **Applications**.
3. Launch from Applications or Spotlight.

The DMG is **signed by `Developer ID Application: BRYAN LU OWENS (6P43CQ9YN4)`** and the `.app` carries a stapled Apple notarization ticket. On first launch macOS will briefly check with Apple's notarization service, then show "Pluck is from an identified developer" — click **Open**.

You can verify the signature manually:

```sh
spctl -a -vv /Applications/Pluck.app
# expected: accepted, source=Notarized Developer ID

codesign -dvv /Applications/Pluck.app 2>&1 | grep -E 'Authority|Notarization'
# expected: Developer ID Application: BRYAN LU OWENS (6P43CQ9YN4)
#           Notarization Ticket=stapled
```

### Build from source

See [Development](#development) below.

---

## Requirements

- **macOS Tahoe 26 or later** — tested on macOS 26.1
- **Apple Silicon** (M1, M2, M3, etc.). Intel Macs are not supported.

---

## What's bundled

Pluck ships all dependencies internally — no Homebrew or system Python required.

| Tool     | Version                   | Purpose                                              |
| -------- | ------------------------- | ---------------------------------------------------- |
| yt-dlp   | 2026.03.17 (auto-updates) | Video extraction + download                          |
| ffmpeg   | N-124449 (arm64)          | Stream merge, audio extraction, container conversion |
| ffprobe  | N-124449 (same build)     | Post-download metadata read for tagging              |
| Electron | 42.2.0                    | App shell                                            |
| React    | 19                        | Renderer UI                                          |
| Vite     | 7                         | Build tooling                                        |

yt-dlp auto-updates from GitHub Releases at every app launch (toggle in Settings → Developer). ffmpeg / ffprobe are pinned and updated only on a new Pluck release.

---

## How to use

### Paste and download

1. Paste a video URL into the input box. Pluck validates the URL inline and starts a background metadata probe.
2. The format dropdown becomes active showing pre-probe options (`Best`, `1080p mp4`, `720p mp4`, `480p mp4`, `360p mp4`, `Audio-only mp3`).
3. Click **Download** immediately or wait for the probe to refine the dropdown — clicking before the probe lands gets you the actual highest non-AV1 quality the source offers.
4. The download appears as a row in the queue with live progress, speed, and ETA.

### Playlist URLs

If the URL looks like a playlist, Pluck pops a modal asking whether to download just the one video or every entry (oldest-first or newest-first). Whole-playlist downloads are throttled at 1 row at a time to avoid YouTube rate limits.

### Sign-in cookies

If a download fails because the source needs sign-in cookies (YouTube age gate, Twitter NSFW / protected tweets, Instagram private profiles, Vimeo private videos, Twitch sub-only VODs, etc.), the row flips to **Needs sign-in cookies** and shows an inline picker with the browsers actually installed on your Mac. Click the browser whose session is signed in to the source site — Pluck saves the choice globally and retries the row.

### Zoom recording passwords

If a Zoom recording is password-protected, Pluck pops a password prompt. You get 3 attempts; entering nothing dismisses without consuming an attempt.

### Settings

Click the gear icon top-right. Sections:

- **Default output folder** — where files land (default: `~/Downloads/Pluck/`).
- **Browser cookies** — global picker for which browser to pull cookies from. Filtered to browsers actually installed on this Mac.
- **Developer** (collapsed by default) — debug mode, concurrent downloads (1–10), concurrent yt-dlp fragments per download, yt-dlp command override, yt-dlp version + auto-update toggle + manual "Check now", clear debug temp folders, clear library.

---

## Development

### Prerequisites

- macOS Tahoe 26 or later, on Apple Silicon (M1, M2, M3, etc.) — Intel Macs are not supported
- Node.js 20+ (24 is the test target)
- npm 10+

### Setup

```sh
git clone git@github.com:BryanOwens012/pluck.git
cd pluck
npm install
```

`postinstall` runs `scripts/fetch-binaries.sh` automatically to pull yt-dlp + ffmpeg + ffprobe into `resources/binaries/` (~155 MB; cached after first run).

### Run the dev app

```sh
npm run dev
```

This starts `electron-vite dev` — Vite HMR for the renderer, hot-reload for the main process. The Electron window opens automatically.

### Type-check, lint, test

```sh
npm run typecheck      # tsc on node + web tsconfigs
npm run lint           # biome + shellcheck + ruff (auto-fix)
npm run lint:check     # same but read-only (CI mode)
npm run format         # biome + prettier + shfmt + ruff (write)
npm run format:check   # check-only
npm test               # vitest watch
npm run test:run       # vitest single-run
npm run test:smoke     # full end-to-end smoke against the bundled binaries
```

Tests live alongside their source files (`foo.ts` → `foo.test.ts`). Vitest currently has 440+ tests with no `.skip` / `xfail`.

### Build the packaged `.app` / DMG

Two electron-builder configs live in the repo:

- **`electron-builder.prod.yml`** — code-signed, hardened, notarized, DMG-signed. Used for distribution.
- **`electron-builder.local.yml`** — unsigned, no notarization, no hardened runtime. Used for fast local iteration.

Whichever you want active gets copied to `electron-builder.yml` by the build scripts. The working copy is gitignored.

**Unsigned local DMG** (~30 s, no Apple creds required):

```sh
npm run build:mac:local
```

Outputs `dist/pluck-<version>-local.dmg`. It runs but launching it on another Mac will show "from an unidentified developer".

**Signed + notarized prod DMG** (3–10 min, mostly Apple's notarization queue):

```sh
export APPLE_ID="your-apple-id@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="ABCDE12345"
npm run build:mac
```

Requires a **Developer ID Application** cert + private key in your login Keychain (paired — visible under Keychain Access → login → My Certificates with a disclosure triangle). The build picks it up automatically; no config needed.

### Bump bundled binaries

Edit the version constants at the top of `scripts/fetch-binaries.sh`:

```bash
YT_DLP_VERSION="2026.03.17"
FFMPEG_ARM64_BUILD="1778771734_N-124449-g8ffaead836"
FFMPEG_AMD64_BUILD="1767299902_N-122320-g38e89fe502"
```

Then re-run with `--force`:

```sh
./scripts/fetch-binaries.sh --force
```

For a distributable universal build, add `--universal` (stitches arm64+x86_64 via `lipo`). Note: ffmpeg / ffprobe arch-fat blobs are ~150 MB each.

---

## Architecture

Pluck is a standard Electron app split into three processes:

```
┌─────────────────────────────────────────────────────────────┐
│  Main process (src/main/)                                   │
│  - IPC handlers (ipc.ts)                                    │
│  - Download queue (downloader/queue.ts)                     │
│  - yt-dlp runner + metadata cache (ytdlp/)                  │
│  - Settings + secrets stores (settings.ts, secrets.ts)      │
│  - History persistence (history.ts, atomic-json.ts)         │
│  - Transcription pipeline (transcription/)                  │
│  - yt-dlp auto-updater (yt-dlp-updater/)                    │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │ contextBridge IPC
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Preload (src/preload/)                                     │
│  - Typed window.pluck surface                               │
│  - Channel forwarding only — no logic                       │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │ window.pluck API
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Renderer (src/renderer/)                                   │
│  - React 19 + Vite + Tailwind v4                            │
│  - App.tsx: top-level state + IPC subscriptions             │
│  - components/: DownloadRow, FormatSelector, SettingsPanel… │
│  - Zustand-style mirror of the queue's state                │
└─────────────────────────────────────────────────────────────┘
```

**Shared code** (`src/shared/`):

- `types.ts` — `Download`, `FormatChoice`, `STATIC_FORMAT_CHOICES`, etc.
- `ipc-channels.ts` — every IPC channel name as a const
- `flags.ts` — build-time feature flags
- `url.ts` — URL validation / normalization

### Key design choices

- **One source of truth**: the main process owns the authoritative `Download` state map. The renderer mirrors via push updates; it never writes back directly.
- **Atomic JSON for persistence**: `atomic-json.ts` does write-then-rename so a crash mid-save can't corrupt `settings.json` or `history.json`.
- **Per-download temp folders** under `~/Library/Caches/video.pluck.app/` — APFS rename makes the final move into `~/Downloads/` atomic. Cleaned on every terminal status (debug mode preserves failed-row folders for inspection).
- **Discriminated-union state machines** for multi-phase async flows (`YtDlpUpdaterRow`, `ApiKeyRow`, `ClearLibraryRow`, etc.) — each phase carries the payload it needs and the renderer never has to read "is this loading?" across two independent booleans.
- **Const-array + `(typeof X)[number]` pattern** for plain string unions (`BROWSER_NAMES`, `FORMAT_IDS`, `PLAYLIST_ORDERS`, `DOWNLOAD_STATUSES`). Discriminated unions with per-variant payloads stay as direct unions.
- **Friendly errors at the boundary**: yt-dlp stderr is parsed in `src/main/ytdlp/parser.ts` and routed into typed error classes (`YtDlpAuthRequiredError`, `YtDlpCookieAccessDeniedError`, `YtDlpPasswordRequiredError`, `YtDlpCancelledError`); the queue translates those to row statuses. The renderer never sees raw stderr.
- **`--cookies-from-browser`** is the universal authentication path. Pluck never asks for or stores a site password (Zoom video passwords are the one exception — those are a Zoom-specific per-recording prompt, not a sign-in).

---

## Project layout

```
.
├── build/                      # macOS code-signing assets + icons
│   ├── entitlements.mac.plist
│   ├── icon.icns
│   └── icon.ico
├── electron-builder.local.yml  # Unsigned dev build config (canonical)
├── electron-builder.prod.yml   # Signed + notarized config (canonical)
├── electron-builder.yml        # Working copy (gitignored; cp'd from one of the above)
├── electron.vite.config.ts
├── resources/
│   ├── binaries/               # yt-dlp + ffmpeg + ffprobe (gitignored, fetched)
│   └── icon.png                # Linux BrowserWindow icon
├── scripts/
│   ├── fetch-binaries.sh       # Pull yt-dlp + ffmpeg + ffprobe
│   └── test-runner.ts          # End-to-end smoke harness
└── src/
    ├── main/                   # Main process (Node + Electron APIs)
    ├── preload/                # Preload (contextBridge)
    ├── renderer/               # Renderer (React + Vite + Tailwind)
    └── shared/                 # Cross-process types + constants
```

---

## Privacy

- Pluck makes network requests to:
  - The source sites you paste URLs from (via yt-dlp)
  - `api.github.com/repos/yt-dlp/yt-dlp/releases/latest` (yt-dlp auto-updater)
  - Apple's notarization CDN (first-launch verification, one-time)
- No telemetry, no analytics, no crash reporting.
- API keys (if/when AI features are enabled) are stored encrypted via macOS `safeStorage` (Keychain-backed).
- Download history (`history.json`) and settings (`settings.json`) live in `~/Library/Application Support/Pluck/`. Reset with `rm -rf ~/Library/Application\ Support/Pluck`.
- Pluck's hardened-runtime entitlements (`build/entitlements.mac.plist`) include `com.apple.security.cs.disable-library-validation` — required so yt-dlp's bundled Python framework can dlopen at runtime under macOS Gatekeeper. No other privileges are claimed.

---

## Known limitations (alpha)

- **8K YouTube can't be downloaded.** YouTube serves 8K as AV1 only, and Pluck excludes AV1 by default for M1 hardware-decode compatibility. Best caps at 4K (WebM → mkv) on 8K sources. Power users can paste a custom selector in Settings → Developer → yt-dlp command override to opt in.
- **No automatic app updates.** Subscribe to GitHub releases or check Settings → Pluck version periodically.
- **AI features (transcription, AI prompts) are gated off** by build-time feature flags. The code is in the repo but disabled in shipped alphas.

---

## Roadmap

- App-level auto-updates (electron-updater wired into the existing `dist/*.zip` artifact + `latest-mac.yml`)
- AI features re-enabled: ElevenLabs Scribe transcription, Anthropic AI-assisted prompts
- "Allow AV1" toggle in Developer settings (current workaround: command override)
- Dark-mode parity with the existing light theme

---

## Feedback

Bugs, requests, weird URLs Pluck mishandles — please open an issue at [github.com/BryanOwens012/pluck/issues](https://github.com/BryanOwens012/pluck/issues) with:

- The URL you tried (or describe the source site if it's private)
- What you expected vs what happened
- A screenshot or recording if the UI is involved
- The "yt-dlp command" preview from Settings → Developer (if relevant)

For sensitive URLs, redact the video ID — just include the site and what kind of content (e.g., "YouTube age-gated video, public").

---

## Acknowledgements

Pluck stands on the shoulders of an enormous amount of open-source work:

- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — the extractor that does the actual heavy lifting. Pluck is a thin macOS-native wrapper around it.
- **[FFmpeg](https://ffmpeg.org/)** (binaries hosted by [martin-riedl.de](https://ffmpeg.martin-riedl.de/)) — stream merge, audio extraction, container conversion.
- **[Electron](https://www.electronjs.org/)** + **[electron-vite](https://electron-vite.org/)** — app shell + dev tooling.
- **[React](https://react.dev/)**, **[Vite](https://vitejs.dev/)**, **[Tailwind CSS](https://tailwindcss.com/)** — renderer stack.
- **[Zod](https://zod.dev/)** — runtime validation at every IPC + persistence boundary.
- **[Biome](https://biomejs.dev/)** + **[Vitest](https://vitest.dev/)** — linting + testing.

---

## License

[MIT](./LICENSE).
