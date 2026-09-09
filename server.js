import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { resolveVideo, parseInputUrl, safeFilename, ResolveError, UA } from './lib/resolve.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Very small in-process rate limit so one client cannot hammer the upstream.
const hits = new Map();
app.use('/api', (req, res, next) => {
  const now = Date.now();
  const key = req.ip;
  const window = (hits.get(key) || []).filter((t) => now - t < 60_000);
  if (window.length >= 30) return res.status(429).json({ error: 'Too many requests, slow down.' });
  window.push(now);
  hits.set(key, window);
  next();
});

/** POST /api/resolve  { url } -> { title, pageUrl, sources[] } */
app.post('/api/resolve', async (req, res) => {
  try {
    const info = await resolveVideo(req.body?.url);
    res.json({
      ...info,
      sources: info.sources.map((s) => ({
        ...s,
        filename: safeFilename(info.title, s.url),
        downloadPath:
          s.kind === 'file'
            ? `/api/download?src=${encodeURIComponent(s.url)}&ref=${encodeURIComponent(
                info.pageUrl
              )}&name=${encodeURIComponent(safeFilename(info.title, s.url))}`
            : null,
      })),
    });
  } catch (err) {
    const status = err instanceof ResolveError ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || 'Failed to resolve that URL.' });
  }
});

/**
 * GET /api/download?src=...&ref=...&name=...
 * Streams the upstream media through this server so the browser gets a proper
 * filename and no CORS/hotlink issues. Range requests are passed through.
 */
app.get('/api/download', async (req, res) => {
  const { src, ref, name } = req.query;
  let target;
  try {
    target = new URL(String(src));
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('bad protocol');
    if (ref) parseInputUrl(ref); // referer must still be a diskwala page
  } catch {
    return res.status(400).send('Invalid source URL.');
  }

  const controller = new AbortController();
  res.on('close', () => controller.abort());

  try {
    const upstream = await fetch(target.href, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: '*/*',
        ...(ref ? { referer: String(ref) } : {}),
        ...(req.headers.range ? { range: req.headers.range } : {}),
      },
    });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(502).send(`Upstream returned ${upstream.status}.`);
    }

    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    const filename = safeFilename(name || 'video', target.href);
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);

    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error(err);
    if (!res.headersSent) res.status(502).send('Download failed.');
    else res.destroy();
  }
});

app.listen(PORT, () => {
  console.log(`Diskwala downloader listening on http://localhost:${PORT}`);
});
