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
app.use(express.json());          // optional: the middleware parses the body itself
app.use("/qid", qidMiddleware(qid));

app.get("/api/me", requireQidSession(qid), (req, res) => {
  res.json(req.qidSession);       // { address, account, expiresAt }
});
```

A body parser is optional here, and its position does not matter. The
middleware reads and parses the body itself when no parser has run
(`middleware.js:35-47` returns `req.body` if one did, and drains the stream
otherwise), so `express.json()` is a convenience for the rest of your app rather
than a requirement of this one.

`requireQidSession` answers 401 for anonymous callers and populates
`req.qidSession` otherwise, so route handlers stay free of auth logic.

## Production stores

The defaults are per-process reference implementations. One long-lived process is
fine; anything else needs a shared store, or replay protection stops being global
and accounts vanish on restart. The package warns about this under
`NODE_ENV=production`.

The stores take a **database handle**, not a path, and they come from the package
root: there is no `/sqlite` subpath export, so importing one throws
`ERR_MODULE_NOT_FOUND`.

```js
import { Database } from "bun:sqlite";                    // node: DatabaseSync from "node:sqlite"
import { createQidConnect, SqliteNonceStore, SqliteAccounts } from "@qid/connect-server";

const db = new Database("/var/lib/yourapp/qid.sqlite");
db.exec("PRAGMA journal_mode=WAL");                        // concurrent readers, worth having

const qid = createQidConnect({
  origin: process.env.QID_ORIGIN,
  sessionSecret: process.env.QID_SESSION_SECRET,
  nonceStore: new SqliteNonceStore(db),
  accounts: new SqliteAccounts(db),
});
```

One handle serves both stores; they create their own tables. `bun:sqlite`,
`node:sqlite` and `better-sqlite3` all work, and
`examples/static-rewrite-demo/server.mjs` shows the runtime-detecting version if
you need to support both. For multi-instance deployments implement the same two
interfaces on Redis or your SQL server; both are small and documented in
`stores.js`, and there is a conformance suite in
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
