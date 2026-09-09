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
- 30 requests/minute per IP, in-process.

Use it for content you have the right to download.
