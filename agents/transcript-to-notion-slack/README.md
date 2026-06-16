# transcript-to-notion-slack

Instantly deploy this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/relayscribe/blob/main/agents/transcript-to-notion-slack/persona.ts)

When a Relayscribe recording lands, this agent writes structured meeting notes — summary, decisions, action items with owners, open questions — into a Notion database, then posts the page link to Slack. Good for product, design, or ops teams who live in Notion rather than an issue tracker.

## Flow

```
Relayscribe recording
  → /recall/recordings/<id>.json
    → extract summary, decisions, action items, open questions
      → Notion page (in your configured database)
        → Slack link
```

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `NOTION_DATABASE_ID` | Yes | Notion database to write meeting notes into |
| `SLACK_CHANNEL` | Yes | Channel to post the Notion page link |

## Integrations needed

- **Recall** — transcript source (wired automatically by Relayscribe)
- **Notion** — page writing (requires database write access)
- **Slack** — link posting
