# Static site with the backend elsewhere

For a CDN-hosted page (Vercel, Netlify, Cloudflare Pages, S3) whose qID server
runs on a VM or container somewhere else. `examples/static-rewrite-demo/` in the
release pack is a complete, runnable version of this, including a systemd unit.

## The one rule

The wallet must see the same origin the user sees. If your page is at
`https://app.example.com` and your qID server is at `https://api.example.com`,
do **not** point the widget at the API host. Instead, rewrite `/qid/*`
same-origin so the browser only ever talks to `app.example.com`.

Two reasons, and both are hard failures rather than warnings:

1. The session cookie is set for the origin that answered `/verify`. Cross-origin,
   the browser will not send it back, so sign-in appears to succeed and the user
   is instantly anonymous again.
2. The proof is bound to `rp_origin`. If the wallet is shown the API origin while
   the user is on the app origin, you have created exactly the phishing shape the
   origin binding exists to prevent.

## Rewrite recipes

**Vercel** (`vercel.json`):

```json
{ "rewrites": [{ "source": "/qid/:path*", "destination": "https://api.example.com/qid/:path*" }] }
```

**Netlify** (`netlify.toml`):

```toml
[[redirects]]
  from = "/qid/*"
  to = "https://api.example.com/qid/:splat"
  status = 200      # 200 = proxy, not 301: a redirect would change the origin
  force = true
```

**Caddy**:

```
app.example.com {
  root * /var/www/app
  file_server
  reverse_proxy /qid/* api.example.com:8788
}
```

**nginx**:

```nginx
location /qid/ {
  proxy_pass http://127.0.0.1:8788;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  # do not touch the Origin header: the login-CSRF guard reads it
}
```

Whatever the platform, it must be a proxy (status 200), not a redirect. A 301 or
302 changes the origin and breaks both the cookie and the origin binding.

## Server config

`origin` is the **page** origin, never the API host:

```js
const qid = createQidConnect({
  origin: "https://app.example.com",     // where users land
  sessionSecret: process.env.QID_SESSION_SECRET,
  nonceStore: new SqliteNonceStore({ path: "/var/lib/qid/qid.sqlite" }),
  accounts: new SqliteAccounts({ path: "/var/lib/qid/qid.sqlite" }),
});
```

Then verify from the outside, through the rewrite, which is the only test that
proves the whole path:

```sh
bun scripts/check-integration.mjs https://app.example.com
```

Running the checker against the API host directly will pass while real users
still fail, because it skips the rewrite that the browser depends on.
