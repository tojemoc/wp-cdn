# wp-cdn

Two pieces that together replace CDN Enabler + Bandwidth Saver:

| Path | What |
|---|---|
| `simple-cdn/` | WordPress plugin — rewrites media/static URLs to a CDN hostname (host-swap or worker style). See `simple-cdn/README.md`. |
| `worker/` | Cloudflare Worker — fetches media from the origin named in the first path segment, caches it in R2, serves it with range support. |

## Worker

```bash
cd worker
npm install
npm run dev        # local dev
npm run typecheck  # tsc --noEmit
npm run build      # wrangler dry-run bundle -> dist/
npm run deploy     # wrangler deploy (needs CLOUDFLARE_API_TOKEN)
```

Configure bindings/vars in `worker/wrangler.toml`. Set `ORIGIN_MODE = "list"`
and `ALLOWED_ORIGINS` before going live.

## Releasing

1. Bump `Version:` in `simple-cdn/simple-cdn.php`, `version` in
   `worker/package.json` and `VERSION` in `worker/src/utils.ts`.
2. `git tag vX.Y.Z && git push --tags`
3. CI builds both artifacts and attaches `simple-cdn.zip` +
   `simple-cdn-worker.js` to a GitHub release.

Every push/PR also runs the worker typecheck + build. Set repo variable
`DEPLOY_WORKER=true` and secret `CLOUDFLARE_API_TOKEN` to also `wrangler deploy`
on tags.
