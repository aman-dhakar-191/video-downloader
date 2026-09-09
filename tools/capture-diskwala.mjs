#!/usr/bin/env node
// Diagnostic ONLY. Never imported by the app, never in the Docker image.
//
// Loads a Diskwala page in headless Chromium and records every XHR/fetch and
// media request: URL, method, request headers, request body, response status
// and response JSON.
//
// Diskwala signs every API call with an Appicrypt header computed client-side
// (see docs/diskwala-api-findings.md), so the request cannot be reproduced with
// a plain fetch. Running the real client is the way to observe what it does.
//
// Usage:
//   node tools/capture-diskwala.mjs https://www.diskwala.com/app/<id>

import fs from 'node:fs/promises';

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
  console.error('  npm i playwright && npx playwright install --with-deps chromium');
  process.exit(1);
}

// This page runs a full prebid ad stack: ~50 bidder calls that bury the two
// requests worth reading. Default to Diskwala's own traffic plus media; pass
// --all when something might be hiding in the noise.
const ALL = process.argv.includes('--all');
const SIGNAL = /diskwala|\.(m3u8|mpd|mp4|m4v|webm|mkv)(\?|$)/i;
const keep = (url) => ALL || SIGNAL.test(url);

const OUT = '/tmp/diskwala-diag';
const records = [];
const pageState = {};

// The capture is the deliverable, so it is reported even when navigation fails.
// An SPA behind Cloudflare may never reach a quiet network, and the API call we
// are after happens long before that would matter.
async function report() {
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(`${OUT}/capture.json`, JSON.stringify(records, null, 2));

  console.log('\n' + '='.repeat(70));
  console.log(`CAPTURED ${records.length} REQUEST(S)  ->  ${OUT}/capture.json`);
  console.log('='.repeat(70));

  for (const r of records) {
    console.log('\n' + '-'.repeat(70));
    console.log(`${r.method} ${r.url}`);
    console.log(`type: ${r.resourceType}   status: ${r.status ?? '(no response seen)'}`);
    if (r.failure) console.log(`FAILED: ${r.failure}`);

    const notable = Object.entries(r.requestHeaders || {}).filter(([k]) =>
      /auth|token|referer|origin|cookie|appicrypt|x-/i.test(k)
    );
    if (notable.length) {
      console.log('\nnotable request headers:');
      for (const [k, v] of notable) console.log(`  ${k}: ${v}`);
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
  }

  console.log('\n' + '='.repeat(70));
  console.log('WHAT THE PAGE ACTUALLY RENDERED');
  console.log(`  final URL: ${pageState.url || '(unknown)'}`);
  console.log(`  title:     ${pageState.title || '(unknown)'}`);
  if (/not found|404/i.test(`${pageState.title} ${pageState.url}`)) {
    console.log('\n  The app routed to its 404 page: it did not recognise this id.');
    console.log('  Confirm the link opens a playing video in your own browser before');
    console.log('  reading anything else here - the API answered, just not usefully.');
  }

  const media = records.filter((r) => /\.(m3u8|mpd|mp4|m4v|webm|mkv)(\?|$)/i.test(r.url));
  console.log('\n' + '='.repeat(70));
  console.log('MEDIA URLS OBSERVED:');
  if (media.length) {
    media.forEach((m) => console.log('  ' + m.url));
    console.log('\nCheck these for a signature/expiry parameter. If present the URL is');
    console.log('temporary: it cannot be cached and a shared link may expire before use.');
  } else {
    console.log('  none');
  }
}

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});
const page = await context.newPage();

page.on('request', (req) => {
  const type = req.resourceType();
  if (type !== 'xhr' && type !== 'fetch' && type !== 'media') return;
  if (!keep(req.url())) return;
  console.log(`  [${type}] ${req.method()} ${req.url()}`);
  records.push({
    url: req.url(),
    method: req.method(),
    resourceType: type,
    requestHeaders: req.headers(),
    requestBody: req.postData() || null,
  });
});

page.on('requestfailed', (req) => {
  if (!keep(req.url())) return;
  const rec = records.find((r) => r.url === req.url() && r.status === undefined);
  const reason = req.failure()?.errorText || 'unknown';
  console.log(`  [FAILED] ${req.method()} ${req.url()} -> ${reason}`);
  if (rec) rec.failure = reason;
});

page.on('response', async (res) => {
  const rec = records.find((r) => r.url === res.url() && r.status === undefined);
  if (!rec) return;
  rec.status = res.status();
  rec.responseHeaders = res.headers();
  try {
    await res.finished();
    const text = await res.text();
    rec.responseBody = text.length > 8000 ? text.slice(0, 8000) + '…[truncated]' : text;
  } catch {
    rec.responseBody = '(unreadable — probably a streamed body)';
  }
});

console.log(`loading ${pageUrl} …\n`);

try {
  // domcontentloaded, not networkidle: analytics and websockets keep this page
  // permanently busy, so networkidle times out having already captured plenty.
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  console.log('\n  DOM loaded; waiting for the app to make its API calls …');
} catch (err) {
  console.log(`\n  navigation problem: ${err.message.split('\n')[0]}`);
  console.log('  continuing anyway — anything captured before this is still reported.');
}

await page.waitForTimeout(10_000);

// The player may only request media once something is clicked.
try {
  await page
    .locator('video, button, [class*="play"], [class*="Play"]')
    .first()
    .click({ timeout: 5000 });
  console.log('  clicked a candidate play control; waiting …');
  await page.waitForTimeout(10_000);
} catch {
  console.log('  nothing clickable found; continuing.');
}

// Let in-flight response handlers finish before tearing the browser down.
await page.waitForTimeout(1500);

try {
  pageState.url = page.url();
  pageState.title = await page.title();
  await fs.writeFile(`${OUT}/rendered.html`, await page.content());
} catch {
  /* page may be gone; the capture matters more */
}

await browser.close();
await report();
