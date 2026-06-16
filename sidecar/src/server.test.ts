import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relayscribe-recordings-'));
process.env.RELAYSCRIBE_RECORDINGS_DIR = recordingsDir;

async function readJson(res: Response): Promise<unknown> {
  return res.json();
}

async function main() {
  const { app } = await import('./server');

  const sessionId = 'session-123';
  fs.writeFileSync(
    path.join(recordingsDir, `${sessionId}.json`),
    JSON.stringify({
      transcript: [
        { speaker: 'You', start: 1.2, text: 'Hva er status på prosjektet?' },
        { speaker: 'Speaker 1', timestamp: 3.5, text: 'Vi er "nesten" ferdig.' },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(recordingsDir, '..', 'secret.json'),
    JSON.stringify({ transcript: [{ speaker: 'Bad', start: 0, text: 'must not read' }] }),
  );
  fs.writeFileSync(
    path.join(recordingsDir, 'evil..session.json'),
    JSON.stringify({ transcript: [{ speaker: 'Bad', start: 0, text: 'must not read' }] }),
  );

  const transcriptRes = await app.request('/recordings/transcript?sessionId=session-123');
  assert.equal(transcriptRes.status, 200);
  assert.deepEqual(await readJson(transcriptRes), [
    { sessionId: 'session-123', speaker: 'You', timestamp: '1.2', text: 'Hva er status på prosjektet?' },
    { sessionId: 'session-123', speaker: 'Speaker 1', timestamp: '3.5', text: 'Vi er "nesten" ferdig.' },
  ]);

  const transcriptMissingRes = await app.request('/recordings/transcript?sessionId=unknown-id');
  assert.equal(transcriptMissingRes.status, 404);
  assert.deepEqual(await readJson(transcriptMissingRes), { error: 'recording not found' });

  const transcriptTraversalRes = await app.request('/recordings/transcript?sessionId=../secret');
  assert.equal(transcriptTraversalRes.status, 400);
  assert.deepEqual(await readJson(transcriptTraversalRes), { error: 'invalid sessionId' });

  const transcriptDotDotRes = await app.request('/recordings/transcript?sessionId=evil..session');
  assert.equal(transcriptDotDotRes.status, 400);
  assert.deepEqual(await readJson(transcriptDotDotRes), { error: 'invalid sessionId' });

  const searchRes = await app.request('/recordings/search?query=nesten');
  assert.equal(searchRes.status, 200);
  assert.deepEqual(await readJson(searchRes), [
    { sessionId: 'session-123', speaker: 'Speaker 1', timestamp: '3.5', text: 'Vi er "nesten" ferdig.' },
  ]);

  const badSearchRes = await app.request('/recordings/search?query=%3Cscript%3E');
  assert.equal(badSearchRes.status, 400);
  assert.deepEqual(await readJson(badSearchRes), { error: 'invalid query' });

  const healthRes = await app.request('/health');
  assert.equal(healthRes.status, 200);
  assert.equal((await readJson(healthRes) as { ok?: boolean }).ok, true);

  const stateRes = await app.request('/state');
  assert.equal(stateRes.status, 200);
  assert.deepEqual(await readJson(stateRes), { status: 'idle' });

  const stopRes = await app.request('/recording/stop', { method: 'POST' });
  assert.equal(stopRes.status, 200);
  assert.equal((await readJson(stopRes) as { ok?: boolean }).ok, true);

  const configRes = await app.request('/config');
  assert.equal(configRes.status, 200);
  assert.equal((await readJson(configRes) as { port?: number }).port, 3700);
}

main()
  .finally(() => {
    fs.rmSync(recordingsDir, { recursive: true, force: true });
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
