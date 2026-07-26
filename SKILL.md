---
name: qid-connect
description: Add "Sign in with qID" to a website or dApp - post-quantum wallet login for BTX where the user's address IS the account, with no email, no password, no relay server and no third-party service. Covers the server SDK (@qid/connect-server), the button widget, the account model, and a live checker that catches the misconfigurations that silently break sign-in. Use this whenever someone wants wallet login, wallet connect, address verification, "prove they own this address", passwordless or email-less auth, or account linking for a BTX or bonuz app, and also when they are debugging an existing qID integration (bad_origin, nonce_unknown, a QR that flips to expired, sign-in that works on desktop but not mobile). Reach for it even if the person says "web3 login" or "connect wallet" without naming qID, as long as BTX, bonuz or qID is anywhere in the picture.
license: MIT
---

# Integrating qID Connect

## What you are building, and the one invariant

A user proves control of a post-quantum BTX address by signing a one-time,
origin-bound challenge. Your server verifies the signature and issues a session.
That address is the account: first successful sign-in creates it, there is
nothing else to collect.

The invariant that shapes every decision below: **a qID login signature is
domain-separated from transactions and can never move funds.** There is no
transaction endpoint in this surface, so the worst case for a fully compromised
integrator site is stolen sessions on that site, never stolen coins. Keep that
line intact and you cannot build a catastrophic bug here.

## Get oriented first

Ask, or work out from the codebase, three things before writing code:

1. **The runtime.** Express, Next.js, or a static site with a backend elsewhere.
   Each has a reference file below; read only the one you need.
2. **The exact origin users land on.** Not the domain, the origin: scheme, host,
   and port after every redirect. This is the single most common cause of a
   dead integration, and it is worth two minutes of certainty now.
3. **Whether more than one server instance will serve this**, now or later.
   Serverless counts. If yes, the default in-memory stores are wrong and you
   need a shared store from the start.

Then follow the four steps. They are ordered so you always have something
verifiable before you add the next piece. A developer who knows their own
codebase should be through all four in well under an hour; most of that is
reading, not typing.

## Step 0: get the SDK

`@qid/connect-server` is **not on npm**. It ships in the release pack, which is
a public download:

```sh
curl -LO https://qid.dev/connect/qid-connect-latest.zip && unzip qid-connect-latest.zip
```

Inside, `packages/server` is the SDK. Add it as a workspace dependency, or copy
it into your app and install its three small dependencies
(`@noble/post-quantum`, `@noble/hashes`, `@scure/base`). The pack also carries
the runnable examples, the reference signer, and this skill.

The button needs nothing installed at all: it imports from qid.dev at runtime.
So if you only want address verification on a page you already serve, you can
skip ahead, wire the two endpoints your framework needs, and come back.

## Step 1: the server

```js
import { createQidConnect } from "@qid/connect-server";
import { qidMiddleware, requireQidSession } from "@qid/connect-server/express";

const qid = createQidConnect({
  origin: "https://www.yourapp.com",              // exact, no path, no trailing slash
  sessionSecret: process.env.QID_SESSION_SECRET,  // 32+ random chars, from a secret store
});

app.use(express.json());
app.use("/qid", qidMiddleware(qid));              // the entire login system
app.get("/api/me", requireQidSession(qid), (req, res) => res.json(req.qidSession));
```

That middleware mounts six routes. You rarely call them directly, but knowing
them makes debugging obvious rather than mysterious:

| route | purpose |
|---|---|
| `POST /qid/challenge` | issue a one-time challenge bound to your origin, plus the browser's poll secret |
| `POST /qid/verify` | verify a proof pasted in this browser, create or find the account, set the session cookie |
| `POST /qid/proof` | a phone wallet submits its proof here after scanning the QR |
| `GET /qid/poll` | the browser that issued the challenge claims the session once the proof lands |
| `GET /qid/session` | `{ address, account, expiresAt }`, or 401 |
| `POST /qid/logout` | clear the cookie |

Framework specifics, including the one Next.js setting that silently breaks QR
sign-in, are in `references/express.md`, `references/nextjs.md` and
`references/static-site.md`.

## Step 2: the button

```html
<div id="signin"></div>
<div id="account"></div>
<script type="module">
  import { mountQidConnect, mountQidAccount } from "https://qid.dev/connect/widget.js";
  const account = mountQidAccount(document.getElementById("account"), {
    api: "/qid",
    onSignedOut() { location.reload(); },
  });
  mountQidConnect(document.getElementById("signin"), {
    api: "/qid",                    // "/api/qid" on Next
    appName: "Your app",
    onSignedIn() { account.refresh(); },
  });
</script>
```

