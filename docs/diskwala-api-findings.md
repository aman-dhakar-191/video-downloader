# Diskwala frontend: what the diagnostic established

Source: `tools/diagnose-diskwala.mjs` run against
`https://www.diskwala.com/app/6aa1693b06ba7ea03d093042` from the VPS.
The bundle ships a full source map (`sourcesContent: YES`, 550 files), so these
are read from Diskwala's own code, not inferred.

## Confirmed

**The page HTML carries no per-video data.** Every `og:` tag on an `/app/:id`
page is site-wide boilerplate — `og:url` is literally `https://www.diskwala.com/`
and `og:title` is the company tagline. 3275 bytes, a React SPA shell. No static
extraction strategy can ever work here; this is why the current resolver fails.

**API base URL:** `https://ddudapidd.diskwala.com/api/v1/`

**API surface** (paths referenced in the bundle):

```
/file/temp_info          /file/get_files        /file/sign
/file/creator_info       /file/add_file         /file/delete_file
/file/playlist_info      /file/update_file_info /file/multipart/*
/public/c/{code}         /public/contactus      /revenue/get
/user/profile            /user/generate_short_code   /user/*
```

**The call behind `/app/:id`, confirmed by browser capture:**

```
POST https://ddudapidd.diskwala.com/api/v1/file/temp_info
body:    {"id":"<the 24-char id from the page URL>"}
headers: Appicrypt: <ES256 JWT>
         Appicrypt-ts: <epoch milliseconds>
         Referer: https://www.diskwala.com/
```

The app first issues `GET /api/v1/auth`, also signed. The id key is plain `id`.

## The blocker: signed requests

The axios instance carries a request interceptor that signs **every** API call:

```js
Zt.interceptors.request.use(async (config) => {
  const t = await Gt({
    method: config.method,
    urlPath: config.url,
    params: config.params,
    data: config.data,
  });
  config.headers.Appicrypt = t.Appicrypt;
  config.headers['Appicrypt-ts'] = t['Appicrypt-ts'];
  return config;
});
```

The instance is also created with `withCredentials: true`, so cookies travel
with each request.

`Appicrypt` is a commercial client-attestation / API request-signing product.
The signature is computed client-side over the method, path, params and body,
with a timestamp. Its entire purpose is to make requests from anything other
than the genuine first-party client fail.

**Consequence:** a plain `fetch()` from Node cannot call this API. Reproducing
the request means reproducing the signature.

## Implications for this project

Reimplementing the `Appicrypt` signature in Node would mean defeating an access
control that exists specifically to prevent non-official clients from calling
the API. This project does not do that — see `README.md` scope: no login, token,
or DRM handling.

The remaining legitimate option is to drive the real client: load the page in a
headless browser, let Diskwala's own JavaScript sign its own requests, and
observe the media URL that results. Nothing is forged; the official client runs
as its authors intended.

That has real costs, which are the actual decision to make:

- Chromium is roughly 300-500 MB of RAM per instance and several seconds per
  cold resolve.
- It is a much larger production image and attack surface than the current
  ~100 MB Node container.
- Media URLs from this kind of API are usually signed and short-lived, so they
  cannot be cached, and a "Direct link" handed to a user may expire before use.

## Conclusion: the web page never exposes the media

Opening the same `/app/:id` URL in an ordinary desktop browser renders a
working page - not the 404 the headless capture hit. What it renders settles
the project:

- A "Shared File" card: mime type (`video/mp4`) and size (`23.25 MB`).
- The filename **masked** (`*i**Wa*a_*iL*_6*f93*****`), and the uploader name
  masked the same way.
- Two actions: **View in App** and **Download App**, plus "Copy link to open
  in browser".
- A panel headed "Open in DiskWala App - Download the app to access this file
  and all DiskWala content."

There is no `<video>` element and no player. The web page is a landing page
whose purpose is to send the visitor to the mobile app. The masking is
deliberate, not a rendering artifact.

So there is no media URL on the page to extract, with or without a browser.
`temp_info` returns metadata for this card; the media itself is gated behind
the app.

### Why the headless capture saw a 404

The same id renders for a normal browser and 404s for headless Chromium from
a datacenter IP. The most likely cause is the Appicrypt attestation failing
for a non-genuine client - which is exactly what that product exists to do.
The ad-bidder payloads in the capture confirm the browser advertised itself
as `HeadlessChrome`.

This matters beyond the diagnostic: it means driving a real browser
server-side, the one remaining approach considered here, does not reliably
work either. Both routes are closed.

## Status: not implementable within this project's scope

Getting the media would require defeating the attestation that gates the API,
or reimplementing the mobile app's client - both squarely outside the scope in
`README.md` ("no login, token, or DRM handling, and none should be added").

The one avenue that is not circumvention is Diskwala's own **"Copy link to
open in browser"** control. If that yields a direct media URL, the existing
resolver can use it. If it yields another `/app/:id` page, there is nothing
further to try.

The web app, the download proxy, the Telegram bot and the deployment all work
and are independent of this. They are ready for any host that publishes a
reachable media URL.
