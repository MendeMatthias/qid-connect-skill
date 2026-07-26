# Troubleshooting

Nearly every real failure is one of a handful of configuration mistakes, and the
symptom tells you which. Run `scripts/check-integration.mjs` first: it detects
most of these directly and saves you the guessing.

## Symptom to cause

| What you see | Almost always |
|---|---|
| Every proof rejected, reason `bad_origin` | `origin` is not the exact origin users land on. Apex vs www, http vs https, or a stray port or trailing slash. |
| QR renders, then flips to "expired" within seconds | Multiple instances with per-process stores. The instance answering `/poll` never saw the nonce `/challenge` issued. |
| Copy-paste sign-in works, phone or QR sign-in does nothing | `apiPath` not passed, so `proof_url` points at a route that 404s. Classic on Next.js, where routes live under `/api/qid`. |
| Sign-in succeeds, then the user is immediately signed out | The session cookie is not reaching your server: a cross-origin backend without a same-origin `/qid/*` rewrite, or plain http so a `Secure` cookie is dropped. |
| `nonce_unknown` on a proof the user just signed | The nonce expired (default TTL 5 minutes), was already used, or was burned by widget rotation. Also what an unshared store looks like. |
| `expired` or `not_yet_valid` | Server clock skew. The window is TTL plus 60 seconds of tolerance. |
| Everyone signed out after a deploy | `sessionSecret` changed. It is derived per-process if you did not pin it; put it in a secret store. |
| Works locally, fails in production only | Almost certainly `origin` again, plus a CDN redirect you did not know about. |
| The button never renders, console shows a CSP violation | The hosted widget is a cross-origin module. Add `https://qid.dev` to `script-src`, or vendor the widget. |
| `ERR_MODULE_NOT_FOUND` importing the SQLite stores | There is no `/sqlite` subpath. `SqliteNonceStore` and `SqliteAccounts` come from the package root, and they take a database handle, not a path. |
| `bun install` fails on a bare server | `unzip` is missing: `apt-get install -y unzip`, or run on Node 20+ with the Node SQLite path. |

## Reason codes, and what each one means

From `verifySignIn`:

- `bad_proof_shape` - not a v1 bundle, or a field is missing or malformed.
- `origin_mismatch` - the proof was signed for a different site. Working as intended: this is what makes a proof for another site worthless on yours.
- `address_mismatch` - the address does not rebuild from the keys in the proof.
- `expired` / `not_yet_valid` - outside the freshness window; check clocks.
- `nonce_used` - replay, or the user submitted twice.
- `bad_signature` - the signature does not verify.

From the server layer:

- `nonce_unknown` - this deployment did not issue that nonce, or no longer knows it.
- `bad_request_body` - the body was not JSON. On Express, `express.json()` must be mounted before the middleware.
- `bad_origin` on `/verify` or `/poll` - the login-CSRF guard fired. Legitimate cross-site attempts hit this; so does a proxy that rewrites the `Origin` header.

## Developing without a wallet

From inside the release pack:

```sh
bun tools/signer/btx-sign-ownership.mjs --random \
  --origin http://localhost:3000 --nonce <nonce> --ts <ts>
```

Take `nonce` and `ts` from the dialog's **Desktop wallet** tab. The QR tab
rotates about every 105 seconds and the server burns the superseded nonce, so a
proof signed against a stale QR is correctly rejected. Paste the printed proof
into that tab's step 2, or POST it to `/qid/proof` to simulate a phone.

## When you are sure the config is right and it still fails

Check in this order, because each rules out a whole class:

1. `curl -s -X POST https://yoursite/qid/challenge | jq .challenge.rp_origin`
   If that string is not exactly what `location.origin` prints in your browser
   on the live site, stop: that is the bug.
2. `curl -s -X POST https://yoursite/qid/challenge | jq .request.proof_url`
   Then `curl -i -X POST` that URL. A 404 means `apiPath` is wrong.
3. Issue a challenge, then immediately POST any junk proof carrying that nonce.
   A `nonce_unknown` response means your stores are not shared across instances.

Those three commands identify the cause in nearly every case, and they are what
`scripts/check-integration.mjs` automates.
