import type { AutomationSettings, RecorderSettings } from './recorder-settings';
import type { RelayWorkspaceContext } from './relay-workspace';

export interface BrainstormPipelineStore {
  persistAudio(
    audio: Uint8Array,
    opts: {
      contentType: string;
      filename?: string;
      relayWorkspaceId?: string;
      settings: RecorderSettings;
    },
  ): Promise<{ id: string }>;
  markTranscribed(id: string): Promise<void>;
  markFailed(id: string): Promise<void>;
}

export const DEFAULT_TRANSCRIPTS_INGEST_URL = 'https://agentrelay.com/cloud/api/v1/webhooks/transcripts';
export const RELAYSCRIBE_VERSION = '1.3.0';

export class BrainstormPipelineError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'BrainstormPipelineError';
  }
}

export interface BrainstormPipelineInput {
  audio: Uint8Array;
  contentType: string;
  filename?: string;
  workerUrl: string;
  transcribeToken: string;
  transcriptsIngestUrl: string;
  relayWorkspaceContext: RelayWorkspaceContext;
  settings: RecorderSettings;
  fetcher?: typeof fetch;
  now?: Date;
}

export interface BrainstormPipelineResult {
  id: string;
  transcript: string;
}

interface TranscribeResponse {
  text?: unknown;
  transcript?: unknown;
  transcript_text?: unknown;
}

function requireNonEmpty(value: string, message: string, code: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new BrainstormPipelineError(message, 500, code);
  }
  return trimmed;
}

function requireNonEmptyUrl(value: string, message: string, code: string): string {
  return requireNonEmpty(value, message, code).replace(/\/+$/, '');
}

function transcriptFromPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload.trim();
  if (!payload || typeof payload !== 'object') return '';
  const candidate = payload as TranscribeResponse;
  for (const value of [candidate.text, candidate.transcript, candidate.transcript_text]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

async function readResponsePayload(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return '';
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function transcribeAudio(input: BrainstormPipelineInput): Promise<string> {
  const workerUrl = requireNonEmptyUrl(input.workerUrl, 'WORKER_URL not configured', 'missing_worker_url');
  const token = requireNonEmpty(input.transcribeToken, 'RECORDER_TRANSCRIBE_TOKEN not configured', 'missing_token');
  const res = await (input.fetcher ?? fetch)(`${workerUrl}/transcribe`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': input.contentType || 'application/octet-stream',
    },
    body: Buffer.from(input.audio),
  });
  const payload = await readResponsePayload(res);
  if (!res.ok) {
    const detail = typeof payload === 'string' ? payload : JSON.stringify(payload);
    throw new BrainstormPipelineError(`transcribe ${res.status}: ${detail}`, 502, 'transcribe_failed');
  }
  const transcript = transcriptFromPayload(payload);
  if (!transcript) {
    throw new BrainstormPipelineError('transcribe returned an empty transcript', 502, 'empty_transcript');
  }
  return transcript;
}

function buildAutomationSettings(settings: RecorderSettings): AutomationSettings {
  return { ...settings.automation_settings };
}

export function buildBrainstormNote(input: {
  transcript: string;
  relayWorkspaceId: string;
  settings: RecorderSettings;
  now?: Date;
  filename?: string;
  idSuffix?: string;
}) {
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const suffix = (input.idSuffix ?? crypto.randomUUID().replace(/-/g, '').slice(0, 8))
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 8) || crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const recordingId = `brainstorm-${now.getTime()}-${suffix}`;
  const id = `not_${recordingId.replace(/[^A-Za-z0-9_]/g, '').slice(0, 48)}`;
  return {
    id,
    object: 'note',
    title: `Brainstorm ${createdAt.slice(0, 10)}`,
    created_at: createdAt,
    updated_at: null,
    web_url: '',
    participants: [],
    transcript_text: input.transcript,
    summary_text: input.transcript,
    mode: 'brainstorm',
    automation_settings: buildAutomationSettings(input.settings),
    source: {
      provider: 'recall',
      type: 'relayscribe',
      mode: 'brainstorm',
      recording_id: recordingId,
      bot_id: null,
      relay_workspace_id: input.relayWorkspaceId,
    },
    metadata: {
      capture: 'native-mic',
      client: 'relayscribe',
      version: RELAYSCRIBE_VERSION,
      ...(input.filename ? { filename: input.filename } : {}),
    },
  };
}

export async function processBrainstormAudio(input: BrainstormPipelineInput): Promise<BrainstormPipelineResult> {
  const relayWorkspaceId = input.relayWorkspaceContext.relay_workspace_id?.trim();
  if (!relayWorkspaceId) {
    throw new BrainstormPipelineError('Sign in to Relay before recording a brainstorm.', 409, 'missing_workspace');
  }
  if (input.audio.byteLength === 0) {
    throw new BrainstormPipelineError('Audio upload was empty.', 400, 'empty_audio');
  }
  const ingestUrl = requireNonEmptyUrl(
    input.transcriptsIngestUrl || DEFAULT_TRANSCRIPTS_INGEST_URL,
    'TRANSCRIPTS_INGEST_URL not configured',
    'missing_ingest_url',
  );
  const token = requireNonEmpty(input.transcribeToken, 'RECORDER_TRANSCRIBE_TOKEN not configured', 'missing_token');
  const transcript = await transcribeAudio(input);
  const note = buildBrainstormNote({
    transcript,
    relayWorkspaceId,
    settings: input.settings,
    now: input.now,
    filename: input.filename,
  });
  const res = await (input.fetcher ?? fetch)(ingestUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(note),
  });
  const payload = await readResponsePayload(res);
  if (!res.ok) {
    const detail = typeof payload === 'string' ? payload : JSON.stringify(payload);
    throw new BrainstormPipelineError(`transcripts ingest ${res.status}: ${detail}`, 502, 'ingest_failed');
  }
  return { id: note.id, transcript };
}

export async function runBrainstormPipelineWithPersistence(
  input: BrainstormPipelineInput,
  store: BrainstormPipelineStore,
): Promise<BrainstormPipelineResult> {
  let persistenceId: string | undefined;
  try {
    const entry = await store.persistAudio(input.audio, {
      contentType: input.contentType,
      filename: input.filename,
      relayWorkspaceId: input.relayWorkspaceContext.relay_workspace_id,
      settings: input.settings,
    });
    persistenceId = entry.id;
  } catch (persistErr) {
    // Persistence failure must not block transcription — log and continue
    console.warn('[pipeline] audio persist failed (continuing):', persistErr instanceof Error ? persistErr.message : persistErr);
  }
  try {
    const result = await processBrainstormAudio(input);
    if (persistenceId) {
      await store.markTranscribed(persistenceId).catch((e: unknown) => {
        console.warn('[pipeline] markTranscribed failed:', e instanceof Error ? e.message : e);
      });
    }
    return result;
  } catch (err) {
    if (persistenceId) {
      await store.markFailed(persistenceId).catch((e: unknown) => {
        console.warn('[pipeline] markFailed failed:', e instanceof Error ? e.message : e);
      });
    }
    throw err;
  }
}
