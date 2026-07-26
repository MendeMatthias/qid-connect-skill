#!/usr/bin/env node
// check-integration.mjs - verify a live qID Connect integration end to end.
//
//   node check-integration.mjs http://localhost:3000
//   node check-integration.mjs https://www.yourapp.com --api /api/qid
//
// No dependencies, no wallet, no keys. It drives the real HTTP surface and
// checks the things that silently break sign-in, because every one of these
// failures looks the same from the UI: the dialog simply never completes.
//
// Exit code 0 = every check passed. 1 = at least one failure. 2 = could not run.
//
// SPDX-License-Identifier: MIT

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`
Usage: node check-integration.mjs <site-url> [--api <path>]

  <site-url>   the origin users actually land on, e.g. https://www.yourapp.com
  --api        where the qID routes are mounted (default: /qid, Next.js: /api/qid)
`);
  process.exit(args.length === 0 ? 2 : 0);
}

if (typeof fetch !== "function") {
  console.error("This needs a runtime with fetch built in: Node 18+, or bun.");
  process.exit(2);
}

const rawUrl = args[0];
const apiIdx = args.indexOf("--api");
if (apiIdx !== -1 && !args[apiIdx + 1]) {
  console.error('--api needs a value, e.g. --api /api/qid');
  process.exit(2);
}
const apiRaw = apiIdx !== -1 ? args[apiIdx + 1] : "/qid";
if (!apiRaw.startsWith("/")) {
  console.error(`--api must be a path starting with "/", got: ${apiRaw}`);
  process.exit(2);
}
const apiPath = apiRaw.replace(/\/+$/, "");

let site;
try {
  site = new URL(rawUrl);
} catch {
  console.error(`Not a URL: ${rawUrl}`);
  process.exit(2);
}
const origin = site.origin;
const base = `${origin}${apiPath}`;

const results = [];
const record = (name, ok, detail, hint) => {
  results.push({ name, ok, detail, hint });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}`);
  if (detail) console.log(`      ${detail}`);
  if (!ok && hint) console.log(`      fix: ${hint}`);
};

const post = async (path, body, headers = {}) => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
    redirect: "manual",
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body: the check that cares will report it */
  }
  return { res, json };
};

console.log(`\nChecking ${origin} with the qID routes at ${apiPath}\n`);

// ---------------------------------------------------------------------------
// 1. Does the site canonicalize away from the origin you configured?
// A 301/308 here means the origin your users land on is NOT the one you tested,
// and every proof will be rejected with bad_origin.
// ---------------------------------------------------------------------------
try {
  const res = await fetch(origin, { redirect: "manual" });
  const loc = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && loc) {
    const finalOrigin = new URL(loc, origin).origin;
    record(
      "site does not redirect to a different origin",
      finalOrigin === origin,
      `${origin} -> ${res.status} -> ${finalOrigin}`,
      `set origin: "${finalOrigin}" in createQidConnect, and re-run this check against ${finalOrigin}`
    );
  } else {
    record("site does not redirect to a different origin", true, `${origin} -> ${res.status}`);
  }
} catch (err) {
  console.error(`Cannot reach ${origin}: ${err.message}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 2. Challenge issuance and shape.
// ---------------------------------------------------------------------------
let challenge = null;
let request = null;
try {
  const { res, json } = await post("/challenge");
  const ok =
    res.status === 200 &&
    json?.challenge &&
    typeof json.challenge.nonce === "string" &&
    typeof json.challenge.rp_origin === "string" &&
    Number.isInteger(json.challenge.ts);
  record(
    "POST /challenge issues a well-formed challenge",
    ok,
    ok ? `nonce ${json.challenge.nonce.slice(0, 12)}... ts ${json.challenge.ts}` : `status ${res.status}`,
    `the middleware is not mounted at ${apiPath}, or express.json() is missing before it`
  );
  if (!ok) {
    summarize();
  }
  challenge = json.challenge;
  request = json.request;
} catch (err) {
  record("POST /challenge issues a well-formed challenge", false, err.message, `is ${base} reachable?`);
  summarize();
}

// ---------------------------------------------------------------------------
// 3. The challenge is bound to the origin users actually land on.
// This is the single most common dead-integration cause.
// ---------------------------------------------------------------------------
record(
  "challenge rp_origin matches the site origin",
  challenge.rp_origin === origin,
  `rp_origin=${challenge.rp_origin}  site=${origin}`,
  `set origin: "${origin}" in createQidConnect - it must be the exact origin after every redirect`
);

// ---------------------------------------------------------------------------
// 4. proof_url is where a phone will actually POST. On Next.js this is the
// apiPath bug: routes live under /api/qid but proof_url says /qid, so QR and
// deep-link sign-in 404 while copy-paste keeps working.
// ---------------------------------------------------------------------------
const expectedProofUrl = `${origin}${apiPath}/proof`;
{
  // Two different bugs land here, so name the right one. A wrong host means the
  // `origin` option is wrong (and check 3 already said so); a wrong path means
  // apiPath was not passed, which is the Next.js default-mount mistake.
  let proofOrigin = null;
  try {
    proofOrigin = new URL(request?.proof_url).origin;
  } catch {
    /* missing or unparseable: handled by the generic hint below */
  }
  const hint =
    proofOrigin && proofOrigin !== origin
      ? `same root cause as the origin check above - fix origin, this follows`
      : `pass apiPath: "${apiPath}" to createQidConnect, otherwise phone sign-in 404s while paste keeps working`;
  record(
    "request.proof_url points at your own /proof route",
    request?.proof_url === expectedProofUrl,
    `proof_url=${request?.proof_url}  expected=${expectedProofUrl}`,
    hint
  );
}

