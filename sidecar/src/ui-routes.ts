/**
 * Malleable (Generative UI Beta) routes.
 *
 * The user authors the ENTIRE app UI in plain English. The model returns a
 * COMPLETE, self-contained HTML document (HTML + CSS + JS) — free-form, no
 * component enum, no spec schema, no fail-closed validation. We persist that
 * document per-workspace and serve it in the WebView with the window.relayscribe.*
 * bridge injected into <head>. The only boundary is the bridge: it is what the
 * generated UI can DO. Presentation is unconstrained.
 *
 * Routes:
 *   GET    /ui            → the malleable UI (stored doc, or a starter), bridge-injected
 *   GET    /ui/raw        → the stored document WITHOUT injection (debug / iterate context)
 *   GET    /ui/current    → { exists, html, workspace } metadata for the native shell
 *   GET    /ui/status     → { state: idle|generating|error, exists, jobId?, elapsedMs?, error? }
 *   GET    /bridge.js     → the bridge source (also inlined into /ui)
 *   POST   /ui/generate   → { request, reset?, async? }
 *                           sync (default): persists and returns { ok, html }
 *                           async (async:true): returns 202 { jobId, state:'generating' } immediately;
 *                           poll /ui/status until state is 'idle' or 'error', then reload /ui
 *   DELETE /ui            → reset to the starter UI
 */
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { harnessGenerate, BrokerUnavailableError } from './harness-generate';

type GenerateFn = (
  request: string,
  context: { workspaceId: string; currentHtml: string | null; systemPrompt: string },
) => Promise<string>;

export interface UiRouteOptions {
  recordingsDir: string;
  workspaceDir?: string;
  workspaceId?: string;
  claudeBin?: string;
  claudeModel?: string;
  generationTimeoutMs?: number;
  /** Injectable generator (tests / alternate backends). Returns a full HTML document. */
  generate?: GenerateFn;
  /**
   * Opt-in gate. The whole Generative UI (Beta) surface is OFF unless the user
   * enabled it natively. When this returns false, `/ui` serves an inert page
   * (no bridge, no stored doc) and every other `/ui*` route is unavailable — so
   * a user who never opted in has zero generative-UI surface on localhost.
   * Defaults to always-enabled when omitted (used by unit tests).
   */
  isEnabled?: () => boolean;
}

// Generation runs through @agent-relay/harness-driver — one local CLI agent
// spawned via the local broker authors the document and submits it back.
// Default-model authoring routinely exceeds 5min, so the cap is generous; the
// worker is hard-killed on timeout (no orphan). Async/poll #21 fixes client UX.
const DEFAULT_GENERATION_TIMEOUT_MS = 1_200_000;
const MAX_REQUEST_CHARS = 4000;
const MAX_DOC_BYTES = 512 * 1024; // generated documents are capped at 512 KB

