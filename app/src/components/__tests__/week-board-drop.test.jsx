import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeekView } from '../Planner.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { moveToDayTarget } from '../../lib/format.js';

// B7: a Week-board drop onto a day strictly earlier than today must be refused
// BEFORE reschedule() runs, matching the List DateTimePicker's disablePast rule
// (compare via localDayKey, NOT next.getTime() < now). A same-day earlier-clock
// drop stays allowed; the existing same-day unchanged-time no-op is preserved.

// A fixed "now" so localDayKey(new Date()) is deterministic across machines.
// Mid-day local so that an earlier-clock-but-same-day drop is representable.
const FAKE_NOW = new Date('2026-06-16T12:00:00');

function renderWeek(props = {}) {
  return render(
    <TooltipProvider>
      <WeekView
        posts={props.posts || []}
        weekStart={props.weekStart || new Date('2026-06-15T00:00:00')}
        onSelect={() => {}}
        onMoveToDay={props.onMoveToDay}
        loading={false}
        lane={{}}
      />
    </TooltipProvider>,
  );
}

// A scheduled-today card the owner drags. Today == FAKE_NOW's day.
const cardToday = {
  campaign: 'spring',
  id: 'r1',
  type: 'reel',
  platforms: ['instagram'],
  caption: 'Spring teaser',
  scheduledAt: '2026-06-16T15:00:00',
  derivedState: 'waiting-due',
  approval: 'approved',
};

function fireDropOn(section, data) {
  // jsdom has no native HTML5 drag-and-drop: stub a DataTransfer whose getData
  // returns the JSON the WeekView onDrop handler parses.
  const dataTransfer = { getData: () => JSON.stringify(data) };
  fireEvent.drop(section, { dataTransfer });
}

describe('WeekView onMoveToDay drop contract', () => {
  it('forwards the dropped card data and the target day to onMoveToDay', () => {
    const onMoveToDay = vi.fn();
    renderWeek({ posts: [cardToday], onMoveToDay });
    // The board renders one <section> per day (aria-labelled). Drop on the first.
    const sections = screen.getAllByRole('region');
    fireDropOn(sections[0], { campaign: 'spring', id: 'r1', scheduledAt: cardToday.scheduledAt });
    expect(onMoveToDay).toHaveBeenCalledTimes(1);
    const [data, day] = onMoveToDay.mock.calls[0];
    expect(data).toEqual({ campaign: 'spring', id: 'r1', scheduledAt: cardToday.scheduledAt });
    expect(day instanceof Date).toBe(true);
  });

  it('does not call onMoveToDay when the dropped payload is not one of our cards', () => {
    const onMoveToDay = vi.fn();
    renderWeek({ posts: [cardToday], onMoveToDay });
    const sections = screen.getAllByRole('region');
    // getData returns non-JSON: the try/JSON.parse swallows it.
    fireEvent.drop(sections[0], { dataTransfer: { getData: () => 'not json' } });
    expect(onMoveToDay).not.toHaveBeenCalled();
  });
});

describe('moveToDayTarget (the App#moveToDay guard)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FAKE_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a drop onto a strictly-earlier day (yesterday): returns null so reschedule is skipped', () => {
    const yesterday = new Date('2026-06-15T00:00:00');
    expect(moveToDayTarget(cardToday.scheduledAt, yesterday)).toBeNull();
  });

  it('preserves the existing same-day unchanged-time no-op: returns null when day+wall-clock equal the original', () => {
    // Drop today's card onto today's column: next == orig => no-op.
    const today = new Date('2026-06-16T00:00:00');
    expect(moveToDayTarget(cardToday.scheduledAt, today)).toBeNull();
  });

  it('ALLOWS a today-target whose resolved wall-clock is earlier than now (day-key, not getTime, decides)', () => {
    // The critical risk: comparing next.getTime() < Date.now() would WRONGLY
    // reject this. A card originally on a prior day at 09:00 dropped onto today's
    // column resolves to today 09:00 -- earlier than FAKE_NOW (12:00). Because
    // localDayKey(next) == localDayKey(now), today is the boundary and allowed.
    const priorCard = { ...cardToday, scheduledAt: '2026-06-10T09:00:00' };
    const today = new Date('2026-06-16T00:00:00');
    const target = moveToDayTarget(priorCard.scheduledAt, today);
    // Sanity: the resolved instant is indeed in the past relative to now...
    expect(target.getTime()).toBeLessThan(FAKE_NOW.getTime());
    // ...yet the guard ALLOWS it because the day-key equals today's.
    expect(target).not.toBeNull();
    expect(target.getDate()).toBe(16);
    expect(target.getHours()).toBe(9);
  });

  it('ALLOWS a drop onto today from a card originally on another day, preserving hours/minutes', () => {
    // Card scheduled YESTERDAY at 09:00, dropped onto today's column. The target
    // day-key equals today's, so it is NOT past (today is the boundary, allowed);
    // reschedule must proceed with the 09:00 wall-clock preserved.
    const yesterdayCard = { ...cardToday, scheduledAt: '2026-06-15T09:00:00' };
    const today = new Date('2026-06-16T00:00:00');
    const target = moveToDayTarget(yesterdayCard.scheduledAt, today);
    expect(target).not.toBeNull();
    expect(target.getDate()).toBe(16);
    expect(target.getHours()).toBe(9);
    expect(target.getMinutes()).toBe(0);
  });

  it('ALLOWS a drop onto a future day, preserving original hours/minutes', () => {
    const future = new Date('2026-06-20T00:00:00');
    const target = moveToDayTarget(cardToday.scheduledAt, future);
    expect(target).not.toBeNull();
    expect(target.getFullYear()).toBe(2026);
    expect(target.getMonth()).toBe(5); // June
    expect(target.getDate()).toBe(20);
    expect(target.getHours()).toBe(15);
    expect(target.getMinutes()).toBe(0);
  });

  it('drives the call-vs-no-call decision: reschedule runs for today/future, never for a past day', async () => {
    // Faithful to App#moveToDay: build next via the guard, call reschedule only
    // when the guard returns a Date. We mock reschedule to assert call vs no-call.
    const reschedule = vi.fn(() => Promise.resolve());
    const moveToDay = async ({ campaign, id, scheduledAt }, day) => {
      const next = moveToDayTarget(scheduledAt, day);
      if (!next) return;
      await reschedule({ campaign, id }, next.toISOString());
    };

    // Past day: refused, reschedule NOT called.
    await moveToDay({ campaign: 'spring', id: 'r1', scheduledAt: cardToday.scheduledAt }, new Date('2026-06-15T00:00:00'));
    expect(reschedule).not.toHaveBeenCalled();

    // Same-day unchanged time: no-op, still NOT called.
    await moveToDay({ campaign: 'spring', id: 'r1', scheduledAt: cardToday.scheduledAt }, new Date('2026-06-16T00:00:00'));
    expect(reschedule).not.toHaveBeenCalled();

    // Future day: reschedule IS called, preserving the original time-of-day.
    await moveToDay({ campaign: 'spring', id: 'r1', scheduledAt: cardToday.scheduledAt }, new Date('2026-06-20T00:00:00'));
    expect(reschedule).toHaveBeenCalledTimes(1);
  });
});
