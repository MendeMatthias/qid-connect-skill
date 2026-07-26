# Next.js

One catch-all route file. The complete drop-in lives in `examples/next-demo/` in
the release pack.

```js
// app/api/qid/[action]/route.js
import { createQidConnect } from "@qid/connect-server";
import { qidNextHandlers } from "@qid/connect-server/next";

const qid = createQidConnect({
  origin: process.env.QID_ORIGIN,
  sessionSecret: process.env.QID_SESSION_SECRET,
  apiPath: "/api/qid",     // REQUIRED on Next, see below
});

export const { GET, POST } = qidNextHandlers(qid);
```

Mount the widget with the matching path:

```js
mountQidConnect(el, { api: "/api/qid", appName: "Your app", onSignedIn() { /* ... */ } });
```

## The apiPath trap

This is the one Next-specific failure, and it is nasty because it is half
invisible.

On Next the routes live under `/api/qid`, but `apiPath` defaults to `/qid`. That
value is baked into `proof_url`, the address a phone wallet POSTs its proof to
after scanning the QR. Omit `apiPath` and the phone posts to `/qid/proof`, gets a
404, and nothing happens. Meanwhile desktop copy-paste keeps working perfectly,
because that path never uses `proof_url`.

So the integration looks fine in development on a laptop and is broken for every
mobile user in production. `scripts/check-integration.mjs` checks exactly this:

```sh
bun scripts/check-integration.mjs https://yourapp.com --api /api/qid
```

## Serverless

Vercel and similar platforms run more than one instance and recycle them freely,
so the in-memory defaults are wrong there in a way that is easy to miss. The
challenge and poll steps are a stateful rendezvous: the instance answering
`/api/qid/poll` must know the nonce that `/api/qid/challenge` issued. With
per-process stores it usually does not, and the QR renders and then flips to
"expired" within seconds.

Use a shared store backed by whatever your platform already gives you: Redis,
Upstash, Postgres, or any store implementing the two small interfaces in
`stores.js`. SQLite on a local disk does not count on serverless, since the disk
is not shared and does not survive.

## Runtime

Use the Node runtime. `export const runtime = "edge"` does not work regardless
of which store you pick: `session.js` imports `createHmac` and `timingSafeEqual`
from `node:crypto` and uses `Buffer`, and `qidNextHandlers` pulls that into the
graph. Swapping to an edge-compatible store will not rescue it; the error will
just move into `node_modules`.