function defaultWorkspaceId(): string {
  return process.env.RELAYSCRIBE_WORKSPACE_ID ?? 'default';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveWorkspaceDir(recordingsDir: string, workspaceId: string, workspaceDir?: string): string {
  return workspaceDir ?? process.env.RELAYSCRIBE_WORKSPACE_DIR ?? path.join(recordingsDir, '..', 'workspace', workspaceId);
}

function htmlPath(workspaceDir: string): string {
  return path.join(workspaceDir, 'generated-ui.html');
}

function resolvePublic(name: string): string {
  const candidates = [
    path.resolve(__dirname, 'public', name),
    path.resolve(__dirname, '..', 'public', name),
    path.resolve(process.cwd(), 'public', name),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function readBridgeSource(): string {
  try {
    return fs.readFileSync(resolvePublic('bridge.js'), 'utf8');
  } catch {
    return '/* relayscribe bridge unavailable */';
  }
}

function readStarterDoc(workspaceId: string): string {
  try {
    return fs.readFileSync(resolvePublic('ui.html'), 'utf8');
  } catch {
    return `<!doctype html><html><body style="font-family:system-ui;padding:40px">` +
      `<h2>Relay — Generative UI (Beta)</h2>` +
      `<p>Workspace: ${escapeHtml(workspaceId)}. Describe the UI you want; it will be generated here.</p>` +
      `</body></html>`;
  }
}

function disabledDoc(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>Generative UI (Beta) — off</title>` +
    `<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;` +
    `font-family:-apple-system,system-ui,sans-serif;background:#0d0e11;color:#9aa3b2}` +
    `div{max-width:420px;text-align:center;padding:24px}h2{color:#f2f4f8}</style></head>` +
    `<body><div><h2>Generative UI (Beta) is off</h2>` +
    `<p>Enable it in Settings → Generative UI to author a custom interface.</p></div></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

function readStoredHtml(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') {
      return null;
    }
    console.warn('[sidecar] generated-ui.html unreadable:', err);
    return null;
  }
}

function writeStoredHtml(filePath: string, html: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, html);
}

/**
 * Inject the bridge into the served document so window.relayscribe is defined
 * before any of the generated app's own scripts run. Inlined (not a <script
 * src>) so it works regardless of load order or asset-path resolution.
 */
function injectBridge(html: string): string {
  const tag = `<script data-relayscribe-bridge="1">\n${readBridgeSource()}\n</script>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${tag}</head>`);
  }
  return `${tag}\n${html}`;
}

/**
 * Strip Markdown code fences and any prose around the HTML document the model
 * returns. We want the raw document starting at <!doctype html> / <html>.
 */
function extractHtmlDocument(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)\s*```/i);
  if (fenced) text = fenced[1].trim();
  const docStart = text.search(/<!doctype html|<html[\s>]/i);
  if (docStart > 0) text = text.slice(docStart);
  return text.trim();
}

function buildSystemPrompt(workspaceId: string): string {
  return [
    'You are the UI author for the Relayscribe desktop app (Generative UI Beta).',
    'The user describes, in plain English, the ENTIRE interface they want. You return a',
    'COMPLETE, self-contained HTML document (one <!doctype html> document with inline',
    '<style> and <script>). No Markdown, no prose, no code fences — output the document only.',
    '',
    'Presentation is fully up to you: any layout, any colors, any components, any rich',
    'client-side JS (DOM, fetch, EventSource, timers, canvas, etc.). Do NOT load remote',
    'scripts or stylesheets from the internet; keep everything inline and offline-capable.',
    '',
    'To actually DO anything in the app, call the pre-injected bridge — window.relayscribe.* —',
    'which is guaranteed to exist before your scripts run. Never invent network endpoints;',
    'reach the app only through the bridge. Available methods (all async / Promise-returning',
    'unless noted):',
    '  relayscribe.record(opts?)            start a capture now',
    '  relayscribe.stop()                   stop the current capture',
    '  relayscribe.pause() / resume()       pause / resume capture',
    '  relayscribe.status()                 -> { ok, status, sdkReady }',
    '  relayscribe.state()                  -> live recorder state object',
    '  relayscribe.onState(cb) -> unsub     subscribe to live state (SSE); cb(state) on change',
    '  relayscribe.listRecordings()         -> [{ sessionId, createdAt, turns }]',
    '  relayscribe.getTranscript(id)        -> [{ sessionId, speaker, timestamp, text }]',
    '  relayscribe.search(query)            -> matching transcript rows',
    '  relayscribe.getSettings() / updateSettings(patch)',
    '  relayscribe.getConfig()              -> app config flags',
    '  relayscribe.connect(provider)        connect slack | linear | github',
    '  relayscribe.openSettings()           open native macOS settings',
    '  relayscribe.regenerate(text)         re-author this whole UI from new English',
    '  relayscribe.reset()                  reset to the starter UI',
    '',
    `Workspace id: ${workspaceId}.`,
    'Make it genuinely usable and good-looking. Handle empty/error states (e.g. no recordings yet).',
    'SINGLE AUTHORING SURFACE: the app ALREADY provides a persistent native toolbar above this',
    'WebView for describing/regenerating the UI. Do NOT render your own describe / generate /',
    '"change this UI" text input or button — that duplicates the native toolbar and confuses users.',
    'If you want to offer quick prompt shortcuts (e.g. example chips/links), have them call',
    'relayscribe.compose("...") to POPULATE that native toolbar — never your own regenerate input.',
    '',
    'HOUSE STYLE — default to the Relay product design system (the user can override it by asking):',
    '  Typography: font-family: "Geist", "Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;',
    '              monospace: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace. (Geist falls back to system fonts — keep it offline.)',
    '  Light theme (default): background #f9fafb (deep #eef4fb), surfaces #ffffff, text #111827, muted #4b5563, faint #9ca3af.',
    '  Dark theme (if asked): background #08111a, surfaces rgba(12,20,30,.82), text #edf4fb, muted #a8b8c8, primary #74b8e2.',
    '  Primary brand blue: #4a90c2 (hover/strong #2d6a9c, deep #234969); primary text #ffffff.',
    '  Warm accent: #c1674b. Destructive/red: #d95b63. Hairline borders: rgba(74,144,194,0.12).',
    '  Buttons: pill-shaped (border-radius: 100px), font-weight 600; primary = #4a90c2 bg / white text, secondary = surface bg / hairline border.',
    '  Cards/inputs: border-radius ~12px, 1px hairline border, subtle shadow rgba(36,74,111,.10); generous padding; antialiased text.',
    '  Aim for the calm, modern, slightly glassy Relay look — not generic dark-neon.',
  ].join('\n');
}

function buildUserPrompt(
  request: string,
  context: { currentHtml: string | null; reset: boolean },
): string {
  if (context.currentHtml && !context.reset) {
    return [
      'Here is the CURRENT interface document. Modify it to satisfy the new instruction,',
      'preserving everything that still applies. Return the FULL updated document.',
      '',
      '--- CURRENT DOCUMENT START ---',
      context.currentHtml,
      '--- CURRENT DOCUMENT END ---',
      '',
      `New instruction: ${request}`,
    ].join('\n');
  }
  return `Build this interface: ${request}`;
}

function isValidHtmlDocument(doc: string): boolean {
  return doc.length > 0 && /<\w+[\s>]/.test(doc);
}

const STRICT_RETRY_SUFFIX =
  '\n\nIMPORTANT: Output ONLY the raw HTML document, starting exactly with <!doctype html>. ' +
  'No prose, no explanation, no Markdown, no code fences.';

// ── Async job state ───────────────────────────────────────────────────────────

type GenerationState = 'idle' | 'generating' | 'error';

interface GenerationStatus {
  state: GenerationState;
  jobId: string;
  startedAt: number;
  error?: string;
}

export function createUiRoutes(options: UiRouteOptions) {
  const workspaceId = options.workspaceId ?? defaultWorkspaceId();
  const workspaceDir = resolveWorkspaceDir(options.recordingsDir, workspaceId, options.workspaceDir);
  const filePath = htmlPath(workspaceDir);
  const isEnabled = options.isEnabled ?? (() => true);
  // One generation per route-factory (= one per sidecar process in production).
  // Clients poll /ui/status until state transitions to 'idle' or 'error'.
  let generationStatus: GenerationStatus = { state: 'idle', jobId: '', startedAt: 0 };
  const app = new Hono();

  app.get('/bridge.js', (c) => {
    if (!isEnabled()) return c.json({ error: 'generative_ui_disabled' }, 403);
    return c.body(readBridgeSource(), 200, { 'Content-Type': 'text/javascript; charset=utf-8' });
  });

  app.get('/ui', (c) => {
    // When OFF: never serve the stored generated document and never inject the
    // bridge — just an inert page. Zero generative-UI surface for opt-out users.
    if (!isEnabled()) {
      return c.body(disabledDoc(), 200, { 'Content-Type': 'text/html; charset=utf-8' });
    }
    const stored = readStoredHtml(filePath);
    const doc = stored ?? readStarterDoc(workspaceId);
    return c.body(injectBridge(doc), 200, { 'Content-Type': 'text/html; charset=utf-8' });
  });

  app.get('/ui/raw', (c) => {
    if (!isEnabled()) return c.json({ error: 'generative_ui_disabled' }, 403);
    const stored = readStoredHtml(filePath);
    return c.body(stored ?? readStarterDoc(workspaceId), 200, { 'Content-Type': 'text/html; charset=utf-8' });
  });

  app.get('/ui/current', (c) => {
    if (!isEnabled()) return c.json({ error: 'generative_ui_disabled' }, 403);
    const stored = readStoredHtml(filePath);
    return c.json({ exists: stored !== null, workspace: workspaceId, html: stored ?? '' });
  });

  app.delete('/ui', (c) => {
    fs.rmSync(filePath, { force: true });
    return c.json({ ok: true, exists: false, workspace: workspaceId });
  });
  // Back-compat alias for older callers.
  app.delete('/ui/spec', (c) => {
    fs.rmSync(filePath, { force: true });
    return c.json({ ok: true, exists: false, workspace: workspaceId });
  });

  // Persist a Swift-provided / model-authored document. This is the storage
  // boundary the native AgentRelaySDK path posts the authored HTML to, so the
  // sidecar no longer needs to spawn an LLM itself.
  app.post('/ui/document', async (c) => {
    if (!isEnabled()) return c.json({ error: 'generative_ui_disabled' }, 403);
    const body: unknown = await c.req.json().catch(() => ({}));
    const rawHtml = isRecord(body) ? body.html : undefined;
    if (typeof rawHtml !== 'string' || rawHtml.trim().length === 0) {
      return c.json({ error: 'invalid_request', reason: 'missing html' }, 400);
    }
    const doc = extractHtmlDocument(rawHtml);
    if (!isValidHtmlDocument(doc)) {
      return c.json({ error: 'invalid_html', reason: 'not an HTML document' }, 422);
    }
    if (Buffer.byteLength(doc, 'utf8') > MAX_DOC_BYTES) {
      return c.json({ error: 'too_large', reason: `document exceeds ${MAX_DOC_BYTES} bytes` }, 422);
    }
    writeStoredHtml(filePath, doc);
    return c.json({ ok: true, workspace: workspaceId, bytes: Buffer.byteLength(doc, 'utf8') });
  });

  // Generation status — clients poll this when using the async path.
  app.get('/ui/status', (c) => {
    const { state, jobId, startedAt, error } = generationStatus;
    const exists = readStoredHtml(filePath) !== null;
    return c.json({
      state,
      exists,
      jobId: jobId || undefined,
      elapsedMs: state === 'generating' ? Date.now() - startedAt : undefined,
      error,
    });
  });

  // Generate a UI document by spawning ONE local CLI agent via the relay broker
  // (@agent-relay/harness-driver). Keyless — no ANTHROPIC_API_KEY, no baked
  // workspace key; model auth = the customer's local CLI login. The native
  // toolbar POSTs here; the result is persisted and served at /ui.
  //
  // Async path (body.async === true): returns 202 + jobId immediately.
  // Client polls GET /ui/status until state is 'idle' or 'error', then reloads.
  // Sync path (default): awaits generation and returns { ok, html } on success.
  // Broker-down → 503 llm_unavailable on both paths.
  app.post('/ui/generate', async (c) => {
    if (!isEnabled()) return c.json({ error: 'generative_ui_disabled' }, 403);
    const body: unknown = await c.req.json().catch(() => ({}));
    const rawRequest = isRecord(body) ? body.request : undefined;
    if (typeof rawRequest !== 'string' || rawRequest.trim().length === 0) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (generationStatus.state === 'generating') {
      return c.json({ error: 'already_generating', jobId: generationStatus.jobId }, 409);
    }
    const useAsync = isRecord(body) && body.async === true;
    const reset = isRecord(body) && body.reset === true;
    const request = rawRequest.trim().slice(0, MAX_REQUEST_CHARS);
    const currentHtml = reset ? null : readStoredHtml(filePath);
    const systemPrompt = buildSystemPrompt(workspaceId);
    const ctx = { workspaceId, currentHtml, systemPrompt };

    const generate: GenerateFn = options.generate ?? ((text, c2) =>
      harnessGenerate(c2.systemPrompt, buildUserPrompt(text, { currentHtml: c2.currentHtml, reset }), {
        workspaceId,
        model: options.claudeModel ?? process.env.RELAYSCRIBE_UI_MODEL ?? process.env.RELAYSCRIBE_UI_CLAUDE_MODEL,
        timeoutMs: options.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS,
      }));

    const runOnce = async (req: string): Promise<string> => extractHtmlDocument((await generate(req, ctx)) ?? '');

    const runGeneration = async (): Promise<
      { ok: true; doc: string } | { ok: false; error: string; status: number; reason?: string }
    > => {
      let doc: string;
      try {
        doc = await runOnce(request);
        if (!isValidHtmlDocument(doc)) {
          doc = await runOnce(request + STRICT_RETRY_SUFFIX);
        }
      } catch (err) {
        if (err instanceof BrokerUnavailableError) {
          console.error('[sidecar] ui generation unavailable:', (err as Error).message);
          return { ok: false, error: 'llm_unavailable', status: 503, reason: (err as Error).message };
        }
        console.error('[sidecar] ui generation failed:', err);
        return { ok: false, error: 'llm_failed', status: 502 };
      }
      if (!isValidHtmlDocument(doc)) {
        return { ok: false, error: 'invalid_html', status: 422, reason: 'model did not return an HTML document' };
      }
      if (Buffer.byteLength(doc, 'utf8') > MAX_DOC_BYTES) {
        return { ok: false, error: 'too_large', status: 422, reason: `document exceeds ${MAX_DOC_BYTES} bytes` };
      }
      writeStoredHtml(filePath, doc);
      return { ok: true, doc };
    };

    if (useAsync) {
      const jobId = `gen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      generationStatus = { state: 'generating', jobId, startedAt: Date.now() };
      console.log(`[sidecar] ui generation started async jobId=${jobId}`);

      void runGeneration().then((result) => {
        if (result.ok) {
          console.log(`[sidecar] ui generation complete jobId=${jobId} bytes=${Buffer.byteLength(result.doc, 'utf8')}`);
          generationStatus = { state: 'idle', jobId, startedAt: generationStatus.startedAt };
        } else {
          console.error(`[sidecar] ui generation failed jobId=${jobId} error=${result.error}`);
          generationStatus = { state: 'error', jobId, startedAt: generationStatus.startedAt, error: result.reason ?? result.error };
        }
      });

      return c.json({ jobId, state: 'generating' }, 202);
    }

    // Sync path (default / tests).
    const result = await runGeneration();
    if (!result.ok) {
      return c.json(
        result.reason ? { error: result.error, reason: result.reason } : { error: result.error },
        result.status as 400 | 422 | 502 | 503,
      );
    }
    return c.json({ ok: true, workspace: workspaceId, bytes: Buffer.byteLength(result.doc, 'utf8'), html: result.doc });
  });

  return app;
}

export const testInternals = {
  buildSystemPrompt,
  buildUserPrompt,
  extractHtmlDocument,
  injectBridge,
  readBridgeSource,
  resolveWorkspaceDir,
  htmlPath,
};
