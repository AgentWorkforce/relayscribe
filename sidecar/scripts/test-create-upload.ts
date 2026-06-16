#!/usr/bin/env npx tsx
/**
 * test-create-upload.ts — smoke-test the Desktop→backend create-upload link.
 *
 * Usage:
 *   WORKER_URL=https://... RECORDER_TRANSCRIBE_TOKEN=... npx tsx scripts/test-create-upload.ts
 *
 * Or with a .env file in the sidecar/ directory:
 *   npx tsx scripts/test-create-upload.ts
 *
 * Confirms:
 *   1. POST /recall/create-upload succeeds (201)
 *   2. Response contains `id` and `upload_token`
 *   3. Prints full response for E2E evidence
 */
import 'dotenv/config';

const WORKER_URL = (process.env.WORKER_URL ?? '').replace(/\/+$/, '');
const SHARED_TOKEN = process.env.RECORDER_TRANSCRIBE_TOKEN ?? '';

async function main() {
  if (!WORKER_URL || !SHARED_TOKEN) {
    console.error('ERROR: Set WORKER_URL and RECORDER_TRANSCRIBE_TOKEN in .env or environment.');
    process.exit(1);
  }

  const endpoint = `${WORKER_URL}/recall/create-upload`;
  console.log(`\n[test-create-upload] POST ${endpoint}`);
  console.log(`[test-create-upload] Authorization: Bearer ${SHARED_TOKEN.slice(0, 6)}…\n`);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${SHARED_TOKEN}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });

  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }

  console.log(`Status:  ${res.status} ${res.statusText}`);
  console.log(`Headers: content-type=${res.headers.get('content-type')}`);
  console.log(`Body:    ${JSON.stringify(body, null, 2)}`);

  if (!res.ok) {
    console.error(`\n❌ FAIL: create-upload returned ${res.status}`);
    process.exit(1);
  }

  const json = body as Record<string, unknown>;
  const ok = typeof json.id === 'string' && typeof json.upload_token === 'string';
  if (!ok) {
    console.error('\n❌ FAIL: response missing `id` or `upload_token`');
    console.error('  Expected: { id: string, upload_token: string, ... }');
    process.exit(1);
  }

  console.log(`\n✅ PASS`);
  console.log(`   upload id:    ${json.id}`);
  console.log(`   upload_token: ${String(json.upload_token).slice(0, 12)}…`);
  if (json.recording_id) console.log(`   recording_id: ${json.recording_id}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
