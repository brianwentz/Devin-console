const drafts = new Map<string, string>();

export function getDraft(sessionId: string | null): string {
  return sessionId ? (drafts.get(sessionId) ?? '') : '';
}

export function setDraft(sessionId: string, text: string): void {
  if (text) drafts.set(sessionId, text);
  else drafts.delete(sessionId);
}

export function clearDraft(sessionId: string): void {
  drafts.delete(sessionId);
}
