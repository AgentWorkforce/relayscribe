# Recorder → transcription authentication

**Status:** draft for implementation · **Verified:** 2026-08-10 · **Repos:** `relayscribe`, `cloud`

The desktop recorder and the transcription backend disagree about what a valid
caller looks like. Transcription cannot succeed from any build of current
source. This specifies the fix, the migration, and how we prove it is done.

Every claim in §1 was read out of current source or observed live on
2026-08-10. Nothing is inferred. File:line references are to relayscribe
`main` (`0d471bc`) and cloud `main` as of that date.

---

## Verdict

Three defects, stacked. The first makes the product non-functional; the second
makes it insecure; the third makes the failure invisible.

1. **The app sends a token the backend will never accept.** The worker compares
   the bearer against one shared secret; the app sends the signed-in user's
   Relay access token. Every transcription request returns `401`.
2. **The shared secret ships inside the app.** It is baked in plaintext into
   every distributed `.app` bundle. Anyone who downloads the DMG can extract it
   and use the transcription backend directly.
3. **The failure is silent and destroys the recording.** The sidecar treats
   `401` as a generic transcription error, burns all three retries against an
   auth failure that cannot self-heal, and the user is never told to sign in
   again.

---

## 1 · Evidence

### 1.1 The live failure

A probe against production, using a **valid, unexpired** credential read from
the Keychain (`accessTokenExpiresAt: 2026-08-11T19:53:45Z`), sending audio in
the exact shape the sidecar uses:

```
== worker health ==
   200 {"ok":true}

== POST real Norwegian audio to /transcribe (raw octet-stream) ==
   input: mix-jr.wav (1.0 MB)
   HTTP 401 in 0.1s
     error: unauthorized
```

The worker is healthy. The credential is live. The request shape is right. It
is rejected at the edge in 100 ms because it is the wrong *kind* of token.

### 1.2 Why it is rejected

```ts
// cloud: packages/transcription-worker/src/index.ts:1005
if (req.method === 'POST' && pathname === '/transcribe') {
  if (!isAuthorized(req, env.RECORDER_TRANSCRIBE_TOKEN)) {
    return json({ error: 'unauthorized' }, 401);
  }

// index.ts:232 — a constant-time compare against ONE shared secret.
// There is no code path that validates a Relay user token.
function isAuthorized(req: Request, token: string) {
  if (!token) return false;
  const authorization = req.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) return false;
  return constantTimeStringEqual(authorization.slice(7), token);
}
```

Meanwhile the sidecar sends the user's sign-in token:

```ts
// relayscribe: sidecar/src/server.ts:107
function resolveWorkerToken(): string {
  if (runtimeCredential.accessToken) return runtimeCredential.accessToken;  // ← Relay user token
  if (process.env.DESKTOP_SHARED_TOKEN) return process.env.DESKTOP_SHARED_TOKEN;
  return '';
}
// used as `transcribeToken` at server.ts:528 and :691

// server.ts:44 still imports the shared token — and never uses it:
import { DEFAULT_RECORDER_TRANSCRIBE_TOKEN } from './build-config';
```

The commit `fix(auth): push the signed-in credential to the sidecar` moved the
client to per-user tokens. The worker was never moved with it. The unused
import at `server.ts:44` is the seam where the change stopped.

### 1.3 The three surfaces on the shared secret

| Surface | Gate | Reference |
| --- | --- | --- |
| `POST /transcribe` | shared `RECORDER_TRANSCRIBE_TOKEN` | `transcription-worker/src/index.ts:1005` |
| `POST /recall/create-upload` | shared `RECORDER_TRANSCRIBE_TOKEN` | `transcription-worker/src/index.ts:977` |
| `POST /api/v1/webhooks/transcripts` | shared `RecorderTranscribeToken` | `web/app/api/v1/webhooks/transcripts/route.ts:53` |

### 1.4 Where the secret leaks

The release workflow injects the token into the sidecar bundle at build time
(`.github/workflows/release-mac-app.yml:138`). It is then readable in plaintext
inside every shipped app:

