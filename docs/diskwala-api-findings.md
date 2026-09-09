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

Every `/file/*_info` endpoint is `POST`, called as `axios.post(path, payload)`.
`/file/temp_info` is the plausible match for `/app/:id`, but the exact payload
key for the id is **not yet established** and must not be guessed.

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

## Not yet established

Run `tools/capture-diskwala.mjs` to answer, from real traffic:

1. Which endpoint `/app/:id` actually calls, and the exact request body.
2. The response JSON shape and where the media URL sits inside it.
3. Whether the media URL is signed/expiring, and whether the CDN requires a
   `Referer`.
4. Whether any of it works without an authenticated session.
