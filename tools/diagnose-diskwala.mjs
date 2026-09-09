#!/usr/bin/env node
// Diagnostic ONLY. Not imported by the app, not shipped in the Docker image.
//
// Fetches a Diskwala page, pulls down its JS bundles and source maps, and
// reports what the frontend actually does: the axios base URL, every API path
// string, and — if the source map carries sourcesContent — the original,
// readable source of the API layer.
//
// Usage:  node tools/diagnose-diskwala.mjs https://www.diskwala.com/app/<id>

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const OUT = '/tmp/diskwala-diag';
const pageUrl = process.argv[2];

if (!pageUrl) {
  console.error('usage: node tools/diagnose-diskwala.mjs <diskwala page url>');
  process.exit(1);
}

const fs = await import('node:fs/promises');
await fs.mkdir(OUT, { recursive: true });

const line = (s = '') => console.log(s);
const rule = (t) => line(`\n${'='.repeat(70)}\n${t}\n${'='.repeat(70)}`);

async function get(url, referer) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': UA, ...(referer ? { referer } : {}) },
  });
  return { status: res.status, body: await res.text(), url: res.url, headers: res.headers };
}

// ---------------------------------------------------------------- page HTML
rule('1. PAGE HTML');
const page = await get(pageUrl);
line(`status: ${page.status}   bytes: ${page.body.length}`);
await fs.writeFile(`${OUT}/page.html`, page.body);
line(`saved:  ${OUT}/page.html`);

const ogTags = [...page.body.matchAll(/<meta[^>]+(?:property|name)=["']og:[^"']+["'][^>]*>/gi)].map(
  (m) => m[0]
);
line(`\nog: tags found (${ogTags.length}):`);
ogTags.forEach((t) => line('  ' + t.trim()));
line('\nIf these are the same generic tags on every video page, the HTML shell');
line('carries no per-file data and only the runtime API can answer.');

// ------------------------------------------------------------- JS bundles
rule('2. JS BUNDLES');
const scripts = [...page.body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) =>
  new URL(m[1], page.url).href
);
line(scripts.length ? scripts.join('\n') : '(none found — page may be fully server-rendered)');

const bundles = [];
for (const src of scripts) {
  const js = await get(src, page.url);
  const name = src.split('/').pop();
  await fs.writeFile(`${OUT}/${name}`, js.body);
  bundles.push({ src, name, body: js.body });
  line(`  fetched ${name}  (${js.body.length} bytes)`);
}

// ------------------------------------------------------------- source maps
rule('3. SOURCE MAPS');
let gotSources = false;
for (const b of bundles) {
  const ref = b.body.match(/\/\/# sourceMappingURL=(\S+)/);
  if (!ref) {
    line(`${b.name}: no sourceMappingURL`);
    continue;
  }
  const mapUrl = new URL(ref[1], b.src).href;
  const map = await get(mapUrl, b.src);
  line(`${b.name}: map -> ${mapUrl}  status ${map.status}`);
  if (map.status !== 200) continue;

  let parsed;
  try {
    parsed = JSON.parse(map.body);
  } catch {
    line('  (map is not valid JSON)');
    continue;
  }

  await fs.writeFile(`${OUT}/${b.name}.map`, map.body);
  const hasContent = Array.isArray(parsed.sourcesContent) && parsed.sourcesContent.length;
  line(`  sources: ${parsed.sources?.length || 0}   sourcesContent: ${hasContent ? 'YES' : 'no'}`);

  if (!hasContent) continue;
  gotSources = true;

  // Unpack originals so the API layer can simply be read.
  const dir = `${OUT}/src`;
  await fs.mkdir(dir, { recursive: true });
  let written = 0;
  for (let i = 0; i < parsed.sources.length; i++) {
    const content = parsed.sourcesContent[i];
    if (!content) continue;
    const safe = parsed.sources[i].replace(/[^\w.-]+/g, '_').slice(-120);
    await fs.writeFile(`${dir}/${safe}`, content);
    written++;
  }
  line(`  unpacked ${written} original files -> ${dir}`);

  const interesting = parsed.sources.filter((s) =>
    /api|service|axios|http|request|file|player|video/i.test(s)
  );
  if (interesting.length) {
    line('\n  files worth reading first:');
    interesting.slice(0, 25).forEach((s) => line('    ' + s));
  }
}

// ---------------------------------------------------------- API surface
rule('4. API SURFACE (from bundle strings)');
const all = bundles.map((b) => b.body).join('\n');

const baseUrls = new Set(
  [
    ...all.matchAll(/baseURL\s*:\s*["'`]([^"'`]+)["'`]/g),
    ...all.matchAll(/["'`](https?:\/\/[^"'`\s]*api[^"'`\s]*)["'`]/gi),
  ].map((m) => m[1])
);
line('candidate API base URLs:');
baseUrls.size ? [...baseUrls].forEach((u) => line('  ' + u)) : line('  (none found)');

const paths = new Set(
  [...all.matchAll(/["'`](\/(?:file|public|user|auth|video|media|stream|revenue)\/[^"'`\s]*)["'`]/g)].map(
    (m) => m[1]
  )
);
line('\nAPI paths referenced in the bundle:');
paths.size ? [...paths].sort().forEach((p) => line('  ' + p)) : line('  (none found)');

// Show the code around each path so the request shape is visible.
rule('5. CALL SITES (context around each API path)');
for (const p of [...paths].sort()) {
  const idx = all.indexOf(p);
  if (idx < 0) continue;
  const snippet = all.slice(Math.max(0, idx - 300), idx + 500).replace(/\s+/g, ' ');
  line(`\n--- ${p} ---`);
  line(snippet);
}

rule('SUMMARY');
line(`artifacts in ${OUT}`);
if (gotSources) {
  line('Source maps included original sources — read /tmp/diskwala-diag/src for the');
  line('API layer. That is the authoritative answer; the greps above are hints.');
} else {
  line('No sourcesContent available. The call-site snippets above are the best');
  line('static evidence. If the request shape is still unclear, run:');
  line('  node tools/capture-diskwala.mjs <url>');
  line('which records the real network traffic in a headless browser.');
}
