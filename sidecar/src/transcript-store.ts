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

export type ExportFormat = 'txt' | 'md';

export function isExportFormat(value: unknown): value is ExportFormat {
  return value === 'txt' || value === 'md';
}

function exportMeta(record: TranscriptRecord): string[] {
  const lines: string[] = [];
  const when = record.started_at ?? record.saved_at;
  if (when) lines.push(`Date: ${when}`);
  if (typeof record.duration_seconds === 'number') {
    const total = Math.max(0, Math.round(record.duration_seconds));
    const mm = Math.floor(total / 60);
    const ss = total % 60;
    lines.push(`Duration: ${mm}m ${ss}s`);
  }
  lines.push(`Recording ID: ${record.recording_id}`);
  return lines;
}

/**
 * Render a transcript record as a downloadable document. `txt` is plain text;
 * `md` is Markdown with headed sections. Pure function — no IO — so it is unit
 * tested directly.
 */
export function formatTranscript(record: TranscriptRecord, format: ExportFormat): string {
  const title = record.title?.trim() || 'Transcript';
  const transcript = record.transcript ?? '';
  const summary = record.summary?.trim();

  if (format === 'md') {
    const parts = [`# ${title}`, '', ...exportMeta(record).map((l) => `- **${l.replace(': ', ':** ')}`)];
    if (summary) parts.push('', '## Summary', '', summary);
    parts.push('', '## Transcript', '', transcript, '');
    return parts.join('\n');
  }

  // txt
  const parts = [title, ...exportMeta(record)];
  if (summary) parts.push('', 'Summary:', summary);
  parts.push('', transcript, '');
  return parts.join('\n');
}

/** Filesystem-safe basename for an exported transcript (no extension). */
export function exportFilename(record: TranscriptRecord): string {
  const base = (record.title?.trim() || record.recording_id || 'transcript')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'transcript';
}