```
/Applications/Watchdog Recorder.app/Contents/Resources/sidecar/dist/build-config.js
  → DEFAULT_RECORDER_TRANSCRIBE_TOKEN = "<64-char hex secret>"
```

One `grep` against a downloaded DMG yields a working credential for the
transcription backend, with no per-user attribution, no rate limit, and no way
to revoke it short of rotating for everyone.

### 1.5 Tenancy rides on a body claim, not on identity

Because the token carries no identity, the ingest route learns which workspace
a transcript belongs to from a field in the request body —
`relay_workspace_id`, validated against the Recall workspace integration row
(`transcripts/route.ts:21-23, 39`). The caller asserts its own tenancy. That is
only survivable while the token is secret, and it is not secret.

### 1.6 The client never refreshes for the path that needs it

| Fact | Reference |
| --- | --- |
| `validCredential()` refreshes within 120 s of expiry and signs out cleanly on failure | `RelayAccount.swift:279` |
| It is called from exactly two places, both integrations UI: `connect(provider:)` and `refreshIntegrationStatuses()` | `RelayAccount.swift:192`, `:221` |
| `workspaceCredential` — the value pushed to the sidecar — reads `accessToken` directly with no expiry check | `RelayAccount.swift:52-56` |
| Observed token lifetimes: access ≈ 22 h, refresh ≈ 7 d | Keychain, 2026-08-10 |

Refresh happens only as a side effect of the app launching or the
status/settings view opening. A menu-bar app that simply keeps running past
~22 hours hands the sidecar a dead token.

### 1.7 And the failure destroys the recording

`transcribeAudio` throws a generic `transcribe_failed` (502) for any non-OK
status — `401` included (`brainstorm-pipeline.ts:105`). The retry queue then
spends its whole budget on it: `MAX_RETRIES = 3` with backoff `2^(n-1) × 2min`
(`recording-persistence.ts:28, 69`). Three guaranteed failures, then the entry
is skipped forever. The user sees a recording that did not become a transcript,
and an app that still says they are signed in.

---

## 2 · Target model

The recorder authenticates as **the signed-in user**. Identity, tenancy, and
entitlement all derive from that one token. No shared secret exists in any
client artifact.

**Before**

| Component | Behaviour |
| --- | --- |
| App | Sends a **baked shared secret** (older builds) or a **user token the worker rejects** (current source). |
| Worker | Compares against one env secret. Knows **nothing** about who is calling. |
| Ingest | Same shared secret. Takes the workspace from a **body field the caller supplies**. |

**After**

| Component | Behaviour |
| --- | --- |
| App | Sends the signed-in user's Relay access token, **refreshed on demand** before every recording. |
| Worker | Introspects the token against cloud, gets `{ userId, workspaceId, scopes }`, requires the `recorder:transcribe` scope. Caches the result briefly. |
| Ingest | Receives the **resolved identity** from the worker and writes to that workspace. The body claim is ignored. |

### Why introspection rather than JWT verification

Relay access tokens are opaque (`cld_…`, 50 chars) and stored hashed — they are
not self-describing, so there is nothing to verify locally. Cloud already owns
the validator: `resolveApiTokenSession(accessToken)` hashes the presented
token, looks it up, and honours `revokedAt`
(`web/lib/auth/api-token-store.ts:211`). Introspection reuses that single
source of truth and — unlike a signed JWT — gives us **immediate revocation**,
which is the property that matters after a leak.

The cost is one internal round-trip per transcription. Transcriptions take tens
of seconds; a sub-100 ms lookup, cached, is not a meaningful tax.

---

## 3 · Changes by component

### 3.1 Cloud — token introspection endpoint

New: `POST /api/v1/auth/introspect`, callable only by trusted first-party
services.

- Body: `{ token: string }`. Never accept the token in a query string — it
  lands in access logs.
- Authenticated by a **service credential** held by the worker
  (`TRANSCRIPTION_WORKER_SERVICE_TOKEN`), not by any client. This secret exists
  only in Cloudflare Worker bindings and never in a distributable artifact.
