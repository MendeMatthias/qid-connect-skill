#!/usr/bin/env node
// check-integration.mjs - verify a live qID Connect integration end to end.
//
//   bun check-integration.mjs http://localhost:3000
//   bun check-integration.mjs https://www.yourapp.com --api /api/qid
//   bun check-integration.mjs https://www.yourapp.com --api=/api/qid
//
// Runs on bun or Node 18+. No dependencies, no wallet, no keys. It drives the
// real HTTP surface and checks the things that silently break sign-in.
//
// A design rule learned the hard way: every check asserts on the SDK's own
// vocabulary, never on the mere absence of a bad answer. A WAF that answers 403
// to everything must not be able to pass a check whose point is that the SDK
// answered 403.
//
// Exit 0 = every check passed. 1 = a check failed. 2 = could not run.
//
// SPDX-License-Identifier: MIT

const TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Arguments. Unknown flags are fatal: silently ignoring one would mean checking
// a mount the user never asked about and then blaming them for the mismatch.
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
  console.log(`
Usage: check-integration.mjs <site-url> [--api <path>]

  <site-url>   the origin users actually land on, e.g. https://www.yourapp.com
  --api        where the qID routes are mounted (default: /qid, Next.js: /api/qid)
               both --api /path and --api=/path work
`);
  process.exit(argv.length === 0 ? 2 : 0);
}

const die = (msg) => {
  console.error(msg);
  process.exit(2);
};

if (typeof fetch !== "function") die("This needs a runtime with fetch built in: Node 18+, or bun.");

let rawUrl = null;
let apiRaw = null;
let apiExplicit = false;
for (let i = 0; i < argv.length; i++) {
  const tok = argv[i];
  if (tok.startsWith("--api=")) {
    apiRaw = tok.slice("--api=".length);
    apiExplicit = true;
  } else if (tok === "--api") {
    apiRaw = argv[++i];
    apiExplicit = true;
    if (!apiRaw) die("--api needs a value, e.g. --api /api/qid");
  } else if (tok.startsWith("-")) {
    die(`Unknown option: ${tok}\nRun with --help for usage.`);
  } else if (rawUrl === null) {
    rawUrl = tok;
  } else {
    die(`Unexpected extra argument: ${tok}\nRun with --help for usage.`);
  }
}
if (!rawUrl) die("Missing <site-url>. Run with --help for usage.");
if (apiExplicit && !apiRaw.startsWith("/")) die(`--api must be a path starting with "/", got: ${apiRaw}`);

let site;
try {
  site = new URL(rawUrl);
} catch {
  die(`Not a URL: ${rawUrl}`);
}
if (site.protocol !== "http:" && site.protocol !== "https:") {
  die(`Not an http(s) URL: ${rawUrl}\nDid you mean http://${rawUrl}?`);
}

const apiPath = (apiRaw ?? "/qid").replace(/\/+$/, "");
const origin = site.origin;
const base = `${origin}${apiPath}`;

// ---------------------------------------------------------------------------
// Reporting. Checks are tagged so the summary can distinguish "sign-in is
// broken" from "sign-in works but this is worth tightening".
// ---------------------------------------------------------------------------
const results = [];
const record = (name, ok, detail, hint, kind = "blocking") => {
  results.push({ name, ok, detail, hint, kind });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
  if (!ok && hint) console.log(`      fix: ${hint}`);
};

function summarize(code) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    const blocking = failed.filter((f) => f.kind === "blocking");
    const hardening = failed.filter((f) => f.kind !== "blocking");
    if (blocking.length) {
      console.log(`\nSign-in cannot work until these are fixed:`);
      for (const f of blocking) console.log(`  - ${f.name}`);
      console.log(
        `\nThese leave no trace in the browser: the dialog opens and never completes.\n` +
          `Fix them before testing with a wallet.`
      );
    }
    if (hardening.length) {
      console.log(`\nSign-in may still work, but these should be fixed:`);
      for (const f of hardening) console.log(`  - ${f.name}`);
    }
    console.log("");
    process.exit(code ?? 1);
  }
  console.log(
    `\nThe surface is wired correctly. Next: one real signed round trip with\n` +
      `tools/signer/btx-sign-ownership.mjs from the release pack.\n`
  );
  process.exit(code ?? 0);
}

