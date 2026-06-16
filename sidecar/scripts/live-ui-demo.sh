#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CLAUDE_BIN="${RELAYSCRIBE_UI_CLAUDE_BIN:-claude}"
if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  echo "Claude CLI is required for the constrained local /ui/generate demo. Set RELAYSCRIBE_UI_CLAUDE_BIN if needed." >&2
  exit 2
fi

export SIDECAR_PORT="${SIDECAR_PORT:-3717}"
export RELAYSCRIBE_WORKSPACE_ID="${RELAYSCRIBE_WORKSPACE_ID:-live-demo}"
export RELAYSCRIBE_RECORDINGS_DIR="${RELAYSCRIBE_RECORDINGS_DIR:-$(mktemp -d)}"
export RELAYSCRIBE_WORKSPACE_DIR="${RELAYSCRIBE_WORKSPACE_DIR:-$(mktemp -d)}"

OUT_DIR="${RELAYSCRIBE_UI_DEMO_OUT:-$ROOT_DIR/demo-output/ui-live-$(date -u +%Y%m%dT%H%M%SZ)}"
BASE_URL="http://127.0.0.1:$SIDECAR_PORT"

mkdir -p "$RELAYSCRIBE_RECORDINGS_DIR" "$RELAYSCRIBE_WORKSPACE_DIR" "$OUT_DIR"
echo "Using constrained local Claude generator for /ui/generate."
echo "Claude binary: $(command -v "$CLAUDE_BIN")."
echo "Claude model: ${RELAYSCRIBE_UI_CLAUDE_MODEL:-${RELAYSCRIBE_UI_RELAY_MODEL:-sonnet}}."

node <<'NODE'
const fs = require('fs');
const path = require('path');

const dir = process.env.RELAYSCRIBE_RECORDINGS_DIR;
const fixtures = [
  ['demo-session-1', '2026-06-01T09:00:00.000Z'],
  ['demo-session-2', '2026-06-08T09:00:00.000Z'],
  ['demo-session-3', '2026-06-09T09:00:00.000Z'],
];

fs.mkdirSync(dir, { recursive: true });
for (const [sessionId, createdAt] of fixtures) {
  const filePath = path.join(dir, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify({
      transcript: [
        { speaker: 'You', start: 0, text: `Kickoff for ${sessionId}` },
        { speaker: 'Speaker 1', start: 12.4, text: 'Demo transcript turn.' },
      ],
    }, null, 2));
  }
  const date = new Date(createdAt);
  fs.utimesSync(filePath, date, date);
}
NODE

npm run build > "$OUT_DIR/build.log" 2>&1

node dist/server.js > "$OUT_DIR/sidecar.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 60); do
  if curl -fsS "$BASE_URL/health" > "$OUT_DIR/health.json"; then
    break
  fi
  sleep 1
done

if ! curl -fsS "$BASE_URL/health" > "$OUT_DIR/health.json"; then
  echo "Sidecar did not become healthy at $BASE_URL. See $OUT_DIR/sidecar.log" >&2
  exit 1
fi

curl -fsS -X DELETE "$BASE_URL/ui/spec" > "$OUT_DIR/reset-spec.json"
curl -fsS "$BASE_URL/recordings" > "$OUT_DIR/recordings.json"

post_generate() {
  local request="$1"
  local output="$2"
  local status

  status="$(curl -sS \
    -X POST "$BASE_URL/ui/generate" \
    -H 'content-type: application/json' \
    -d "{\"request\":\"$request\"}" \
    -o "$output" \
    -w '%{http_code}')"
  printf '%s\n' "$status" > "$output.status"
  if [[ "$status" != "200" ]]; then
    echo "/ui/generate failed for '$request' with HTTP $status" >&2
    cat "$output" >&2
    exit 1
  fi
}

post_generate "list my recent recordings" "$OUT_DIR/01-recent-recordings-spec.json"
post_generate "show meeting frequency" "$OUT_DIR/02-meeting-frequency-spec.json"

curl -fsS "$BASE_URL/ui/spec" > "$OUT_DIR/final-spec.json"
curl -fsS "$BASE_URL/ui" > "$OUT_DIR/ui.html"

node - "$OUT_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2];
const finalSpec = JSON.parse(fs.readFileSync(path.join(outDir, 'final-spec.json'), 'utf8'));
const html = fs.readFileSync(path.join(outDir, 'ui.html'), 'utf8');
const components = Array.isArray(finalSpec.components) ? finalSpec.components : [];

const hasRecordingsList = components.some((component) =>
  component.type === 'list' &&
  component.data?.capability === 'data.recordings'
);
const hasFrequencyChart = components.some((component) =>
  component.type === 'chart' &&
  component.data?.capability === 'data.recordings' &&
  typeof component.data?.derive === 'string' &&
  component.data.derive.startsWith('frequency.')
);
const hasRenderer = html.includes('<div id="surface"></div>') && html.includes('textContent');

if (!hasRecordingsList) throw new Error('final spec is missing the recordings list');
if (!hasFrequencyChart) throw new Error('final spec is missing the meeting frequency chart');
if (!hasRenderer) throw new Error('GET /ui did not return the runtime renderer');

const summary = [
  '# Runtime UI Live Demo',
  `Base URL: ${process.env.SIDECAR_PORT ? `http://127.0.0.1:${process.env.SIDECAR_PORT}` : '(unknown)'}`,
  `Workspace: ${finalSpec.workspace}`,
  `Recordings dir: ${process.env.RELAYSCRIBE_RECORDINGS_DIR}`,
  `Workspace dir: ${process.env.RELAYSCRIBE_WORKSPACE_DIR}`,
  `Generation: constrained local Claude subprocess with --tools "" and JSON schema output`,
  `Claude binary: ${process.env.RELAYSCRIBE_UI_CLAUDE_BIN || 'claude'}`,
  `Claude model: ${process.env.RELAYSCRIBE_UI_CLAUDE_MODEL || process.env.RELAYSCRIBE_UI_RELAY_MODEL || 'sonnet'}`,
  '',
  'Captured:',
  '- health.json',
  '- recordings.json',
  '- 01-recent-recordings-spec.json',
  '- 02-meeting-frequency-spec.json',
  '- final-spec.json',
  '- ui.html',
  '- sidecar.log',
  '',
  'Assertions:',
  '- Recent recordings list uses data.recordings',
  '- Meeting frequency chart uses data.recordings with a frequency derivation',
  '- GET /ui returned the textContent-based runtime renderer',
  '',
].join('\n');

fs.writeFileSync(path.join(outDir, 'summary.md'), summary);
console.log(summary);
NODE

echo "Demo artifacts written to $OUT_DIR"
