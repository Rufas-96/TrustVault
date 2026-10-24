# TrustVault API

JSON over HTTPS. All endpoints are under `/api`. Authentication is a server-side session cookie set by
`POST /api/auth/login`.

**Every state-changing request** (POST, PUT, PATCH, DELETE) made while signed in must send the header
`X-CSRF-Token: <csrfToken>`, using the value returned by login or `GET /api/auth/me`. A request with an
`Origin` header from another site is refused.

**Errors** are `{"error": "message"}` with these statuses:

- `400` invalid input
- `401` not signed in
- `403` your role or access level does not allow this
- `404` not found *or* you have no access (deliberately the same answer)
- `409` conflict
- `413` too large
- `415` file type not allowed
- `429` rate limited

"Doc level" below means your access to that one document: `owner`, `edit` or `read`. It is decided by
`authorize()` in `src/authz.js`. Roles (`admin`, `owner`, `viewer`) only gate features.

## Authentication — `src/routes/auth.js`

| Method & path | Who may call | Body / query | Notes |
|---|---|---|---|
| `POST /auth/login` | Anyone (rate-limited 20 / 15 min / IP) | `{username, password}` as JSON only | Sets the cookie and returns `{user, csrfToken}`. Locks the account for 15 min after 5 failures. Audited (success and failure). |
| `POST /auth/logout` | Signed in | — | Deletes the session row server-side. |
| `GET /auth/me` | Signed in | — | `{user, csrfToken}` |
| `POST /auth/password` | Signed in | `{currentPassword, newPassword}` | Ends all your other sessions. |
| `GET /auth/sessions` | Signed in | — | Your own sessions only. |
| `DELETE /auth/sessions/:id` | Signed in | — | Only matches your own sessions; anything else is 404. |

## Documents — `src/routes/documents.js`

| Method & path | Who may call | Body / query | Notes |
|---|---|---|---|
| `GET /meta/categories` | Signed in | — | Allowed category list. |
| `GET /documents` | Signed in | `scope=all\|mine\|shared`, `q`, `owner`, `category`, `from`, `to` (YYYY-MM-DD), `dateField=updated\|created`, `sort=updated\|created\|title`, `page` | **Only documents you own or hold a live grant on**, filtered inside SQL. 25 per page. |
| `POST /documents` | Role **owner** | multipart: `file`, `title`, `category`, `description` | Validates type by contents, encrypts, stores. Returns `{id}`. |
| `GET /documents/:id` | Doc level owner / edit / read | — | Metadata and versions. Audited as `document.view`. |
| `PATCH /documents/:id` | Doc level owner / edit | `{title?, description?, category?}` | Other fields are ignored. Old and new values are audited. |
| `POST /documents/:id/versions` | Doc level owner / edit | multipart: `file` | Authorisation runs **before** the body is accepted. |
| `GET /documents/:id/download?version=n` | Doc level owner / edit / read | `version` optional (default current) | Audited **before** sending. Served as an attachment, sandboxed, no-store. Version is scoped to this document. |
| `DELETE /documents/:id` | Doc level **owner** | — | Moves to trash; nobody can open it while it is there. |
| `GET /trash` | Role **owner** | — | Your own trashed documents. |
| `POST /documents/:id/restore` | Doc level **owner**, document in trash | — | 409 if not in trash. |
| `DELETE /documents/:id/purge` | Doc level **owner**, document in trash | — | Destroys all stored versions and grants. The audit trail is kept. |
| `GET /documents/:id/activity` | Doc level **owner** | — | Audit entries for this document (no IPs). |
| `GET /activity` | Role **owner** | `outcome`, `page` | Audit entries for all documents you currently own. |
| `GET /dashboard` | Signed in | — | Counts and recent items, all scoped to you. |

## Sharing — `src/routes/sharing.js`

| Method & path | Who may call | Body / query | Notes |
|---|---|---|---|
| `GET /documents/:id/permissions` | Doc level **owner** | — | Current grants. |
| `PUT /documents/:id/permissions/:userId` | Doc level **owner** | `{level: "read"\|"edit", expiresOn?: "YYYY-MM-DD"}` | Grants, or changes an existing grant. The grantee must be active, not the owner, and not an admin. |
| `DELETE /documents/:id/permissions/:userId` | Doc level **owner** | — | Revokes. Effective on the grantee's next request. |
| `GET /documents/:id/suggestions` | Doc level **owner** | — | Generates and returns pending suggestions. **Never grants.** |
| `POST /documents/:id/suggestions/:sid/accept` | Doc level **owner** | — | Grants **read** only. Audited as `suggestion.accepted` plus `permission.grant`. |
| `POST /documents/:id/suggestions/:sid/dismiss` | Doc level **owner** | — | Audited. |
| `GET /users/directory?q=` | Role **owner** | `q` (2+ characters) | Up to 10 active, non-admin users. |

## Administration — `src/routes/admin.js` (all require role **admin**)

No admin endpoint returns file contents, and none grants document access.

| Method & path | Body / query | Notes |
|---|---|---|
| `GET /admin/overview` | — | Counts, alerts ("worth noticing"), chain status, recent refusals and permission changes, 7-day series. |
| `GET /admin/audit` | `action` (exact, or prefix ending in `.`), `outcome`, `actor`, `document`, `from`, `to`, `page` | 50 per page, with IPs and hashes. |
| `GET /admin/audit/export.csv` | same filters | Formula-safe CSV. The export itself is audited. |
| `POST /admin/audit/verify` | — | Walks the hash chain: `{ok, count, headSeq, headHash}` or `{ok:false, brokenAt, reason}`. Audited. |
| `GET /admin/users` | — | All users with counts. |
| `POST /admin/users` | `{username, displayName, email, role, password}` | |
| `PATCH /admin/users/:id` | `{role?, isActive?, displayName?}` | Deactivation ends all sessions at once. You cannot demote or deactivate yourself or the last admin, or promote someone who holds documents. |
| `POST /admin/users/:id/reset-password` | `{newPassword}` | Ends their sessions and clears any lockout. |
| `POST /admin/users/:id/logout` | — | Ends all of that user's sessions. |
| `GET /admin/documents` | — | Metadata only: title, owner, counts. |
| `GET /admin/permissions` | — | Every grant. |
| `DELETE /admin/permissions/:documentId/:userId` | — | Revoke (narrowing only). Audited with `byAdministrator: true`. |

## Leak forensics and access reviews — `src/routes/forensics.js`

| Method & path | Who may call | Body / query | Notes |
|---|---|---|---|
| `POST /trace` | Role **owner** or **admin** | multipart `file` (a suspected leaked copy) **or** JSON `{traceId}` | Finds the download a copy came from, by the trace ID inside it or by its SHA-256. Owners only get matches for documents they own; admins get all, with IPs. The file is never stored. Every lookup is audited as `trace.lookup`. |
| `GET /reviews` | Role **owner** | — | Grants on your live documents, oldest confirmation first, with `due` after 30 days. |
| `POST /documents/:id/permissions/:userId/confirm` | Doc level **owner** | — | Confirms a grant is still needed (resets its review clock). Audited as `permission.review`. |

Every `GET /documents/:id/download` response carries an `X-TrustVault-Trace` header with that copy's trace ID.

## Other

| Method & path | Who | Notes |
|---|---|---|
| `GET /api/health` | Anyone | `{ok:true}`, for the host's health check. Reveals nothing else. |
