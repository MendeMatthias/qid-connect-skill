# qID Connect skill

An [Agent Skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills)
that teaches an AI coding assistant to add **"Sign in with qID"** to a website or
dApp: post-quantum wallet login for BTX, where the user's address is the account.
No email, no password, no relay server, no third party.

Point your assistant at this folder and ask it to wire up qID sign-in. It will
pick the right path for your stack, wire the server and the button, get the
account model right, and verify the result against your running app.

## Install

**Claude Code** (project or personal):

```sh
mkdir -p .claude/skills && cp -R qid-connect .claude/skills/
```

Personal, available in every project: copy to `~/.claude/skills/` instead.

**Any other assistant:** the skill is plain Markdown. Paste `SKILL.md` in as the
task brief and let it pull in the reference files it names.

It also ships inside the qID Connect release pack under `skills/qid-connect/`,
so if you already downloaded the pack you have it.

## What is in it

```
SKILL.md                        the workflow, the invariant, the four steps
references/express.md           Express wiring and production stores
references/nextjs.md            Next.js, including the apiPath trap
references/static-site.md       CDN page with the backend elsewhere
references/account-model.md     the address is the account, and the one takeover trap
references/troubleshooting.md   symptom to cause, and the reason codes
scripts/check-integration.mjs   live checker, zero dependencies
```

## The checker, on its own

Useful whether or not you use an assistant. It drives the real HTTP surface of a
running integration and reports what is wrong, with the fix:

```sh
bun skills/qid-connect/scripts/check-integration.mjs http://localhost:3000
node skills/qid-connect/scripts/check-integration.mjs https://www.yourapp.com --api /api/qid
```

Ten checks, no wallet and no keys required. It catches the mistakes that leave no
error in the browser at all: an `origin` that does not match where users land, a
`proof_url` your users' phones would 404 against, per-process stores on a
multi-instance deployment, a missing login-CSRF guard, a `/session` route that
answers 200 to anonymous callers.

Exit code 0 means the surface is wired correctly. Then do one real signed round
trip with `tools/signer/btx-sign-ownership.mjs` from the release pack, and you
are done.

## Links

- Integration guide: https://qid.dev/connect/integrate
- Live demo: https://qid.dev/connect
- Release pack: https://qid.dev/connect/qid-connect-latest.zip

## License

MIT. The qID name and mark are not covered by it.
