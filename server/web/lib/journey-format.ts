/**
 * Pure presentation helpers for the Journey view (Activity → Reaction). No DB
 * imports, so client components can pull these in. Server data fetching lives
 * in ./journey.ts. The job here: turn a raw trace (kind + source + node type)
 * into a human-readable "what you did" line + an icon key + a pipeline
 * category, so the feed reads like a story rather than a log.
 */

export type ActionCategory = 'content' | 'dialog' | 'automation';

export type ActionIconKey =
  | 'chat'
  | 'pdf'
  | 'doc'
  | 'image'
  | 'file'
  | 'email'
  | 'note'
  | 'event'
  | 'task'
  | 'telegram'
  | 'tool'
  | 'automation'
  | 'secret';

export type ActionPresentation = {
  /** Human "what happened" line, e.g. "Email ingested". */
  label: string;
  /** Which of the two reaction pipelines this fed. */
  category: ActionCategory;
  iconKey: ActionIconKey;
};

/** Friendly source label for the chip under an action. */
export function sourceLabel(source: string | null): string {
  switch (source) {
    case 'assistant_upload':
      return 'chat upload';
    case 'assistant':
      return 'chat';
    case 'telegram':
      return 'telegram';
    case 'telegram_upload':
      return 'telegram upload';
    case 'file_upload':
      return 'files';
    case 'file_create':
      return 'files';
    case 'file_edit':
      return 'files';
    case 'note_create':
      return 'notes';
    case 'agent_tool':
      return 'agent';
    case 'extractor':
      return 'pipeline';
    default:
      return source || 'system';
  }
}

function iconForNode(nodeType: string | null, mime: string | null): ActionIconKey {
  switch (nodeType) {
    case 'note':
      return 'note';
    case 'email':
    case 'email_thread':
      return 'email';
    case 'task':
      return 'task';
    case 'event':
      return 'event';
    case 'secret':
      return 'secret';
    case 'telegram_message':
      return 'telegram';
    case 'file': {
      const m = (mime ?? '').toLowerCase();
      if (m.includes('pdf')) return 'pdf';
      if (m.startsWith('image/')) return 'image';
      if (
        m.includes('word') ||
        m.includes('officedocument') ||
        m.includes('spreadsheet') ||
        m.includes('excel') ||
        m.includes('csv')
      )
        return 'doc';
      return 'file';
    }
    default:
      return 'file';
  }
}

function contentLabel(nodeType: string | null, mime: string | null, source: string | null): string {
  // Prefer the explicit human action when we recorded one.
  switch (source) {
    case 'assistant_upload':
      return 'Uploaded in chat';
    case 'telegram_upload':
      return 'Sent media via Telegram';
    case 'file_upload':
      return 'Uploaded a file';
    case 'file_create':
      return 'Created a file';
    case 'file_edit':
      return 'Edited a file';
    case 'note_create':
      return 'Wrote a note';
    case 'agent_tool':
      return 'Agent created content';
    default:
      break;
  }
  // Otherwise derive from what the node turned out to be.
  switch (nodeType) {
    case 'email':
    case 'email_thread':
      return 'Email ingested';
    case 'note':
      return 'Note added';
    case 'event':
      return 'Event created';
    case 'task':
      return 'Task created';
    case 'secret':
      return 'Secret stored';
    case 'file': {
      const m = (mime ?? '').toLowerCase();
      if (m.includes('pdf')) return 'PDF ingested';
      if (m.startsWith('image/')) return 'Image ingested';
      return 'File added';
    }
    default:
      return 'Content added';
  }
}

export function deriveAction(t: {
  kind: string;
  nodeType: string | null;
  mime: string | null;
  source: string | null;
}): ActionPresentation {
  // Conversation messages are dialog, even though the extractor (a content-
  // pipeline worker) fires on their node. The transcript/text lives in the
  // conversation store (L2 recent_turns) and flows through the dialog pipeline;
  // the node is a shadow that the content index deliberately ignores. Labelling
  // it "content" would mis-file chatter — and most such nodes skip anyway.
  if (t.nodeType === 'telegram_message') {
    return { label: 'Telegram message', category: 'dialog', iconKey: 'telegram' };
  }
  switch (t.kind) {
    case 'responder_turn':
      return { label: 'Conversation turn', category: 'dialog', iconKey: 'chat' };
    case 'summarizer_run':
      return {
        label: 'Rolled up conversation digests',
        category: 'automation',
        iconKey: 'automation',
      };
    case 'reflector_run':
      return {
        label: 'Updated persona from conversation',
        category: 'automation',
        iconKey: 'automation',
      };
    case 'heartbeat_fire':
      return { label: 'Scheduled automation fired', category: 'automation', iconKey: 'automation' };
    default:
      // extractor_run / content_ingest / photo_ingest / manual → content pipeline
      return {
        label: contentLabel(t.nodeType, t.mime, t.source),
        category: 'content',
        iconKey: iconForNode(t.nodeType, t.mime),
      };
  }
}

/** Where each pipeline lands, for the legend/reference panel. */
export const PIPELINE_LEGEND: {
  category: ActionCategory;
  title: string;
  flow: string;
  blurb: string;
}[] = [
  {
    category: 'content',
    title: 'Content pipeline',
    flow: 'L6 store → L5 index → L4 facts → graph',
    blurb:
      'Anything you add as knowledge — files, PDFs, images, notes, emails — is stored, summarised + embedded into the searchable index, mined for durable facts, and linked into the entity graph.',
  },
  {
    category: 'dialog',
    title: 'Dialog pipeline',
    flow: 'L2 recent turns → L3 digests → L1 persona',
    blurb:
      'Conversation lands as recent turns, gets rolled up into digests by the summarizer, and shapes the agent’s persona via the reflector.',
  },
  {
    category: 'automation',
    title: 'Automation',
    flow: 'timers + heartbeats',
    blurb:
      'Background work the brain does on its own schedule — digest roll-ups, persona reflection, and heartbeat-triggered actions.',
  },
];
