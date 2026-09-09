import { safeFilename } from './resolve.js';

/**
 * Build the /api/download path for one resolved source. Returns null for HLS
 * and DASH manifests, which cannot be saved as a single file.
 *
 * Shared by the web server and the Telegram bot so both produce identical URLs.
 */
export function downloadPath(source, pageUrl, title) {
  if (source.kind !== 'file') return null;
  const params = new URLSearchParams({
    src: source.url,
    ref: pageUrl,
    name: safeFilename(title, source.url),
  });
  return `/api/download?${params}`;
}

/** Same thing, absolute, for contexts that cannot use a relative path. */
export function downloadUrl(baseUrl, source, pageUrl, title) {
  const p = downloadPath(source, pageUrl, title);
  if (!p) return null;
  return new URL(p, baseUrl).href;
}
