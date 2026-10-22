# Write-up

> Review and rewrite this in your own words before submitting. Interviewers will ask you about every
> sentence here.

## What I built

TrustVault is a document-sharing system with three roles (administrator, owner, viewer) and per-document
grants (`read` / `edit`) to named people, with optional expiry. It covers all ten required features:
authentication with roles, upload/organise/search/manage, per-document permissions, grant and revoke,
server-enforced access on every route, an audit trail (including refusals), search by name, owner, category
and date, upload validation, an admin activity and permission view, and automated tests proving one user
cannot reach another's documents.

Beyond the floor:

- versions
- trash with restore and permanent purge
- grant expiry
- encryption at rest with per-file keys bound to their records
- a tamper-evident (HMAC hash-chained) audit log with an integrity check
- CSV export that is safe to open in a spreadsheet
- "worth noticing" alerts for admins
- session management (see and end your own sessions)
- rule-based sharing suggestions that never grant anything on their own
- a mutation script that proves the tests actually test the checks

## My permission model, in my own words

_Rewrite this paragraph yourself._ A role decides what *kind* of thing you can do. A grant decides *which
documents* you can do it to. Owners create documents, which start private. The owner is the only person who
can share a document, delete it, or see its activity. A read grant lets you open and download; an edit grant
also lets you change the details and add versions, but never share. Admins manage people and see the audit
trail, but cannot read contents and cannot be granted anything. That separation means the account whose
password is published for the judges cannot leak a document.

Every decision is made in one function, `authorize()` in `src/authz.js`, on every request, against the live
database. If that call were removed from the download route, any signed-in user could download any document
by ID. The tests catch that: `npm run mutation` shows which ones fail.

**Revocation is immediate** because nothing is issued except the session. There are no share links, signed
URLs or JWTs. The cost is that every download is served by the app, and anything already downloaded is out
of reach, which is why each download is recorded before it is sent.

**The audit trail is protected** by three layers:

1. database triggers that reject `UPDATE` and `DELETE`
2. an HMAC chain whose key lives outside the database, so edits, deletions and forged rewrites are detected
3. a copy of every entry in the platform log

It does not protect against someone who holds both the database and the key. I say so in THREATS T-23c.

## What I deliberately did not build, and why

- **Share links or external anonymous access.** A link is a bearer token: it cannot say *who* opened the
  file, and it keeps working wherever it was forwarded. External partners get a viewer account instead
  (`dave` in the demo).
- **Folders, groups and inherited permissions.** This is the "given a folder for one file, can now see
  forty" problem from the brief. Per-document grants are more clicks but never over-share. Groups would be the
  next step, and I would keep them as explicit, audited membership, not inheritance.
- **An LLM inside the product.** Suggestions use a visible rule, so the owner can see exactly why someone is
  suggested, and no document content is sent to a third party. The brief's constraint (the machine never
  widens access on its own) is enforced in code and tested (T-15).
- **Antivirus scanning, MFA, SSO, email.** Out of scope for a week; listed as accepted in THREATS.md.
- **Multiple app instances.** SQLite and in-memory rate limits assume one instance.

## How I used AI, and where it was wrong

_Fill this in from PROMPTS.md, in your own words. Be specific: what it produced, what was wrong, how you
found it, and the commit that fixed it._

## What is unfinished

- Ownership transfer when an owner leaves (their documents stay readable by existing grantees; T-67).
- Retention policy (automatic purge of trash after N days, audit-log archiving).
- External anchoring of the audit head hash (today it is only printed to the log and shown to admins).
- Persistent storage on the free deployment: a restart resets data (T-61).
- Open-redirect protection on `/login?next=` is client-side and not covered by an automated test.
- The upload page's client-side checks are convenience only. The server is authoritative, but the client
  messages are not localised or exhaustive.
