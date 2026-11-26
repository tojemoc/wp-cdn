# Simple CDN

One small plugin that replaces **CDN Enabler** and **Bandwidth Saver** (self-hosted mode).
It rewrites your site's image URLs (or any file types you list) to a CDN hostname.

## Two URL styles

| Style | Rewritten URL | Needs |
|---|---|---|
| **Host swap** | `https://cdn.example.com/wp-content/uploads/a.jpg` | A hostname that serves the same paths as your site, e.g. a Cloudflare-proxied CNAME pointing at your server (the approach in Josh Betz's post). No Worker, no R2. |
| **Worker** | `https://cdn.example.com/example.com/wp-content/uploads/a.jpg` | The ImgPro-style Cloudflare Worker + R2 bucket. The Worker reads the origin domain from the first path segment, fetches the file once, stores it in R2. Images, video and audio only. |

## Two CDNs at once

You can configure up to two CDNs, each with its own hostname, URL style and extension list. Every file extension is routed to exactly one CDN. Example:

| | Hostname | Style | Extensions |
|---|---|---|---|
| CDN 1 | `media.fktrans.eu` | Worker | jpg, jpeg, png, gif, webp, avif, svg, ico |
| CDN 2 | `static.fktrans.eu` | Host swap | css, js, woff, woff2, ttf, otf, eot |

If both claim an extension, CDN 1 wins and the settings page tells you.

### Things to check for the static (host swap) CDN

* **Fonts need CORS.** Browsers refuse cross-origin fonts (Firefox is strictest) unless the response has `Access-Control-Allow-Origin`. In Cloudflare add a *Modify Response Header* rule on `static.…` that sets it to your site origin. The Worker already sends `*` for media.
* **Service workers must stay same-origin.** Add `/sw.js` (or whatever yours is called) to Exclusions, as well as any `new Worker('/…js')` script.
* Your origin web server must answer for the `static.…` hostname (wildcard or extra vhost).

## Install / migrate

1. Upload and activate **Simple CDN**. If Bandwidth Saver (self-hosted mode) or CDN Enabler had a hostname saved, it is imported automatically.
2. Open **Settings → Simple CDN**, enter a CDN hostname, pick a URL style, tick *Rewrite URLs on the front end* and **Save**. Then check the *Preview* line at the bottom.
3. Deactivate the old plugin(s). Their settings stay in the database; delete the plugins whenever you're happy.
4. View source on a page and confirm image URLs point at your CDN hostname.

## What was intentionally dropped from Bandwidth Saver

* Everything that talks to `billing.bandwidth-saver.com`: accounts, Stripe checkout, plan selector, usage charts, API-key encryption, onboarding (~90% of the plugin's code).
* The per-image `onerror` fallback, its 14 KB JS file and CSS. The Worker answers with a 302 to your origin whenever it knows upfront that it can't serve a file. Mid-stream failures slip through: when the origin omits `Content-Length` (chunked responses) and the body exceeds `MAX_FILE_SIZE`, when the origin stalls after sending headers and hits the fetch timeout, or when the stream is otherwise interrupted — the Worker can't redirect and the image just breaks. It's easy to add the fallback back if you want it.
* Rewriting every image host. Only *your* site's hostnames are rewritten (add more with the `simple_cdn_site_hostnames` filter).

## Filters

* `simple_cdn_bypass` → return `true` to skip rewriting for a request.
* `simple_cdn_site_hostnames` → array of hostnames that count as "this site".

## Page caches

Simple CDN rewrites the finished HTML in an output buffer. If a page-cache plugin stores pages, make sure it stores them *after* this runs (most do, since they capture the same final output). After first enabling, purge your page cache.

## Securing your Worker (important)

The Worker's default `ORIGIN_MODE` is `open`: it will fetch and cache images from **any** domain someone puts in the URL, on your Cloudflare bill. Set these Worker variables:

```
ORIGIN_MODE     = list
ALLOWED_ORIGINS = example.com,www.example.com
```

`*.example.com` does **not** match the bare `example.com`; list both.
The Worker ignores query strings, so replacing an image *at the same path* keeps serving the old R2 copy — and browsers hold it immutably for a year. To refresh:

1. Fetch the image once through a URL it has never served, e.g. `photo.jpg?v=2&force=1`. `force` makes the Worker refetch the origin and replace the R2 object; the URL must be fresh because the `force` response is itself cached immutably (reusing `?force=1` alone may hit a stale browser or edge cache).
2. Verify the new copy actually landed — the R2 write finishes in the background, and the forced URL can't confirm it (`force` skips the R2 lookup entirely). Fetch the non-forced URL (`photo.jpg?v=2`), which reads from R2, or check the bucket directly. Some origin responses are never stored at all (`Cache-Control: no-store`, `private`, or `no-cache`; a `Vary` on anything but `Accept-Encoding`; or an encoded body) — a forced fetch of one streams straight from the origin, writes nothing, and leaves any existing R2 copy untouched, so this procedure does nothing for them.
3. Switch your markup to a *new* versioned URL — `photo.jpg?v=2`, then `v=3` on the next refresh. Never reuse a versioned URL a browser may already hold; it stays frozen for a year.
