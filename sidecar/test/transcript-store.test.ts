import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatTranscript,
  isExportFormat,
  exportFilename,
  type TranscriptRecord,
} from '../src/transcript-store';

const record: TranscriptRecord = {
  recording_id: 'brainstorm-123-abcd',
  title: 'Sprint Planning',
  transcript: 'We should ship the export endpoint.',
  summary: 'Decided to ship export.',
  duration_seconds: 95,
  started_at: '2026-06-16T08:00:00.000Z',
  saved_at: '2026-06-16T08:02:00.000Z',
};

describe('isExportFormat', () => {
  it('accepts txt and md only', () => {
    assert.equal(isExportFormat('txt'), true);
    assert.equal(isExportFormat('md'), true);
    assert.equal(isExportFormat('json'), false);
    assert.equal(isExportFormat(''), false);
    assert.equal(isExportFormat(undefined), false);
  });
});

describe('formatTranscript', () => {
  it('renders txt with metadata, summary, and transcript', () => {
    const out = formatTranscript(record, 'txt');
    assert.match(out, /^Sprint Planning/);
    assert.match(out, /Date: 2026-06-16T08:00:00\.000Z/);
    assert.match(out, /Duration: 1m 35s/);
    assert.match(out, /Recording ID: brainstorm-123-abcd/);
    assert.match(out, /Summary:\nDecided to ship export\./);
    assert.match(out, /We should ship the export endpoint\./);
  });

  it('renders md with headed sections', () => {
    const out = formatTranscript(record, 'md');
    assert.match(out, /^# Sprint Planning/);
    assert.match(out, /- \*\*Duration:\*\* 1m 35s/);
    assert.match(out, /## Summary\n\nDecided to ship export\./);
    assert.match(out, /## Transcript\n\nWe should ship the export endpoint\./);
  });

  it('falls back to a default title and omits an absent summary', () => {
    const minimal: TranscriptRecord = {
      recording_id: 'r1',
      transcript: 'hello',
      saved_at: '2026-06-16T08:02:00.000Z',
    };
    const txt = formatTranscript(minimal, 'txt');
    assert.match(txt, /^Transcript/);
    assert.doesNotMatch(txt, /Summary:/);
    assert.doesNotMatch(txt, /Duration:/);
    assert.match(txt, /Date: 2026-06-16T08:02:00\.000Z/); // falls back to saved_at
  });
});

describe('exportFilename', () => {
  it('slugifies the title', () => {
    assert.equal(exportFilename(record), 'sprint-planning');
  });

  it('falls back to recording_id, then a default', () => {
    assert.equal(
      exportFilename({ recording_id: 'rec-9', transcript: '', saved_at: '' }),
      'rec-9',
    );
    assert.equal(
      exportFilename({ recording_id: '', transcript: '', saved_at: '' }),
      'transcript',
    );
  });
});
