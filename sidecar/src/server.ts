import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  exportFilename,
  formatTranscript,
  getTranscript,
  isExportFormat,
  listTranscripts,
  saveTranscript,
  type TranscriptRecord,
} from './transcript-store';
import {
  BrainstormPipelineError,
  type BrainstormPipelineStore,
  processBrainstormAudio,
  runBrainstormPipelineWithPersistence,
} from './brainstorm-pipeline';
import {
  bumpRetryCount,
  getRetryableEntries,
  markFailed,
  markTranscribed,
  persistAudio,
  RETRY_INTERVAL_MS,
  type RecordingEntry,
} from './recording-persistence';
import {
  normalizeRelayWorkspaceContext,
  type RelayWorkspaceContext,
} from './relay-workspace';
import {
  normalizeLanguage,
  normalizeMode,
  normalizeRecorderSettings,
  parseBoolean,
  type RecorderSettings,
} from './recorder-settings';
import { createUiRoutes } from './ui-routes';
import {
  DEFAULT_RECALL_API_URL,
  DEFAULT_RECORDER_TRANSCRIBE_TOKEN,
  DEFAULT_RELAY_CONNECT_URL,
  DEFAULT_TRANSCRIPTS_INGEST_URL,
  DEFAULT_WORKER_URL,
} from './build-config';

// Declared early so process.on handlers below can reference it.
// The Recall Desktop SDK binary can't run in headless/terminal contexts —
// it needs a real macOS .app bundle with screen-capture permissions.
let sdkReady = false;

// Suppress SDK async crashes so the HTTP layer stays alive for smoke-testing.
process.on('uncaughtException', (err) => {
  if (
    err.message.includes('Desktop SDK') ||
    err.message.includes('not started') ||
    err.message.includes('no longer accepting commands')
  ) {
    sdkReady = false;
    console.warn('[sidecar] SDK unavailable (headless/no desktop perms):', err.message);
    return;
  }
  throw err;
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (
    msg.includes('Desktop SDK') ||
    msg.includes('not started') ||
    msg.includes('no longer accepting commands')
  ) {
    sdkReady = false;
    console.warn('[sidecar] SDK rejection (headless):', msg);
    return;
  }
  console.error('[sidecar] unhandled rejection:', reason);
});

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.SIDECAR_PORT ?? '3700', 10);
// Config resolves from env first (set by the app/.env at runtime), then falls
// back to the values baked into build-config.ts at release time. The committed
// build-config.ts ships empty/dev defaults; the release workflow overwrites it
// with the packaged worker/connect URLs.
const WORKER_URL = (process.env.WORKER_URL ?? DEFAULT_WORKER_URL).replace(/\/+$/, '');
const RECALL_API_URL = process.env.RECALL_API_URL ?? DEFAULT_RECALL_API_URL ?? 'https://us-west-2.recall.ai';
const TRANSCRIPTS_INGEST_URL = (process.env.TRANSCRIPTS_INGEST_URL ?? DEFAULT_TRANSCRIPTS_INGEST_URL).trim();
// Hosted OAuth connect endpoint template (supports a {provider} placeholder).
// Seeded at launch via the RELAY_CONNECT_URL env var; falls back to WORKER_URL.
const RELAY_CONNECT_URL = (process.env.RELAY_CONNECT_URL ?? DEFAULT_RELAY_CONNECT_URL).trim();

const INSTANCE_ID = process.env.RELAYSCRIBE_SIDECAR_INSTANCE_ID ?? 'unknown';

interface RuntimeCredential { accessToken: string; workspaceId: string; apiUrl: string }

let runtimeCredential: RuntimeCredential = {
  accessToken: process.env.RELAY_ACCESS_TOKEN ?? '',
  workspaceId: process.env.RELAY_WORKSPACE_ID ?? '',
  apiUrl: (process.env.RELAY_API_URL ?? '').replace(/\/+$/, ''),
};

// Transcription requires a signed-in Relay credential. DESKTOP_SHARED_TOKEN
// is a local dev override only — never compiled into release builds.
function resolveWorkerToken(): string {
  if (runtimeCredential.accessToken) return runtimeCredential.accessToken;
  if (process.env.DESKTOP_SHARED_TOKEN) return process.env.DESKTOP_SHARED_TOKEN;
  return '';
}

