/**
 * The step of `mail`: an email file (`.eml`, `.msg`) or a mailbox (`.mbox`)
 * to the tab Mail (one row a message: its headers and its attachments'
 * names) and the file's text (each message's headers, whole body and
 * attachment names), with the description of a mail database. One step,
 * one write call. It runs in the parser job `pipelineRun`. The core has no
 * text route for these types, so this Reader's text is the file's text
 * (docs/pipelines.md, "Text and pictures from every Reader").
 *
 * - No message (an empty file): a write with no tabs and no text, so the
 *   database is the word `no-rows` and the file keeps the default text.
 * - An Outlook file that cannot be read throws: a failed job, and the file
 *   gets its word (document_unreadable), as for any reader.
 * - Attachments are named, never read: the detail cut `mail_attachments`
 *   says so (it does not make the file partial, as an archive's entries).
 * - A read that stopped at a safety cap, or a message not read in full,
 *   says how many were read in full (`mail_messages`): the file is partial.
 */
import { FILE_TABS_WRITE, type PipelineStep } from '../../contract';
import type { ReadCutValue } from '../../../read-cut';
import { mailTab, mailText, readMail } from './mail';

export const step: PipelineStep = async (req, job) => {
  const ext = (req.file?.ext ?? '').toLowerCase();
  const read = await readMail(await job.bytes(), ext);
  // No message: no tabs, so the write gives the word `no-rows`, and no text,
  // so the file keeps the default text.
  if (read.messages.length === 0) {
    return { status: 'ok', calls: [{ call: 'tool', tool: FILE_TABS_WRITE, input: { tabs: [] } }] };
  }
  const attachments = read.messages.reduce((n, m) => n + m.attachments.length, 0);
  const readCuts: Record<string, ReadCutValue> = {};
  if (attachments > 0)
    readCuts.mail_attachments = { what: 'attachments', read: 0, total: attachments };
  // Read in part: a cap ended the read, or a message was not read in full.
  if (read.whole < read.total) {
    readCuts.mail_messages = { what: 'messages', read: read.whole, total: read.total };
  }
  return {
    status: 'ok',
    calls: [
      {
        call: 'tool',
        tool: FILE_TABS_WRITE,
        input: {
          tabs: [mailTab(read)],
          description: MAIL_DESCRIPTION,
          text: mailText(read, ext),
          ...(Object.keys(readCuts).length > 0 ? { readCuts } : {}),
        },
      },
    ],
  };
};

/** What a reader of a mail database's tab must know before a query. */
export const MAIL_DESCRIPTION =
  `Email: one row of Mail per message, in file order, with its sender, recipients,` +
  ` date (UTC) and subject. Attachments holds the names of its attachments, joined` +
  ` by "; ": they are named only, never read. The bodies are not in this tab: they` +
  ` are the file's text, in search (one "## Message N" section a message for a mailbox).`;