- Implementation delegates to `resolveApiTokenSession()`; adds workspace
  resolution and scope projection.
- Response `200`: `{ active: true, userId, workspaceId, scopes: string[], expiresAt }`.
- Response `200` with `{ active: false }` for unknown, revoked, or expired
  tokens. Never distinguish the three — that difference is an oracle for token
  probing.
- Constant-time comparison for the service credential; rate-limit by service
  identity.

**New scope: `recorder:transcribe`.** Tokens minted through the desktop sign-in
flow carry it. Its presence is what authorises transcription — not merely being
a valid Relay token, so a token minted for another purpose cannot spend
transcription budget.

### 3.2 Cloud — transcription worker

- Replace `isAuthorized(req, env.RECORDER_TRANSCRIBE_TOKEN)` on `/transcribe`
  and `/recall/create-upload` with `authenticateRecorder(req, env)`, returning a
  resolved `RecorderIdentity` or a `401`.
- **Cache** introspection by SHA-256 of the token: positive results for 60 s,
  negative for 10 s. Bounds both the load on cloud and the blast radius of a
  revocation lag.
- Forward the **resolved** `workspaceId` to the ingest call — never the
  client's claim.
- Distinguish failure modes in the response body so the client can act:
  `{ error: 'unauthorized', reason: 'expired' | 'revoked' | 'insufficient_scope' | 'invalid' }`.
  The reason describes the *caller's* token, which the caller already
  possesses, so it leaks nothing.
- Emit `userId` and `workspaceId` on every transcription log line. Today an
  abusive caller is entirely anonymous.

### 3.3 Cloud — transcripts ingest

- Accept the worker's service credential rather than the recorder secret.
- Take `workspaceId` from the worker-resolved identity. **Delete** the code path
  that trusts `relay_workspace_id` from the body.
- Keep the existing Recall-integration validation as a second check: the
  resolved workspace must still own the Recall integration the recording
  arrived through.

### 3.4 Relayscribe — sidecar

- Delete `DEFAULT_RECORDER_TRANSCRIBE_TOKEN` and its import at `server.ts:44`.
  Delete the `DESKTOP_SHARED_TOKEN` fallback in `resolveWorkerToken()` — a dev
  override that reintroduces exactly the shared-secret model we are removing.
- On `401` from `/transcribe` or `/recall/create-upload`: throw a distinct
  `unauthorized` error carrying the worker's `reason`, not a generic
  `transcribe_failed`.
- **Do not consume a retry on `401`.** Park the recording as `needs-auth` and
  leave `retryCount` untouched. An auth failure is not a transient failure and
  must not exhaust a budget meant for network flakiness.
- Resume every `needs-auth` entry immediately when a new credential arrives via
  `setWorkspaceCredential`. Signing back in should drain the queue with no user
  action beyond signing in.
- Expose `GET /auth/state` returning
  `{ state: 'ok' | 'needs-auth', parkedRecordings: number }` so the app can show
  the truth in the menu bar.

### 3.5 Relayscribe — macOS app

- Add `func validWorkspaceCredential() async throws -> WorkspaceCredential`
  that routes through `validCredential()`, so every credential handed to the
  sidecar is refresh-checked.
- Call it **before every recording starts**, not only at launch. This is the
  single change that closes the long-uptime gap.
- Keep the existing `.onChange(of: account.credential)` push so a refresh
  propagates immediately.
- Re-push a freshly refreshed credential when the sidecar reports `needs-auth`;
  if the refresh token is also dead, sign out and surface the existing copy:
  *"Your Relay session expired. Please sign in again."*
- Show `needs-auth` in the menu-bar item — a recorder that cannot transcribe
  must not look idle and healthy.

### 3.6 Release pipeline

- Remove the token injection at `release-mac-app.yml:138`. No build step may
  write a credential into a distributable artifact.
- Add a **release gate**: scan the built `.app` for high-entropy strings and
  fail the build on a hit. This class of defect should never ship twice.

---

## 4 · Migration