let recorderSettings: RecorderSettings = {
  mode: normalizeMode(process.env.RELAYSCRIBE_MODE),
  language: normalizeLanguage(process.env.RELAYSCRIBE_LANGUAGE),
  automation_settings: {
    create_linear_issues: parseBoolean(process.env.RELAYSCRIBE_CREATE_LINEAR_ISSUES),
    create_github_issues: parseBoolean(process.env.RELAYSCRIBE_CREATE_GITHUB_ISSUES),
    dispatch_enabled: parseBoolean(process.env.RELAYSCRIBE_DISPATCH_ENABLED),
  },
};
let relayWorkspaceContext: RelayWorkspaceContext = normalizeRelayWorkspaceContext({
  relay_workspace_id:
    process.env.RELAYSCRIBE_RELAY_WORKSPACE_ID ?? process.env.RELAY_WORKSPACE_ID,
});

// Generative UI (Beta) opt-in gate. OFF until the native app pushes the user's
// opt-in via POST /generative-ui (see RecordingStore.syncGenerativeUI). When
// off, createUiRoutes serves an inert /ui and 403s the rest of the /ui* surface.
let generativeUiEnabled = parseBoolean(process.env.RELAYSCRIBE_GENERATIVE_UI_ENABLED);

// Where the malleable UI document is persisted (per workspace). The recordings
// dir is the same root the recording-persistence layer uses; ui-routes derives
// the workspace dir from it (recordingsDir/../workspace/<workspaceId>).
const RECORDINGS_DIR =
  process.env.RELAYSCRIBE_RECORDINGS_DIR ??
  (process.platform === 'darwin'
    ? `${process.env.HOME ?? ''}/Library/Application Support/Relayscribe/recordings`
    : `${process.cwd()}/.relayscribe/recordings`);

// ── State ─────────────────────────────────────────────────────────────────────
type RecordingStatus =
  | 'idle'
  | 'meeting-detected'
  | 'recording'
  | 'uploading'
  | 'error';

interface SidecarState {
  status: RecordingStatus;
  windowId?: string;
  meetingTitle?: string;
  uploadId?: string;
  recordingId?: string;
  startedAt?: number;
  errorMessage?: string;
}

let state: SidecarState = { status: 'idle' };

// SSE subscribers
const sseClients = new Set<(data: string) => void>();

function setState(next: SidecarState) {
  state = next;
  const json = JSON.stringify(state);
  for (const send of sseClients) {
    send(json);
  }
  console.log(`[sidecar] state → ${next.status}`);
}

function settingsPayload(): RecorderSettings {
  return {
    mode: recorderSettings.mode,
    language: recorderSettings.language,
    automation_settings: { ...recorderSettings.automation_settings },
  };
}

// ── Recall SDK ────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RecallAiSdk = require('@recallai/desktop-sdk');

interface FileLike {
  name?: string;
  type?: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function firstBodyValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function isFileLike(value: unknown): value is FileLike {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as FileLike).arrayBuffer === 'function',
  );
}

async function createUpload(): Promise<{ id: string; upload_token: string; recording_id?: string }> {
  if (!WORKER_URL) throw new Error('WORKER_URL not configured');
  const token = resolveWorkerToken();
  if (!token) throw new Error('No auth credential — sign in to Relay in the app settings');

  // Contract: POST /recall/create-upload, Bearer token, body {}
  // Response: { id: string, upload_token: string, recording_id?: string }
  const res = await fetch(`${WORKER_URL}/recall/create-upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`create-upload ${res.status}: ${body}`);
  }
  return res.json() as Promise<{ id: string; upload_token: string; recording_id?: string }>;
}

async function fireWebhook(recordingId: string): Promise<void> {
  if (!WORKER_URL) return;
  try {
    const token = resolveWorkerToken();
    const res = await fetch(`${WORKER_URL}/recall/webhook`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ event: 'sdk_upload.complete', data: { recording_id: recordingId } }),
    });
    console.log(`[sidecar] webhook fired recording_id=${recordingId} status=${res.status}`);
  } catch (err) {
    console.error('[sidecar] webhook fire failed:', err);
  }
}

async function startRecording(windowId: string, meetingTitle?: string) {
  setState({ status: 'meeting-detected', windowId, meetingTitle });
  try {
    const { id, upload_token, recording_id } = await createUpload();
    if (sdkReady) {
      RecallAiSdk.startRecording({ windowId, uploadToken: upload_token });
    } else {
      console.warn('[sidecar] SDK not ready — simulating recording state (headless test mode)');
    }
    setState({ status: 'recording', windowId, meetingTitle, uploadId: id, recordingId: recording_id, startedAt: Date.now() });
    console.log(`[sidecar] recording started windowId=${windowId} uploadId=${id} recordingId=${recording_id ?? '(none)'}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[sidecar] startRecording error:', msg);
    setState({ status: 'error', errorMessage: msg });
  }
}

