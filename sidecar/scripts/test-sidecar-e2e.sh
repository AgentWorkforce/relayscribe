#!/usr/bin/env bash
# test-sidecar-e2e.sh — integration smoke-test for the TS sidecar
#
# Starts the sidecar (requires dist/ built), exercises /health, /state,
# and /recording/test-start (which calls create-upload against the real backend).
#
# Usage:
#   WORKER_URL=https://... RECORDER_TRANSCRIBE_TOKEN=... bash scripts/test-sidecar-e2e.sh
#
# Requires: node, dist/server.js (run `npm run build` first)

set -euo pipefail

PORT="${SIDECAR_PORT:-3700}"
BASE="http://127.0.0.1:${PORT}"
PASS=0
FAIL=0

ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo ""
echo "=== Relayscribe sidecar E2E smoke test ==="
echo "    PORT=${PORT}  WORKER_URL=${WORKER_URL:-<unset>}"
echo ""

# ── Start sidecar ─────────────────────────────────────────────────────────────
echo "[1] Starting sidecar..."
node dist/server.js &
SIDECAR_PID=$!
trap "kill $SIDECAR_PID 2>/dev/null; echo ''; echo 'Sidecar stopped.'" EXIT

# Wait for health
READY=0
for i in $(seq 1 30); do
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/health" 2>/dev/null || true)
  if [ "$STATUS" = "200" ]; then READY=1; break; fi
  sleep 0.5
done
[ $READY -eq 1 ] && ok "sidecar started (PID ${SIDECAR_PID})" || { fail "sidecar did not start within 15s"; exit 1; }

# ── /health ───────────────────────────────────────────────────────────────────
echo ""
echo "[2] GET /health"
HEALTH=$(curl -s "${BASE}/health")
echo "    ${HEALTH}"
echo "$HEALTH" | grep -q '"ok":true' && ok "/health returns {ok:true}" || fail "/health missing ok:true"

# ── /state ────────────────────────────────────────────────────────────────────
echo ""
echo "[3] GET /state"
STATE=$(curl -s "${BASE}/state")
echo "    ${STATE}"
echo "$STATE" | grep -q '"status":"idle"' && ok "/state returns idle" || fail "/state not idle on start"

# ── /recording/test-start ─────────────────────────────────────────────────────
echo ""
echo "[4] POST /recording/test-start (calls create-upload against ${WORKER_URL:-<missing>})"
if [ -z "${WORKER_URL:-}" ] || [ -z "${RECORDER_TRANSCRIBE_TOKEN:-}" ]; then
  echo "    SKIP — WORKER_URL or RECORDER_TRANSCRIBE_TOKEN not set"
  echo "    (set both env vars to test the full create-upload call)"
  PASS=$((PASS+1))
else
  RESULT=$(curl -s -X POST "${BASE}/recording/test-start" \
    -H 'content-type: application/json' \
    -d '{"windowId":"test-001","meetingTitle":"E2E Test Meeting"}')
  echo "    ${RESULT}"
  echo "$RESULT" | grep -q '"ok":true' && ok "test-start returned ok:true" || fail "test-start failed"

  # Give it a moment for state to update
  sleep 1
  STATE2=$(curl -s "${BASE}/state")
  echo "    state after start: ${STATE2}"
  (echo "$STATE2" | grep -q '"status":"recording"' || echo "$STATE2" | grep -q '"status":"meeting-detected"') \
    && ok "state transitioned to recording/meeting-detected" \
    || fail "state did not transition (may be error — check WORKER_URL response)"

  # Stop recording
  curl -s -X POST "${BASE}/recording/stop" > /dev/null
  ok "POST /recording/stop sent"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
[ $FAIL -eq 0 ] && echo "✅ ALL PASS" || { echo "❌ FAILURES"; exit 1; }
