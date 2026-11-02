import { describe, it, expect } from 'vitest';
import { makeT } from '../i18n.js';
import { approveNoticeText, retimedNames } from '../approveNotice.js';

// An approve that SUCCEEDS can still owe the owner one line: the image is on the brand's own
// site but not online yet (engine: mediaPending, re-checked right before posting), or the
// caption has non-blocking brand-rule hints (lintWarnings). A plain approve stays silent.
const en = makeT('en');
const de = makeT('de-CH');
const PENDING = { ok: true, mediaPending: [{ platform: 'instagram', url: 'https://brand.example/media/a.jpg' }] };
const HINTS = { ok: true, lintWarnings: [{ platform: 'x', rule: 'hashtag-count' }] };

describe('approveNoticeText', () => {
  it('stays silent for a plain approve', () => {
    expect(approveNoticeText({ ok: true }, en)).toBeNull();
    expect(approveNoticeText({ ok: true, mediaPending: [], lintWarnings: [] }, en)).toBeNull();
    expect(approveNoticeText(undefined, en)).toBeNull();
  });

  it('says the image is not online yet and will be re-checked', () => {
    expect(approveNoticeText(PENDING, de)).toBe('Freigegeben. Das Bild ist noch nicht online; pendpost prüft es kurz vor dem Posten nochmals.');
    expect(approveNoticeText(PENDING, en)).toBe("Approved. The image isn't online yet; pendpost checks it again right before posting.");
  });

  it('mentions brand-rule hints, alone or after the image line', () => {
    expect(approveNoticeText(HINTS, en)).toBe('Approved. The caption has brand-rule hints worth a look before it posts.');
    expect(approveNoticeText({ ...PENDING, ...HINTS }, en)).toBe("Approved. The image isn't online yet; pendpost checks it again right before posting. The caption also has brand-rule hints worth a look.");
  });

  it('a bulk run says it once across all results', () => {
    expect(approveNoticeText([{ ok: true }, PENDING, PENDING], en)).toBe("Approved. The image isn't online yet; pendpost checks it again right before posting.");
  });
});

// Planner judge round 2, item 10: a Radar reply approved after its draft time goes out 5 minutes
// after the approval (the engine's contract). Every approve says so, with the bulk bar's sentence.
describe('approveNoticeText: a retimed Radar reply', () => {
  it('a plain single approve names the post', () => {
    expect(approveNoticeText({ ok: true }, de, { retimed: 'Bluesky-Antwort 1' })).toBe('Freigegeben. Der Termin war vorbei, darum 5 Minuten nach der Freigabe: Bluesky-Antwort 1');
    expect(approveNoticeText({ ok: true }, en, { retimed: 'Reply 1' })).toBe('Approved. The time had passed, so 5 minutes after the approval: Reply 1');
  });

  it('rides after the other notices', () => {
    expect(approveNoticeText(PENDING, de, { retimed: 'A' })).toBe('Freigegeben. Das Bild ist noch nicht online; pendpost prüft es kurz vor dem Posten nochmals. Der Termin war vorbei, darum 5 Minuten nach der Freigabe: A');
  });

  it('retimedNames: only a Radar reply whose time passed, named', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    const past = { id: 'r1', caption: 'Bluesky-Antwort 1', radarReplyTo: { url: 'https://bsky.app/x' }, scheduledAt: '2026-11-01T11:00:00Z' };
    const future = { ...past, id: 'r2', caption: 'Später', scheduledAt: '2026-11-01T13:00:00Z' };
    const plain = { id: 'p', caption: 'Kein Reply', scheduledAt: '2026-11-01T11:00:00Z' };
    expect(retimedNames([past, future, plain], de, now)).toBe('Bluesky-Antwort 1');
    expect(retimedNames([future, plain], de, now)).toBeNull();
  });
});