function stopRecording() {
  if (state.status !== 'recording') return;
  try {
    RecallAiSdk.stopRecording();
    console.log('[sidecar] recording stopped');
  } catch (err) {
    console.error('[sidecar] stopRecording error:', err);
  }
  // In headless mode the SDK never emits recording-ended, so the state would
  // stay stuck at 'recording' forever. Force the transition here so the UI
  // flips immediately regardless of whether SDK events fire.
  if (!sdkReady && state.status === 'recording') {
    setState({ status: 'idle' });
  }
}

function initSdk() {
  try {
    RecallAiSdk.init({
      apiUrl: RECALL_API_URL,
      acquirePermissionsOnStartup: ['screen-capture', 'microphone'],
    });
    sdkReady = true;
    console.log(`[sidecar] Recall Desktop SDK ready (${RECALL_API_URL})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[sidecar] Recall Desktop SDK unavailable (headless env?): ${msg}`);
    console.warn('[sidecar] HTTP layer running; recording disabled until app is launched as .app bundle');
    return;
  }

  RecallAiSdk.addEventListener(
    'meeting-detected',
    (evt: { window: { id: string; title?: string } }) => {
      console.log('[sidecar] meeting-detected', evt.window);
      void startRecording(evt.window.id, evt.window.title);
    },
  );

  RecallAiSdk.addEventListener('recording-ended', () => {
    const uploadId = state.uploadId;
    if (uploadId) {
      setState({ status: 'uploading', uploadId });
    }
  });

  RecallAiSdk.addEventListener('upload-complete', () => {
    setState({ status: 'idle' });
    console.log('[sidecar] upload complete → idle');
  });

  RecallAiSdk.addEventListener('error', (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[sidecar] sdk error:', msg);
    setState({ status: 'error', errorMessage: msg });
  });

  RecallAiSdk.addEventListener('permission-status', (evt: { permission: string; status: string }) => {
    console.log(`[sidecar] permission-status ${evt.permission}=${evt.status}`);
  });

  RecallAiSdk.addEventListener('permissions-granted', () => {
    console.log('[sidecar] permissions-granted — Screen Recording is now active');
  });
}

// ── Hosted integration connect ─────────────────────────────────────────────────
type RelayIntegrationProvider = 'slack' | 'linear' | 'github';
const RELAY_INTEGRATION_PROVIDERS = new Set<RelayIntegrationProvider>(['slack', 'linear', 'github']);

function normalizeRelayIntegrationProvider(provider: string): RelayIntegrationProvider {
  const normalized = provider.trim().toLowerCase() as RelayIntegrationProvider;
  if (!RELAY_INTEGRATION_PROVIDERS.has(normalized)) {
    throw new Error('Unsupported Relay integration provider');
  }
  return normalized;
}

function providerConfigKey(provider: RelayIntegrationProvider): string {
  return `${provider}-relay`;
}

function connectEndpointFor(provider: RelayIntegrationProvider): string {
  if (RELAY_CONNECT_URL) {
    return RELAY_CONNECT_URL.replace(/\{provider\}/g, encodeURIComponent(provider));
  }
  if (WORKER_URL) {
    return `${WORKER_URL}/integrations/${encodeURIComponent(provider)}/connect`;
  }
  throw new Error('RELAY_CONNECT_URL or WORKER_URL must be configured to connect integrations.');
}

function assertBrowserUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Hosted connect endpoint did not return an OAuth URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('Hosted connect endpoint returned an invalid OAuth URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Refusing to open unsupported OAuth URL scheme: ${parsed.protocol || '(none)'}`);
  }
  return parsed.href;
}

