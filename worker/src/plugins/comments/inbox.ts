/** Activity is a comment or reply someone else created; status changes and my
 *  own writes never count. A published comment doc satisfies this shape. */
export interface ThreadEntry {
  createdAt: string;
  createdByEmail?: unknown;
  deleted?: unknown;
}

/** One per (site, person): when that person last opened each top-level comment.
 *  '' is an explicit mark-unread, which holds until they open the thread again. */
export interface SeenState {
  user: string;
  seen: Record<string, string>;
}

const identity = (email: unknown): string =>
  typeof email === 'string' ? email.trim().toLowerCase() : '';

/** The id of a person's seen doc, so a reader can fetch theirs directly. */
export const seenDocId = (email: string): string => identity(email);

export function lastActivityByOthers(
  comment: ThreadEntry,
  replies: readonly ThreadEntry[],
  me: string,
): string | null {
  const self = identity(me);
  let latest: string | null = null;
  for (const entry of [comment, ...replies]) {
    if (entry.deleted || identity(entry.createdByEmail) === self) continue;
    if (latest === null || Date.parse(entry.createdAt) > Date.parse(latest))
      latest = entry.createdAt;
  }
  return latest;
}

export function isUnread(
  comment: ThreadEntry,
  replies: readonly ThreadEntry[],
  me: string,
  seenAt: string | undefined,
): boolean {
  if (seenAt === '') return true;
  const activity = lastActivityByOthers(comment, replies, me);
  if (activity === null) return false;
  return seenAt === undefined || Date.parse(activity) > Date.parse(seenAt);
}
