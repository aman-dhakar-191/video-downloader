import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveVideo, parseInputUrl, safeFilename, ResolveError } from '../lib/resolve.js';

/** Serve fixture HTML for any URL, so tests never touch the network. */
function stubFetch(pages) {
  globalThis.fetch = async (url) => {
    const key = String(url);
    if (!(key in pages)) throw new Error(`unexpected fetch: ${key}`);
    return {
      ok: true,
      status: 200,
      url: key,
      text: async () => pages[key],
    };
  };
}

test('rejects non-diskwala hosts', () => {
  assert.throws(() => parseInputUrl('https://example.com/v/1'), ResolveError);
  assert.throws(() => parseInputUrl('file:///etc/passwd'), ResolveError);
  assert.throws(() => parseInputUrl('not a url'), ResolveError);
  assert.equal(parseInputUrl('https://diskwala.com/v/abc').hostname, 'diskwala.com');
});

test('extracts og:video and prefers a plain file over a manifest', async () => {
  stubFetch({
    'https://diskwala.com/v/abc': `
      <html><head>
        <meta property="og:title" content="My Clip: Part 2" />
        <meta property="og:video" content="https://cdn.diskwala.com/x/master.m3u8" />
      </head><body>
        <script>var cfg = {"file":"https://cdn.diskwala.com/x/720.mp4"};</script>
      </body></html>`,
  });

  const info = await resolveVideo('https://diskwala.com/v/abc');
  assert.equal(info.title, 'My Clip: Part 2');
  assert.equal(info.sources[0].kind, 'file');
  assert.equal(info.sources[0].url, 'https://cdn.diskwala.com/x/720.mp4');
  assert.ok(info.sources.some((s) => s.kind === 'hls'));
});

test('follows an iframe when the landing page has no media', async () => {
  stubFetch({
    'https://diskwala.com/v/abc': `<html><title>Landing</title>
      <iframe src="/embed/abc"></iframe></html>`,
    'https://diskwala.com/embed/abc': `<html><video src="https:\\/\\/cdn.diskwala.com\\/y.mp4">
      </video></html>`,
  });

  const info = await resolveVideo('https://diskwala.com/v/abc');
  assert.equal(info.sources[0].url, 'https://cdn.diskwala.com/y.mp4');
});

test('reports a clear error when nothing is found', async () => {
  stubFetch({ 'https://diskwala.com/v/abc': '<html><body>gone</body></html>' });
  await assert.rejects(() => resolveVideo('https://diskwala.com/v/abc'), /No media URL found/);
});

test('safeFilename strips path separators and keeps the extension', () => {
  assert.equal(safeFilename('a/b: "c"', 'https://x/y.mp4'), 'ab c.mp4');
  assert.equal(safeFilename('', 'https://x/y.webm?t=1'), 'video.webm');
});
