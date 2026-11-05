import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PostCard, ListView } from '../Planner.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Judge pass 2, fix 1: the planner card shows WHY a post did not go out in one plain
// sentence (lib/failureCopy.js), never the platform's raw "lane: POST /path: HTTP 500"
// dump. The card is itself a button, so it holds no "?": the raw line lives behind the
// post detail's "?" and is not even a hover title here (the title repeats the sentence,
// which line-clamp may cut).
const RAW = 'linkedin: POST /rest/posts: HTTP 500 - LinkedIn returned an internal error, try again later.';
const post = {
  id: 'p1', campaign: 'c', type: 'text', platforms: ['linkedin'], caption: 'Fresh sourdough every Saturday.',
  scheduledAt: '2026-09-20T10:00:00Z', approval: 'approved', derivedState: 'publish-failed',
  lastFailure: { lane: 'linkedin', message: RAW, at: '2026-09-20T10:01:00Z', terminal: false, halted: false, haltCode: null, code: null },
};

function renderCard(p) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider locale="de-CH">
        <TooltipProvider>
          <ConfirmProvider><PostCard post={p} onSelect={() => {}} /></ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('PostCard failure reason', () => {
  // Q5: a reschedule leaves the attempts tail (and so lastFailure) in place, while the
  // derived state is healthy again. The card shows its caption, not the old failure.
  it('a stale lastFailure on a rescheduled, healthy post shows the caption, not the failure', () => {
    renderCard({ ...post, derivedState: 'waiting-due', scheduledAt: '2099-01-01T10:00:00Z' });
    expect(screen.queryByText(/internen Fehler/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Fresh sourdough every Saturday.').length).toBeGreaterThan(0);
  });

  it('renders the humanized sentence, never the raw text, not even as its title', () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider locale="de-CH">
          <TooltipProvider>
            <ConfirmProvider><PostCard post={post} onSelect={() => {}} /></ConfirmProvider>
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    const why = screen.getByText('LinkedIn hatte einen internen Fehler. An deinem Beitrag liegt es nicht, ein späterer Versuch klappt meist.');
    expect(why).toHaveAttribute('title', 'LinkedIn hatte einen internen Fehler. An deinem Beitrag liegt es nicht, ein späterer Versuch klappt meist.');
    expect(screen.queryByText(RAW)).not.toBeInTheDocument();
    expect(document.querySelector(`[title="${RAW}"]`)).toBeNull();
  });
});

// Wave 2g F1: the List row's pill no longer carries a failure reason in a hover title, so a
// failed row said only the word. Like the Blockiert row, its meta line now shows the one
// plain sentence in place of campaign/type: neutral ink while pendpost retries (D1), red
// only when the owner must act. The raw platform line never shows.
function renderList(posts) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider locale="de-CH">
        <TooltipProvider>
          <ConfirmProvider><ListView posts={posts} onSelect={() => {}} loading={false} /></ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}
const SENTENCE = 'LinkedIn hatte einen internen Fehler. An deinem Beitrag liegt es nicht, ein späterer Versuch klappt meist.';
const RED = /(?:^|\s)(?:dark:)?text-(?:red|rose)-/;
const rowOf = (title) => screen.getByText(title).closest('li');

describe('Planner List row failure reason', () => {
  it('a retrying row shows the plain sentence in neutral ink, never the raw line', () => {
    renderList([{ ...post, title: 'Sourdough' }]);
    const why = within(rowOf('Fresh sourdough every Saturday.')).getByText(SENTENCE);
    expect(RED.test(why.getAttribute('class') || '')).toBe(false);
    expect(screen.queryByText(RAW)).not.toBeInTheDocument();
    expect(document.querySelector(`[title="${RAW}"]`)).toBeNull();
  });

  it('a terminal failure reads red: the owner must act', () => {
    renderList([{ ...post, title: 'Sourdough', lastFailure: { ...post.lastFailure, terminal: true } }]);
    const why = within(rowOf('Fresh sourdough every Saturday.')).getByText(SENTENCE);
    expect(RED.test(why.getAttribute('class') || '')).toBe(true);
  });

  it('a healthy row with a stale lastFailure keeps its campaign line', () => {
    renderList([{ ...post, title: 'Sourdough', derivedState: 'waiting-due', scheduledAt: '2099-01-01T10:00:00Z' }]);
    expect(within(rowOf('Fresh sourdough every Saturday.')).queryByText(SENTENCE)).toBeNull();
  });
});

// Phase 3 final tail: the Week card and the List row read ONE failure predicate. A failure
// the engine recorded with only a code (no message) is still a live failure, and
// humanizeFailure names it from the code; the card used to demand a message and fell back
// to the caption while the List row said why.
describe('Week card and List row agree on a code-only failure', () => {
  const codeOnly = {
    ...post,
    title: 'Sourdough',
    lastFailure: { lane: 'linkedin', message: null, code: 'needs_scope', at: '2026-09-20T10:01:00Z', terminal: true, halted: false, haltCode: null },
  };
  const SCOPE = 'LinkedIn verlangt eine Berechtigung, die der Verbindung fehlt. Neu verbinden behebt das.';

  it('the Week card shows the sentence, not the caption', () => {
    renderCard(codeOnly);
    expect(screen.getByText(SCOPE)).toBeInTheDocument();
    // The reason takes the caption slot; a text card draws no fake cover of its words.
    expect(screen.queryByText('Fresh sourdough every Saturday.')).toBeNull();
  });

  it('the List row shows the same sentence', () => {
    renderList([codeOnly]);
    expect(within(rowOf('Fresh sourdough every Saturday.')).getByText(SCOPE)).toBeInTheDocument();
  });
});
