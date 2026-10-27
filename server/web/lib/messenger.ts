/**
 * The messenger's HTTP adapter (Messenger V1, plan page d8954876): the
 * routes under /api/messenger/* read the caller with anyLoginCaller() and
 * hand @mantle/content/messenger the actor. Every rule is in the content
 * module; this file only maps a request to it.
 */
import { NextResponse } from '@/server/http-compat';
import type { Login } from '@/lib/auth/login';
import type { MessengerActor } from '@mantle/content/messenger';

export {
  addMessengerParticipants,
  clearMessengerForMe,
  createMessengerConversation,
  deleteMessengerHistory,
  deleteMessengerMessage,
  editMessengerMessage,
  getMessengerConversation,
  leaveMessengerConversation,
  listMessengerConversations,
  listMessengerMessages,
  markMessengerRead,
  messengerDirectory,
  messengerLoginPhoto,
  messengerLoginUsable,
  messengerTyping,
  messengerUnread,
  patchMessengerConversation,
  removeMessengerFavourite,
  removeMessengerParticipant,
  sendMessengerMessage,
  setMessengerFavourite,
  toggleMessengerReaction,
  touchLoginPresence,
} from '@mantle/content/messenger';

/** The actor of a signed-in session: no credential label (a session's
 *  messages carry no via). */
export function messengerActorOf(login: Login): MessengerActor {
  return { ownerId: login.brainId, loginId: login.loginId, via: null };
}

/** A seq path segment: digits only, else the one 404 (an id that is not a
 *  seq names nothing). */
export function seqParam(raw: string): number | null {
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

export function notFound(): Response {
  return NextResponse.json({ error: 'not found' }, { status: 404 });
}

/** An optional seq query parameter: absent, a seq, or invalid. */
export function seqQuery(params: URLSearchParams, name: string): number | null | 'bad' {
  const raw = params.get(name);
  if (raw === null || raw === '') return null;
  return /^\d{1,15}$/.test(raw) ? Number(raw) : 'bad';
}
