import type { OpenUserUrlReply } from '../shared/ipc';

export type UserUrlReason = Extract<OpenUserUrlReply, { ok: false }>['reason'];

// Why main refused a user-supplied URL (address bar, drop).
export const USER_URL_REASON_TEXT: Record<UserUrlReason, string> = {
  empty: 'Type a web address',
  scheme: 'Only http and https addresses can open here',
  'not-a-url': "That doesn't look like a web address",
  'too-long': 'That address is too long',
  invalid: "Couldn't open that address",
  unavailable: "Couldn't open that address",
};
