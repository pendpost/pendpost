// Instagram-quality badge: at approval time, will Instagram serve this video in HD
// or downgrade it? Instagram builds its HD rendition ladder from the SOURCE bitrate -
// a master that clears the 8 Mbps floor (HD_BITRATE_FLOOR, lib/assets.mjs) gets the
// HD ladder; one below it is served at a pixelated 720p. specChecks already computes
// that verdict as hdReady (true / false / null=unprobed-or-not-a-video); this badge
// just reads it. Warning-only - it never gates a publish.
//
// Green "HD" pill when ready, amber "720p" pill (with the real bitrate in the tooltip)
// when the master is too thin, and nothing when hdReady is null - so a call site can
// render <HdBadge .../> unconditionally and it self-hides for images and unprobed files.
// A thin wrapper over IconBadge, matching the reusable-status-badge pattern in this dir.
import { Gauge, AlertTriangle } from 'lucide-react';
import { IconBadge } from './IconBadge.jsx';
import { useT } from '../../lib/i18n.js';

// `static` forwards to IconBadge's non-interactive variant: on the Planner cards the
// badge sits INSIDE the card's open-detail <button>, so it must not render its own
// Radix Tooltip trigger <button> (a nested button is invalid HTML). Sibling call
// sites (Freigaben, Assets) leave it false and keep the focusable tooltip.
export function HdBadge({ hdReady, bitrate, static: isStatic = false }) {
  const t = useT();
  if (hdReady == null) return null;
  if (hdReady) {
    return <IconBadge icon={Gauge} tone="ok" text="HD" label={t('assets.spec.hdReady')} static={isStatic} />;
  }
  // bitrate is bits/s (ffprobe format.bit_rate); show it as Mbps to one decimal.
  const mbps = Number.isFinite(bitrate) ? (bitrate / 1e6).toFixed(1) : '?';
  return <IconBadge icon={AlertTriangle} tone="warn" text="720p" label={t('assets.spec.hdBelow', { mbps })} static={isStatic} />;
}
