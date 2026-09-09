// Resolves a public Diskwala page URL into a list of directly playable media URLs.
//
// NOTE: this was written without live access to diskwala.com (blocked by network
// policy at development time), so the extraction strategies below are generic
// video-host patterns applied in order of confidence. If a page fails to
// resolve, run with DEBUG_HTML=1 to dump the fetched HTML and add a strategy.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HOST_RE = /(^|\.)diskwala\.[a-z.]+$/i;

export class ResolveError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Accept only http(s) diskwala URLs; keeps this off arbitrary internal hosts. */
export function parseInputUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new ResolveError('That is not a valid URL.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new ResolveError('Only http(s) URLs are supported.');
  }
  if (!HOST_RE.test(u.hostname)) {
    throw new ResolveError(`Unsupported host "${u.hostname}". Only diskwala links are accepted.`);
  }
  return u;
}

async function fetchText(url, referer) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      ...(referer ? { referer } : {}),
    },
  });
  if (!res.ok) {
    throw new ResolveError(`Upstream returned ${res.status} for ${url}`, 502);
  }
  return { html: await res.text(), finalUrl: res.url };
}

const decodeEntities = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

const unescapeJs = (s) =>
  s.replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/').replace(/\\"/g, '"');

const clean = (s) => decodeEntities(unescapeJs(String(s))).trim();

function kindOf(url) {
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
  if (/\.mpd(\?|$)/i.test(url)) return 'dash';
  return 'file';
}

/** Ordered extraction strategies. Each returns candidate URL strings. */
const STRATEGIES = [
  {
    name: 'og:video meta tag',
    run: (html) =>
      [...html.matchAll(/<meta[^>]+(?:property|name)=["']og:video(?::(?:secure_)?url)?["'][^>]*>/gi)]
        .map((m) => m[0].match(/content=["']([^"']+)["']/i)?.[1])
        .filter(Boolean),
  },
  {
    name: 'source / video src attribute',
    run: (html) => [
      ...[...html.matchAll(/<source[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]),
      ...[...html.matchAll(/<video[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]),
    ],
  },
  {
    name: 'JSON file/src/url key',
    run: (html) =>
      [
        ...html.matchAll(
          /["'](?:file|src|source|url|videoUrl|video_url|play_url)["']\s*:\s*["']([^"']+)["']/gi
        ),
      ]
        .map((m) => m[1])
        .filter((v) => /\.(m3u8|mpd|mp4|m4v|webm|mkv)(\?|$)/i.test(v)),
  },
  {
    name: 'bare media URL in page text',
    run: (html) =>
      [
        ...html.matchAll(
          /https?:\\?\/\\?\/[^\s"'<>()]+?\.(?:m3u8|mpd|mp4|m4v|webm|mkv)(?:\?[^\s"'<>()]*)?/gi
        ),
      ].map((m) => m[0]),
  },
];

function collect(html, baseUrl) {
  const seen = new Map();
  for (const strat of STRATEGIES) {
    let found = [];
    try {
      found = strat.run(html) || [];
    } catch {
      continue;
    }
    for (const raw of found) {
      let abs;
      try {
        abs = new URL(clean(raw), baseUrl).href;
      } catch {
        continue;
      }
      if (!/^https?:/i.test(abs)) continue;
      if (!seen.has(abs)) seen.set(abs, { url: abs, kind: kindOf(abs), via: strat.name });
    }
  }
  return [...seen.values()];
}

function extractTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  if (og) return clean(og[1]);
  const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return t ? clean(t[1]) : null;
}

/** Landing pages often only host an iframe; find it so we can retry against it. */
function findEmbedUrl(html, baseUrl) {
  const m =
    html.match(/<iframe[^>]+src=["']([^"']+)["']/i) ||
    html.match(/["'](https?:\\?\/\\?\/[^"']*\/(?:embed|player|e|watch)\/[^"']+)["']/i);
  if (!m) return null;
  try {
    return new URL(clean(m[1]), baseUrl).href;
  } catch {
    return null;
  }
}

export async function resolveVideo(inputUrl) {
  const pageUrl = parseInputUrl(inputUrl);
  const { html, finalUrl } = await fetchText(pageUrl.href);

  if (process.env.DEBUG_HTML) console.error(html.slice(0, 4000));

  let sources = collect(html, finalUrl);
  let title = extractTitle(html);

  if (sources.length === 0) {
    const embed = findEmbedUrl(html, finalUrl);
    if (embed && embed !== finalUrl) {
      const nested = await fetchText(embed, finalUrl);
      sources = collect(nested.html, nested.finalUrl);
      title = title || extractTitle(nested.html);
    }
  }

  if (sources.length === 0) {
    throw new ResolveError(
      'No media URL found on that page. It may be private, removed, or the player ' +
        'builds its source at runtime, which this extractor cannot follow.',
      422
    );
  }

  // Prefer a plain file over a manifest: it downloads in one shot.
  sources.sort((a, b) => (a.kind === 'file' ? -1 : 0) - (b.kind === 'file' ? -1 : 0));

  return { pageUrl: finalUrl, title: title || 'video', sources };
}

export function safeFilename(title, url) {
  const ext = (url.match(/\.([a-z0-9]{2,4})(?:\?|$)/i)?.[1] || 'mp4').toLowerCase();
  const base =
    String(title || 'video')
      .replace(/[^\w\s.-]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'video';
  return `${base}.${ext}`;
}

export { UA };
