import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface TranscriptRecord {
  recording_id: string;
  title?: string;
  transcript: string;
  summary?: string;
  duration_seconds?: number;
  started_at?: string;
  saved_at: string;
}

export type TranscriptMeta = Omit<TranscriptRecord, 'transcript'>;

function transcriptsDir(): string {
  if (process.env.RELAYSCRIBE_RECORDINGS_DIR) {
    return join(process.env.RELAYSCRIBE_RECORDINGS_DIR, '..', 'transcripts');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Relayscribe', 'transcripts');
  }
  return join(process.cwd(), '.relayscribe', 'transcripts');
}

function ensureDir(): string {
  const dir = transcriptsDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveTranscript(record: TranscriptRecord): void {
  const dir = ensureDir();
  writeFileSync(
    join(dir, `${record.recording_id}.json`),
    JSON.stringify(record, null, 2),
    'utf-8',
  );
}

export function listTranscripts(): TranscriptMeta[] {
  try {
    const dir = ensureDir();
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .flatMap(f => {
        try {
          const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as TranscriptRecord;
          const { transcript: _t, ...meta } = raw;
          return [meta];
        } catch { return []; }
      })
      .sort((a, b) => (b.saved_at > a.saved_at ? 1 : -1));
  } catch { return []; }
}

export function getTranscript(id: string): TranscriptRecord | null {
  try {
    const dir = transcriptsDir();
    return JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf-8')) as TranscriptRecord;
  } catch { return null; }
}
