/**
 * transcript-to-linear-github handler.
 *
 *   /recall/recordings/<id>.json lands (Recall Desktop SDK / Relayscribe)
 *     → extract action items → route each as code | task | question
 *     → code:     Linear issue (agent-dispatchable) + open GitHub PR
 *     → task:     Linear issue (needs-triage)
 *     → question: Slack message to question channel
 *     → digest:   summary post to SLACK_CHANNEL
 */
import { defineAgent, listJsonFiles, type WorkforceCtx } from '@agentworkforce/runtime';
import { relayClient, slackClient } from '@relayfile/relay-helpers';

type Route = 'code' | 'task' | 'question' | 'drop';

interface ActionItem {
  route: Route;
  title: string;
  intent: string;
  speaker: string | null;
  acceptance_criteria: string[];
  question?: string;
}

interface Extraction {
  meetingTitle: string;
  summary: string;
  items: ActionItem[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

async function readTranscript(ctx: WorkforceCtx, notePath: string): Promise<{ note: Record<string, unknown>; transcript: string } | null> {
  try {
    const raw = await ctx.fs.readFile(notePath, 'utf-8');
    const note = JSON.parse(raw) as Record<string, unknown>;
    const transcript = str(note.transcript_text) || str(note.transcript) || str(note.summary_text);
    if (!transcript.trim()) return null;
    return { note, transcript };
  } catch {
    return null;
  }
}

async function resolveTeamId(ctx: WorkforceCtx, inputTeamId: string): Promise<string> {
  if (inputTeamId) return inputTeamId;
  try {
    const teams = await listJsonFiles(ctx, '/linear/teams');
    if (teams.length === 1) {
      const raw = await ctx.fs.readFile(teams[0], 'utf-8');
      return (JSON.parse(raw) as { id: string }).id;
    }
  } catch { /* fall through */ }
  throw new Error('LINEAR_TEAM_ID is required when you have more than one Linear team.');
}

async function extractItems(ctx: WorkforceCtx, transcript: string, title: string): Promise<Extraction> {
  const prompt = [
    'Extract action items from this meeting transcript. For each item assign exactly one route:',
    '- "code": a well-scoped coding task with ≥2 checkable acceptance criteria and a clear target area.',
    '- "task": a real commitment that is too broad, human-owned, or lacks a clear coding target.',
    '- "question": intent exists but a decision is needed before work can start — write the specific question.',
    '- "drop": status recaps, hypotheticals, completed work — omit entirely.',
    '',
    'Reply with JSON only:',
    '{"meetingTitle":"short title","summary":"1-3 sentences","items":[{',
    '  "route":"code"|"task"|"question",',
    '  "title":"imperative, ≤70 chars",',
    '  "intent":"1-2 sentences: the WHY",',
    '  "speaker":"name or null",',
    '  "acceptance_criteria":["objectively checkable; ≥2 for code route"],',
    '  "question":"only for question route"',
    '}]}',
    '',
    `Meeting title: ${title || '(none)'}`,
    '',
    'Transcript:',
    transcript.slice(0, 20000),
  ].join('\n');

  const fallback: Extraction = { meetingTitle: title || 'Meeting', summary: '', items: [] };
  try {
    const raw = (await ctx.llm.complete(prompt, { maxTokens: 2000 })).replace(/```json\s*|```/g, '').trim();
    const e = JSON.parse(raw) as Extraction;
    if (!Array.isArray(e.items)) e.items = [];
    e.items = e.items.filter((i) => i && str(i.title).trim() && i.route !== 'drop');
    if (!e.meetingTitle) e.meetingTitle = title || 'Meeting';
    return e;
  } catch {
    return fallback;
  }
}

export default defineAgent({
  triggers: { recall: [{ on: 'file.created' }] },
  handler: async (ctx, event) => {
    const data = (await event.expand('full')).data as Record<string, unknown>;
    const notePath = str(data.path ?? data.key);
    if (!notePath.includes('/recall/recordings/') || !notePath.endsWith('.json')) return;

    const result = await readTranscript(ctx, notePath);
    if (!result) {
      ctx.log('warn', 'transcript-to-linear-github.empty-transcript', { notePath });
      return;
    }
    const { note, transcript } = result;
    const title = str(note.title) || str(note.meetingTitle);

    const extraction = await extractItems(ctx, transcript, title);
    if (!extraction.items.length && !extraction.summary) return;

    const slackChannel = ctx.inputs.SLACK_CHANNEL as string;
    const questionChannel = (ctx.inputs.QUESTION_CHANNEL as string) || slackChannel;
    const githubRepo = ctx.inputs.GITHUB_REPO as string;
    const createIssues = (ctx.inputs.CREATE_ISSUES as string) !== 'false';
    const openPrs = (ctx.inputs.OPEN_PRS as string) !== 'false';

    const teamId = await resolveTeamId(ctx, ctx.inputs.LINEAR_TEAM_ID as string);
    const linear = relayClient('linear');
    const slack = slackClient();

    const digestLines: string[] = [`*${extraction.meetingTitle}*`, extraction.summary || ''];

    for (const item of extraction.items) {
      if (item.route === 'question') {
        const q = item.question || item.title;
        await slack.post(questionChannel, `:question: *${item.title}*\n${q}`);
        continue;
      }

      if (!createIssues) {
        digestLines.push(`• ${item.title}${item.speaker ? ` _(${item.speaker})_` : ''}`);
        continue;
      }

      const label = item.route === 'code' ? 'agent-dispatchable' : 'needs-triage';
      const description = [
        item.intent,
        '',
        item.acceptance_criteria.length ? `**Acceptance criteria:**\n${item.acceptance_criteria.map((c) => `- ${c}`).join('\n')}` : '',
      ].filter(Boolean).join('\n');

      const created = await linear.write('issues', {}, {
        teamId,
        title: item.title,
        description,
        labels: [label],
      });

      const issueUrl = str(created.receipt?.url);
      const issueId = str(created.receipt?.id ?? created.receipt?.identifier);
      digestLines.push(`• <${issueUrl || '#'}|${item.title}>${item.speaker ? ` _(${item.speaker})_` : ''}`);

      if (item.route === 'code' && openPrs && githubRepo) {
        const run = await ctx.harness.run({
          cwd: ctx.sandbox.cwd,
          prompt: [
            `Implement the following task and open a GitHub pull request. The GitHub integration opens the PR — do not use git or the gh CLI. Put the PR URL on the last line.`,
            `\nLinear issue: ${issueUrl || '(pending)'}`,
            `\n**Task:** ${item.title}`,
            `\n**Intent:** ${item.intent}`,
            item.acceptance_criteria.length ? `\n**Acceptance criteria:**\n${item.acceptance_criteria.map((c) => `- ${c}`).join('\n')}` : '',
          ].join(''),
        });
        const prUrl = run.output.match(/https?:\/\/\S*\/pull\/\d+/g)?.pop();
        if (prUrl && issueId) {
          await linear.write('comments', { issueId }, { body: `:rocket: PR: ${prUrl}` });
        }
      }
    }

    if (digestLines.some((l) => l.trim())) {
      await slack.post(slackChannel, digestLines.filter((l) => l.trim()).join('\n'));
    }
  },
});
