# Express

The whole login system is one middleware.

```js
import express from "express";
import { createQidConnect } from "@qid/connect-server";
import { qidMiddleware, requireQidSession } from "@qid/connect-server/express";

const qid = createQidConnect({
  origin: process.env.QID_ORIGIN,                 // "https://www.yourapp.com"
  sessionSecret: process.env.QID_SESSION_SECRET,  // 32+ random chars
  // nonceStore / accounts: pass shared stores in production, see below
});

const app = express();
app.use(express.json());          // must come BEFORE the middleware
app.use("/qid", qidMiddleware(qid));

app.get("/api/me", requireQidSession(qid), (req, res) => {
  res.json(req.qidSession);       // { address, account, expiresAt }
});
```

`express.json()` mounted after the middleware produces `bad_request_body` on
every call, which reads like a client bug and is not.

`requireQidSession` answers 401 for anonymous callers and populates
`req.qidSession` otherwise, so route handlers stay free of auth logic.

## Production stores

The defaults are per-process reference implementations. One long-lived process is
fine; anything else needs a shared store, or replay protection stops being global
and accounts vanish on restart. The package warns about this under
`NODE_ENV=production`.

```js
import { SqliteNonceStore, SqliteAccounts } from "@qid/connect-server/sqlite";

const qid = createQidConnect({
  origin: process.env.QID_ORIGIN,
  sessionSecret: process.env.QID_SESSION_SECRET,
  nonceStore: new SqliteNonceStore({ path: "/var/lib/yourapp/qid.sqlite" }),
  accounts: new SqliteAccounts({ path: "/var/lib/yourapp/qid.sqlite" }),
});
```

Works with `bun:sqlite`, `node:sqlite` or `better-sqlite3`. For multi-instance
deployments implement the same two interfaces on Redis or your SQL server; both
are small and documented in `stores.js`, and there is a conformance suite in
`packages/server/test/stores.test.js` to validate your adapter against.

`QID_ALLOW_MEMORY_STORES=1` silences the production warning when you are
deliberately running a single process.

## Behind a proxy

If Express sits behind nginx, Caddy or a CDN, the rule is narrow but absolute:
the origin the wallet sees must equal the origin the user visits. Proxying
`/qid/*` same-origin to a backend on another host is fine and is what makes the
session cookie work. Rewriting the `Origin` header is not: the login-CSRF guard
on `/verify` and `/poll` depends on it.

Set `app.set("trust proxy", 1)` if your proxy terminates TLS, so Express reports
the right protocol.
