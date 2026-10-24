# THREATS.md — how TrustVault could be broken

Each entry: **the threat**, **what I did**, **how it is tested** (test file and the `T-xx` tag used in
the test name), and its **status**. "Accepted" means I know it is weak and chose to leave it, with the reason.

The single place where document access is decided is `authorize()` in `src/authz.js`. The list and search
query uses the same rule written as SQL (`ACCESSIBLE_SQL` in the same file). Most entries below come back to
those two.

`npm run mutation` deletes 20 individual security checks one at a time and re-runs the tests. Every one
is currently caught by at least one failing test (see "Testing the tests" at the end).

---

## A. Reaching a document you were not given

| ID | Threat | What I did | Test | Status |
|---|---|---|---|---|
| T-01 | **IDOR**: call any document route with someone else's document ID (view, download, versions, edit, new version, delete, restore, purge, activity, permissions, grant, revoke, suggestions). | Every one of the 13 routes calls `authorize(req, id, action)` before touching data. There is no route that reads a document or file without it. IDs are random UUIDs (not guessable), but I do not rely on that. | `authz.test.js` "another owner cannot reach a document through any route" loops over all 13 routes. | Closed |
| T-02 | **Existence oracle**: 403 vs 404 tells an attacker which IDs are real. | No access, a missing document and a malformed ID all return the same `404 Document not found`. 403 is only returned when you already have *some* access (e.g. a read grantee trying to delete), so it reveals nothing new. | T-02 | Closed |
| T-03 | **No session** at all. | `requireAuth` on every API route except login and health. Tested against all routes. | T-03 | Closed |
| T-04 | **Search and listing leak**: titles, counts, owners or totals of documents you cannot open, including via `%`/`_` wildcards. | The access rule is part of the SQL `WHERE` (not filtered afterwards), so counts and pagination totals are also clean. LIKE input is escaped. Expired grants are excluded in SQL too. | T-04 (4 tests) | Closed |
| T-05 | **Read grant used to edit, upload versions, delete, share, or read the activity log.** | Per-action rule table `RULES` in `authz.js`. | T-05 | Closed |
| T-06 | **Edit grantee widens access**: re-shares to someone else, grants themself more, or revokes the owner's choices. | Sharing is owner-only. An editor cannot touch the permissions table at all. | T-06 | Closed |
| T-07 | **Mass assignment**: `PATCH` with `owner_id`, `deleted_at`, etc. to take ownership. | Only `title`, `description`, `category` are read from the body, each validated. Same for user updates (role / isActive / displayName only). | T-07 | Closed |
| T-11 | **Trash still reachable**: grantees (or anyone) opening a soft-deleted document. | `authorize()` refuses every action on a trashed document except the owner's restore/purge. | T-11 | Closed |
| T-13 | **Version parameter crosses documents**: `/documents/A/download?version=2` returning version 2 of a different document B. | Version lookup is `WHERE document_id = ? AND version = ?`, scoped to the authorised document. | T-13 | Closed |
| T-16 | **Direct file access**: guessing a URL for the stored file, path traversal through the static server, reaching the DB file. | Files live in `DATA_DIR/files`, outside `public/`, under 64-hex random names. The static server only serves `public/`, ignores dotfiles. The original filename never becomes part of a path. | `auth.test.js` "data directory and server code are not reachable", T-33 | Closed |
| T-12 | **Administrator as super-reader**: the admin account (whose password is in the README!) reads everything. | There is no admin bypass in `authorize()`. Admin routes return metadata only, never file contents. Owners cannot grant to admin accounts, and a user who owns or holds documents cannot be promoted to admin. Admins can *revoke* any grant but there is no admin grant route. | T-12 | Closed |
| T-14 | **Role bypass**: a viewer uploads or calls `/api/admin/*`. An owner calls admin routes. | `requireRole()` on upload, trash, activity, directory, and the whole admin router. Refusals are audited. The UI hiding menu items is cosmetic only. | T-14 | Closed |
| T-15 | **AI suggestion widens access by itself**, or a suggestion ID is replayed on another document. | Suggestions are rows in `share_suggestions` only. Nothing is granted until the owner clicks Accept, which grants **read only** and re-checks eligibility. Generation, acceptance and dismissal are all audited, and the resulting grant records `via: suggestion`. Suggestion lookups are scoped to the document. | T-15 (2 tests) | Closed |
| T-52 | **User directory as reconnaissance**: listing every username, including admins. | Owners only, needs 2+ characters, max 10 results, never lists admins or deactivated users. Viewers get 403. | T-14 | Partly accepted: an owner can still enumerate non-admin users by trying letter pairs. Owners need to find people to share with; I judged that acceptable inside one company. |

