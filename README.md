# Relayscribe

Native macOS menu-bar recorder for Relay. The app records meeting audio locally through the Recall Desktop SDK, so no bot joins the call.

## Architecture

Relayscribe is a Swift app with a local TypeScript sidecar:

1. `Relayscribe.app` launches as a tray-only macOS app using SwiftUI `MenuBarExtra`.
2. `SidecarManager` starts the embedded Node sidecar from `Contents/Resources/sidecar`.
3. The sidecar runs a Hono HTTP server and initializes `@recallai/desktop-sdk`.
4. In Meeting mode, when the Recall Desktop SDK detects a meeting window, the sidecar calls the Relay backend to mint an SDK upload.
5. The sidecar passes the returned upload token to `RecallAiSdk.startRecording`.
6. Recall sends `sdk_upload.complete` to the cloud transcription worker, which transcribes the audio and forwards the transcript to the ingest endpoint.
7. meeting-actions watches `/recall/recordings/**` and files the Linear issues plus Slack digest.
8. In Brainstorm mode, the native menu-bar UI records microphone audio directly, uploads it to the sidecar, and the sidecar posts the transcript through the same transcript ingest endpoint with `mode=brainstorm`.

The Recall API key never lives on the desktop. The desktop app only uses `WORKER_URL` and `RECORDER_TRANSCRIBE_TOKEN` to call the cloud worker's upload-minting and `/transcribe` endpoints.
Integration Connect also stays server-owned: the sidecar asks the hosted backend for a Relay/Nango OAuth URL and the native shell opens that URL in the user's default browser. The distributed app never shells out to `relayfile` and does not contain OAuth client secrets.

Release builds are customer-zero-config: the signed app is compiled with the production worker URL, the production Recall API URL, and the design-partner shared recorder token. Local `.env` values still override those defaults for development and smoke tests.

Release builds are customer-zero-config: the signed app is compiled with the production worker URL, the production Recall API URL, and the design-partner shared recorder token. Local `.env` values still override those defaults for development and smoke tests.

## Requirements

- macOS 14+
- Node.js 18+
- Swift 5.9+
- A stage/dev Relay backend with `RECORDER_TRANSCRIBE_TOKEN` configured if you are overriding the packaged defaults locally

## Configure

For local sidecar tests or development overrides, create `sidecar/.env`:

```bash
WORKER_URL=https://<transcription-worker-url>
RECORDER_TRANSCRIBE_TOKEN=<shared desktop token>
RECALL_API_URL=https://us-west-2.recall.ai
RELAY_CONNECT_URL=https://<hosted-backend>/integrations/{provider}/connect
TRANSCRIPTS_INGEST_URL=https://agentrelay.com/cloud/api/v1/webhooks/transcripts
```

Do not commit `.env` files or tokens.

Production release builds inject these defaults during GitHub Actions:

```bash
WORKER_URL=https://transcription.agentrelay.com
RECALL_API_URL=https://us-west-2.recall.ai
RELAY_CONNECT_URL=https://transcription.agentrelay.com/integrations/{provider}/connect
RECORDER_TRANSCRIBE_TOKEN=<from GitHub secret RECORDER_TRANSCRIBE_TOKEN>
TRANSCRIPTS_INGEST_URL=https://agentrelay.com/cloud/api/v1/webhooks/transcripts
```

The release workflow verifies `https://transcription.agentrelay.com/health` before compiling the sidecar. If the stable worker hostname is not deployed, the release fails rather than shipping a notarized app with a fragile generated URL.

## Build

```bash
make sidecar-check
make sidecar
make test
make dmg
```

Outputs:

- `dist/Relayscribe.app`
- `dist/Relayscribe.dmg`

Launch the app:

```bash
open dist/Relayscribe.app
```

## Smoke Tests

Sidecar HTTP lifecycle:

```bash
cd sidecar
npm run test:e2e
```

Desktop-to-backend upload minting:

