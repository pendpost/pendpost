// The ONE honest statement of which lanes the cloud can and cannot fire, driven by
// the cloud's public capability map (useCapabilities; baked fallback offline) so a
// capability flip propagates without an app release. Shared by the Cloud page (shown
// pre-purchase, before sign-in) AND the header cloud-status popover (shown once the
// cloud is on) so both read the SAME copy - the coverage answer is stated in exactly
// one place. Lane ids -> human names only; a lane without a name here stays out of the
// prose (it is not a UI platform).
import { useCapabilities } from '../lib/cloud.js';
import { useT } from '../lib/i18n.js';

const LANE_LABELS = {
  reddit: 'Reddit', tiktok: 'TikTok', youtube: 'YouTube', mastodon: 'Mastodon',
  wordpress: 'WordPress', ghost: 'Ghost', telegram: 'Telegram', discord: 'Discord',
  nostr: 'Nostr', pinterest: 'Pinterest', gbp: 'Google Business Profile',
};

// `short` renders the one-sentence form (the header popover): just the
// local-only limit, no native-lane elaboration. The Cloud page keeps the full
// two-sentence note - both read the same capability map.
export function LanesHonestyNote({ className = '', short = false }) {
  const t = useT();
  const { data: caps } = useCapabilities();
  const names = (list, fallback) => ((Array.isArray(list) && list.length ? list : fallback))
    .map((l) => LANE_LABELS[l]).filter(Boolean).join(', ');
  const localOnly = names(caps?.localOnlyLanes, ['reddit', 'tiktok']);
  const native = names(caps?.nativeLanes, ['youtube', 'mastodon', 'wordpress', 'ghost']);
  if (!localOnly) return null;
  return <p className={className}>{short ? t('cloud.lanes.noteShort', { localOnly }) : t('cloud.lanes.note', { localOnly, native })}</p>;
}
