import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BrainstormPipelineError,
  BrainstormPipelineStore,
  buildBrainstormNote,
  processBrainstormAudio,
  runBrainstormPipelineWithPersistence,
} from '../src/brainstorm-pipeline';
import { DEFAULT_SETTINGS } from '../src/recorder-settings';

describe('brainstorm pipeline', () => {
  it('blocks before transcription when no Relay workspace is signed in', async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response('{}');
    };

    await assert.rejects(
      processBrainstormAudio({
        audio: new Uint8Array([1, 2, 3]),
        contentType: 'audio/mp4',
        workerUrl: 'https://transcription.example',
        transcribeToken: 'token-123',
        transcriptsIngestUrl: 'https://agentrelay.example/cloud/api/v1/webhooks/transcripts',
        relayWorkspaceContext: {},
        settings: DEFAULT_SETTINGS,
        fetcher,
      }),
      (err: unknown) => err instanceof BrainstormPipelineError && err.code === 'missing_workspace',
    );
    assert.deepEqual(calls, []);
  });

  it('transcribes audio and posts a brainstorm note to transcript ingest', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/transcribe')) {
        return new Response(JSON.stringify({ text: 'Build the native brainstorm path.' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    };

    const result = await processBrainstormAudio({
      audio: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mp4',
      filename: 'brainstorm.m4a',
      workerUrl: 'https://transcription.example/',
      transcribeToken: 'token-123/',
      transcriptsIngestUrl: 'https://agentrelay.example/cloud/api/v1/webhooks/transcripts',
      relayWorkspaceContext: { relay_workspace_id: 'rw_123' },
      settings: {
        mode: 'brainstorm',
        automation_settings: {
          create_linear_issues: true,
          create_github_issues: false,
          dispatch_enabled: false,
        },
      },
      fetcher,
      now: new Date('2026-06-15T08:00:00.000Z'),
    });

    assert.match(result.id, /^not_brainstorm1781510400000[A-Za-z0-9]{8}$/);
    assert.equal(result.transcript, 'Build the native brainstorm path.');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://transcription.example/transcribe');
    assert.deepEqual(calls[0].init?.headers, {
      authorization: 'Bearer token-123/',
      'content-type': 'audio/mp4',
    });
    assert.equal(calls[1].url, 'https://agentrelay.example/cloud/api/v1/webhooks/transcripts');
    assert.deepEqual(calls[1].init?.headers, {
      authorization: 'Bearer token-123/',
      'content-type': 'application/json',
    });
    const note = JSON.parse(String(calls[1].init?.body));
    assert.match(note.id, /^not_brainstorm1781510400000[A-Za-z0-9]{8}$/);
    assert.equal(note.object, 'note');
    assert.equal(note.mode, 'brainstorm');
    assert.equal(note.source.provider, 'recall');
    assert.match(note.source.recording_id, /^brainstorm-1781510400000-[A-Za-z0-9]{8}$/);
    assert.equal(note.source.relay_workspace_id, 'rw_123');
    assert.equal(note.source.mode, 'brainstorm');
    assert.equal(note.transcript_text, 'Build the native brainstorm path.');
    assert.equal(note.summary_text, 'Build the native brainstorm path.');
    assert.deepEqual(note.participants, []);
    assert.equal(note.automation_settings.create_linear_issues, true);
    assert.equal(note.metadata.capture, 'native-mic');
  });

  it('builds a stable granola-shaped brainstorm note', () => {
    const note = buildBrainstormNote({
      transcript: 'Ship it.',
      relayWorkspaceId: 'rw_abc',
      settings: DEFAULT_SETTINGS,
      now: new Date('2026-06-15T09:10:11.000Z'),
      filename: 'clip.m4a',
      idSuffix: 'abcd1234',
    });

    assert.equal(note.id, 'not_brainstorm1781514611000abcd1234');
    assert.equal(note.object, 'note');
    assert.equal(note.title, 'Brainstorm 2026-06-15');
    assert.equal(note.source.recording_id, 'brainstorm-1781514611000-abcd1234');
    assert.equal(note.source.provider, 'recall');
    assert.equal(note.source.relay_workspace_id, 'rw_abc');
    assert.equal(note.transcript_text, 'Ship it.');
    assert.equal(note.summary_text, 'Ship it.');
    assert.deepEqual(note.participants, []);
    assert.equal(note.mode, 'brainstorm');
    assert.equal(note.metadata.version, '1.3.0');
    assert.equal(note.metadata.filename, 'clip.m4a');
  });
});

describe('runBrainstormPipelineWithPersistence', () => {
  function makeMockStore(): BrainstormPipelineStore & {
    persisted: Array<{ id: string }>;
    transcribed: string[];
    failed: string[];
  } {
    const persisted: Array<{ id: string }> = [];
    const transcribed: string[] = [];
    const failed: string[] = [];
    return {
      persisted,
      transcribed,
      failed,
      async persistAudio(_audio, _opts) {
        const id = `persist-${persisted.length + 1}`;
        persisted.push({ id });
        return { id };
      },
      async markTranscribed(id) { transcribed.push(id); },
      async markFailed(id) { failed.push(id); },
    };
  }

  const baseInput = {
    audio: new Uint8Array([1, 2, 3]),
    contentType: 'audio/mp4',
    workerUrl: 'https://worker.example',
    transcribeToken: 'tok',
    transcriptsIngestUrl: 'https://ingest.example',
    relayWorkspaceContext: { relay_workspace_id: 'rw_abc' },
    settings: DEFAULT_SETTINGS,
    now: new Date('2026-06-15T08:00:00.000Z'),
  };

  it('persists audio, calls pipeline, marks transcribed on success', async () => {
    const store = makeMockStore();
    const fetcher: typeof fetch = async (url) => {
      if (String(url).endsWith('/transcribe')) {
        return new Response(JSON.stringify({ text: 'hello world' }));
      }
      return new Response('{}', { status: 202 });
    };

    const result = await runBrainstormPipelineWithPersistence({ ...baseInput, fetcher }, store);

    assert.equal(store.persisted.length, 1);
    assert.equal(store.transcribed[0], 'persist-1');
    assert.equal(store.failed.length, 0);
    assert.equal(result.transcript, 'hello world');
  });

  it('persists audio and marks failed when transcription returns 502', async () => {
    const store = makeMockStore();
    const fetcher: typeof fetch = async () => new Response('Service Unavailable', { status: 502 });

    await assert.rejects(
      () => runBrainstormPipelineWithPersistence({ ...baseInput, fetcher }, store),
      (err: unknown) => err instanceof BrainstormPipelineError && err.code === 'transcribe_failed',
    );

    assert.equal(store.persisted.length, 1);
    assert.equal(store.failed[0], 'persist-1');
    assert.equal(store.transcribed.length, 0);
  });

  it('continues without persistence id when persistAudio throws', async () => {
    const store = makeMockStore();
    store.persistAudio = async () => { throw new Error('disk full'); };
    const fetcher: typeof fetch = async (url) => {
      if (String(url).endsWith('/transcribe')) return new Response(JSON.stringify({ text: 'ok' }));
      return new Response('{}', { status: 202 });
    };

    const result = await runBrainstormPipelineWithPersistence({ ...baseInput, fetcher }, store);
    assert.equal(result.transcript, 'ok');
    assert.equal(store.transcribed.length, 0);
    assert.equal(store.failed.length, 0);
  });
});
