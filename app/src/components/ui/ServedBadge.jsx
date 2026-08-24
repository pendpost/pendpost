// Post-publish quality badge: what resolution/bitrate Instagram ACTUALLY served
// this reel at, measured after publish from media_url (see lib/verify.mjs ->
// scripts/meta-social.mjs probeServedRendition). media_url is a MID-LADDER mp4, so
// >=1080p (shorter side) is proof of HD, and anything below is likely a downscale.
// Sibling of HdBadge (which PREDICTS the same verdict from the source master); this
// one MEASURES it. Warning-only, display-only - never gates or changes anything.
//
// Green pill with the resolution when HD, amber pill when downscaled, and nothing
// when unmeasured - so a call site can render <ServedBadge served={...} /> and it
// self-hides for non-video posts and posts not yet verified. A thin wrapper over
// IconBadge, matching the reusable-status-badge pattern in this dir.
import { Gauge, AlertTriangle } from 'lucide-react';
import { IconBadge } from './IconBadge.jsx';
import { useT } from '../../lib/i18n.js';
import { fmtRelative } from '../../lib/format.js';

export function ServedBadge({ served }) {
  const t = useT();
  if (!served || !served.width || !served.height) return null;
  // Shorter side is orientation-safe: a 9:16 reel served at 720x1280 -> "720p".
  const shortSide = Math.min(served.width, served.height);
  const res = `${shortSide}p`;
  const mbps = Number.isFinite(served.bitrate) ? (served.bitrate / 1e6).toFixed(1) : '?';
  const when = served.probedAt ? fmtRelative(served.probedAt) : '';
  const hd = shortSide >= 1080;
  return (
    <IconBadge
      icon={hd ? Gauge : AlertTriangle}
      tone={hd ? 'ok' : 'warn'}
      text={res}
      label={t(hd ? 'postDetail.served.hd' : 'postDetail.served.downscaled', { res, mbps, when })}
    />
  );
}