// A transport failure mid-run must not lose the results already gathered, and
// must be distinguishable from "a check failed" by exit code.
process.on("unhandledRejection", (err) => {
  console.log(`\nAborted: ${err?.message ?? err}`);
  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks completed before the error.\n`);
  process.exit(2);
});

const req = async (url, init = {}) => {
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
  let json = null;
  try {
    json = await res.clone().json();
  } catch {
    /* non-JSON: the checks that care assert on the parsed value */
  }
  return { res, json };
};

const post = (path, body, headers = {}) =>
  req(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });

// Every check runs inside this, so one broken endpoint cannot take the run down.
// An aborted check is unknown, not failed: reporting it as blocking would accuse
// a working integration on the strength of a transport blip.
const check = async (name, fn) => {
  try {
    await fn();
  } catch (err) {
    if (err?.__fatal) throw err;
    record(
      `${name} (could not run)`,
      false,
      err?.message ?? String(err),
      "transport error while running this check; re-run to see whether it is persistent",
      "hardening"
    );
  }
};

// The SDK's own vocabulary. Anything outside this set means something that is
// not the SDK answered, which is the failure these checks exist to catch.
const VERIFIER_REASONS = new Set([
  "ok",
  "bad_proof_shape",
  "origin_mismatch",
  "address_mismatch",
  "expired",
  "not_yet_valid",
  "nonce_used",
  "bad_signature",
  "nonce_unknown",
  "bad_request_body",
  "bad_origin",
]);

console.log(
  `\nChecking ${origin} with the qID routes at ${apiPath}${apiExplicit ? "" : " (default)"}\n`
);

// ---------------------------------------------------------------------------
// 1. Canonicalization. Only an apex/www or scheme change on the same site means
// "your users land somewhere else"; a redirect to an unrelated host (SSO, a
// marketing page) is a normal app shape and must not be reported as an origin
// bug. Check 3 is the authority on the configured origin either way.
// ---------------------------------------------------------------------------
await check("site canonicalization", async () => {
  let res;
  try {
    ({ res } = await req(origin));
  } catch (err) {
    // Nothing else can be learned if the site is unreachable, and this is "could
    // not run" (exit 2), not "a check failed" (exit 1), so CI can tell a network
    // blip from a real defect. Exit here rather than throwing: a top-level
    // rejection would be reported by the runtime before our handler sets the code.
    console.error(`Cannot reach ${origin}: ${err.message}`);
    process.exit(2);
  }
  const loc = res.headers.get("location");
  const permanent = res.status === 301 || res.status === 308;
  if (res.status >= 300 && res.status < 400 && loc) {
    const target = new URL(loc, origin);
    const root = (h) => h.replace(/^www\./, "");
    const canonicalizing = root(target.hostname) === root(site.hostname);
    if (permanent && canonicalizing && target.origin !== origin) {
      record(
        "site does not canonicalize to a different origin",
        false,
        `${origin} -> ${res.status} -> ${target.origin}`,
        `your users land on ${target.origin}; test that origin instead, and make sure createQidConnect uses it`
      );
    } else {
      record(
        "site does not canonicalize to a different origin",
        true,
        canonicalizing
          ? `${origin} -> ${res.status} -> ${target.origin}`
          : `${origin} -> ${res.status} -> ${target.origin} (unrelated host, not an origin problem)`
      );
    }
  } else {
    record("site does not canonicalize to a different origin", true, `${origin} -> ${res.status}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Challenge issuance and shape.
// ---------------------------------------------------------------------------
let challenge = null;
let request = null;
await check("POST /challenge", async () => {
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
    ok
      ? `nonce ${json.challenge.nonce.slice(0, 12)}... ts ${json.challenge.ts}`
      : `status ${res.status}${json ? "" : " (non-JSON response)"}`,
    `nothing that speaks qID answered ${base}/challenge - check the mount path${
      apiExplicit ? "" : ` (you did not pass --api, so this tested ${apiPath})`
    }`
  );
  if (!ok) summarize();
  challenge = json.challenge;
  request = json.request;
});

// ---------------------------------------------------------------------------
// 3. The challenge is bound to the origin users actually land on. This is the
// authoritative statement of what the server thinks its origin is.
// ---------------------------------------------------------------------------
await check("rp_origin", async () => {
  record(
    "challenge rp_origin matches the site origin",
    challenge.rp_origin === origin,
    `rp_origin=${challenge.rp_origin}  site=${origin}`,
    `set origin: "${origin}" in createQidConnect - it must be the exact origin after every redirect`
  );
});

// ---------------------------------------------------------------------------
// 4. proof_url is where a phone will actually POST. On Next.js this is the
// apiPath bug: routes under /api/qid but proof_url saying /qid, so QR and
// deep-link sign-in 404 while copy-paste keeps working.
// ---------------------------------------------------------------------------
const expectedProofUrl = `${origin}${apiPath}/proof`;
await check("proof_url", async () => {
  let proofOrigin = null;
  try {
    proofOrigin = new URL(request?.proof_url).origin;
  } catch {
    /* missing or unparseable: the generic hint covers it */
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
});

// ---------------------------------------------------------------------------
// 5. /proof is mounted and is the SDK. A phone posts here.
// ---------------------------------------------------------------------------
await check("POST /proof", async () => {
  const { res, json } = await post("/proof", { v: 1 });
  const isSdk = json !== null && VERIFIER_REASONS.has(json.reason);
  record(
    "POST /proof is mounted and answers like the SDK",
    isSdk,
    `status ${res.status} reason=${json?.reason ?? (json ? "none" : "non-JSON body")}`,
    "the phone's proof submission has nowhere to land, or something in front of your app is answering for it"
  );
});

// ---------------------------------------------------------------------------
// 6. A nonce issued by this deployment is still known when the proof comes
// back. Sampled, because behind a load balancer one round trip can land back on
// the issuing instance by luck. Every round must both get a challenge AND get a
// recognisable answer, or it counts as lost: a 500 is not evidence of a store.
// ---------------------------------------------------------------------------
await check("nonce persistence", async () => {
  const ROUNDS = 4;
  const outcomes = [];
  for (let i = 0; i < ROUNDS; i++) {
    const fresh = await post("/challenge");
    const ch = fresh.json?.challenge;
    if (!ch) {
      outcomes.push("no_challenge");
      continue;
    }
    const { json } = await post("/verify", {
      v: 1,
      alg: "ML-DSA-44",
      address: "btx1zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
      challenge: ch,
      login_pubkey: "00",
      recovery_leaf_hash: "00",
      signature: "00",
    });
    const reason = json?.reason;
    if (!reason || !VERIFIER_REASONS.has(reason)) outcomes.push(`unrecognised:${reason ?? "none"}`);
    else if (reason === "nonce_unknown") outcomes.push("lost");
    else outcomes.push("kept");
  }
  const kept = outcomes.filter((o) => o === "kept").length;
  const lost = outcomes.filter((o) => o === "lost").length;
  const odd = outcomes.filter((o) => o !== "kept" && o !== "lost");
  record(
    "a nonce issued by this deployment is still known on the next request",
    kept === outcomes.length,
    `${kept}/${outcomes.length} round trips kept the nonce${lost ? `, ${lost} lost` : ""}${
      odd.length ? `, ${odd.length} inconclusive (${odd[0]})` : ""
    }`,
    lost
      ? "requests are hitting different instances with per-process stores - pass SqliteNonceStore on a shared volume, or a Redis/SQL store"
      : "the server did not answer like the SDK - something in front of your app may be intercepting /challenge or /verify"
  );
});

// ---------------------------------------------------------------------------
// 7. Each challenge is unique.
// ---------------------------------------------------------------------------
await check("nonce freshness", async () => {
  const a = await post("/challenge");
  const b = await post("/challenge");
  const nonceA = a.json?.challenge?.nonce;
  const nonceB = b.json?.challenge?.nonce;
  const both = Boolean(nonceA) && Boolean(nonceB);
  record(
    "each challenge carries a fresh nonce",
    both && nonceA !== nonceB,
    both
      ? `${String(nonceA).slice(0, 10)}... vs ${String(nonceB).slice(0, 10)}...`
      : `no nonce returned (statuses ${a.res.status}, ${b.res.status})`,
    both
      ? "a caching layer is caching POST /challenge, which breaks single-use"
      : "/challenge stopped answering mid-run - rate limiting (429) or an upstream error"
  );
});

// ---------------------------------------------------------------------------
// 8. Login-CSRF guard. Must be the SDK's own bad_origin, not any 403: a WAF
// that blocks POSTs to auth paths also returns 403, while leaving /verify dead.
// ---------------------------------------------------------------------------
await check("login-CSRF guard", async () => {
  const { res, json } = await post("/verify", { v: 1 }, { origin: "https://evil.example" });
  record(
    "POST /verify rejects a cross-site Origin",
    json?.reason === "bad_origin",
    `status ${res.status} reason=${json?.reason ?? (json ? "none" : "non-JSON body")}`,
    res.status === 403 && json?.reason !== "bad_origin"
      ? "something in front of your app returned 403 before the SDK saw the request - browser sign-in is dead even though QR may still work"
      : "a proxy is stripping or rewriting the Origin header before it reaches the SDK"
  );
});

// ---------------------------------------------------------------------------
// 9. An anonymous caller is not signed in.
// ---------------------------------------------------------------------------
await check("anonymous session", async () => {
  const { res } = await req(`${base}/session`);
  record(
    "GET /session is 401 without a cookie",
    res.status === 401,
    `status ${res.status}`,
    "something upstream is answering /session before the SDK does"
  );
});

// ---------------------------------------------------------------------------
// 10. A Content-Security-Policy that omits qid.dev blocks the hosted widget,
// and the only symptom is a console warning: no button, no error, no clue.
// Only meaningful when the page actually imports the hosted widget, so look
// before judging.
//
// 10b. The same policy must also allow the widget's styles. The widget injects
// its stylesheet at runtime as a <style> element, so a style-src (or
// default-src fallback) without an effective 'unsafe-inline' renders the
// dialog as raw unstyled HTML while every script check still passes - which is
// exactly how a live site broke once with this suite reporting all green.
// Hash-pinning cannot fix it: the widget is hosted and unpinned, so the hash
// changes every release, and a nonce or hash source in the directive makes
// browsers IGNORE 'unsafe-inline' entirely.
// ---------------------------------------------------------------------------
await check("CSP", async () => {
  // Stay on this origin. If the root bounces to SSO or a marketing site, that
  // page's policy says nothing about the app, and chasing it can hang or fail
  // on a host that has nothing to do with the integration.
  const { res } = await req(origin);
  const skipBoth = (scriptName, detail) => {
    record(scriptName, true, detail, undefined, "hardening");
    record("CSP allows the widget's runtime styles", true, detail, undefined, "hardening");
  };
  if (res.status >= 300 && res.status < 400) {
    skipBoth(
      "CSP allows the hosted widget",
      `root redirects (${res.status}); cannot inspect the app's own page from here`
    );
    return;
  }
  const html = await res.text().catch(() => "");
  const usesHosted = html.includes("qid.dev/connect/widget");
  const headerCsp = res.headers.get("content-security-policy") || "";
  const metaMatch = html.match(
    /<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]+content=["']([^"']+)["']/i
  );
  const csp = headerCsp || metaMatch?.[1] || "";

  if (!usesHosted) {
    skipBoth(
      "CSP allows the hosted widget (or the widget is vendored)",
      csp ? "page does not import the hosted widget; CSP not relevant" : "no hosted widget import found"
    );
    return;
  }
  if (!csp) {
    skipBoth("CSP allows the hosted widget", "no Content-Security-Policy set");
    return;
  }
  const directive =
    csp.match(/(?:^|;)\s*script-src-elem\s+([^;]+)/i) ||
    csp.match(/(?:^|;)\s*script-src\s+([^;]+)/i) ||
    csp.match(/(?:^|;)\s*default-src\s+([^;]+)/i);
  const allowed = !directive || /https:\/\/qid\.dev|\*|'unsafe-inline'\s+https:/.test(directive[1]);
  record(
    "CSP allows the hosted widget",
    allowed,
    directive ? `${directive[0].trim().slice(0, 90)}` : "no script-src or default-src directive",
    "add https://qid.dev to script-src, or vendor packages/widget/src/ instead - otherwise the button never renders and the only clue is a console warning"
  );

  // The injected <style> element is governed by style-src-elem, falling back
  // to style-src, then default-src; no directive at all means unrestricted.
  const styleDirective =
    csp.match(/(?:^|;)\s*style-src-elem\s+([^;]+)/i) ||
    csp.match(/(?:^|;)\s*style-src\s+([^;]+)/i) ||
    csp.match(/(?:^|;)\s*default-src\s+([^;]+)/i);
  let styleOk = true;
  if (styleDirective) {
    const sources = styleDirective[1];
    const inlineNullified = /'(?:nonce-|sha(?:256|384|512)-)/i.test(sources);
    styleOk = /'unsafe-inline'/i.test(sources) && !inlineNullified;
  }
  record(
    "CSP allows the widget's runtime styles",
    styleOk,
    styleDirective
      ? `${styleDirective[0].trim().slice(0, 90)}`
      : "no style-src or default-src directive; styles unrestricted",
    "use style-src 'self' 'unsafe-inline' - the widget injects its stylesheet at runtime, so a hash pin breaks on every widget release, and a nonce or hash source makes browsers ignore 'unsafe-inline'; otherwise the dialog renders as raw unstyled HTML",
    "hardening"
  );
});

// ---------------------------------------------------------------------------
// 11. HTTPS in production, so the session cookie can be Secure.
// ---------------------------------------------------------------------------
await check("https", async () => {
  const isLocal = site.hostname === "localhost" || site.hostname === "127.0.0.1";
  record(
    "served over https (or local development)",
    site.protocol === "https:" || isLocal,
    `protocol ${site.protocol}`,
    "the session cookie cannot be Secure over plain http",
    "hardening"
  );
});

summarize();