async function requestHostedIntegrationConnect(provider: string): Promise<{
  success: boolean;
  provider?: RelayIntegrationProvider;
  status?: 'awaiting-user';
  authUrl?: string;
  sessionId?: string;
  error?: string;
}> {
  const normalizedProvider = normalizeRelayIntegrationProvider(provider);
  const endpoint = connectEndpointFor(normalizedProvider);
  const workerToken = resolveWorkerToken();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...(workerToken ? { authorization: `Bearer ${workerToken}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      provider: normalizedProvider,
      integration: normalizedProvider,
      allowedIntegrations: [providerConfigKey(normalizedProvider)],
      requestedBackend: 'nango',
      source: 'relayscribe',
    }),
  });
  const raw = await res.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    payload = {};
  }
  if (!res.ok) {
    const message =
      typeof payload.error === 'string'
        ? payload.error
        : typeof payload.message === 'string'
          ? payload.message
          : raw || `Hosted connect endpoint returned ${res.status}.`;
    throw new Error(message);
  }
  const authUrl = assertBrowserUrl(payload.authUrl ?? payload.connectLink ?? payload.connectUrl ?? payload.url);
  const sessionId =
    typeof payload.sessionId === 'string'
      ? payload.sessionId
      : typeof payload.sessionToken === 'string'
        ? payload.sessionToken
        : typeof payload.token === 'string'
          ? payload.token
          : typeof payload.connectionId === 'string'
            ? payload.connectionId
            : undefined;
  return {
    success: true,
    provider: normalizedProvider,
    status: 'awaiting-user',
    authUrl,
    ...(sessionId ? { sessionId } : {}),
  };
}

// ── HTTP server ───────────────────────────────────────────────────────────────
export const app = new Hono();

app.get('/health', (c) =>
  c.json({ app: 'relayscribe-sidecar', sidecarApiVersion: 2, instanceId: INSTANCE_ID, ok: true, status: state.status, sdkReady }),
);

app.get('/state', (c) => c.json(state));

// Server-sent events — Swift shell subscribes here for live updates
app.get('/state/stream', (c) => {
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');
  return stream(c, async (s) => {
    await s.write('retry: 1000\n\n');
    // Send current state immediately
    await s.write(`data: ${JSON.stringify(state)}\n\n`);

    const send = async (data: string) => {
      await s.write(`data: ${data}\n\n`);
    };
    sseClients.add(send);

    // Keep alive
    const keepAlive = setInterval(() => {
      void s.write(': keepalive\n\n');
    }, 15_000);

    // Clean up when client disconnects
    await new Promise<void>((resolve) => {
      s.onAbort(() => {
        sseClients.delete(send);
        clearInterval(keepAlive);
        resolve();
      });
    });
  });
});

app.get('/settings', (c) => c.json(settingsPayload()));

app.post('/settings', async (c) => {
  const body = await c.req.json().catch(() => null);
  recorderSettings = normalizeRecorderSettings(body);
  console.log(
    `[sidecar] settings updated mode=${recorderSettings.mode} automation=${JSON.stringify(recorderSettings.automation_settings)}`,
  );
  return c.json({ ok: true, ...settingsPayload() });
});

// Native app pushes the Generative UI (Beta) opt-in here. Gates the /ui* surface.
app.post('/generative-ui', async (c) => {
  const body = await c.req.json<{ enabled?: unknown }>().catch(() => null);
  // The native app sends a JSON boolean; tolerate string forms too.
  generativeUiEnabled =
    typeof body?.enabled === 'boolean' ? body.enabled : parseBoolean(String(body?.enabled ?? ''));
  console.log(`[sidecar] generative UI ${generativeUiEnabled ? 'enabled' : 'disabled'}`);
  return c.json({ ok: true, enabled: generativeUiEnabled });
});

app.post('/relay/workspace', async (c) => {
  const body = await c.req.json().catch(() => null);
  relayWorkspaceContext = normalizeRelayWorkspaceContext(body);
  console.log(`[sidecar] relay workspace context updated hasWorkspace=${Boolean(relayWorkspaceContext.relay_workspace_id)}`);
  return c.json({ ok: true, hasRelayWorkspace: Boolean(relayWorkspaceContext.relay_workspace_id) });
});

const persistenceStore: BrainstormPipelineStore = {
  persistAudio: (audio, opts) =>
    persistAudio(audio, {
      contentType: opts.contentType,
      filename: opts.filename,
      relayWorkspaceContext: opts.relayWorkspaceId ? { relay_workspace_id: opts.relayWorkspaceId } : {},
      settings: opts.settings,
    }),
  markTranscribed,
  markFailed,
};

app.post('/brainstorm/upload', async (c) => {
  try {
    if (recorderSettings.mode !== 'brainstorm') {
      return c.json({ ok: false, error: 'Switch to Brainstorm mode before recording.' }, 409);
    }
    const body = await c.req.parseBody().catch(() => null);
    const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const file = firstBodyValue(input.file ?? input.audio);
    if (!isFileLike(file)) {
      return c.json({ ok: false, error: 'Multipart audio file is required.' }, 400);
    }
    const audio = new Uint8Array(await file.arrayBuffer());
    const result = await runBrainstormPipelineWithPersistence(
      {
        audio,
        contentType: file.type || 'application/octet-stream',
        filename: file.name,
        workerUrl: WORKER_URL,
        transcribeToken: resolveWorkerToken(),
        transcriptsIngestUrl: TRANSCRIPTS_INGEST_URL,
        relayWorkspaceContext,
        settings: settingsPayload(),
      },
      persistenceStore,
    );
    console.log(`[sidecar] brainstorm uploaded id=${result.id} transcript_chars=${result.transcript.length}`);
    return c.json({ ok: true, id: result.id, transcript: result.transcript });
  } catch (err) {
    const status = (err instanceof BrainstormPipelineError ? err.statusCode : 500) as ContentfulStatusCode;
    const code = err instanceof BrainstormPipelineError ? err.code : 'brainstorm_upload_failed';
    const error = err instanceof Error ? err.message : String(err);
    console.error('[sidecar] brainstorm upload error:', error);
    return c.json({ ok: false, error, code }, status);
  }
});

app.post('/recording/stop', (c) => {
  const recordingId = state.recordingId;
  stopRecording();
  // When the SDK is not running (headless / no Screen Recording permission),
  // fire the pipeline webhook directly so the chain still runs after Stop.
  if (!sdkReady && recordingId && WORKER_URL) {
    void fireWebhook(recordingId);
  }
  return c.json({ ok: true, sdkReady, recordingId });
});

// Manual trigger for testing (simulates meeting-detected event)
app.post('/recording/test-start', async (c) => {
  interface TestStartBody { windowId?: string; meetingTitle?: string }
  const body = await c.req.json<TestStartBody>().catch((): TestStartBody => ({}));
  const windowId = body.windowId ?? 'test-window-001';
  const meetingTitle = body.meetingTitle ?? 'Test Meeting';
  await startRecording(windowId, meetingTitle);
  return c.json({ ok: true, windowId, meetingTitle });
});

app.post('/permission/screen-recording', async (c) => {
  if (!sdkReady) return c.json({ ok: false, error: 'SDK not ready' }, 503);
  try {
    await RecallAiSdk.requestPermission('screen-capture');
    return c.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 500);
  }
});

app.post('/relay/auth-token', async (c) => {
  interface AuthTokenBody { access_token?: string; workspace_id?: string; api_url?: string }
  const body = await c.req.json<AuthTokenBody>().catch((): AuthTokenBody => ({}));
  if (!body.access_token) return c.json({ ok: false, error: 'access_token is required' }, 400);
  runtimeCredential = {
    accessToken: body.access_token,
    workspaceId: body.workspace_id ?? runtimeCredential.workspaceId,
    apiUrl: (body.api_url ?? runtimeCredential.apiUrl).replace(/\/+$/, ''),
  };
  console.log(`[sidecar] relay auth-token updated workspaceId=${runtimeCredential.workspaceId}`);
  return c.json({ ok: true });
});

app.post('/integrations/:provider/connect', async (c) => {
  try {
    const result = await requestHostedIntegrationConnect(c.req.param('provider'));
    return c.json(result);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error }, 500);
  }
});

app.get('/config', (c) =>
  c.json({
    hasWorkerUrl: Boolean(WORKER_URL),
    hasRelayToken: Boolean(runtimeCredential.accessToken),
    hasDeprecatedSharedToken: Boolean(process.env.DESKTOP_SHARED_TOKEN),
    workspaceId: runtimeCredential.workspaceId || undefined,
    recallApiUrl: RECALL_API_URL,
    relayConnectUrl: RELAY_CONNECT_URL,
    port: PORT,
  }),
);

// ── Transcript endpoints ──────────────────────────────────────────────────────
// Called by the cloud worker after processing completes to persist the
// transcript + summary locally so the desktop app can display them.
app.post('/recall/transcript', async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body.recording_id !== 'string' || typeof body.transcript !== 'string') {
    return c.json({ ok: false, error: 'recording_id (string) and transcript (string) are required' }, 400);
  }
  const record: TranscriptRecord = {
    recording_id: body.recording_id,
    title: typeof body.title === 'string' ? body.title : undefined,
    transcript: body.transcript,
    summary: typeof body.summary === 'string' ? body.summary : undefined,
    duration_seconds: typeof body.duration_seconds === 'number' ? body.duration_seconds : undefined,
    started_at: typeof body.started_at === 'string' ? body.started_at : undefined,
    saved_at: new Date().toISOString(),
  };
  try {
    saveTranscript(record);
    console.log(`[sidecar] transcript saved recording_id=${record.recording_id} chars=${record.transcript.length}`);
    return c.json({ ok: true, recording_id: record.recording_id });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[sidecar] transcript save error:', error);
    return c.json({ ok: false, error }, 500);
  }
});

app.get('/transcripts', (c) => c.json({ transcripts: listTranscripts() }));

app.get('/transcripts/:id', (c) => {
  const record = getTranscript(c.req.param('id'));
  if (!record) return c.json({ error: 'not found' }, 404);
  return c.json(record);
});

// Export a single transcript as a downloadable .txt or .md document. JSON is
// already available from GET /transcripts/:id, so this covers the human-readable
// formats. ?format defaults to txt.
app.get('/transcripts/:id/export', (c) => {
  const format = c.req.query('format') ?? 'txt';
  if (!isExportFormat(format)) {
    return c.json({ error: 'format must be txt or md' }, 400);
  }
  const record = getTranscript(c.req.param('id'));
  if (!record) return c.json({ error: 'not found' }, 404);

  const body = formatTranscript(record, format);
  const contentType = format === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
  return c.body(body, 200, {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${exportFilename(record)}.${format}"`,
  });
});

