/**
 * transcript-to-notion-slack handler.
 *
 *   /recall/recordings/<id>.json lands
 *     → extract summary, decisions, action items, open questions
 *     → create Notion page in configured database
 *     → post Slack link
 */
import { defineAgent, type WorkforceCtx } from '@agentworkforce/runtime';
import { relayClient, slackClient } from '@relayfile/relay-helpers';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

interface MeetingNotes {
  summary: string;
  decisions: string[];
  actionItems: { owner: string | null; task: string; dueDate: string | null }[];
  openQuestions: string[];
}

async function extractNotes(ctx: WorkforceCtx, transcript: string, title: string): Promise<MeetingNotes> {
  const prompt = [
    'Extract structured meeting notes from this transcript. Reply with JSON only:',
    '{',
    '  "summary": "2-4 sentence overview of the meeting",',
    '  "decisions": ["decisions that were made"],',
    '  "actionItems": [{"owner":"name or null","task":"what needs to be done","dueDate":"date or null"}],',
    '  "openQuestions": ["unresolved questions that need follow-up"]',
    '}',
    '',
    'If a section has no content, use an empty array. Keep items concise and specific.',
    '',
    `Meeting title: ${title || '(untitled)'}`,
    '',
    'Transcript:',
    transcript.slice(0, 20000),
  ].join('\n');

  const fallback: MeetingNotes = { summary: '', decisions: [], actionItems: [], openQuestions: [] };
  try {
    const raw = (await ctx.llm.complete(prompt, { maxTokens: 1500 })).replace(/```json\s*|```/g, '').trim();
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

function notionBlocks(notes: MeetingNotes, title: string): unknown[] {
  const blocks: unknown[] = [
    { object: 'block', type: 'heading_1', heading_1: { rich_text: [{ type: 'text', text: { content: title } }] } },
    { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: notes.summary } }] } },
  ];

  if (notes.decisions.length) {
    blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: 'Decisions' } }] } });
    for (const d of notes.decisions) {
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: d } }] } });
    }
  }

  if (notes.actionItems.length) {
    blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: 'Action items' } }] } });
    for (const a of notes.actionItems) {
      const label = [a.owner ? `${a.owner}: ` : '', a.task, a.dueDate ? ` (${a.dueDate})` : ''].join('');
      blocks.push({ object: 'block', type: 'to_do', to_do: { rich_text: [{ type: 'text', text: { content: label } }], checked: false } });
    }
  }

  if (notes.openQuestions.length) {
    blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: 'Open questions' } }] } });
    for (const q of notes.openQuestions) {
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ type: 'text', text: { content: q } }] } });
    }
  }

  return blocks;
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
    const notes = await extractNotes(ctx, transcript, title);

    const databaseId = ctx.inputs.NOTION_DATABASE_ID as string;
    const notion = relayClient('notion');

    const created = await notion.write('pages', {}, {
      parent: { database_id: databaseId },
      properties: { Name: { title: [{ type: 'text', text: { content: title } }] } },
      children: notionBlocks(notes, title),
    });

    const pageUrl = str(created.receipt?.url);
    const slackChannel = ctx.inputs.SLACK_CHANNEL as string;

    const summaryLine = notes.summary ? `\n>${notes.summary}` : '';
    const actionCount = notes.actionItems.length;
    const meta = actionCount ? ` · ${actionCount} action item${actionCount === 1 ? '' : 's'}` : '';

    await slackClient().post(
      slackChannel,
      pageUrl
        ? `:notebook: <${pageUrl}|${title}>${meta}${summaryLine}`
        : `:notebook: *${title}* — notes written to Notion${meta}${summaryLine}`
    );
  },
});
