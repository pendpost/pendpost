// One name per cloud state (2026-11-01 flow repair). A cloud that answers but does not publish
// (worker_stale) was worded three ways: "Cloud macht Pause" on the popover row and the Cloud page
// card, "Cloud veröffentlicht nicht" on the sidebar card and the Needs-you tray row, and the long
// handover sentence. "Pause" also collided with "Pausiert", this computer's own paused state.
// Now every surface names it with the delivery reason key (the one the sidebar card and the tray
// read), and the long sentence stays where there is room for a "why": the handover glyph's
// tooltip and accessible name.
import { describe, it, expect } from 'vitest';
import { issueLabel, issueMessage } from '../CloudIssues.jsx';
import enPack from '../../locales/en.json';
import dePack from '../../locales/de-CH.json';

const conn = (kind) => ({ clientId: 'acme', clientName: 'Acme', campaign: null, postId: null, title: null, lane: null, message: 'x', terminal: false, kind });

describe('one name for a cloud state on every surface', () => {
  for (const [name, pack, word, why] of [
    ['en', enPack, 'Cloud not publishing', /^The cloud answers but is not publishing right now\./],
    ['de-CH', dePack, 'Cloud veröffentlicht nicht', /^Die Cloud antwortet, veröffentlicht aber gerade nichts\./],
  ]) {
    const t = (k) => (k in pack.strings ? pack.strings[k] : k);

    it(`${name}: worker stale reads "${word}" on the sidebar card, the tray row, the popover row and the Cloud page card`, () => {
      // Sidebar card + Needs-you tray row read delivery.reason.<reason>.
      expect(t('delivery.reason.worker_stale')).toBe(word);
      // Popover row + Cloud page card read issueLabel.
      expect(issueLabel(conn('worker_stale'), t)).toBe(word);
      // The "why" rides the handover glyph (tooltip + accessible name), never the name slot.
      expect(issueMessage(conn('worker_stale'), t)).toMatch(why);
    });

    it(`${name}: an unreachable cloud has one name too`, () => {
      expect(issueLabel(conn('unreachable'), t)).toBe(t('delivery.reason.cloud_unreachable'));
    });

    it(`${name}: no second wording of the state is left in the pack`, () => {
      expect(pack.strings['connection.issue.kind.worker_stale']).toBeUndefined();
      expect(pack.strings['connection.issue.kind.unreachable']).toBeUndefined();
      const offenders = Object.entries(pack.strings)
        .filter(([, v]) => /macht Pause|Cloud is paused/i.test(v))
        .map(([k]) => k);
      expect(offenders).toEqual([]);
    });
  }
});
