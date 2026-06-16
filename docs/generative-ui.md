# Generative UI (Beta) — the fully malleable app surface

Relayscribe ships a native Swift recorder. **Generative UI (Beta)** is an
**opt-in** mode in which the user authors the **entire app interface in plain
English**, renders it in a WebView, and keeps iterating on it — regeneratable
anytime. It is **not** a fixed app with sandboxed widgets; the layout and
presentation are unconstrained. The only boundary is the **bridge**: what the
generated UI can *do*.

## Opt-in & default-off

- New native setting: **Generative UI (Beta)** (Settings → Generative UI). Default **OFF**.
- **OFF** → the normal native recorder UI, unchanged.
- **ON** → a "Generative UI (Beta)" button appears in the menu-bar panel; it
  opens the malleable WebView surface. The native recorder keeps running underneath.
- Persisted locally in `UserDefaults` (`relayscribe.generativeUI.enabled`).
  It is a UI-mode flag and is **not** synced to the sidecar settings payload.

## How it works

```
 ┌─────────────── native Swift shell ───────────────┐
 │  menu bar · capture engine · settings · windows  │
 │                                                   │
 │  Generative UI (Beta) window  ──────────────►  WKWebView  ── GET /ui ──┐
 │     toolbar: describe / Generate / Reset / Reload                       │
 └────────────────────────────────────────────────────────────────────────┘
                                                                            │
                           ┌──────────────── TS sidecar ────────────────────┘
                           │  POST /ui/generate  → claude (free-form) → full HTML doc
                           │  persists  workspace/<id>/generated-ui.html
                           │  GET  /ui           → stored doc + <bridge> injected in <head>
                           │  REST app surface   ← window.relayscribe.* calls land here
                           └─────────────────────────────────────────────────
```

1. The user describes any UI ("big record button center, recordings as cards,
   dark, live transcript drawer"). The description is sent to `POST /ui/generate`.
2. The sidecar drives the `claude` CLI (free-form — no JSON schema, no component
   enum, no spec validation) to author a **complete, self-contained HTML
   document** (inline `<style>` + `<script>`).
3. The document is persisted per-workspace at `workspace/<id>/generated-ui.html`.
4. `GET /ui` serves the stored document with the **bridge inlined into `<head>`**
   so `window.relayscribe` is defined before any of the generated app's scripts run.
5. The user iterates ("now add X", "make it light"). The current document is fed
   back to the model so changes are applied in-place. **Reset** discards it and
   returns to the starter.

Generated documents are capped at 512 KB; remote scripts/stylesheets are
discouraged by the system prompt (keep it inline/offline). Rich client-side JS
(DOM, `fetch`, `EventSource`, timers, canvas, …) is fully allowed — the WebView
is the only inherent sandbox.

## The bridge — `window.relayscribe.*`

The bridge is the **action boundary**. Presentation is free; the only things the
UI can *do* are bridge calls. Most methods are thin wrappers over the local
sidecar REST API (same-origin); a few "native" actions hop to the Swift shell via
a `WKScriptMessageHandler`. All methods return Promises unless noted.

| Method | Does | Backed by |
| --- | --- | --- |
| `record(opts?)` / `startRecording(opts?)` | Start a capture now | `POST /recording/test-start` |
| `stop()` / `stopRecording()` | Stop the current capture | `POST /recording/stop` |
| `pause()` | Pause capture (if engine supports it) | `POST /recording/pause` |
| `resume()` | Resume capture | `POST /recording/resume` |
| `status()` | `{ ok, status, sdkReady }` | `GET /status` |
| `state()` | Full live recorder state object | `GET /state` |
| `onState(cb) → unsub` | Subscribe to live state over SSE; `cb(state)` on every change | `GET /state/stream` |
| `listRecordings()` | `[{ sessionId, createdAt, turns }]` | `GET /recordings` |
| `getTranscript(sessionId)` / `openRecording(sessionId)` | `[{ sessionId, speaker, timestamp, text }]` | `GET /recordings/transcript` |
| `search(query)` | Matching transcript rows | `GET /recordings/search` |
| `getSettings()` | Recorder mode + automation settings | `GET /settings` |
| `updateSettings(patch)` | Update mode / automation | `POST /settings` |
| `getConfig()` | App config flags (worker URL set?, ports, …) | `GET /config` |
| `connect(provider)` | Connect `slack` \| `linear` \| `github` (hosted OAuth) | `POST /integrations/:provider/connect` |
| `openSettings()` | Open the native macOS Settings window | native `WKScriptMessageHandler` |
| `regenerate(request, opts?)` | Re-author this whole UI from new English (then reload) | `POST /ui/generate` |
| `reset(opts?)` | Reset back to the starter UI (then reload) | `DELETE /ui` |
| `describe()` | Introspect the callable surface (sync) | — |

`regenerate`/`reset` reload the WebView by default; pass `{ reload: false }` to
suppress. `regenerate` accepts `{ reset: true }` to author from scratch instead
of iterating on the current document.

### Example generated app

```html
<!doctype html>
<html>
<head><title>My Recorder</title></head>
<body>
  <button id="rec">● Record</button>
  <div id="list"></div>
  <input id="ask" placeholder="change this UI…">
  <script>
    document.getElementById('rec').onclick = () => relayscribe.record();
    relayscribe.onState(s => document.title = s.status);
    relayscribe.listRecordings().then(rs =>
      document.getElementById('list').innerHTML =
        rs.map(r => `<div>${r.sessionId} · ${r.turns} turns</div>`).join(''));
    document.getElementById('ask').addEventListener('keydown', e => {
      if (e.key === 'Enter') relayscribe.regenerate(e.target.value);
    });
  </script>
</body>
</html>
```

## Routes (sidecar)

| Route | Purpose |
| --- | --- |
| `GET /ui` | The malleable UI (stored doc, or starter), bridge injected |
| `GET /ui/raw` | Stored document without injection (debug / iterate context) |
| `GET /ui/current` | `{ exists, html, workspace }` for the native shell |
| `GET /bridge.js` | The bridge source (also inlined into `/ui`) |
| `POST /ui/generate` | `{ request, reset? }` → (re)generate, persist, return `{ ok, html }` |
| `DELETE /ui` | Reset to the starter UI |

## Environment

- `RELAYSCRIBE_UI_CLAUDE_BIN` — generator binary (default `claude`)
- `RELAYSCRIBE_UI_CLAUDE_MODEL` / `RELAYSCRIBE_UI_RELAY_MODEL` — generation model (default `sonnet`)
- `RELAYSCRIBE_WORKSPACE_ID` / `RELAYSCRIBE_WORKSPACE_DIR` — where `generated-ui.html` persists

## Safety posture (intentionally minimal)

Per the product direction, this is **maximally malleable + maximally capable**,
gated behind the Beta opt-in. There is **no** fail-closed spec validation, no
component enum, no capability whitelist (the rejected PR #5 approach). The
guardrails are: opt-in + default-off + Beta labeling; the bridge bounds *actions*
(not presentation); generated docs are size-capped and the model is told to keep
assets inline/offline. The WebView itself is the boundary.
