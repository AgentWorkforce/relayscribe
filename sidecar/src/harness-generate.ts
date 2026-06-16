/**
 * Generative-UI backend: spawn ONE local CLI agent via @agent-relay/harness-driver
 * to author the HTML document, and await its structured result.
 *
 * This is the shipping architecture (per MSD CHAT_ARCHITECTURE.md): the agent is
 * a local PTY subprocess driven through the local relay broker — NOT `claude -p`,
 * NOT a cloud proxy, NOT a baked workspace key. RELAY_API_KEY is optional; when
 * absent the local broker path is the fallback. Model auth = the user's local
 * claude/codex CLI login (inherited by the spawned agent via PATH /
 * RELAYSCRIBE_UI_CLAUDE_BIN).
 *
 * The agent returns the document through the `submit_result` MCP tool; we pair it
 * with an `agentResultSchema` so it knows the shape ({ html }).
 */
import fs from 'node:fs';
// Type-only import — erased at runtime so the tests can run without the package
// installed. The value import happens lazily inside getClient() via dynamic import().
import type { HarnessDriverClient, SpawnedAgentHandle } from '@agent-relay/harness-driver';

export interface HarnessGenerateOptions {
  workspaceId: string;
  model?: string;
  timeoutMs?: number;
  /** Path to a running broker's connection.json (else the default is used). */
  connectionPath?: string;
}

const DEFAULT_BROKER_URL = 'http://127.0.0.1:3889';

/** Env-provided broker base URL, if any. */
function brokerUrlFromEnv(): string | undefined {
  return (
    process.env.RELAYSCRIBE_UI_BROKER_URL ??
    process.env.RELAY_BROKER_URL ??
    process.env.RELAY_BASE_URL ??
    undefined
  )?.replace(/\/+$/, '');
}

/** Env-provided broker API key (br_… for the broker API; rk_live_… as fallback). */
function brokerKeyFromEnv(): string | undefined {
  return (
    process.env.RELAYSCRIBE_UI_BROKER_KEY ??
    process.env.RELAY_BROKER_API_KEY ??
    process.env.RELAY_API_KEY ??
    undefined
  );
}

/**
 * Model-auth (Khaliq, 2026-06-14):
 *  • Tier 1 (default): the customer's LOCAL claude login. We set NO model env, so
 *    the spawned `claude` CLI uses its own ~/.claude credentials. This is what
 *    works today and ships for any customer who has claude.
 *  • Tier 2 (fallback, no local claude): route model calls through the relay
 *    CLOUD proxy — set ANTHROPIC_BASE_URL + a SHORT-LIVED per-customer token
 *    (NOT the house key; the cloud injects the real key server-side and meters).
 *    The native app derives the token from the customer's cli:auth login
 *    (ConnectCloud #19) and provides it via RELAYSCRIBE_UI_MODEL_PROXY_URL/TOKEN.
 * Returns the broker-env overrides for Tier 2, or undefined for Tier 1.
 * NOTE: only reachable via the managed-broker spawn (the spawned agent has no
 * per-agent env). When attaching to an already-running broker, model-auth is
 * whatever that broker's env already provides.
 */
function modelProxyEnv(): NodeJS.ProcessEnv | undefined {
  const baseUrl = process.env.RELAYSCRIBE_UI_MODEL_PROXY_URL?.trim();
  const token = process.env.RELAYSCRIBE_UI_MODEL_PROXY_TOKEN?.trim();
  if (baseUrl && token) {
    return { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: token };
  }
  return undefined;
}

// Default-model authoring routinely runs several minutes and was observed past
// 7min — a 300s cap hard-502'd mid-author + left an orphan. Generous cap; the
// hard-kill below guarantees no orphan even if it's hit. (Async/poll #21 is the
// durable client-UX fix.)
const DEFAULT_TIMEOUT_MS = 1_200_000;

// Prefix for the per-generation ephemeral channel. Generation agents are
// isolated headless HTML authors — they must NEVER join the fleet channel
// (#general). A failed/lingering author on #general role-plays in the fleet and
// spams everyone (observed 2026-06-14). Each spawn gets its own `${GENUI_CHANNEL}-${name}`.
const GENUI_CHANNEL = 'relayscribe-genui';

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    html: { type: 'string', description: 'The complete, self-contained HTML document.' },
  },
  required: ['html'],
} as const;

/** Raised when no local broker is reachable and none could be spawned. */
export class BrokerUnavailableError extends Error {}

// Dynamic import so the module is only loaded when harnessGenerate() is actually
// called. Tests that inject `generate` never touch this path, so they run fine
// even when @agent-relay/harness-driver is not installed.
async function getHarnessDriver(): Promise<{
  HarnessDriverClient: typeof HarnessDriverClient;
}> {
  return import('@agent-relay/harness-driver') as Promise<{ HarnessDriverClient: typeof HarnessDriverClient }>;
}

let clientPromise: Promise<HarnessDriverClient> | null = null;
let spawnCounter = 0;