```bash
cd sidecar
WORKER_URL=https://<transcription-worker-url> \
RECORDER_TRANSCRIBE_TOKEN=<shared desktop token> \
npm run test:create-upload
```

## Backend Contract

The sidecar calls:

```http
POST <WORKER_URL>/recall/create-upload
Authorization: Bearer <RECORDER_TRANSCRIBE_TOKEN>
Content-Type: application/json

{
  "source": {
    "relay_workspace_id": "rw_..."
  }
}
```

When no Relay workspace is signed in, the sidecar omits `source` entirely.

The sidecar requires this response shape:

```json
{
  "id": "sdk-upload-id",
  "upload_token": "recall-upload-token"
}
```

Recall also returns fields such as `recording_id`, `status`, `created_at`, and `metadata`; the desktop client ignores those extras.

For Brainstorm mode, the native app calls:

```http
POST http://127.0.0.1:<sidecar-port>/brainstorm/upload
Content-Type: multipart/form-data

file=<audio/m4a>
```

The sidecar requires a signed-in Relay workspace before it transcribes. It then calls:

```http
POST <WORKER_URL>/transcribe
Authorization: Bearer <RECORDER_TRANSCRIBE_TOKEN>
Content-Type: audio/mp4
```

After transcription, the sidecar posts a granola-shaped note to `TRANSCRIPTS_INGEST_URL`:

```json
{
  "id": "not_brainstorm1781510400000abcd1234",
  "object": "note",
  "title": "Brainstorm 2026-06-15",
  "created_at": "2026-06-15T08:00:00.000Z",
  "updated_at": null,
  "web_url": "",
  "participants": [],
  "transcript_text": "Build the native brainstorm path.",
  "summary_text": "Build the native brainstorm path.",
  "mode": "brainstorm",
  "source": {
    "provider": "recall",
    "type": "relayscribe",
    "mode": "brainstorm",
    "recording_id": "brainstorm-1781510400000-abcd1234",
    "bot_id": null,
    "relay_workspace_id": "rw_..."
  },
  "metadata": {
    "capture": "native-mic",
    "client": "relayscribe",
    "version": "1.3.0"
  }
}
```

For integration OAuth, the sidecar calls:

```http
POST <RELAY_CONNECT_URL>
Authorization: Bearer <RECORDER_TRANSCRIBE_TOKEN>
Content-Type: application/json

{
  "provider": "slack",
  "integration": "slack",
  "allowedIntegrations": ["slack-relay"],
  "requestedBackend": "nango",
  "source": "relayscribe"
}
```

`{provider}` in `RELAY_CONNECT_URL` is replaced with `slack`, `linear`, or `github`. If `RELAY_CONNECT_URL` is not set, the sidecar falls back to `<WORKER_URL>/integrations/{provider}/connect`.

The hosted endpoint must create the Nango/Relay connect session server-side and return one of `authUrl`, `connectLink`, `connectUrl`, or `url` with an `http` or `https` URL. Optional `sessionId`, `sessionToken`, `token`, or `connectionId` fields are passed through for diagnostics.

## Project Layout

```text
Relayscribe/
  AppBundle/Info.plist       macOS app bundle metadata
  Main/                      executable entry point
  Sources/                   SwiftUI app, sidecar process manager, state store
  Tests/                     Swift tests
sidecar/
  src/server.ts              Hono server and Recall Desktop SDK integration
  scripts/test-create-upload.ts
  scripts/test-sidecar-e2e.sh
Makefile                     sidecar, Swift, .app, and .dmg build targets
```

## Notes

- The packaged app embeds the compiled sidecar under `Contents/Resources/sidecar`.
- `SidecarManager` launches the sidecar with that directory as the working directory, so `.env` files can still override the compiled defaults during development or support diagnostics.
- `LSUIElement` is enabled in `Info.plist`, so the app appears in the menu bar rather than the Dock.
