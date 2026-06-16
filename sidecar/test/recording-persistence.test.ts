import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  persistAudio,
  markTranscribed,
  markFailed,
  bumpRetryCount,
  getRetryableEntries,
  backoffDelayMs,
  MAX_RETRIES,
} from '../src/recording-persistence';

const TEST_DIR = join(tmpdir(), `relayscribe-persist-test-${process.pid}`);

before(async () => {
  // RELAYSCRIBE_RECORDINGS_DIR points to the app-support root (not the recordings subdir)
  process.env.RELAYSCRIBE_RECORDINGS_DIR = TEST_DIR;
  await mkdir(TEST_DIR, { recursive: true });
});

after(async () => {
  delete process.env.RELAYSCRIBE_RECORDINGS_DIR;
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('recording-persistence', () => {
  describe('backoffDelayMs', () => {
    it('returns 0 for first attempt (retryCount=0)', () => {
      assert.equal(backoffDelayMs(0), 0);
    });

    it('returns 2 minutes for retryCount=1', () => {
      assert.equal(backoffDelayMs(1), 2 * 60 * 1000);
    });

    it('returns 4 minutes for retryCount=2', () => {
      assert.equal(backoffDelayMs(2), 4 * 60 * 1000);
    });
  });

  it('persists audio and writes manifest entry', async () => {
    const audio = new Uint8Array([1, 2, 3, 4]);
    const entry = await persistAudio(audio, {
      contentType: 'audio/mp4',
      filename: 'test.m4a',
      relayWorkspaceContext: { relay_workspace_id: 'rw_test' },
    });

    assert.ok(entry.id, 'entry has an id');
    assert.equal(entry.status, 'pending');
    assert.equal(entry.retryCount, 0);
    assert.equal(entry.relayWorkspaceId, 'rw_test');
    assert.equal(entry.filename, 'test.m4a');
    assert.ok(entry.audioPath.endsWith('.m4a'), 'audio path has .m4a extension');

    const saved = await readFile(entry.audioPath);
    assert.deepEqual(new Uint8Array(saved), audio);
  });

  it('markTranscribed removes audio file and clears manifest entry', async () => {
    const audio = new Uint8Array([10, 20]);
    const entry = await persistAudio(audio, { contentType: 'audio/mp4' });

    await markTranscribed(entry.id);

    await assert.rejects(() => readFile(entry.audioPath), /ENOENT/);

    const retryable = await getRetryableEntries();
    assert.ok(!retryable.some((e) => e.id === entry.id));
  });

  it('markFailed sets status to failed and preserves audio file', async () => {
    const audio = new Uint8Array([5, 6, 7]);
    const entry = await persistAudio(audio, { contentType: 'audio/mp4' });

    await markFailed(entry.id);

    const saved = await readFile(entry.audioPath);
    assert.deepEqual(new Uint8Array(saved), audio);

    const retryable = await getRetryableEntries();
    const found = retryable.find((e) => e.id === entry.id);
    assert.ok(found, 'failed entry appears in retryable list');
    assert.equal(found!.status, 'failed');
  });

  it('bumpRetryCount increments count and resets status to pending', async () => {
    const audio = new Uint8Array([8, 9]);
    const entry = await persistAudio(audio, { contentType: 'audio/mp4' });
    await markFailed(entry.id);

    const newCount = await bumpRetryCount(entry.id);
    assert.equal(newCount, 1);

    // Should be in backoff window (2 min delay, not past yet with nowMs=now)
    const retryable = await getRetryableEntries();
    const found = retryable.find((e) => e.id === entry.id);
    assert.ok(!found, 'entry with retryCount=1 is in backoff window');
  });

  it('getRetryableEntries respects MAX_RETRIES limit', async () => {
    const audio = new Uint8Array([11]);
    const entry = await persistAudio(audio, { contentType: 'audio/mp4' });
    await markFailed(entry.id);

    for (let i = 0; i < MAX_RETRIES; i++) {
      await bumpRetryCount(entry.id);
      await markFailed(entry.id);
    }

    const farFuture = Date.now() + 60 * 60 * 1000;
    const retryable = await getRetryableEntries(farFuture);
    assert.ok(!retryable.some((e) => e.id === entry.id), 'exhausted entry not retried');
  });

  it('getRetryableEntries skips orphaned entries with missing audio', async () => {
    const audio = new Uint8Array([12]);
    const entry = await persistAudio(audio, { contentType: 'audio/wav' });
    await markFailed(entry.id);

    await rm(entry.audioPath);

    const retryable = await getRetryableEntries(Date.now() + 60_000);
    assert.ok(!retryable.some((e) => e.id === entry.id), 'orphaned entry skipped');
  });
});
