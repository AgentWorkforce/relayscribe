# transcript-slack-digest

Instantly deploy this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/relayscribe/blob/main/agents/transcript-slack-digest/persona.ts)

When a Relayscribe recording lands, this agent extracts action items, decisions, and open questions from the transcript and posts a clean Slack digest. The simplest flow — no issue tracker, no code. Good as a first step or for non-engineering teams.

## Flow

```
Relayscribe recording
  → /recall/recordings/<id>.json
    → extract action items, decisions, open questions
      → Slack digest
```

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `SLACK_CHANNEL` | Yes | Channel to post the meeting digest |

## Integrations needed

- **Recall** — transcript source (wired automatically by Relayscribe)
- **Slack** — digest output
