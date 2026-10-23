# TrustVault

Secure document sharing where the wrong person cannot reach a document, and you can prove who did.

- **Live demo:** https://trustvault-8h1o.onrender.com/
- **Demo video:** _add your 5-minute video link here_

| Document | What it covers |
|---|---|
| [THREATS.md](THREATS.md) | How this could be broken, what was done, what was accepted |
| [API.md](API.md) | Every endpoint and who may call it |
| [WRITEUP.md](WRITEUP.md) | What was built, what was not, the permission model, and AI use |
| [PROMPTS.md](PROMPTS.md) | AI prompts, where the AI was wrong, and what was done about it |

## Demo accounts (one per role)

| Role | Username | Password | What to try |
|---|---|---|---|
| Administrator | `admin` | `AdminVault#2026` | Overview alerts, audit log, Verify integrity, deactivate a user. You cannot open document contents. |
| Owner | `alice` | `OwnerAlice#2026` | Owns HR documents; shared two with `carol`, one with `dave` |
| Owner | `bob` | `OwnerBob#2026` | Owns Legal/Engineering documents; `dave` can edit the MSA |
| Viewer | `carol` | `ViewerCarol#2026` | Sees only her salary letter and the handbook |
| Viewer (external) | `dave` | `ViewerDave#2026` | External partner: one edit grant, one expiring grant |

"Payroll summary Q3 2026" (alice) and "Board minutes" (bob) are shared with nobody: good targets for testing
access control. These passwords are public on purpose; set `SEED_DEMO=false` for anything real.

## Roles and permissions in one paragraph

Roles gate features: **owners** upload, **viewers** cannot, **administrators** run the system but can never
read document contents. Access to a document comes only from its owner granting it **by name**, as `read`
(view and download) or `edit` (also change details and upload versions), optionally with an expiry date. Only
the owner can share, delete or see a document's activity. No folders, no inheritance, no share links. Full
tables are on the `/security` page and in [WRITEUP.md](WRITEUP.md).

**Where is the authorisation decision made?** In `authorize()` in [`src/authz.js`](src/authz.js), called
first by every route that touches a document. Lists and search use the same rule in SQL (`ACCESSIBLE_SQL`).

## Stack, and why

| Piece | Choice | Why |
|---|---|---|
| Server | Node.js 22.13+ / 24, Express 5 | Small, readable, and Express 5 forwards async errors to the error handler automatically. |
| Database | SQLite via built-in `node:sqlite` | No native build step and no separate DB server. Triggers make the audit table append-only. The single-instance limit is accepted (THREATS T-58, T-62). |
| Uploads | multer 2 (memory storage, strict limits) | |
| Crypto | Node `crypto`: scrypt passwords, AES-256-GCM files, HMAC-SHA256 audit chain | No third-party crypto. |
| Frontend | Plain HTML pages + vanilla JS, one page per feature | No build step. A strict CSP (`script-src 'self'`) is possible because there are no inline scripts. All data is rendered with `textContent`. |
| Tests | `node:test` with real HTTP requests | Tests the deployed shape, not mocks. |

Only two runtime dependencies: `express` and `multer`.

## Run it locally (from a clean clone)

Requires **Node.js 22.13 or newer** (`node --version`).

```bash
npm ci              # install exact dependency versions from package-lock.json
npm run setup       # create the database schema and the demo data (safe to re-run)
npm start           # http://localhost:3000
```

In development, encryption and audit keys are generated once into `data/dev-keys.json`. The database is
`data/trustvault.db`, and encrypted files are in `data/files/`. To start over, stop the server and delete `data/`.

### Tests

```bash
npm test            # 64 tests: access control, audit trail, uploads, sessions/CSRF
npm run mutation    # removes 20 security checks one at a time and confirms the tests catch each
```

## Deploy (Render, free tier)

1. Push the repository to GitHub.
2. On Render, choose **New → Blueprint** and select the repository. `render.yaml` defines the service and
   generates `FILE_ENCRYPTION_KEY` and `AUDIT_HMAC_KEY` for you.
3. Wait for the deploy, then open the URL in a private window and sign in with a demo account.

Manual setup on any Node host:

```bash
npm ci
npm run keys        # prints two random keys; set them as environment variables
NODE_ENV=production FILE_ENCRYPTION_KEY=... AUDIT_HMAC_KEY=... DATA_DIR=/path/to/persistent/disk npm start
```

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV` | yes (`production`) | Enables Secure `__Host-` cookies, HSTS, trust proxy, and refuses to start without keys. |
| `FILE_ENCRYPTION_KEY` | yes in production | 64 hex chars or 32+ random characters. **Losing it makes stored files unreadable.** |
| `AUDIT_HMAC_KEY` | yes in production | Signs the audit chain. Keep it out of the database and backups. |
| `DATA_DIR` | no (default `./data`) | Where the DB and encrypted files live. Point it at a persistent disk. |
| `PORT` | no (default 3000) | Set automatically by most hosts. |
| `SEED_DEMO` | no (default `true`) | Creates the demo users and documents on an empty database. |
| `AUDIT_STDOUT` | no (default `true`) | Prints each audit entry and its hash to the log, as a second copy outside the DB. |

> **Free-tier caveat:** Render's free web services have no persistent disk. A redeploy or restart resets the
> database to the seed data, including the audit trail. This is acceptable for a demo and is documented as
> THREATS T-61. For real use, attach a disk and set `DATA_DIR`.

## Project layout

```
server.js               entry point: load config, build app, seed, listen
db/schema.sql           all tables, indexes, and the append-only triggers on audit_log
src/
  authz.js              ★ the document authorisation decision (RULES table + authorize())
  audit.js              hash-chained audit trail: record() and verify()
  sessions.js           server-side sessions (idle + absolute expiry)
  storage.js            AES-256-GCM encrypted blob store
  validation.js         upload allow-list, magic-byte checks, filename sanitising
  middleware.js         security headers, CSRF/origin check, role gate, rate limit
  suggestions.js        rule-based sharing suggestions (advisory only)
  documents.js          create document / add version (file + rows + audit, atomically)
  users.js, passwords.js, http.js, config.js, db.js, seed.js
  routes/               auth, documents, sharing, admin
public/                 one HTML page per feature + js/<page>.js + css/app.css
test/                   authz, audit, uploads, auth test suites
scripts/                setup, generate-keys, mutation-check
```

## Pages

| Page | Who | Purpose |
|---|---|---|
| `/` , `/security`, `/login` | Everyone | Landing page, security model, sign-in |
| `/dashboard` | Owner, viewer | Stats, recent documents, recent activity, expiring access |
| `/documents` | Owner | My documents |
| `/shared` | Owner, viewer | Shared with me |
| `/search` | Owner, viewer | Search by name, owner, category, date |
| `/upload` | Owner | Upload |
| `/document?id=` | Anyone with access | Details, versions, edit, new version, trash |
| `/share?id=` | Document owner | Grant, change, revoke, suggestions |
| `/activity` | Owner | Activity (including refusals) on my documents |
| `/trash` | Owner | Restore or permanently delete |
| `/account` | Everyone | Profile, password, sessions |
| `/admin` | Admin | Alerts, chain status, 7-day chart, recent refusals and permission changes |
| `/admin-audit` | Admin | Full audit log, filters, verify, CSV export |
| `/admin-users` | Admin | Create, role change, deactivate, reset password, sign out everywhere |
| `/admin-permissions` | Admin | Every grant, revoke, permission history |
| `/admin-documents` | Admin | Metadata of every document |
