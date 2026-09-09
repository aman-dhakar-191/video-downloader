# Diskwala Video Downloader

A small Node/Express web app: paste a public Diskwala video page URL, get the
direct media link back, and download it through the server (so the browser gets a
proper filename and no CORS/hotlink errors).

## Run

```bash
npm install
npm start          # http://localhost:3000
```

No build step, no frontend framework — `public/index.html` is the whole UI.

```bash
npm test           # unit tests, no network
```

To deploy on a VPS with Docker and automatic HTTPS, see **[DEPLOY.md](DEPLOY.md)**:

```bash
cp .env.example .env    # set DOMAIN and ACME_EMAIL
docker compose up -d --build
```

## Telegram bot (optional)

`bot.js` is a zero-dependency long-polling bot that shares `lib/resolve.js` with
the web app. Send it a Diskwala link and it replies with buttons.

It deliberately does **not** send the video file: the Bot API caps bot uploads at
50 MB and most videos are larger. Each resolved file gets two buttons — a
**Download** button pointing at this app's `/api/download` proxy (proper
filename, survives hotlink protection, uses your bandwidth) and a **Direct link**
to the CDN (free, but breaks if the upstream checks `Referer`). HLS/DASH sources
get the manifest plus an `ffmpeg` command instead, since there is no single file.

```bash
TELEGRAM_TOKEN=... PUBLIC_BASE_URL=https://your-domain npm run bot
```

Set `TELEGRAM_ALLOWED_IDS` to a comma-separated list of numeric user ids.
Without it the bot answers anyone who finds it, and every button they tap spends
your bandwidth.

## How it works

1. `POST /api/resolve { url }` fetches the page server-side with a browser-like
   User-Agent and runs four extraction strategies in order of confidence:
   `og:video` meta tag → `<source>`/`<video src>` → JSON `file`/`src`/`url` keys
   → any bare `.mp4`/`.m3u8`/`.mpd`/`.webm`/`.mkv` URL in the page text.
   If the page yields nothing, it follows one `<iframe>`/embed link and retries.
2. Plain files get a `/api/download` link that streams the upstream response
   through the server, forwarding `Range` headers so seeking and resume work.
3. HLS/DASH manifests can't be saved as one file, so the UI shows the manifest
   URL plus a ready-to-paste `ffmpeg -i ... -c copy out.mp4` command.

## Important caveat

The extraction logic was written **without live access to diskwala.com** — the
development environment's network policy blocked the host, so none of the
patterns above have been verified against a real Diskwala page. They are generic
video-host patterns. Expect to adjust one regex on first real use:

```bash
DEBUG_HTML=1 npm start
```

That prints the first 4 KB of the fetched HTML to stderr on each resolve. Find
how the player receives its source, then add a strategy to the `STRATEGIES`
array in `lib/resolve.js`.

If the player builds its source at runtime (XHR to a signed API, JS-computed
URL), regex extraction won't reach it — that case needs a headless browser
(Playwright) intercepting network requests instead.

## Scope

- Only `diskwala.*` hostnames are accepted, on `http`/`https`. Other hosts are
  rejected, which also keeps `/api/resolve` from being used to probe internal
  addresses.
- Public pages only. There is no login, token, or DRM handling, and none should
  be added.
- 30 requests/minute per IP, in-process (`RATE_LIMIT_PER_MIN` to change).
- No authentication. Deployed publicly, anyone who finds the URL uses your
  bandwidth — see the deployment caveats in DEPLOY.md.

Use it for content you have the right to download.
