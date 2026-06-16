/**
 * transcript-slack-digest handler.
 *
 *   /recall/recordings/<id>.json lands
 *     → extract action items, decisions, open questions
 *     → post structured Slack digest
 */
import { defineAgent, type WorkforceCtx } from '@agentworkforce/runtime';
import { slackClient } from '@relayfile/relay-helpers';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

async function buildDigest(ctx: WorkforceCtx, transcript: string, title: string): Promise<string> {
  const prompt = [
    'Produce a Slack digest for this meeting. Reply with plain text formatted for Slack (use *bold*, _italic_, • bullets).',
    '',
    'Sections to include (omit any section that has no content):',
    '• *Action items* — concrete next steps with owner if known',
    '• *Decisions* — conclusions reached',
    '• *Open questions* — unresolved items that need a follow-up',
    '',
    'Keep it tight. If there is nothing to report, reply with a single line: "(nothing actionable)".',
    '',
    `Meeting title: ${title || '(untitled)'}`,
    '',
    'Transcript:',
    transcript.slice(0, 20000),
  ].join('\n');

  return ctx.llm.complete(prompt, { maxTokens: 800 });
}

export default defineAgent({
  triggers: { recall: [{ on: 'file.created' }] },
  handler: async (ctx, event) => {
    const data = (await event.expand('full')).data as Record<string, unknown>;
    const notePath = str(data.path ?? data.key);
    if (!notePath.includes('/recall/recordings/') || !notePath.endsWith('.json')) return;

    let note: Record<string, unknown>;
    try {
      note = JSON.parse(await ctx.fs.readFile(notePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      return;
    }

    const transcript = str(note.transcript_text) || str(note.transcript) || str(note.summary_text);
    if (!transcript.trim()) return;

    const title = str(note.title) || str(note.meetingTitle) || 'Meeting';
    const digest = await buildDigest(ctx, transcript, title);

    if (digest.trim() && digest !== '(nothing actionable)') {
      const channel = ctx.inputs.SLACK_CHANNEL as string;
      await slackClient().post(channel, `*${title}*\n\n${digest}`);
    }
  },
});
