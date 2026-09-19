import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import ActivityView from '../Activity.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import en from '../../locales/en.json';
import deCH from '../../locales/de-CH.json';

// Spec 51 Task 6 fix: the scheduler's split fence (lib/scheduler.mjs) writes a
// 'publish-refused' row with errorCode 'stale_content' and a raw ENGLISH
// errorMessage ("content changed since approval - re-approve to publish").
// activity.error.stale_content already carries the localized copy in both
// en.json and de-CH.json, but nothing referenced it - the raw English message
// rendered verbatim even under the de-CH locale. This pins that the row now
// resolves the translated key instead of leaking the raw errorMessage.
const ACTIVITY = [
  {
    ts: '2026-09-09T09:00:00.000Z',
    action: 'publish-refused',
    ok: false,
    platform: 'instagram',
    campaign: 'acme',
    postId: 'p1',
    errorCode: 'stale_content',
    errorMessage: 'content changed since approval - re-approve to publish',
  },
];

vi.mock('../../lib/api.js', () => ({
  useActivity: () => ({ data: { activity: ACTIVITY }, isLoading: false, isError: false }),
}));

function renderActivity(locale) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ActivityView active platformFilter={[]} failuresOnly={false} actionGroups={[]} onOpenPost={() => {}} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Activity stale_content note localization (spec 51 Task 6)', () => {
  it('renders the localized en.json note text for a publish-refused/stale_content row', () => {
    renderActivity('en');
    expect(screen.getByText(en.strings['activity.error.stale_content'])).toBeTruthy();
  });

  it('renders the localized de-CH note text (not the raw English errorMessage) under the de-CH locale', () => {
    renderActivity('de-CH');
    expect(screen.getByText(deCH.strings['activity.error.stale_content'])).toBeTruthy();
    expect(screen.queryByText('content changed since approval - re-approve to publish')).toBeNull();
  });
});
