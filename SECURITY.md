# ALICE — Security Review (Part 5)

This document records the security posture of ALICE as of v0.5.0. ALICE is a
**client-side** web application (no backend, no server-side execution). Several
controls below are therefore architectural (browser sandbox) rather than
server-enforced — those are called out explicitly.

## 1. Threat model

| Threat | Status |
|--------|--------|
| Unrestricted autonomy / destructive actions | Mitigated — deny-by-default confirmation for sensitive actions |
| Secret leakage into logs | Mitigated — log redaction (`CONFIG.security.redactPatterns`) |
| Unauthorized auth bypass | Partially — prototype PIN only (see §3) |
| Arbitrary file/system access | Mitigated — browser sandbox; files are user-picked or downloaded |
| Unauthorized external calls | Mitigated — external navigation/sends require confirmation |
| Malicious plugin/skill | Mitigated — skill manifest validation + per-skill disable |
| Device/API key exposure | Mitigated by design — no keys exist; keys must stay server-side |

## 2. What is enforced

- **Sensitive-action confirmation** (`js/permissions.js`): delete/remove/clear/
  forget, send/email/post/share/publish, account/password/payment, and
  format/uninstall/overwrite-style actions pause for explicit approval. Approve/
  cancel works from both the UI dialog and voice.
- **No unrestricted system access**: ALICE never executes real shell commands.
  Developer Mode's "run command" is a **simulation** (dry-run), also
  confirmation-gated. Browser automation is limited to opening a URL (new tab)
  and reading the current page.
- **Log redaction** (`js/utils.js: redact()`): `state.logActivity`, activity log
  entries, and notifications all pass through redaction of common API-key,
  token, password, and secret patterns.
- **Skill/plugin gating** (`js/skillManager.js`): every skill is validated
  (name/description/patterns/execute; optional permissions/risk/inputs), and the
  user can disable individual skills from Settings — disabled skills are
  excluded from routing and execution.
- **Deny-by-default plugin registration**: invalid plugins are rejected and
  logged, never registered.

## 3. Known gaps / recommendations

- **Authentication is a prototype.** The PIN (`1234`) is compared client-side in
  `js/auth.js`. Anyone with the page can bypass it by inspecting the source.
  **For any real deployment, move authentication server-side** (sessions/tokens,
  rate-limited, hashed credentials) and serve the app behind it.
- **API keys must stay server-side.** If a future integration (LLM, search, IoT)
  needs credentials, they must be proxied through a backend or local agent —
  never embedded in `js/` or committed to Git. The current DuckDuckGo API is
  keyless by design.
- **localStorage is not encrypted.** Memories, notes, and settings are stored in
  plaintext in the user's browser profile. This is acceptable for a local
  assistant prototype; do not store secrets there.
- **Vision is local-only** (Canvas colour/brightness analysis). No image leaves
  the browser. If OCR/vision is added via a cloud API, review its data policy and
  gate it behind permission.
- **IoT providers** register through `integrations.js`. Real adapters must
  authenticate with the provider (never hardcode tokens) and keep control
  actions behind the confirmation layer (the IoT skill already does this).
- **No Content-Security-Policy** is currently set. Serving over plain
  `http.server` is fine for local dev; a production deployment should add a CSP
  and serve over HTTPS.

## 4. Checklist

- [x] API keys server-side — **N/A: no keys exist** (documented requirement for future work)
- [x] Authentication protected — **prototype PIN only** (see §3)
- [x] Sensitive actions require permission
- [x] File/system access restricted (browser sandbox)
- [x] External integrations use explicit permissions (confirmation prompts)
- [x] Users can disable individual skills (Settings)
- [x] Logs do not unnecessarily expose sensitive information (redaction)

## 5. Reporting

If you find a security issue in ALICE, open a private report to the maintainer
rather than filing a public issue for anything that could be exploited.
