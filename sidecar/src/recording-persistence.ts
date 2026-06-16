import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { RecorderSettings } from './recorder-settings';
import type { RelayWorkspaceContext } from './relay-workspace';

export type PersistenceStatus = 'pending' | 'transcribed' | 'failed';

export interface RecordingEntry {
  id: string;
  audioPath: string;
  contentType: string;
  filename?: string;
  status: PersistenceStatus;
  timestamp: number;
  retryCount: number;
  lastAttemptAt?: number;
  relayWorkspaceId?: string;
  settings?: RecorderSettings;
}

interface Manifest {
  recordings: Record<string, RecordingEntry>;
}

export const MAX_RETRIES = 3;
export const RETRY_INTERVAL_MS = 5 * 60 * 1000;

function getAppSupportDir(): string {
  if (process.env.RELAYSCRIBE_RECORDINGS_DIR) return process.env.RELAYSCRIBE_RECORDINGS_DIR;
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Relayscribe');
  }
  return join(process.cwd(), '.relayscribe');
}

function recordingsDir(): string {
  return join(getAppSupportDir(), 'recordings');
}

function manifestPath(): string {
  return join(getAppSupportDir(), 'recording-manifest.json');
}

async function readManifest(): Promise<Manifest> {
  try {
    const raw = await readFile(manifestPath(), 'utf8');
    const parsed = JSON.parse(raw) as Manifest;
    return { recordings: parsed.recordings ?? {} };
  } catch {
    return { recordings: {} };
  }
}

async function writeManifest(manifest: Manifest): Promise<void> {
  await mkdir(getAppSupportDir(), { recursive: true });
  await writeFile(manifestPath(), JSON.stringify(manifest, null, 2), 'utf8');
}

function audioExtension(contentType: string): string {
  if (contentType.includes('mp4') || contentType.includes('m4a')) return 'm4a';
  if (contentType.includes('wav')) return 'wav';
  if (contentType.includes('webm')) return 'webm';
  return 'audio';
}

export function backoffDelayMs(retryCount: number): number {
  if (retryCount <= 0) return 0;
  return Math.pow(2, retryCount - 1) * 2 * 60 * 1000;
}

export async function persistAudio(
  audio: Uint8Array,
  opts: {
    contentType: string;
    filename?: string;
    relayWorkspaceContext?: RelayWorkspaceContext;
    settings?: RecorderSettings;
  },
): Promise<RecordingEntry> {
  await mkdir(recordingsDir(), { recursive: true });
  const id = randomUUID();
  const ext = audioExtension(opts.contentType);
  const audioPath = join(recordingsDir(), `${id}.${ext}`);
  await writeFile(audioPath, audio);

  const entry: RecordingEntry = {
    id,
    audioPath,
    contentType: opts.contentType,
    filename: opts.filename,
    status: 'pending',
    timestamp: Date.now(),
    retryCount: 0,
    relayWorkspaceId: opts.relayWorkspaceContext?.relay_workspace_id,
    settings: opts.settings,
  };

  const manifest = await readManifest();
  manifest.recordings[id] = entry;
  await writeManifest(manifest);
  console.log(`[persist] audio saved id=${id} path=${audioPath}`);
  return entry;
}

export async function markTranscribed(id: string): Promise<void> {
  const manifest = await readManifest();
  const entry = manifest.recordings[id];
  if (!entry) return;
  try { await unlink(entry.audioPath); } catch { /* already gone */ }
  delete manifest.recordings[id];
  await writeManifest(manifest);
  console.log(`[persist] transcribed id=${id} — audio deleted`);
}

export async function markFailed(id: string): Promise<void> {
  const manifest = await readManifest();
  const entry = manifest.recordings[id];
  if (!entry) return;
  entry.status = 'failed';
  entry.lastAttemptAt = Date.now();
  manifest.recordings[id] = entry;
  await writeManifest(manifest);
  console.log(`[persist] failed id=${id} retryCount=${entry.retryCount}`);
}

export async function bumpRetryCount(id: string): Promise<number> {
  const manifest = await readManifest();
  const entry = manifest.recordings[id];
  if (!entry) return 0;
  entry.retryCount += 1;
  entry.status = 'pending';
  entry.lastAttemptAt = Date.now();
  manifest.recordings[id] = entry;
  await writeManifest(manifest);
  return entry.retryCount;
}

export async function getRetryableEntries(nowMs?: number): Promise<RecordingEntry[]> {
  const manifest = await readManifest();
  const now = nowMs ?? Date.now();
  const results: RecordingEntry[] = [];
  const orphanIds: string[] = [];

  for (const [id, entry] of Object.entries(manifest.recordings)) {
    if (entry.status !== 'failed') continue;
    if (entry.retryCount >= MAX_RETRIES) continue;
    if (!existsSync(entry.audioPath)) {
      orphanIds.push(id);
      continue;
    }
    const delay = backoffDelayMs(entry.retryCount);
    const readyAt = (entry.lastAttemptAt ?? entry.timestamp) + delay;
    if (now >= readyAt) {
      results.push(entry);
    }
  }

  if (orphanIds.length > 0) {
    for (const id of orphanIds) delete manifest.recordings[id];
    await writeManifest(manifest);
  }

  return results;
}