// ── Retry queue ───────────────────────────────────────────────────────────────
async function retryFailedRecordings(): Promise<void> {
  let entries: RecordingEntry[];
  try {
    entries = await getRetryableEntries();
  } catch (err) {
    console.warn('[retry] could not read manifest:', err instanceof Error ? err.message : err);
    return;
  }
  if (entries.length === 0) return;
  console.log(`[retry] found ${entries.length} failed recording(s) to retry`);

  const { readFile } = await import('node:fs/promises');
  for (const entry of entries) {
    const attempt = await bumpRetryCount(entry.id).catch(() => 0);
    console.log(`[retry] id=${entry.id} attempt=${attempt}`);
    try {
      const audio = new Uint8Array(await readFile(entry.audioPath));
      await processBrainstormAudio({
        audio,
        contentType: entry.contentType,
        filename: entry.filename,
        workerUrl: WORKER_URL,
        transcribeToken: resolveWorkerToken(),
        transcriptsIngestUrl: TRANSCRIPTS_INGEST_URL,
        relayWorkspaceContext: { relay_workspace_id: entry.relayWorkspaceId },
        settings: entry.settings ?? settingsPayload(),
      });
      await markTranscribed(entry.id);
      console.log(`[retry] success id=${entry.id}`);
    } catch (err) {
      await markFailed(entry.id).catch(() => {});
      console.error(`[retry] failed id=${entry.id}:`, err instanceof Error ? err.message : err);
    }
  }
}

