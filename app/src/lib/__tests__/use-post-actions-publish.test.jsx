import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePostActions } from '../usePostActions.js';
import { ConfirmProvider } from '../../components/ui/confirm.jsx';
import { I18nProvider } from '../i18n.js';

// The overview ⋯ menu (usePostActions) must offer the SAME recovery verbs the detail
// drawer does, decided by the SAME shared gates (postActions.js). These lock the two new
// items: publish-now / try-again for an approved overdue/failed post, and resume for a
// lane-halted (X 402 credits) post - and neither on a clean posted post.

function wrapper({ children }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <ConfirmProvider>{children}</ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

const keysFor = (post) => renderHook(() => usePostActions(post), { wrapper }).result.current.items.map((i) => i.key);

const base = {
  id: 'p1', campaign: 'launch', approval: 'approved',
  executionMode: 'fully-scheduled', scheduledAt: '2026-06-01T10:00:00Z',
};

describe('usePostActions: publish-now + resume-lane parity with the drawer', () => {
  it('offers publish-now (Send) on an approved overdue post', () => {
    const items = renderHook(() => usePostActions({ ...base, derivedState: 'overdue' }), { wrapper }).result.current.items;
    const pub = items.find((i) => i.key === 'publish-now');
    expect(pub).toBeTruthy();
    expect(pub.label).toMatch(/publish now/i);
    expect(keysFor({ ...base, derivedState: 'overdue' })).not.toContain('resume-lane');
  });

  it('offers publish-now as "Try again" on a publish-failed HELD post', () => {
    const held = { ...base, derivedState: 'publish-failed', publishHold: { lane: 'instagram' } };
    const pub = renderHook(() => usePostActions(held), { wrapper }).result.current.items.find((i) => i.key === 'publish-now');
    expect(pub).toBeTruthy();
    expect(pub.label).toMatch(/try again/i);
  });

  it('offers resume-lane (not publish-now) on a credits-halted post', () => {
    const halted = { ...base, derivedState: 'publish-failed', lastFailure: { lane: 'x', halted: true } };
    const keys = keysFor(halted);
    expect(keys).toContain('resume-lane');
    expect(keys).not.toContain('publish-now');
  });

  it('offers NEITHER on a clean posted post', () => {
    const keys = keysFor({ ...base, derivedState: 'posted', status: 'posted' });
    expect(keys).not.toContain('publish-now');
    expect(keys).not.toContain('resume-lane');
  });
});