The hosted import is the default worth recommending: wallet-list and UX updates
reach users without a redeploy, and the signed protocol underneath is frozen v1,
so an update cannot break login. Pin `widget-<version>.js` or vendor
`packages/widget/src/` when the project has a policy about third-party script
origins. Either way, keep the button and dialog stock. Sameness across BTX apps
is what makes the flow trustworthy to users, so restyling it is a real cost.

`mountQidAccount` renders nothing while signed out, so mount it unconditionally.

**If the site sends a Content-Security-Policy, add qid.dev to `script-src`
before you debug anything else.** The hosted import is a cross-origin module, so
a strict policy blocks it and the button simply never appears, with the only
clue in the browser console. qID's own sites run
`script-src 'self' https://qid.dev` for exactly this reason. Vendoring the
widget instead of importing it avoids the question entirely, which is the right
call when a policy forbids third-party script origins outright.

## Step 3: the account model, and the one trap

Your accounts table needs exactly one required column: `address TEXT PRIMARY
KEY`. Registration and login are the same event. Do not add an email column for
identity. If the project already has email accounts, `docs/MIGRATION-from-email.md`
in the pack covers unbolting that.

Now the trap, because it is the one place an integrator can create an account
takeover while following the shape of the docs:

**Never look accounts up by `recovery_leaf_hash`, merge on it, or gate
one-per-wallet rules on it.** A verified proof establishes control of the login
key only. The recovery leaf hash is a value the signer *chose*, not a key they
proved: anyone can pair a leaf hash they saw with a login key they generated and
produce a perfectly valid proof for a different address carrying that same hash.
It is also public by design, since a P2MR spend reveals the sibling hash in its
control block. Treat it as an attribute of the address and nothing more.

Rotation-aware identity is the legitimate version of what people reach for that
field to do, and it is not available yet. Details and the design that survives
the transition are in `references/account-model.md`. Read it before designing
anything that links two addresses to one human.

## Step 4: verify it works

Run the checker against your running app. It needs no wallet, no keys and no
dependencies:

```sh
bun scripts/check-integration.mjs http://localhost:3000        # or: node scripts/...
bun scripts/check-integration.mjs https://www.yourapp.com --api /api/qid
```

It exercises the real HTTP surface and reports pass/fail per check: origin
mismatches, a `proof_url` your phone would 404 against, an unshared store across
instances, a CSP that blocks the widget, anything answering on the SDK's behalf,
and a session endpoint that leaks 200 to anonymous callers. It separates
failures that stop sign-in from ones merely worth tightening. Fix the blocking
ones before touching a wallet: from the UI they are indistinguishable, because
the dialog simply never completes.

Then do one real signed round trip. From inside the release pack you can sign
without any wallet installed:

```sh
bun tools/signer/btx-sign-ownership.mjs --random \
  --origin http://localhost:3000 --nonce <nonce> --ts <ts>
```

Take `nonce` and `ts` from the dialog's **Desktop wallet** tab, not the QR tab.
The QR rotates about every 105 seconds and the server burns the superseded
nonce, so a proof signed against a QR you left sitting will correctly be
rejected. Paste the printed proof into that same tab's step 2, or POST it to
`/qid/proof` to simulate a phone.

## Before it goes live

- `origin` is the exact final origin, after apex/www and http/https redirects.
  Open the deployed site and read `location.origin` in the console; that string
  is your value. Getting this wrong rejects every proof with `bad_origin`.
- Durable, shared stores if anything other than a single long-lived process
  serves traffic. Use `SqliteNonceStore` / `SqliteAccounts`, or implement the two
  interfaces in `stores.js` on Redis or your SQL. The package warns under
  `NODE_ENV=production` when it is still on the in-memory defaults.
- HTTPS, so the session cookie is `Secure` as well as `HttpOnly` and `SameSite=Lax`.
- `sessionSecret` from a secret manager, 32+ random characters. Rotating it signs
  everyone out, which makes it your kill switch.
- A same-origin `/qid/*` proxy is fine and is required when your backend is on
  another host. The rule is narrow: never let the proxy change the origin the
  wallet sees versus the one the user visits.

## When something is broken

`references/troubleshooting.md` maps symptoms to causes, including the failures
that produce no error at all. Start there rather than reading the SDK source;
nearly every real-world failure is one of six configuration mistakes, and the
symptom identifies which.