function startRetryQueue(): void {
  // Run once on startup to catch recordings that failed in a previous session
  void retryFailedRecordings();
  setInterval(() => { void retryFailedRecordings(); }, RETRY_INTERVAL_MS);
}

// ── Generative UI (Beta) routes ────────────────────────────────────────────────
// Mount the malleable-UI sub-app at root so the native shell can hit /ui,
// /ui/generate, /ui/status, etc. at the sidecar base URL. The opt-in gate reads
// the live generativeUiEnabled flag (toggled via POST /generative-ui), so the
// whole surface stays inert until the user enables it in the app. Generation,
// model, and timeouts fall back to ui-routes' own env-driven defaults.
app.route('/', createUiRoutes({
  recordingsDir: RECORDINGS_DIR,
  isEnabled: () => generativeUiEnabled,
}));

// ── Start ─────────────────────────────────────────────────────────────────────
initSdk();
startRetryQueue();

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[sidecar] listening on http://127.0.0.1:${info.port}`);
  if (!WORKER_URL) console.warn('[sidecar] WARNING: WORKER_URL is not set');
  if (!resolveWorkerToken()) console.warn('[sidecar] WARNING: No auth credential — set RELAY_ACCESS_TOKEN or DESKTOP_SHARED_TOKEN');
});