// ---------------------------------------------------------------------------
// 5. /proof is reachable. A 404 here is the same bug seen from the other side.
// ---------------------------------------------------------------------------
{
  const { res, json } = await post("/proof", { v: 1 });
  const reachable = res.status !== 404 && json !== null;
  record(
    "POST /proof is mounted and answers with a reason",
    reachable,
    `status ${res.status}${json?.reason ? ` reason=${json.reason}` : ""}`,
    "the phone's proof submission has nowhere to land; check the mount path and any rewrite"
  );
}

// ---------------------------------------------------------------------------
// 6. The nonce just issued is still known when the proof comes back. If this
// fails on a deployment with more than one instance, the stores are per-process
// and the rendezvous is broken: the QR renders, then flips to expired.
// ---------------------------------------------------------------------------
{
  // Sampled, not single-shot: behind a load balancer a single round trip can
  // land back on the issuing instance by luck and pass while the deployment is
  // still broken. Several fresh issue-then-use pairs make that unlikely.
  const ROUNDS = 4;
  const reasons = [];
  for (let i = 0; i < ROUNDS; i++) {
    const fresh = await post("/challenge");
    const ch = fresh.json?.challenge;
    if (!ch) continue;
    const { json } = await post("/verify", {
      v: 1,
      alg: "ML-DSA-44",
      address: "btx1zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
      challenge: ch,
      login_pubkey: "00",
      recovery_leaf_hash: "00",
      signature: "00",
    });
    reasons.push(json?.reason ?? "none");
  }
  const lost = reasons.filter((r) => r === "nonce_unknown").length;
  record(
    "a nonce issued by this deployment is still known on the next request",
    lost === 0,
    `${ROUNDS - lost}/${ROUNDS} round trips kept the nonce${lost ? ` (lost: ${lost})` : ""}`,
    "requests are hitting different instances with per-process stores - pass SqliteNonceStore on a shared volume, or a Redis/SQL store"
  );
}

// ---------------------------------------------------------------------------
// 7. Each challenge is unique. Repeats would mean a broken or cached issuer.
// ---------------------------------------------------------------------------
{
  const a = await post("/challenge");
  const b = await post("/challenge");
  const nonceA = a.json?.challenge?.nonce;
  const nonceB = b.json?.challenge?.nonce;
  record(
    "each challenge carries a fresh nonce",
    Boolean(nonceA) && Boolean(nonceB) && nonceA !== nonceB,
    `${String(nonceA).slice(0, 10)}... vs ${String(nonceB).slice(0, 10)}...`,
    "a caching layer is caching POST /challenge, which breaks single-use"
  );
}

// ---------------------------------------------------------------------------
// 8. Login-CSRF guard: a cross-site page must not be able to POST a proof into
// a visitor's browser and mint them a session.
// ---------------------------------------------------------------------------
{
  const { res, json } = await post("/verify", { v: 1 }, { origin: "https://evil.example" });
  const guarded = res.status === 403 || json?.reason === "bad_origin";
  record(
    "POST /verify rejects a cross-site Origin",
    guarded,
    `status ${res.status} reason=${json?.reason ?? "none"}`,
    "a proxy is stripping or rewriting the Origin header before it reaches the SDK"
  );
}

// ---------------------------------------------------------------------------
// 9. An anonymous caller is not signed in.
// ---------------------------------------------------------------------------
{
  const res = await fetch(`${base}/session`, { redirect: "manual" });
  record(
    "GET /session is 401 without a cookie",
    res.status === 401,
    `status ${res.status}`,
    "something upstream is answering /session before the SDK does"
  );
}

// ---------------------------------------------------------------------------
// 10. HTTPS in production, so the session cookie can be Secure.
// ---------------------------------------------------------------------------
{
  const isLocal = site.hostname === "localhost" || site.hostname === "127.0.0.1";
  record(
    "served over https (or local development)",
    site.protocol === "https:" || isLocal,
    `protocol ${site.protocol}`,
    "the session cookie cannot be Secure over plain http"
  );
}

summarize();

function summarize() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(`\nFailed:`);
    for (const f of failed) console.log(`  - ${f.name}`);
    console.log(
      `\nEvery one of these looks identical in the browser: the dialog opens and\n` +
        `never completes. Fix them before testing with a wallet.\n`
    );
    process.exit(1);
  }
  console.log(`\nThe surface is wired correctly. Next: one real signed round trip with\n` +
    `tools/signer/btx-sign-ownership.mjs from the release pack.\n`);
  process.exit(0);
}
