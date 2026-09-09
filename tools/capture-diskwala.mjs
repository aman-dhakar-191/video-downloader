#!/usr/bin/env node
// Diagnostic ONLY. Never imported by the app, never in the Docker image.
//
// Loads a Diskwala page in headless Chromium and records every XHR/fetch and
// media request: URL, method, request headers, request body, response status
// and response JSON. This is the authoritative answer to "what request does the
// frontend actually make", when static analysis of the bundle is inconclusive.
//
// Setup on the VPS (outside the app image):
//   npm i -D playwright && npx playwright install --with-deps chromium
//
// Usage:
//   node tools/capture-diskwala.mjs https://www.diskwala.com/app/<id>

const pageUrl = process.argv[2];
if (!pageUrl) {
  console.error('usage: node tools/capture-diskwala.mjs <diskwala page url>');
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright is not installed. From the repo root, run:');
  console.error('  npm i -D playwright && npx playwright install --with-deps chromium');
  process.exit(1);
}

// Requests worth reporting: the API surface and anything that smells like media.
const INTERESTING =
  /\/(file|public|user|auth|video|media|stream|revenue)\/|\.(m3u8|mpd|mp4|m4v|webm|mkv)(\?|$)/i;

const browser = await chromium.launch();
const context = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});
const page = await context.newPage();

const records = [];

page.on('request', (req) => {
  const type = req.resourceType();
  if (type !== 'xhr' && type !== 'fetch' && type !== 'media') return;
  if (!INTERESTING.test(req.url())) return;
  records.push({
    url: req.url(),
    method: req.method(),
    resourceType: type,
    requestHeaders: req.headers(),
    requestBody: req.postData() || null,
  });
});

page.on('response', async (res) => {
  const rec = records.find((r) => r.url === res.url() && r.status === undefined);
  if (!rec) return;
  rec.status = res.status();
  rec.responseHeaders = res.headers();
  try {
    const text = await res.text();
    rec.responseBody = text.length > 8000 ? text.slice(0, 8000) + '…[truncated]' : text;
  } catch {
    rec.responseBody = '(unreadable — probably a streamed body)';
  }
});

console.log(`loading ${pageUrl} …\n`);
await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 60_000 });

// The player often only requests media after it mounts; give it a moment, and
// try a click in case playback is gated behind one.
await page.waitForTimeout(5000);
try {
  await page.locator('video, [class*="play"], button').first().click({ timeout: 3000 });
  await page.waitForTimeout(5000);
} catch {
  /* nothing clickable; fine */
}

await browser.close();

// ------------------------------------------------------------------- report
if (records.length === 0) {
  console.log('No matching requests captured. Widen the INTERESTING regex and retry.');
  process.exit(0);
}

for (const r of records) {
  console.log('='.repeat(70));
  console.log(`${r.method} ${r.url}`);
  console.log(`resourceType: ${r.resourceType}   status: ${r.status ?? '(no response seen)'}`);

  const notableHeaders = Object.entries(r.requestHeaders).filter(([k]) =>
    /auth|token|referer|origin|cookie|x-/i.test(k)
  );
  if (notableHeaders.length) {
    console.log('\nnotable request headers:');
    for (const [k, v] of notableHeaders) console.log(`  ${k}: ${v}`);
  }

  if (r.requestBody) console.log(`\nrequest body:\n  ${r.requestBody}`);

  if (r.responseBody) {
    let body = r.responseBody;
    try {
      body = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      /* not JSON; print raw */
    }
    console.log(`\nresponse body:\n${body}`);
  }
  console.log();
}

const media = records.filter((r) => /\.(m3u8|mpd|mp4|m4v|webm|mkv)(\?|$)/i.test(r.url));
console.log('='.repeat(70));
console.log('MEDIA URLS OBSERVED:');
if (media.length) {
  media.forEach((m) => console.log('  ' + m.url));
  console.log('\nCheck these for a signature/expiry query parameter. If present, the');
  console.log('URL is temporary and must be resolved per request, never cached.');
} else {
  console.log('  none — the player may build the URL only on user interaction.');
}
