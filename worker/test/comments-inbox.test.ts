import { describe, expect, it } from 'vitest';
import { isUnread, lastActivityByOthers, seenDocId } from '../src/plugins/comments/inbox';

const ME = 'tom@example.com';
const at = (minute: number) => new Date(Date.UTC(2026, 10, 4, 9, minute)).toISOString();
const by = (email: string, minute: number, extra: Record<string, unknown> = {}) => ({
  createdAt: at(minute),
  createdByEmail: email,
  ...extra,
});

describe('isUnread', () => {
  it("is unread when someone else's comment was never seen", () => {
    expect(isUnread(by('ana@example.com', 0), [], ME, undefined)).toBe(true);
  });

  it('is read once seen after the last activity', () => {
    expect(isUnread(by('ana@example.com', 0), [], ME, at(1))).toBe(false);
  });

  it('never makes my own comment unread, seen or not', () => {
    expect(isUnread(by(ME, 0), [], ME, undefined)).toBe(false);
  });

  it('keeps a thread read when only I replied after seeing it', () => {
    const replies = [by(ME, 5)];
    expect(isUnread(by('ana@example.com', 0), replies, ME, at(1))).toBe(false);
  });

  it('goes unread again when someone else replies after I saw it', () => {
    const replies = [by(ME, 2), by('ana@example.com', 5)];
    expect(isUnread(by(ME, 0), replies, ME, at(3))).toBe(true);
  });

  it('is unread again after mark-unread drops the seen stamp', () => {
    const replies = [by('ana@example.com', 2)];
    expect(isUnread(by(ME, 0), replies, ME, at(3))).toBe(false);
    expect(isUnread(by(ME, 0), replies, ME, undefined)).toBe(true);
  });

  it('matches me by email regardless of case and padding', () => {
    expect(isUnread(by(' Tom@Example.com ', 0), [], ME, undefined)).toBe(false);
  });

  it('does not count deleted replies as activity', () => {
    const replies = [by('ana@example.com', 5, { deleted: true })];
    expect(isUnread(by(ME, 0), replies, ME, undefined)).toBe(false);
  });

  it('counts a comment with no stamped email as someone else', () => {
    expect(isUnread({ createdAt: at(0) }, [], ME, undefined)).toBe(true);
  });
});

describe('lastActivityByOthers', () => {
  it('is the newest creation by anyone but me', () => {
    const replies = [by('ana@example.com', 3), by(ME, 9), by('bo@example.com', 6)];
    expect(lastActivityByOthers(by(ME, 0), replies, ME)).toBe(at(6));
  });

  it('is null when the whole thread is mine', () => {
    expect(lastActivityByOthers(by(ME, 0), [by(ME, 1)], ME)).toBeNull();
  });
});

describe('seenDocId', () => {
  it('keys one seen doc per person, whatever the email casing', () => {
    expect(seenDocId(' Tom@Example.com ')).toBe(seenDocId('tom@example.com'));
  });
});
