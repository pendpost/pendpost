import { describe, it, expect } from 'vitest';
import { buildFeedbackTarget, FEEDBACK_REPO, FEEDBACK_EMAIL } from '../feedback.js';

// The deep-link builder is the load-bearing core of the Help & feedback dialog:
// it maps a (type, message, diagnostics) tuple onto a pre-filled GitHub issue or
// mailto URL keyed on the exact field ids in .github/ISSUE_TEMPLATE/*.yml. These
// tests pin the channel, the template, the field ids, and the encoding.

const DIAG = { version: '0.3.0', os: 'darwin 25.5.0', node: 'v20.11.0', mode: 'mock' };

describe('buildFeedbackTarget', () => {
  it('bug -> GitHub bug_report.yml with diagnostics prefilled', () => {
    const { kind, url } = buildFeedbackTarget({ type: 'bug', message: 'Crash on save', diagnostics: DIAG });
    expect(kind).toBe('github');
    expect(url.startsWith(`${FEEDBACK_REPO}/issues/new?`)).toBe(true);
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('template')).toBe('bug_report.yml');
    expect(q.get('title')).toBe('[bug] Crash on save');
    expect(q.get('what-happened')).toBe('Crash on save');
    expect(q.get('version')).toBe('0.3.0');
    expect(q.get('os')).toBe('darwin 25.5.0');
    expect(q.get('node')).toBe('v20.11.0');
    expect(q.get('mode')).toBe('mock');
  });

  it('feature -> GitHub feature_request.yml mapping message to problem', () => {
    const { kind, url } = buildFeedbackTarget({ type: 'feature', message: 'Add dark mode' });
    expect(kind).toBe('github');
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('template')).toBe('feature_request.yml');
    expect(q.get('title')).toBe('[feature] Add dark mode');
    expect(q.get('problem')).toBe('Add dark mode');
    // diagnostics are bug-only: no version leaks into a feature request.
    expect(q.get('version')).toBe(null);
  });

  it('feedback -> mailto with subject and body', () => {
    const { kind, url } = buildFeedbackTarget({ type: 'feedback', message: 'Love it' });
    expect(kind).toBe('mailto');
    expect(url.startsWith(`mailto:${FEEDBACK_EMAIL}?`)).toBe(true);
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('subject')).toBe('[pendpost] Love it');
    expect(q.get('body')).toBe('Love it');
  });

  it('encodes spaces, newlines and ampersands without creating spurious params', () => {
    const message = 'tom & jerry\nline two has spaces';
    const { url } = buildFeedbackTarget({ type: 'bug', message, diagnostics: DIAG });
    // No raw space or raw newline in the URL; the & inside the message is escaped
    // so it never starts a new query param.
    expect(url).not.toMatch(/ /);
    expect(url).not.toMatch(/\n/);
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('what-happened')).toBe(message);
  });

  it('drops absent diagnostics rather than emitting empty params', () => {
    const { url } = buildFeedbackTarget({ type: 'bug', message: 'x', diagnostics: {} });
    expect(url).not.toMatch(/version=/);
    expect(url).not.toMatch(/[?&]mode=/);
  });

  it('truncates a long title with an ellipsis but keeps the full body', () => {
    const message = 'a'.repeat(120);
    const { url } = buildFeedbackTarget({ type: 'bug', message, diagnostics: DIAG });
    const q = new URLSearchParams(url.split('?')[1]);
    expect(q.get('title').length).toBeLessThanOrEqual('[bug] '.length + 60);
    expect(q.get('title').endsWith('…')).toBe(true);
    expect(q.get('what-happened')).toBe(message); // body is never truncated
  });

  it('an empty message still produces a valid target', () => {
    const bug = buildFeedbackTarget({ type: 'bug', message: '' });
    expect(bug.kind).toBe('github');
    const mail = buildFeedbackTarget({ type: 'feedback', message: '' });
    expect(mail.url.startsWith(`mailto:${FEEDBACK_EMAIL}?`)).toBe(true);
  });
});
