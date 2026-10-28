import { describe, it, expect } from 'vitest';
import { makeT } from '../i18n.js';
import { approveNoticeText } from '../approveNotice.js';

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