## B. Taking access away

| ID | Threat | What I did | Test | Status |
|---|---|---|---|---|
| T-08 | **Revocation not immediate**: cached permissions, signed URLs, share links or JWTs keep working after revoke. | No share links, download tokens, signed URLs or JWTs exist. The only credential is the session cookie, looked up server-side on every request, and `authorize()` reads the live `permissions` table every time. Downgrading edit to read is equally immediate. Downloads are sent with `Cache-Control: no-store`. | T-08 (2 tests) | Closed. **Cost:** every download goes through the app server (no CDN offload), plus one extra DB read per request. |
| T-09 | **Expired grants keep working.** | Expiry is checked at decision time in both `accessLevel()` and the SQL filter. No background job needed. | T-09 | Closed |
| T-10 | **Leaver keeps access**: a deactivated employee's open session still works, or reactivation brings back an old (possibly stolen) session. | Deactivation deletes all their sessions in the same transaction. Session lookup also rejects inactive users on every request, and `accessLevel()` rejects them again (defence in depth, tested on its own). | T-10 (3 tests) | Closed |
| T-53 | **What was already downloaded.** | Cannot be recalled. This is exactly why downloads are audited before they are sent. | — | Accepted (inherent) |
| T-54 | **Restoring from trash silently re-enables old grants.** | Kept on purpose, so restore is a true undo. The restore dialog says how many people get access back and sends the owner straight to the Manage access page. | — | Accepted, mitigated in UI |

## C. The audit trail

| ID | Threat | What I did | Test | Status |
|---|---|---|---|---|
| T-20 | **Missing events**: upload, view, download, edit, delete, restore, purge, permission grant/update/revoke, suggestions, logins, admin actions. | All recorded, with actor, time, IP, document and details (old and new values for changes). | T-20 | Closed |
| T-21 | **Refusals not recorded**: you cannot investigate attempts you never saw. | `authorize()` records every refusal with the reason (`no_access`, `insufficient_level`, `document_in_trash`…). Role refusals, CSRF/cross-origin rejections, failed logins and rejected uploads are recorded too. | T-21 | Closed |
| T-26 | **Unrecorded read**: the file is sent but the audit write fails. | The download entry is written before the bytes are sent. If the write throws, the request fails and nothing is served. | mutation test "download not audited" | Closed |
| T-22 | **Alteration through the app or SQL**: `UPDATE`/`DELETE` on `audit_log`. | No route modifies audit rows. SQLite triggers abort any `UPDATE` or `DELETE`. No foreign keys, so purging a document or user never cascades into the log. | T-22 | Closed |
| T-23 | **Alteration with raw DB access** (triggers dropped): edit a row, delete a row, or rewrite the whole chain. | Each row stores `HMAC-SHA256(AUDIT_HMAC_KEY, prev_hash + row)`. Editing or deleting a middle row breaks the chain. Rewriting the whole chain needs the HMAC key, which lives in an environment variable, not the DB. Admin "Verify" shows the first broken entry. | T-23 (3 tests) | Closed for edit/delete/rewrite-without-key |
| T-23b | **Cutting off the newest entries** (truncating the tail) leaves a valid shorter chain. | Every entry is also printed to stdout with its hash, so the hosting platform's log is an independent copy. The admin page shows the head hash, which can be noted externally. | — | Partly accepted: no automatic external anchoring. |
| T-23c | **Attacker holding both the DB and the HMAC key** (full server compromise) can rewrite history. | Out of scope for an app-level control. A real deployment would ship entries to a write-once store (e.g. S3 Object Lock or a SIEM). | — | Accepted |
| T-24 | **The audit log itself leaks**: owners seeing events on others' documents, or seeing IP addresses. | Owners see only events for documents they currently own, without IPs. Viewers see none. Admin sees all. | T-24 | Closed |
| T-25 | **CSV/formula injection** when an admin opens the export in Excel. | Cells starting with `= + - @ tab CR` are prefixed with `'`. Every cell is quoted. | T-25 | Closed |
| T-55 | **Log flooding** to bury an event (e.g. thousands of refused requests). | API rate limit of 600 requests/min per IP. Refusals are grouped per user in admin alerts. | — | Partly accepted: no log retention or compaction policy. |

## D. Files

