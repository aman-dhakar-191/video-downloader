import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

process.env.PUBLIC_BASE_URL = 'https://dl.example.com';
const { firstUrl, replyFor, esc } = await import('../bot.js');

const FILE_SRC = { url: 'https://cdn.diskwala.com/x/720.mp4', kind: 'file', via: 'test' };
const HLS_SRC = { url: 'https://cdn.diskwala.com/x/master.m3u8', kind: 'hls', via: 'test' };

test('firstUrl pulls a link out of surrounding chatter', () => {
  assert.equal(firstUrl('check this https://diskwala.com/v/1 out'), 'https://diskwala.com/v/1');
  assert.equal(firstUrl('no link here'), null);
});

test('esc neutralises HTML in titles', () => {
  assert.equal(esc('<b>hi</b> & bye'), '&lt;b&gt;hi&lt;/b&gt; &amp; bye');
});

test('a file source gets both a proxied and a direct button', () => {
  const { markup } = replyFor({
    title: 'Clip',
    pageUrl: 'https://diskwala.com/v/abc',
    sources: [FILE_SRC],
  });

  const [row] = markup.inline_keyboard;
  assert.equal(row.length, 2);
  assert.match(row[0].url, /^https:\/\/dl\.example\.com\/api\/download\?/);
  assert.match(row[0].url, /src=https%3A%2F%2Fcdn\.diskwala\.com/);
  assert.equal(row[1].url, FILE_SRC.url);
});

test('an HLS source gets an ffmpeg command and no buttons', () => {
  const { text, markup } = replyFor({
    title: 'Clip',
    pageUrl: 'https://diskwala.com/v/abc',
    sources: [HLS_SRC],
  });

  assert.equal(markup, undefined);
  assert.match(text, /ffmpeg -i/);
  assert.match(text, /master\.m3u8/);
});

test('the title is escaped into the reply body', () => {
  const { text } = replyFor({
    title: 'A <script> & friends',
    pageUrl: 'https://diskwala.com/v/abc',
    sources: [FILE_SRC],
  });
  assert.match(text, /A &lt;script&gt; &amp; friends/);
  assert.doesNotMatch(text, /<script>/);
});

test('polls a stubbed Bot API and replies to a message', async (t) => {
  const sent = [];
  let updatesServed = false;

  const stub = http.createServer((req, res) => {
    const method = req.url.split('/').pop();
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      const reply = (result) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, result }));
      };

      if (method === 'getMe') return reply({ username: 'stubbot' });
      if (method === 'sendMessage') {
        sent.push(payload);
        return reply({ message_id: 1 });
      }
      if (method === 'getUpdates') {
        if (updatesServed) return reply([]);
        updatesServed = true;
        // A non-diskwala host fails validation with no network access at all,
        // so this exercises the full loop deterministically.
        return reply([
          {
            update_id: 10,
            message: { chat: { id: 5 }, from: { id: 5 }, text: 'https://example.com/x' },
          },
        ]);
      }
      return reply(true);
    });
  });

  stub.listen(0);
  await once(stub, 'listening');
  const base = `http://127.0.0.1:${stub.address().port}`;

  const child = spawn(process.execPath, ['bot.js'], {
    env: {
      ...process.env,
      TELEGRAM_TOKEN: 'stub-token',
      TELEGRAM_API_BASE: base,
      PUBLIC_BASE_URL: 'https://dl.example.com',
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGKILL');
    stub.close();
  });

  const deadline = Date.now() + 10_000;
  while (sent.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.equal(sent.length, 1, 'bot should have sent exactly one reply');
  assert.equal(sent[0].chat_id, 5);
  assert.match(sent[0].text, /Unsupported host/);
});