Builds already in the field authenticate with the baked secret. Removing it
server-side without a window breaks them; leaving it forever keeps a public
credential live. The order matters, and rotation comes first.

### Phase 0 — Rotate the leaked secret (do first)

The current value is extractable from every DMG ever shipped and must be
treated as public. Rotate `RECORDER_TRANSCRIBE_TOKEN` across the worker, the
ingest route, and the release secret, then ship one build carrying the new
value. This does not fix the model — it limits what an already-public string
can do while the rest lands.

### Phase 1 — Backend accepts both (no client change)

- Ship introspection and `authenticateRecorder` with **dual accept**: a valid
  user token with `recorder:transcribe`, **or** the rotated shared secret.
- Tag every request with `auth_path: "user_token" | "shared_secret"` in logs.
- Old builds keep working; new builds start working for the first time.

### Phase 2 — Ship the client

- Release relayscribe and the Watchdog white-label with §3.4 and §3.5, and with
  no baked secret.
- Verify against production that transcription succeeds on a user token — the
  acceptance test in §7.

### Phase 3 — Drain the old builds

- Watch `auth_path: "shared_secret"` volume. Hold until it is nil for **14
  consecutive days**, or the known holders have upgraded — with a partner-sized
  user base, "who is still on the old build" is a question we can answer by
  asking.
- Add a forced-upgrade notice for versions below the Phase 2 release.

### Phase 4 — Remove the shared secret (terminal state)

- Delete the dual-accept branch and unbind `RECORDER_TRANSCRIBE_TOKEN` from the
  worker and ingest route.
- From here a transcription request without a live, scoped user token cannot
  succeed, and every one that does is attributable to a user and revocable in
  one action.

---

## 5 · Error taxonomy

Each failure gets one cause, one client behaviour, and one sentence the user
can act on.

| Worker response | Sidecar behaviour | What the user sees |
| --- | --- | --- |
| `401 reason: expired` | Park as `needs-auth`, no retry consumed, ask app to refresh | Nothing — the app refreshes and the recording drains automatically |
| `401 reason: revoked` | Park as `needs-auth`, no retry consumed | "Your Relay session expired. Please sign in again." |
| `401 reason: insufficient_scope` | Park, do not retry, log loudly | "This account isn't enabled for transcription. Contact support." |
| `503` Modal unavailable | Retry with existing backoff | "Transcription is temporarily unavailable — we'll retry automatically." |
| `5xx` other | Retry with existing backoff, up to `MAX_RETRIES` | Only surfaced after retries are exhausted |

**Invariant.** A recording is never deleted while its transcript has not been
produced *and* its failure is an auth failure. Today's code unlinks on success
only, which is correct — the change is that a parked recording must not age out
of the manifest while `needs-auth` is the reason it is parked.

---

## 6 · Observability

- **Worker:** per-request `auth_path`, `userId`, `workspaceId`, `reason` on
  rejection. Alert on any `shared_secret` use after Phase 3 begins.
- **Worker:** introspection cache hit rate and p95 latency — the guard against
  introspection becoming the bottleneck.
- **Sidecar:** count of parked `needs-auth` recordings, exported via
  `GET /auth/state`.
- **Alert:** a sustained non-zero parked count across users means the refresh
  path has regressed — that is the alarm for this whole class of bug returning.

---

## 7 · Acceptance

Done means every line below passes. Not "the code is merged".

### Automated

- [ ] Introspection returns `{active: false}` identically for unknown, expired,
      and revoked tokens (no oracle).
- [ ] Worker rejects: no bearer, malformed bearer, valid token without
      `recorder:transcribe`, revoked token.
- [ ] Worker accepts a valid scoped token and forwards the **resolved**
      workspace, not the body claim.
- [ ] Ingest rejects a request whose body `relay_workspace_id` disagrees with
      the resolved identity — regression test for the tenancy bug.
- [ ] Sidecar: `401` parks the recording and leaves `retryCount` at its prior
      value.
- [ ] Sidecar: a new credential drains parked recordings without user action.
- [ ] Sidecar: `503` still consumes a retry — the parked path must not swallow
      genuine transient failures.