| ID | Threat | What I did | Test | Status |
|---|---|---|---|---|
| T-30 | **Executable or malware disguised** with a document extension. | Extension allow-list plus a magic-byte check, so the first bytes must match the type (`%PDF-`, PNG/JPEG signatures, OOXML zip with `[Content_Types].xml`, UTF-8 without NULs for text). | T-30 | Closed for disguise. Accepted: **no antivirus scan**, and a real PDF can still carry malicious content. |
| T-31 | **Stored XSS through uploads**: HTML, SVG or JS served inline from our origin. | Those types are not on the allow-list. Every download is `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: default-src 'none'; sandbox`. | T-31, T-35 | Closed |
| T-32 | **Huge or empty files, many parts** to exhaust memory. | 10 MB limit, 1 file, limited fields and parts (multer). For new versions the upload body is only accepted after authorisation. | T-32 | Partly accepted: files are buffered in memory, so 10 MB times many concurrent uploads could pressure a small instance. |
| T-33 | **Path traversal in the filename** (`../../etc/passwd`). | The name is only stored for display: sanitised, path parts stripped. The disk name is random. | T-33 | Closed |
| T-34 | **Stolen disk or backup** reveals contents. | AES-256-GCM per file, key derived (HKDF) from `FILE_ENCRYPTION_KEY` plus a random per-file salt. The key is not stored with the data in production. | T-34 | Closed (key in env on the same host is accepted, T-23c) |
| T-36 | **Blob swap or tamper on disk**: put document B's encrypted file in place of A. | GCM associated data binds each ciphertext to its `document_versions.id`. A SHA-256 of the plaintext is re-checked. Failure means a 500, nothing served, and an audit entry plus admin alert. | T-36 | Closed |
| T-56 | **Header injection via filename** in `Content-Disposition`. | RFC 5987 encoding plus an ASCII fallback with quotes and controls stripped. | T-35 | Closed |

## E. Sessions, login and the browser

| ID | Threat | What I did | Test | Status |
|---|---|---|---|---|
| T-40 | **Username enumeration** via different messages or timing. | One message for every failure. Unknown users still run a dummy scrypt. | T-40 | Closed |
| T-41 | **Password guessing.** | Account lock after 5 failures (15 min), per-IP limit of 20 attempts per 15 min, scrypt hashing, minimum length 10. | T-41 + rate-limit test | Partly accepted: lockout can be abused to lock someone out for 15 minutes (DoS). No MFA. |
| T-42 | **Session theft via script.** | Cookie is `HttpOnly; SameSite=Strict`; `Secure` and `__Host-` prefix in production. Token is 256-bit random; only its SHA-256 is stored, so a DB leak gives no usable sessions. | T-42 | Closed |
| T-43 | **Logout only in the browser.** | Session row deleted on logout. Replaying the old cookie gives 401. | T-43 | Closed |
| T-44 | **Password change leaves a thief signed in.** | All other sessions ended. Admin reset ends all sessions. | T-44 | Closed |
| T-45 | **CSRF**: another site makes the victim's browser grant access. | `SameSite=Strict`, a per-session CSRF token required in `X-CSRF-Token` on every state change, `Origin` checked when present, and login only accepts JSON. | T-45 (2 tests) | Closed |
| T-46 | **Forgotten logged-in machine.** | 30-minute idle and 8-hour absolute expiry, enforced server-side. Users can see and end their own sessions (and only their own). | T-46 | Closed |
| T-47 | **XSS / clickjacking in the app UI**, e.g. a document titled `<img src=x onerror=...>`. | All data is inserted with `textContent` (no `innerHTML` anywhere). Strict CSP: `script-src 'self'`, no inline scripts or styles. `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, no `X-Powered-By`. | T-47 | Closed |
| T-48 | **Open redirect** via `/login?next=//evil.example`. | `next` must be a same-site path (`/` not followed by `/`). | — (client-side only) | Closed, but untested in automation |
| T-19 | **SQL injection.** | Every query is parameterised. The one dynamic column name (user PATCH) comes from a fixed list, never from input. | Covered indirectly (search tests with `%`) | Closed |
| T-57 | **Error messages leak internals.** | 500s return a generic message. Stack traces only go to the server log. | auth.test.js last test | Closed |
| T-58 | **Race conditions**: two version uploads taking the same number, grant and revoke interleaving. | The version number is read inside the write transaction, plus `UNIQUE(document_id, version)`. node:sqlite is synchronous, so one process executes one statement at a time. | — | Closed for a single instance. Accepted: not designed for multiple app instances. |

## F. Deployment and operations (accepted, stated plainly)

