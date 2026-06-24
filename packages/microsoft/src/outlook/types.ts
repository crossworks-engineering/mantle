/** Minimal typed shapes for the Graph mail endpoints M2 touches. */

export interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

export interface GraphHeader {
  name: string;
  value: string;
}

export interface GraphMessage {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  categories?: string[];
  flag?: { flagStatus?: string };
  internetMessageHeaders?: GraphHeader[];
  /** Filled only when fetched with $select=body. */
  body?: { contentType?: string; content?: string };
}

export interface GraphAttachment {
  '@odata.type'?: string;
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  /** Base64 — present on `#microsoft.graph.fileAttachment` only. */
  contentBytes?: string;
}
