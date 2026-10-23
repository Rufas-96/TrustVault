# PROMPTS.md

This file records how I used AI to build TrustVault: the instructions I gave the tool, a log of the
issues found during the build, and five entries describing what it got wrong and what was done instead.

## 1. Reusable context I gave the tool

This is the instruction block I reused when asking for changes, so the tool kept to the security model:

```
Project: TrustVault (Node 22+/Express 5/node:sqlite). Security is the priority, not features.
Rules you must not break:
- Every route that touches a single document calls authorize(req, id, action) from src/authz.js FIRST.
  Never add an admin bypass. Never authorise in the frontend only.
- Lists/search must apply ACCESSIBLE_SQL inside the SQL WHERE, not filter results afterwards.
- No share links, signed URLs, JWTs or caches of permissions: revocation must be immediate.
- Every state change and every refusal is written with audit.record(); a download is audited BEFORE sending.
- Never UPDATE/DELETE audit_log. Never render server data with innerHTML; use TV.el / textContent.
- Every new check needs a test that fails if the check is removed (run npm run mutation).
Explain any security decision you make in a code comment, briefly.
```

## 2. Raw log from the AI-assisted build session (22 Oct 2026)


| # | Area | What was produced | What was wrong | What changed |
|---|---|---|---|---|
| a | **Access control / sessions** | Deactivation deleted the user's sessions; the session lookup also rejected inactive users. | `npm run mutation` showed that deleting the "destroy sessions on deactivation" line did **not** fail any test. Because the lookup also checks `is_active`, the tests could not see it. But without that line, **reactivating** a user would revive an old (possibly stolen) session. | Added test "reactivating a user does not bring their old sessions back" in `test/authz.test.js`. |
| b | **Authorisation** | `accessLevel()` returns null for inactive users. | Also survived the mutation run. It was only exercised indirectly through the session layer, so it was untested defence in depth. | Added a direct unit test on `authz.accessLevel()`. |
| c | **Audit (CSV export)** | A test for formula injection logged in with username `=HYPERLINK(...)` and checked the export. | The test was wrong: the attempted username is stored inside the JSON `details` cell, which starts with `{`, so the guard was never exercised and the assertion failed for the wrong reason. | Rewrote the test to write a hostile actor name straight into the log and assert that every cell starting with `= + - @` is prefixed with `'`. |
| d | Frontend | The upload and edit forms read fields as `form.title`. | `HTMLFormElement.title` is the form's own title attribute, not the input named "title", so the title the user typed was ignored. | Changed to `form.elements.title` (same for category and description). |
| e | Frontend | The document details panel passed conditional `null` children to the DOM's native `append()`. | Native `append(null)` inserts the text "null", so viewers saw "nullnull" and the labels shifted by one. Found by screenshotting each page per role. | Used the helper `TV.append`, which skips nulls. |
| f | Frontend / access | The Manage-access page let an owner change an existing grant's level. | For an **expired** grant, changing the level would have re-sent no expiry date and silently renewed access forever. | The level selector is disabled for expired grants; renewing requires an explicit new grant. |

## 3. Entries

### Entry 1 — 2026-10-22 — Reactivated users got their old sessions back
- **What I asked:** Let admins deactivate a user so they lose access immediately.
- **What it produced:** Deactivation deleted the user's sessions, and the session lookup
  also rejected inactive users.
- **What was wrong:** The mutation run (`npm run mutation`) showed the "destroy sessions" line
  could be deleted with no test failing, because the is_active check hid it. But if the user was later
  reactivated, an old (possibly stolen) session would work again.
- **What I did instead:** Added the test "reactivating a user does not bring their old
  sessions back" in test/authz.test.js, which fails if that line is removed.
  (commit: none, fixed before the project was put under git; see the test above)

### Entry 2 — 2026-10-22 — Expired access could silently become permanent
- **What I asked:** Let an owner change someone's access level (read/edit) on the Manage access page.
- **What it produced:** A level dropdown on every grant in the list, including expired ones.
- **What was wrong (specifically):** Changing the level of an **expired** grant sent no expiry date
  with the update, so the person silently got permanent access again.
- **What I did instead:** The dropdown is now disabled for expired grants (public/js/share.js), with
  the hint "Expired. Grant again to renew." Renewing access needs a new grant with a new expiry.
  (commit: none, fixed before the project was put under git)

### Entry 3 — 2026-10-22 — The CSV injection test was not testing anything
- **What I asked:** Make the audit log CSV export safe to open in Excel (no formula injection), with a test.
- **What it produced:** A test that tried to sign in with the username `=HYPERLINK(...)` and checked the export.
- **What was wrong (specifically):** The attempted username is stored inside the JSON "details" cell,
  which starts with `{`, so the formula protection was never triggered. The test failed for the wrong reason.
- **What I did instead:** Rewrote the test to write a hostile actor name straight into the audit log and
  check that every cell starting with = + - @ is prefixed with ' ("CSV export neutralises spreadsheet
  formulas" in test/audit.test.js). (commit: none, fixed before the project was put under git)

### Entry 4 — 2026-10-22 — A security check with no test of its own
- **What I asked:** Make sure deactivated users cannot access any document.
- **What it produced:** accessLevel() in src/authz.js returns null for inactive users.
- **What was wrong (specifically):** The mutation run (`npm run mutation`) showed that removing this check
  did not fail any test. It was only covered indirectly through the session layer, so it was untested defence in depth.
- **What I did instead:** Added a direct unit test on authz.accessLevel() for active and inactive users
  (test/authz.test.js). (commit: none, fixed before the project was put under git)

### Entry 5 — 2026-10-22 — The upload form ignored the typed title
- **What I asked:** Build the upload and edit forms for documents.
- **What it produced:** JavaScript that read the fields as form.title, form.category and form.description.
- **What was wrong (specifically):** form.title is the form element's own "title" attribute, not the input
  named "title", so whatever the user typed was ignored.
- **What I did instead:** Changed it to form.elements.title (and the same for category and description) in
  public/js/upload.js and public/js/document.js. (commit: none, fixed before the project was put under git)
