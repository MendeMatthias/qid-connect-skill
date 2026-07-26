# The account model

Read this before designing anything that links addresses to people. The
mistakes here are not cosmetic; one of them is an account takeover.

## The address is the account

```sql
CREATE TABLE accounts (
  address    TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
  -- optional profile fields: display_name, avatar_url, ...
  -- no email column for identity
);
```

The adapter is two functions:

```js
const accounts = {
  async getOrCreate(address, now, context) { /* INSERT ... ON CONFLICT DO NOTHING; SELECT */ },
  async get(address) { /* SELECT */ },
};
```

Registration and login are the same event, so there is no signup flow to build.
If the app genuinely needs email later, for receipts or alerts, collect it after
sign-in as contact data, never as a credential. `docs/MIGRATION-from-email.md`
in the release pack covers unbolting qID from an existing email login.

`getOrCreate` receives a third argument `{ proof, recoveryLeafHash }` when the
call comes from a verified proof. Both built-in adapters ignore it, and so
should yours unless you have a specific reason.

One trap if you do use it: on QR sign-in the *last* call to touch the row is the
`poll` step, and that one arrives with no context at all. An adapter written the
natural way, writing whatever it was handed, blanks the column on every mobile
sign-in and leaves it populated for desktop. Never clear a stored field on a
context-free call.

## Never key accounts on `recovery_leaf_hash`

The field looks like a stable per-wallet identifier. It is not one, and using it
as an account key hands the account to anyone who wants it.

What a v1 proof establishes: **control of the login key.** Nothing else.

The recovery leaf hash is a value the signer chose, not a key they proved. The
verifier only checks that the proven address commits to that hash, so a signer
cannot misreport their own. Anyone can pick a leaf hash they saw, pair it with a
login key they generated, and produce a valid proof for a different address that
carries the same hash. The value is also public by design: a P2MR spend reveals
the sibling hash in its control block, so every address that has ever spent has
already published it.

Concretely, this is exploitable:

```js
// account takeover, not a hypothetical
const account = await db.get("SELECT * FROM accounts WHERE recovery_leaf_hash = ?", leaf);
```

An attacker reads a victim's leaf hash off the chain, generates their own login
key, signs your challenge honestly, and arrives with a valid proof carrying that
hash. Keyed lookup hands them the victim's row. The same applies to merge rules
and one-per-wallet limits.

Treat it as an attribute of the address. The address stays the primary key.

## What "one wallet" actually means today

- **One address per wallet, static and reused.** BTX addresses do not rotate per
  transaction the way modern Bitcoin HD wallets do, and change returns to the
  same address. It behaves like an account number.
- **A user can hold several wallets**, and each is a separate identity with its
  own login key and its own recovery root. They share nothing you can verify and
  are not meant to be linkable.
- **You cannot tell whether two addresses are the same person.** If the product
  needs one account per human, that is a policy layer you own. No field in the
  proof substitutes for it.

## Rotation, and the thing to build now so it survives

The protocol supports login-key rotation: the identity root stays, the login key
changes, and the address changes with it. Under the frozen v1 verifier that ships
today, a rotated wallet simply arrives as a new address with no verifiable link
to the old one. Attestation chains, serials and revocation floors exist in the
qid library and reach qID Connect in a later phase.

Do not try to infer the link. Build it so the upgrade costs nothing:

1. Keep your own user id internally. Attach addresses to it as credentials; one
   user can own several address rows.
2. Make linking an explicit, authenticated action: while signed in with address
   A, the user signs in with address B in that same session and attaches it.
   That is a user-authorized link today, and it is exactly the link the
   attestation chain will later let you verify cryptographically.
3. Never merge accounts on a field of the proof.

When attestations land, your schema does not change. You gain proof where you
had user consent.