async function getClient(connectionPath?: string): Promise<HarnessDriverClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { HarnessDriverClient: HDC } = await getHarnessDriver();
      // 1. Explicit broker URL + key from env — attach directly (the running
      //    fleet broker exposes RELAY_BROKER_API_KEY but no connection.json).
      const apiKey = brokerKeyFromEnv();
      if (apiKey) {
        return new HDC({ baseUrl: brokerUrlFromEnv() ?? DEFAULT_BROKER_URL, apiKey });
      }
      // 2. A running broker's connection.json (keyless attach).
      try {
        return HDC.connect(connectionPath ? { connectionPath } : {});
      } catch {
        // 3. Spawn a managed broker (needs a broker binary — bundling/ship task).
        //    The spawned agent has NO per-agent env, so it inherits the broker's
        //    env — this is the ONLY hook for model-auth Tier 2 (cloud proxy).
        try {
          const proxyEnv = modelProxyEnv();
          return await HDC.spawn(proxyEnv ? { env: { ...process.env, ...proxyEnv } } : {});
        } catch (err) {
          throw new BrokerUnavailableError(
            `no running broker (set RELAYSCRIBE_UI_BROKER_URL + RELAY_BROKER_API_KEY, or run 'agent-relay up'): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    })().catch((err) => {
      clientPromise = null; // allow a later retry once the broker is up
      throw err;
    });
  }
  return clientPromise;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'default';
}

/**
 * Forcibly terminate the spawned agent's PTY. `handle.release()` only
 * DEREGISTERS the agent from the broker — it does NOT kill a busy `claude`
 * process (proven 2026-06-14: a worker ran 130s+ past release until manual
 * SIGKILL). So after release we SIGKILL the OS pid (and its process group, in
 * case the PTY spawned children). Best-effort: the pid may already be gone.
 */
function hardKill(handle: SpawnedAgentHandle): void {
  const pid = handle.pid;
  if (typeof pid !== 'number' || pid <= 0) return;
  for (const target of [pid, -pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      /* already exited, or not a process-group leader */
    }
  }
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Whether an error from attach/spawn means the broker is simply unreachable
 * (vs. the agent producing a bad result). The env-attach path builds a client
 * without dialing the broker, so a down URL only surfaces here as a raw
 * fetch/transport error — map those to BrokerUnavailableError → 503.
 */
function isConnectionError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } };
  if (typeof e?.code === 'string' && CONNECTION_ERROR_CODES.has(e.code)) return true;
  if (typeof e?.cause?.code === 'string' && CONNECTION_ERROR_CODES.has(e.cause.code)) return true;
  const text = `${e?.message ?? ''} ${e?.cause?.message ?? ''}`;
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|socket hang up|network|connect ECONN/i.test(text);
}

function buildTask(systemPrompt: string, userPrompt: string): string {
  return [
    systemPrompt,
    '',
    userPrompt,
    '',
    'Return the finished document by calling the `submit_result` tool with',
    '{ "html": "<the complete HTML document>" }. Submit the RAW document only — no prose,',
    'no Markdown, no code fences. Do NOT write any files and do NOT message anyone; the only',
    'action that completes the task is a single submit_result call.',
  ].join('\n');
}

/**
 * Spawn one agent to author the document and return its HTML. Throws
 * BrokerUnavailableError when no broker is reachable, or Error on
 * timeout / empty result.
 */
export async function harnessGenerate(
  systemPrompt: string,
  userPrompt: string,
  options: HarnessGenerateOptions,
): Promise<string> {
  // Offline/CI/demo hook: return a canned document instead of spawning an agent.
  // Used by `npm run demo:ui-live` so it needs no broker.
  const fakeDocPath = process.env.RELAYSCRIBE_UI_FAKE_DOC;
  if (fakeDocPath) {
    return fs.readFileSync(fakeDocPath, 'utf8');
  }
  // getClient throws BrokerUnavailableError when no broker is reachable.
  const client = await getClient(options.connectionPath ?? process.env.RELAYSCRIBE_UI_BROKER_CONNECTION_PATH);
  const name = `relayscribe-ui-${sanitize(options.workspaceId)}-${(spawnCounter++).toString(36)}`;
  // Per-generation ephemeral channel — NEVER #general. A headless author must
  // not be visible to or able to post in the fleet workspace; skipRelayPrompt
  // also drops the "you are a fleet agent" framing so it can't role-play as a
  // coordinator. submit_result still works (it's an MCP tool, independent of both).
  const channel = `${GENUI_CHANNEL}-${name}`;

  let handle: SpawnedAgentHandle;
  try {
    handle = await client.spawnClaude({
      name,
      ...(options.model ? { model: options.model } : {}),
      task: buildTask(systemPrompt, userPrompt),
      agentResultSchema: RESULT_SCHEMA,
      channels: [channel],
      skipRelayPrompt: true,
    });
  } catch (err) {
    // A spawn that fails readiness (e.g. an unsupported model that never reaches
    // worker_ready) may have already started a PTY — terminate it by name so it
    // cannot linger/escape. Then map the error.
    await client.release(name).catch(() => {});
    // The env-attach client doesn't dial the broker until spawn, so an
    // unreachable broker surfaces as a transport error here.
    if (isConnectionError(err)) {
      clientPromise = null; // drop the cached client so a later attempt re-attaches
      throw new BrokerUnavailableError(
        `broker unreachable (check RELAYSCRIBE_UI_BROKER_URL / that a broker is running): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  }

  try {
    const info = await handle.waitForResult<{ html?: string }>(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (info.reason === 'timeout') throw new Error('generation timed out');
    if (info.reason === 'exited') throw new Error('agent exited without submitting a result');
    const html = info.data?.html;
    if (typeof html !== 'string' || html.trim().length === 0) {
      throw new Error('agent submitted an empty result');
    }
    return html;
  } finally {
    // Always terminate the worker — on submit_result, timeout, or exit.
    // release() deregisters; hardKill() SIGKILLs the busy PTY so nothing lingers.
    await handle.release('generation complete').catch(() => {});
    hardKill(handle);
  }
}
