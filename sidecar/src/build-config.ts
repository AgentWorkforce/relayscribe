// Packaged sidecar defaults. Public endpoints are baked in here so dev/unsigned
// builds work out of the box; the auth token stays empty and is provided at
// runtime (per-customer sign-in → RELAY_ACCESS_TOKEN) or injected by the signed
// release workflow. server.ts reads env first, then these defaults.
export const DEFAULT_WORKER_URL = 'https://transcription.agentrelay.com';
export const DEFAULT_RECORDER_TRANSCRIBE_TOKEN = '';
export const DEFAULT_RECALL_API_URL = 'https://us-west-2.recall.ai';
export const DEFAULT_RELAY_CONNECT_URL = 'https://transcription.agentrelay.com/integrations/{provider}/connect';
export const DEFAULT_TRANSCRIPTS_INGEST_URL = 'https://agentrelay.com/cloud/api/v1/webhooks/transcripts';