| ID | Issue | Why it is accepted |
|---|---|---|
| T-60 | **Demo credentials are public** (the brief requires them in the README). Anyone can sign in as the demo admin. | Required for judging. The demo admin can still not read documents (T-12). Set `SEED_DEMO=false` and change passwords for any real use. |
| T-61 | **Free hosting with ephemeral disk**: a restart or redeploy wipes the database, files and audit log, and the seed data is recreated. | Free tier. Losing the audit log is an evidence problem, so in production you would mount a persistent disk (`DATA_DIR`) and ship audit lines to external storage. The stdout copy (T-23b) survives in the platform's log stream. |
| T-62 | **Rate limits are in memory**, so they reset on restart and are not shared across instances. | Single-instance deployment. A real deployment would use Redis or the platform's WAF. |
| T-63 | **Administrators see document titles** in the audit log and admin pages. A title like "Salary letter - Carol" is itself sensitive. | Oversight needs to know *what* was accessed. Titles are metadata; contents are never shown. |
| T-64 | **A legitimately granted reader can copy, photograph or forward** what they read. | No web app can prevent copying. What TrustVault adds is attribution: every download is a uniquely stamped copy, so a leaked file can be traced to the person and moment it left (T-70). Robust watermarking that survives re-saving or photographs is out of scope. |
| T-65 | **No email verification, MFA or SSO.** | Out of scope for the week. Accounts are created by an administrator. |
| T-66 | **Trust proxy is set to 1 hop** in production; client IPs in the audit depend on that being correct for the host. | Correct for Render, which sits behind exactly one proxy. |
| T-67 | **When an owner is deactivated, their documents stay accessible to existing grantees**, and there is no ownership transfer. | Deliberate, so business continuity does not depend on one person. Admins can revoke grants if needed. Ownership transfer is listed as unfinished. |

## G. After access was legitimately given: leaks and stale access

Everything above stops the wrong person. These threats are about the *right* person, or access that
outlived its purpose. Tests are in `test/forensics.test.js`.

| ID | Threat | What I did | Test | Status |
|---|---|---|---|---|
| T-70 | **A leaked copy cannot be attributed.** Ten people were granted the file; it turns up outside. Who leaked it? | Every download is a unique copy stamped with its own trace ID (`src/trace.js`), placed so the file stays valid: visible footer (txt/csv), comment after `%%EOF` (pdf), zip archive comment (docx/xlsx/pptx), `tEXt` chunk with correct CRC (png), COM segment (jpeg). The stored original is never altered. The audit entry records the trace ID and the SHA-256 of the exact bytes delivered, written before sending. | T-70 (5 tests) | Closed |
| T-71 | **The Leak Tracer becomes an oracle** for other people's documents ("whose download is this ID?"). | Owners only get matches for documents they currently own; viewers get 403; admins see all. Every lookup, with or without a match, is audited as `trace.lookup`, and a successful trace raises a high admin alert. | T-71 | Closed |
| T-72 | **Stripping or defeating the stamp:** delete the footer, re-save the PDF, retype the text, photograph the screen. | An unmodified copy still matches by SHA-256. The tracer accepts either a trace ID or a file. | T-71 ("footer removed") | **Accepted**: a determined insider who re-saves or photographs the content defeats it. Forensic watermarking that survives re-encoding is out of scope. |
| T-73 | **Stale access:** a contract ends or a person changes team, and nobody remembers to revoke. | Access reviews: grants not confirmed for 30 days are flagged for their owner (`/reviews`), who keeps or revokes each one; both are audited (`permission.review`, `permission.revoke`). Admins are alerted to grants unconfirmed for 90 days. | T-73 | Partly accepted: a review is a prompt, not an automatic revoke. Auto-expiry is available per grant. |
| T-74 | **The tracer stores what it is given**, creating a second, unprotected copy of a leaked document. | The uploaded file is held in memory only to hash it and search for a trace ID, never written to disk. | T-74 | Closed |
| T-75 | **A reader does not realise their copy is traceable**, which weakens deterrence. | The download message shows the copy's trace ID, and "Why can I see this?" on every document says that each copy is traceable. | — | Closed (UI) |

---

## Testing the tests

The brief says a judge will remove one authorisation check and run the tests. `scripts/mutation-check.js`
does exactly that for 25 checks: owner check, expiry check, trash check, level check, missing-grant check,
inactive-user check, search access filter, version scoping, upload role, download audit, download trace
stamping, tracer owner scoping, tracer role gate, review-confirm authorisation, tracer lookup audit, upload
validation, admin gate, session deletion on deactivation, admin-grant block, suggestion scoping, directory
role, idle timeout, CSRF check, logout session deletion, and hash-chain verification.

The first run found **two checks no test noticed** (both are now covered):

1. Deleting the sessions on deactivation. No test failed, because session lookup also checks `is_active`.
   But without it, *reactivating* the user brings their old sessions back to life. New test: "reactivating
   a user does not bring their old sessions back".
2. The `is_active` check inside `accessLevel()`, which was only exercised through the session layer. New
   unit test on `authz.accessLevel()` directly.

Current result: `Every removed check was caught by at least one test.`
