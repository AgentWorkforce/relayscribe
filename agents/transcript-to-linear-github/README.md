# transcript-to-linear-github

Instantly deploy this agent on Agent Relay

[![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/relayscribe/blob/main/agents/transcript-to-linear-github/persona.ts)

When a Relayscribe recording lands, this agent extracts every concrete action item from the transcript, files it as a Linear issue, and — for well-scoped coding tasks — autonomously opens a GitHub PR. No manual handoff at any step.

## Flow

```
Relayscribe recording
  → /recall/recordings/<id>.json
    → extract action items
      → coding task  → Linear issue (agent-dispatchable) → GitHub PR
      → other task   → Linear issue (needs-triage)
      → blocked item → Slack question
    → Slack digest of everything filed
```

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `SLACK_CHANNEL` | Yes | Channel for the action-item digest |
| `GITHUB_REPO` | Yes | Repo to open PRs against (`org/repo`) |
| `LINEAR_TEAM_ID` | No | Auto-resolved when you have one team |
| `QUESTION_CHANNEL` | No | Channel for clarifying questions (defaults to `SLACK_CHANNEL`) |
| `CREATE_ISSUES` | No | Set to `"false"` for Slack digest only (default: `"true"`) |
| `OPEN_PRS` | No | Set to `"false"` to file issues without opening PRs (default: `"true"`) |

## Integrations needed

- **Recall** — transcript source (wired automatically by Relayscribe)
- **Linear** — issue filing
- **GitHub** — PR authoring
- **Slack** — digest and questions
