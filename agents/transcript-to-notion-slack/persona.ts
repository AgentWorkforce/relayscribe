import { definePersona } from '@agentworkforce/persona-kit';

/**
 * transcript-to-notion-slack — when a Relayscribe recording lands, write
 * structured meeting notes into a Notion database and post a Slack link.
 * Good for product, design, or ops teams who live in Notion rather than
 * an issue tracker.
 *
 * Requires the Notion integration to be connected with database write access.
 */
export default definePersona({
  id: 'transcript-to-notion-slack',
  intent: 'relay-orchestrator',
  tags: ['discovery'],
  description:
    'When a meeting transcript lands, writes structured notes and action items to a Notion database, then posts a Slack link.',
  cloud: true,

  integrations: {
    recall: { scope: { recordings: '/recall/recordings/**' } },
    notion: {
      scope: {
        databases: '/notion/databases/**',
        pages: '/notion/pages/**',
      },
    },
    slack: { scope: { channels: '/slack/channels/**' } },
  },

  inputs: {
    NOTION_DATABASE_ID: {
      description: 'Notion database to write meeting notes into.',
      env: 'NOTION_DATABASE_ID',
      picker: { provider: 'notion', resource: 'databases' },
    },
    SLACK_CHANNEL: {
      description: 'Channel to post the Notion page link after writing.',
      env: 'SLACK_CHANNEL',
      picker: { provider: 'slack', resource: 'channels' },
    },
  },

  harness: 'claude',
  model: 'claude-sonnet-4-6',
  systemPrompt:
    'Write structured meeting notes to Notion: a brief summary, decisions made, action items with owners and due dates, and open questions. ' +
    'Keep each section concise and scannable. Post the Notion page link to Slack when done. ' +
    'Transcripts may be in any language or dialect, including Norwegian dialects (Sunnmøre, Bergensk, Trøndersk, Nordnorsk) and other Scandinavian speech — read them natively and write the notes in the same language.',
  harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },

  onEvent: './agent.ts',
});
