import { definePersona } from '@agentworkforce/persona-kit';

/**
 * transcript-slack-digest — when a Relayscribe recording lands, post a clean
 * Slack digest of action items, decisions, and open questions. No issue filing,
 * no code. The simplest flow — good as a first step or for non-engineering teams.
 */
export default definePersona({
  id: 'transcript-slack-digest',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    'When a meeting transcript lands, posts a structured Slack digest of action items, decisions, and open questions. No issue filing, no code.',
  cloud: true,

  integrations: {
    recall: { scope: { recordings: '/recall/recordings/**' } },
    slack: { scope: { channels: '/slack/channels/**' } },
  },

  inputs: {
    SLACK_CHANNEL: {
      description: 'Channel to post the meeting digest.',
      env: 'SLACK_CHANNEL',
      picker: { provider: 'slack', resource: 'channels' },
    },
  },

  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt:
    'Extract action items, decisions, and open questions from meeting transcripts and post a clean Slack digest. ' +
    'Group by owner when attribution is clear. Surface blockers and unresolved questions separately. ' +
    'Be concise — every line should earn its place. Transcripts may be in any language or dialect, including Norwegian dialects (Sunnmøre, Bergensk, Trøndersk, Nordnorsk) and other Scandinavian speech — read them natively and respond in the same language.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 120 },

  onEvent: './agent.ts',
});
