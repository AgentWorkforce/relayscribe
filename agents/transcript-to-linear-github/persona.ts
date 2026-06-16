import { definePersona } from '@agentworkforce/persona-kit';

/**
 * transcript-to-linear-github — when a Relayscribe recording lands, extract
 * action items, file a Linear issue per item, and autonomously open a GitHub PR
 * for each coding task.
 *
 * Transcript source: /recall/recordings/<id>.json (Recall Desktop SDK via
 * Relayscribe) or /granola/notes/<id>.json (Granola). Deploy this persona
 * pointing at whichever integrations your team uses.
 */
export default definePersona({
  id: 'transcript-to-linear-github',
  intent: 'relay-orchestrator',
  tags: ['discovery', 'implementation'],
  description:
    'When a meeting transcript lands, extracts action items, files them as Linear issues, and autonomously opens a GitHub PR for each coding task.',
  cloud: true,

  integrations: {
    recall: { scope: { recordings: '/recall/recordings/**' } },
    linear: {
      scope: {
        projects: '/linear/projects/**',
        teams: '/linear/teams/**',
        issues: '/linear/issues/**',
      },
    },
    github: {},
    slack: { scope: { channels: '/slack/channels/**' } },
  },

  inputs: {
    SLACK_CHANNEL: {
      description: 'Channel for the action-item digest.',
      env: 'SLACK_CHANNEL',
      picker: { provider: 'slack', resource: 'channels' },
    },
    QUESTION_CHANNEL: {
      description: 'Channel for clarifying questions when an item is blocked. Defaults to SLACK_CHANNEL.',
      env: 'QUESTION_CHANNEL',
      optional: true,
      picker: { provider: 'slack', resource: 'channels' },
    },
    GITHUB_REPO: {
      description: 'GitHub repo to open PRs against (org/repo).',
      env: 'GITHUB_REPO',
    },
    LINEAR_TEAM_ID: {
      description: 'Linear team to file issues under. Auto-resolved when you have a single team.',
      env: 'LINEAR_TEAM_ID',
      optional: true,
      picker: { provider: 'linear', resource: 'teams' },
    },
    CREATE_ISSUES: {
      description: 'Set to "false" for Slack digest only without filing Linear issues.',
      env: 'CREATE_ISSUES',
      default: 'true',
    },
    OPEN_PRS: {
      description: 'Set to "false" to file issues only without opening PRs.',
      env: 'OPEN_PRS',
      default: 'true',
    },
  },

  harness: 'claude',
  model: 'claude-sonnet-4-6',
  systemPrompt:
    'You extract concrete action items from meeting transcripts, file them as Linear issues, and for well-scoped coding tasks open a GitHub PR autonomously. ' +
    'Be precise: surface real commitments and decisions with a next step. Never invent tasks or pad the list. ' +
    'Transcripts may be in any language or dialect — including Norwegian dialects (Sunnmøre, Bergensk, Trøndersk, Nordnorsk) and other Scandinavian speech. Read them natively; respond in the same language the speaker used.',
  harnessSettings: { reasoning: 'medium', timeoutSeconds: 600 },

  onEvent: './agent.ts',
});
