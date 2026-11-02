// DeliveryGlyph - the delivery indicator's icon + status dot, shared by the sidebar Delivery
// card and the header ConnectionStatus button so both paint the same thing. The GLYPH says
// where a project publishes from (a cloud = the managed 24/7 runtime, a monitor = this
// computer); the DOT says how that is going. Tones come from lib/deliveryState.js
// (cloudTone / localTone); this file owns the colours.
//
// Green is back on purpose here and ONLY here (owner decision 2026-11-01, q4 a): "We had a
// clear color coding for the cloud being active or having issues. This should be brought
// back." A green dot = the cloud is delivering. Everywhere else an all-clear stays grey
// (app/src/__tests__/all-clear-no-colour.test.jsx lists this file as the one exception).
// Colour is never the only signal: every dot carries an accessible name.
import { Cloud as CloudIcon, CloudAlert, Monitor, MonitorOff } from 'lucide-react';

const DOT = {
  ok: 'bg-emerald-500',
  attention: 'bg-amber-500',
  paused: 'bg-amber-500',
  disrupted: 'bg-red-500',
};

// The dot's colour class for a tone (null = no dot). The header button paints its own corner
// dot with it (its children are presentational, so it names the dot by aria-describedby).
export function deliveryDotClass(tone) {
  return DOT[tone] || null;
}

// The glyph for a channel: cloud, or a monitor (a crossed-out one when paused, so the paused
// state reads without the colour too). A cloud that needs a look or is disrupted swaps to the
// alert cloud for the same reason: the header button and the sidebar card change SHAPE, never
// only the dot's colour (polish 2026-11-01).
export function deliveryIcon(channel, tone) {
  if (channel === 'cloud') return tone === 'attention' || tone === 'disrupted' ? CloudAlert : CloudIcon;
  return tone === 'paused' ? MonitorOff : Monitor;
}

// One channel: icon, corner dot, and (in All-projects mode) the project count beside it.
// `label` is the channel's accessible text ("On the cloud: 2"); `dotLabel` names the dot.
export default function DeliveryGlyph({ channel, tone = null, count = null, showCount = false, label, dotLabel }) {
  const Icon = deliveryIcon(channel, tone);
  const dot = deliveryDotClass(tone);
  return (
    <span className="inline-flex items-center gap-1" data-channel={channel}>
      <span className="relative inline-flex">
        <Icon size={15} className="text-zinc-600 dark:text-zinc-300" aria-hidden="true" />
        {dot ? (
          <span
            role="img"
            aria-label={dotLabel}
            data-tone={tone}
            className={`absolute -right-1 -top-1 h-2 w-2 rounded-full ring-2 ring-zinc-100 dark:ring-zinc-800 ${dot}`}
          />
        ) : null}
      </span>
      {showCount ? <span aria-hidden="true" className="text-xs font-bold tabular-nums leading-none">{count}</span> : null}
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
