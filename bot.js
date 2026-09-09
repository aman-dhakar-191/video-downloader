// Telegram bot front end for the resolver.
//
// The bot never downloads or uploads the video itself: Telegram caps bot
// uploads at 50 MB, which most videos exceed. Instead it replies with buttons —
// one pointing at this app's /api/download proxy (proper filename, survives
// hotlink protection, costs your bandwidth) and one at the raw CDN URL (free,
// but breaks if the upstream checks Referer).
//
// Zero dependencies: the Bot API is plain HTTPS and long polling is a loop.

import { pathToFileURL } from 'node:url';
import { resolveVideo, ResolveError } from './lib/resolve.js';
import { downloadUrl } from './lib/links.js';

const TOKEN = process.env.TELEGRAM_TOKEN;
// Overridable so tests can point at a stub, and so a self-hosted Bot API server
// (which raises the 50 MB upload cap) can be dropped in later without edits.
const API_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const API = `${API_BASE}/bot${TOKEN}`;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

// Without an allowlist the bot is open to anyone who finds it, and every
// download button they tap spends your VPS bandwidth.
const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const HELP = [
  'Send me a public Diskwala video link and I will reply with its direct media URL.',
  '',
  'I do not send the video file itself — Telegram caps bot uploads at 50 MB and',
  'most videos are larger. You get buttons instead:',
  '',
  '• <b>Download</b> — streams through this server, keeps a proper filename.',
  '• <b>Direct link</b> — straight from the CDN, faster, but may be blocked.',
  '',
  'Tip: if a download stalls, open the link in your real browser rather than',
  "Telegram's built-in one.",
].join('\n');

async function callApi(method, payload, signal) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method} failed: ${data.description || res.status}`);
  return data.result;
}

function send(chatId, text, replyMarkup) {
  return callApi('sendMessage', {
    chat_id: chatId,
    text: text.slice(0, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  }).catch((err) => console.error('send failed:', err.message));
}

/** Pull the first URL out of a message, so "check this out <link>" still works. */
function firstUrl(text) {
  return text.match(/https?:\/\/\S+/i)?.[0] || null;
}

function replyFor(info) {
  const lines = [`<b>${esc(info.title)}</b>`, ''];
  const buttons = [];

  for (const source of info.sources) {
    if (source.kind === 'file') {
      const proxied = PUBLIC_BASE_URL
        ? downloadUrl(PUBLIC_BASE_URL, source, info.pageUrl, info.title)
        : null;
      const row = [];
      if (proxied) row.push({ text: '⬇️ Download', url: proxied });
      row.push({ text: '🔗 Direct link', url: source.url });
      buttons.push(row);
    } else {
      // A manifest is not a file; the user needs ffmpeg to turn it into one.
      lines.push(
        `${source.kind.toUpperCase()} stream — no single file to download. Use:`,
        `<code>ffmpeg -i "${esc(source.url)}" -c copy out.mp4</code>`,
        ''
      );
    }
  }

  if (buttons.length === 0 && lines.length === 2) {
    lines.push('Resolved, but produced no usable link.');
  }

  return {
    text: lines.join('\n').trim(),
    markup: buttons.length ? { inline_keyboard: buttons.slice(0, 5) } : undefined,
  };
}

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text || '').trim();
  if (!chatId || !text) return;

  if (ALLOWED.size && !ALLOWED.has(String(msg.from?.id))) {
    return send(chatId, 'This bot is private.');
  }

  if (text.startsWith('/start') || text.startsWith('/help')) {
    return send(chatId, HELP);
  }

  const url = firstUrl(text);
  if (!url) {
    return send(chatId, 'Send me a Diskwala video link. /help for details.');
  }

  await callApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  try {
    const info = await resolveVideo(url);
    const { text: body, markup } = replyFor(info);
    return send(chatId, body, markup);
  } catch (err) {
    if (err instanceof ResolveError) return send(chatId, `❌ ${esc(err.message)}`);
    console.error('resolve failed:', err);
    return send(chatId, '❌ Something went wrong resolving that link.');
  }
}

async function main() {
  if (!TOKEN) {
    console.error('TELEGRAM_TOKEN is not set. Get one from @BotFather.');
    process.exit(1);
  }
  if (!PUBLIC_BASE_URL) {
    console.warn('PUBLIC_BASE_URL is not set: replies will omit the proxied download button.');
  }

  const me = await callApi('getMe', {});
  console.log(`Telegram bot running as @${me.username}`);
  if (ALLOWED.size) console.log(`Allowlist active: ${ALLOWED.size} user id(s)`);
  else console.warn('No TELEGRAM_ALLOWED_IDS set — the bot responds to anyone.');

  const controller = new AbortController();
  let running = true;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      running = false;
      controller.abort();
    });
  }

  let offset = 0;
  let backoff = 1000;

  while (running) {
    try {
      const updates = await callApi(
        'getUpdates',
        { offset, timeout: 30, allowed_updates: ['message'] },
        controller.signal
      );
      backoff = 1000;
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) await handleMessage(update.message);
      }
    } catch (err) {
      if (!running) break;
      // 409 means another instance is polling the same token; backing off
      // rather than exiting lets a rolling restart settle on its own.
      console.error('poll error:', err.message);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }

  console.log('Bot stopped.');
  process.exit(0);
}

// Only poll when run directly, so tests can import the pure helpers below.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { firstUrl, replyFor, esc, HELP };
