import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { createUiRoutes, testInternals } from './ui-routes';
import { BrokerUnavailableError } from './harness-generate';

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relayscribe-ui-'));
const recordingsDir = path.join(rootDir, 'recordings');
const workspaceDir = path.join(rootDir, 'workspace', 'test-workspace');
fs.mkdirSync(recordingsDir, { recursive: true });

process.env.RELAYSCRIBE_RECORDINGS_DIR = recordingsDir;
process.env.RELAYSCRIBE_WORKSPACE_ID = 'test-workspace';
process.env.RELAYSCRIBE_WORKSPACE_DIR = workspaceDir;

const SAMPLE_DOC = '<!doctype html><html><head><title>Recorder</title></head><body><button id="rec">Record</button><script>document.getElementById("rec").onclick=()=>window.relayscribe.record();</script></body></html>';

function routeApp(options: Parameters<typeof createUiRoutes>[0]) {
  const app = new Hono();
  app.route('/', createUiRoutes(options));
  return app;
}

async function main() {
  // ── unit: extractHtmlDocument strips fences + prose ────────────────────────
  assert.equal(
    testInternals.extractHtmlDocument('Sure! Here you go:\n```html\n<!doctype html><html></html>\n```'),
    '<!doctype html><html></html>',
  );
  assert.equal(
    testInternals.extractHtmlDocument('<html><body>hi</body></html>'),
    '<html><body>hi</body></html>',
  );

  // ── unit: injectBridge defines window.relayscribe before app scripts ──────────
  const injected = testInternals.injectBridge('<html><head><title>x</title></head><body></body></html>');
  assert.ok(injected.includes('data-relayscribe-bridge'), 'bridge script injected');
  assert.ok(injected.indexOf('data-relayscribe-bridge') < injected.indexOf('<title>'), 'bridge precedes head content');
  assert.ok(testInternals.readBridgeSource().includes('window'), 'bridge source loads from public/bridge.js');

  // injectBridge also handles documents with no <head>
  const noHead = testInternals.injectBridge('<html><body>hi</body></html>');
  assert.ok(noHead.includes('data-relayscribe-bridge'), 'bridge injected even without <head>');

  // ── route: starter UI served with bridge when nothing generated yet ────────
  const app = routeApp({ recordingsDir, workspaceDir, workspaceId: 'test-workspace' });

  const starter = await app.request('/ui');
  assert.equal(starter.status, 200);
  const starterHtml = await starter.text();
  assert.ok(starterHtml.includes('data-relayscribe-bridge'), 'starter carries the bridge');
  assert.ok(/Generative UI/i.test(starterHtml), 'starter is the malleable welcome');

  const bridgeRes = await app.request('/bridge.js');
  assert.equal(bridgeRes.status, 200);
  assert.match(bridgeRes.headers.get('content-type') ?? '', /javascript/);

  const currentEmpty = await app.request('/ui/current');
  assert.deepEqual(await currentEmpty.json(), { exists: false, workspace: 'test-workspace', html: '' });

  // ── route: generate persists the model's free-form document ────────────────
  const calls: Array<{ request: string; currentHtml: string | null }> = [];
  const genApp = routeApp({
    recordingsDir,
    workspaceDir,
    workspaceId: 'test-workspace',
    generate: async (request, ctx) => {
      calls.push({ request, currentHtml: ctx.currentHtml });
      return 'Here is your app:\n```html\n' + SAMPLE_DOC + '\n```';
    },
  });

  const gen = await genApp.request('/ui/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'big record button' }),
  });
  assert.equal(gen.status, 200);
  const genBody = (await gen.json()) as { ok: boolean; html: string };
  assert.equal(genBody.ok, true);
  assert.equal(genBody.html, SAMPLE_DOC);
  assert.equal(calls[0].request, 'big record button');
  assert.equal(calls[0].currentHtml, null, 'first generation has no prior doc');

  // served /ui now returns the generated doc + injected bridge
  const served = await app.request('/ui');
  const servedHtml = await served.text();
  assert.ok(servedHtml.includes('id="rec"'), 'generated doc is served');
  assert.ok(servedHtml.includes('data-relayscribe-bridge'), 'bridge injected into generated doc');

  // ── route: iterate passes the current doc back to the model ────────────────
  const iterate = await genApp.request('/ui/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'now make it light' }),
  });
  assert.equal(iterate.status, 200);
  const lastCall = calls[calls.length - 1];
  assert.ok(lastCall.currentHtml && lastCall.currentHtml.includes('id="rec"'), 'iteration receives prior doc');

  // ── route: invalid + non-HTML + reset ──────────────────────────────────────
  const bad = await genApp.request('/ui/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: '' }),
  });
  assert.equal(bad.status, 400);

  const junkApp = routeApp({
    recordingsDir,
    workspaceDir: path.join(rootDir, 'workspace', 'junk-ws'),
    workspaceId: 'junk-ws',
    generate: async () => 'I cannot do that.',
  });
  const junk = await junkApp.request('/ui/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'x' }),
  });
  assert.equal(junk.status, 422, 'non-HTML output rejected');

  // an unreachable broker surfaces as llm_unavailable (503); other errors → 502
  const brokerDownApp = routeApp({
    recordingsDir, workspaceDir, workspaceId: 'test-workspace',
    generate: async () => { throw new BrokerUnavailableError('no running broker'); },
  });
  const brokerDown = await brokerDownApp.request('/ui/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'anything' }),
  });
  assert.equal(brokerDown.status, 503, 'broker unavailable → llm_unavailable');

  const erroringApp = routeApp({
    recordingsDir, workspaceDir, workspaceId: 'test-workspace',
    generate: async () => { throw new Error('agent exited'); },
  });
  const erroring = await erroringApp.request('/ui/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'anything' }),
  });
  assert.equal(erroring.status, 502, 'generation error → llm_failed');

  const del = await app.request('/ui', { method: 'DELETE' });
  assert.equal(del.status, 200);
  const afterReset = await app.request('/ui');
  assert.ok(/Generative UI/i.test(await afterReset.text()), 'reset returns to starter');

  // ── POST /ui/document: store a caller-provided document (Swift path) ───────
  const docApp = routeApp({ recordingsDir, workspaceDir: path.join(rootDir, 'workspace', 'doc-ws'), workspaceId: 'doc-ws' });
  const goodDoc = await docApp.request('/ui/document', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ html: '```html\n' + SAMPLE_DOC + '\n```' }),
  });
  assert.equal(goodDoc.status, 200, 'POST /ui/document stores a document');
  const docServed = await docApp.request('/ui');
  assert.ok((await docServed.text()).includes('id="rec"'), 'stored document is served');
  const badDoc = await docApp.request('/ui/document', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ html: 'not html' }),
  });
  assert.equal(badDoc.status, 422, 'non-HTML document rejected');
  const emptyDoc = await docApp.request('/ui/document', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(emptyDoc.status, 400, 'missing html rejected');

  // ── GET /ui/status: idle by default ───────────────────────────────────────
  const statusApp = routeApp({ recordingsDir, workspaceDir: path.join(rootDir, 'workspace', 'st-ws'), workspaceId: 'st-ws' });
  const statusIdle = await statusApp.request('/ui/status');
  assert.equal(statusIdle.status, 200);
  const idleBody = (await statusIdle.json()) as { state: string; exists: boolean; jobId?: string };
  assert.equal(idleBody.state, 'idle', 'fresh app starts idle');
  assert.equal(idleBody.exists, false);
  assert.equal(idleBody.jobId, undefined);

  // ── POST /ui/generate async:true → 202 + jobId, then idle ─────────────────
  let resolveAsync!: () => void;
  const asyncGenApp = routeApp({
    recordingsDir,
    workspaceDir: path.join(rootDir, 'workspace', 'async-ws'),
    workspaceId: 'async-ws',
    generate: async (request, ctx) => {
      await new Promise<void>((res) => { resolveAsync = res; });
      return SAMPLE_DOC;
    },
  });

  const asyncReq = await asyncGenApp.request('/ui/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'async generate test', async: true }),
  });
  assert.equal(asyncReq.status, 202, 'async generate returns 202');
  const asyncBody = (await asyncReq.json()) as { jobId: string; state: string };
  assert.ok(typeof asyncBody.jobId === 'string' && asyncBody.jobId.startsWith('gen_'), 'jobId returned');
  assert.equal(asyncBody.state, 'generating');

  // while generating, /ui/status should reflect 'generating'
  const generatingStatus = await asyncGenApp.request('/ui/status');
  const gBody = (await generatingStatus.json()) as { state: string; jobId: string; elapsedMs?: number };
  assert.equal(gBody.state, 'generating');
  assert.equal(gBody.jobId, asyncBody.jobId);
  assert.ok(typeof gBody.elapsedMs === 'number', 'elapsedMs present while generating');

  // 409 when already generating
  const alreadyGen = await asyncGenApp.request('/ui/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'concurrent', async: true }),
  });
  assert.equal(alreadyGen.status, 409, 'concurrent async generate → 409');

  // resolve the blocked generator; wait for background task to settle
  resolveAsync();
  await new Promise<void>((res) => setTimeout(res, 50));

  const doneStatus = await asyncGenApp.request('/ui/status');
  const doneBody = (await doneStatus.json()) as { state: string; exists: boolean };
  assert.equal(doneBody.state, 'idle', 'status is idle after completion');
  assert.equal(doneBody.exists, true, 'document persisted after async generation');

  // ── POST /ui/generate async:true → error path ─────────────────────────────
  const asyncErrApp = routeApp({
    recordingsDir,
    workspaceDir: path.join(rootDir, 'workspace', 'async-err-ws'),
    workspaceId: 'async-err-ws',
    generate: async () => { throw new Error('agent crashed'); },
  });
  await asyncErrApp.request('/ui/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'will fail', async: true }),
  });
  await new Promise<void>((res) => setTimeout(res, 50));
  const errStatus = await asyncErrApp.request('/ui/status');
  const errBody = (await errStatus.json()) as { state: string; error?: string };
  assert.equal(errBody.state, 'error', 'status is error after failed async generation');
  assert.ok(typeof errBody.error === 'string', 'error message surfaced');

  // ── opt-in gate: when disabled, the whole /ui* surface is inert ────────────
  let calledWhileOff = false;
  const offApp = routeApp({
    recordingsDir,
    workspaceDir,
    workspaceId: 'test-workspace',
    isEnabled: () => false,
    generate: async () => { calledWhileOff = true; return SAMPLE_DOC; },
  });
  const offUi = await offApp.request('/ui');
  assert.equal(offUi.status, 200);
  const offHtml = await offUi.text();
  assert.ok(!offHtml.includes('data-relayscribe-bridge'), 'disabled /ui carries no bridge');
  assert.ok(!offHtml.includes('id="rec"'), 'disabled /ui does not serve the stored generated doc');
  assert.ok(/is off/i.test(offHtml), 'disabled /ui is the inert page');

  assert.equal((await offApp.request('/bridge.js')).status, 403, 'disabled /bridge.js is 403');
  assert.equal((await offApp.request('/ui/current')).status, 403, 'disabled /ui/current is 403');
  assert.equal((await offApp.request('/ui/raw')).status, 403, 'disabled /ui/raw is 403');
  const offGen = await offApp.request('/ui/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request: 'sneak in a UI' }),
  });
  assert.equal(offGen.status, 403, 'disabled /ui/generate is 403');
  assert.equal(calledWhileOff, false, 'generator never runs while disabled');

  console.log('ui.test.ts: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
