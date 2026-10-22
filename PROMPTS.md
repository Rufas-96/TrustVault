# PROMPTS.md

> **How to use this file.** The brief wants at least five dated entries, **written as you go**, each with
> what you asked, what the tool produced, what was wrong, and what you did instead **with a link to the
> commit**. At least two must be about authorisation, access control or the audit trail.
>
> Only record things that really happened, in your own words. Section 2 is a factual log of issues found
> during the AI-assisted build session on 22 Oct 2026. Use it as raw material: check each one yourself in
> the code, then write the entry from your own understanding and link the commit where you made the change.
> Do not claim you personally spotted something you did not.

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

Facts only. Turn the ones you have verified into entries in section 3.

| # | Area | What was produced | What was wrong | What changed |
|---|---|---|---|---|
| a | **Access control / sessions** | Deactivation deleted the user's sessions; the session lookup also rejected inactive users. | `npm run mutation` showed that deleting the "destroy sessions on deactivation" line did **not** fail any test. Because the lookup also checks `is_active`, the tests could not see it. But without that line, **reactivating** a user would revive an old (possibly stolen) session. | Added test "reactivating a user does not bring their old sessions back" in `test/authz.test.js`. |
| b | **Authorisation** | `accessLevel()` returns null for inactive users. | Also survived the mutation run. It was only exercised indirectly through the session layer, so it was untested defence in depth. | Added a direct unit test on `authz.accessLevel()`. |
| c | **Audit (CSV export)** | A test for formula injection logged in with username `=HYPERLINK(...)` and checked the export. | The test was wrong: the attempted username is stored inside the JSON `details` cell, which starts with `{`, so the guard was never exercised and the assertion failed for the wrong reason. | Rewrote the test to write a hostile actor name straight into the log and assert that every cell starting with `= + - @` is prefixed with `'`. |
| d | Frontend | The upload and edit forms read fields as `form.title`. | `HTMLFormElement.title` is the form's own title attribute, not the input named "title", so the title the user typed was ignored. | Changed to `form.elements.title` (same for category and description). |
| e | Frontend | The document details panel passed conditional `null` children to the DOM's native `append()`. | Native `append(null)` inserts the text "null", so viewers saw "nullnull" and the labels shifted by one. Found by screenshotting each page per role. | Used the helper `TV.append`, which skips nulls. |
| f | Frontend / access | The Manage-access page let an owner change an existing grant's level. | For an **expired** grant, changing the level would have re-sent no expiry date and silently renewed access forever. | The level selector is disabled for expired grants; renewing requires an explicit new grant. |

## 3. Entries

### Entry 1 — YYYY-MM-DD — _title_
- **What I asked:**
- **What it produced:**
- **What was wrong (specifically):**
- **What I did instead:** … (commit: `<link>`)

### Entry 2 — YYYY-MM-DD — _authorisation / access control_
- **What I asked:**
- **What it produced:**
- **What was wrong:**
- **What I did instead:** … (commit: `<link>`)

### Entry 3 — YYYY-MM-DD — _audit trail_
- **What I asked:**
- **What it produced:**
- **What was wrong:**
- **What I did instead:** … (commit: `<link>`)

### Entry 4 — YYYY-MM-DD
- **What I asked:**
- **What it produced:**
- **What was wrong:**
- **What I did instead:** … (commit: `<link>`)

### Entry 5 — YYYY-MM-DD
- **What I asked:**
- **What it produced:**
- **What was wrong:**
- **What I did instead:** … (commit: `<link>`)