- [ ] Swift: a credential within 120 s of expiry is refreshed before a recording
      starts.
- [ ] Swift: a dead refresh token signs out and surfaces the expiry message.
- [ ] Release gate fails a build containing a high-entropy string in the bundle.

### Manual, against production

- [ ] Sign in, record a brainstorm, transcript lands at
      `/recall/recordings/<id>.json` in the correct workspace.
- [ ] The listening persona fires and posts its Slack digest.
- [ ] Revoke the token mid-flight; the next transcription fails with `revoked`
      and the app prompts a sign-in.
- [ ] **The 22-hour test.** Leave the app running past access-token expiry
      without opening any view, then record. It must transcribe. This is the
      exact case that is broken today and no other test covers it.
- [ ] Extract the shipped `.app` and grep it — no credential present.

---

## 8 · Rollback

Each phase reverses independently, which is why they are ordered this way.

- **Phase 1–3:** dual accept is still live, so reverting the worker to
  secret-only restores old and new builds alike. No client action.
- **Phase 4:** re-binding `RECORDER_TRANSCRIBE_TOKEN` and restoring the
  dual-accept branch is the rollback. Keep that commit ready and do not delete
  the rotated secret from the secret store until Phase 4 has soaked for a week.
- **Client:** the previous signed DMG remains downloadable throughout; a bad
  client release is rolled back by re-pointing the release tag.

---

## 9 · Risks & open questions

| Risk | Mitigation |
| --- | --- |
| Introspection becomes a hard dependency of transcription — cloud down means no transcription | 60 s positive cache absorbs brief outages; the audio is already persisted and retried, so an outage delays rather than loses transcripts |
| Access tokens last ~22 h; a long meeting could straddle expiry | Refresh immediately before the transcription request, not only before recording starts |
| The rotated secret leaks again in Phase 0–3, since it still ships | Phase 0 to Phase 4 should be days, not months; the release gate prevents a fresh bake after Phase 2 |
| Old builds silently stop working at Phase 4 | Forced-upgrade notice in Phase 3, gated on observed `shared_secret` volume reaching zero |

### Open questions

- **Who mints `recorder:transcribe`?** Every token from the desktop sign-in
  flow, or an explicit entitlement per workspace? An entitlement gives
  per-customer transcription control; it also adds a provisioning step to
  partner onboarding.
- **Is `/recall/create-upload` on the same clock as `/transcribe`?** Both are
  recorder-facing and both should move together, but meeting-mode recording via
  the Recall SDK has a longer path to verify than brainstorm mode.
- **Self-hosted backends.** The README offers a bring-your-own-backend
  deployment. Introspection assumes reachable Relay cloud; a self-hosted worker
  needs either its own introspection target or a documented shared-secret mode
  with the trade-off stated plainly.

---

## 10 · Sequence

| # | Work | Repo | Blocks |
| --- | --- | --- | --- |
| 1 | Rotate the leaked secret, ship a build carrying it | cloud + relayscribe | everything |
| 2 | `/api/v1/auth/introspect` + `recorder:transcribe` scope | cloud | 3 |
| 3 | `authenticateRecorder` with dual accept + cache + identity logging | cloud | 4, 6 |
| 4 | Ingest takes resolved identity; delete body-claim path | cloud | — |
| 5 | Sidecar: 401 taxonomy, park-not-retry, drain on credential, `/auth/state` | relayscribe | 6 |
| 6 | App: refresh before recording, re-push on `needs-auth`, menu-bar state | relayscribe | 7 |
| 7 | Release pipeline: drop injection, add entropy gate | relayscribe | 8 |
| 8 | Ship client, run §7 manual acceptance including the 22-hour test | both | 9 |
| 9 | Drain window, then remove shared secret | cloud | — |

**Shortest path to a working demo.** Steps 1–3 alone make transcription work
again, because dual accept means a build carrying the rotated secret
authenticates while the user-token path lands behind it. If a partner demo is
needed before the full sequence completes, that is the cut — but it ships a
known-public credential, so it is a bridge, not a destination.
