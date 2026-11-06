// UnconnectedProjectsLine - "these posts wait for a platform that is not connected", said ONCE
// per project at the top of the All-projects queue (Freigaben error UX, 2026-11-06, owner pick A).
// It replaces the red "LinkedIn ist nicht verbunden" line and the Verbinden button that every
// such row used to carry (15 rows, 15 buttons for one fix). The rows keep only a quiet chip.
//
//   [avatar] TILL  15  (li+plug) (x+plug)
//
// Each lane's connect is a bordered pill right after the count: the lane glyph with a plug
// badge (its name on hover and for a screen reader), so it says which lane it connects and can
// never be mistaken for the rows' passive struck chip. It runs the SAME fix the rows ran
// (IssueFixButton connect): a key lane connects in a modal scoped to THIS project, an OAuth lane
// opens Setup with its reconnect started, after the app has switched to this project
// (onNavigate's 4th argument, App navigateForProject).
// One project mode needs none of this: the DestinationStrip above the list says it already.
import { PlugZap } from 'lucide-react';
import { useT, tCount } from '../lib/i18n.js';
import { laneLabel } from '../lib/failureCopy.js';
import { setupIdOf } from '../lib/format.js';
import { ClientAvatar } from './ClientSwitcher.jsx';
import { Tip } from './ui/Tooltip.jsx';
import IssueFixButton from './IssueFixButton.jsx';
import { PlatformGlyph } from './ApprovalBlockerLine.jsx';

/**
 * Group posts that wait for a lane that is not connected, per project. Pure.
 * offlineLanesOf(post) -> lanes. Returns [{ clientId, clientName, accent, lanes, count }],
 * most posts first.
 */
export function unconnectedGroups(posts, offlineLanesOf) {
  const groups = new Map();
  for (const p of posts || []) {
    const lanes = offlineLanesOf(p) || [];
    if (!lanes.length) continue;
    const id = p.clientId || '';
    let g = groups.get(id);
    if (!g) {
      g = { clientId: p.clientId || null, clientName: p.clientName || '', accent: p.accent || null, lanes: [], count: 0, order: groups.size };
      groups.set(id, g);
    }
    g.count += 1;
    for (const l of lanes) if (!g.lanes.includes(l)) g.lanes.push(l);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.order - b.order).map(({ order, ...g }) => g); // eslint-disable-line no-unused-vars
}

// The connect button's face: the lane's own glyph (in colour, NOT struck: the struck glyph is
// the rows' passive "not connected" chip) with a small plug badge at its bottom-right, so it
// reads "connect LinkedIn".
function ConnectGlyph({ platform }) {
  return (
    <span className="relative inline-flex" aria-hidden="true">
      <PlatformGlyph platform={platform} size={16} />
      <span data-plug-badge="" className="absolute -bottom-1 -right-1.5 inline-flex rounded-full bg-white p-px text-brand ring-1 ring-zinc-900/10 dark:bg-zinc-900 dark:text-brand-light dark:ring-white/15">
        <PlugZap size={10} aria-hidden="true" />
      </span>
    </span>
  );
}

export default function UnconnectedProjectsLine({ groups = [], onNavigate = null }) {
  const t = useT();
  if (!groups.length) return null;
  return (
    <div data-unconnected-projects="" className="flex flex-col gap-1">
      {groups.map((g) => {
        const names = g.lanes.map(laneLabel).join(', ');
        const tip = tCount(t, 'approvals.unconnected.tip', g.count, { project: g.clientName || g.clientId || '', platforms: names });
        const nav = typeof onNavigate === 'function' ? (p, platform, opts) => onNavigate(p, platform, opts, g.clientId || undefined) : null;
        return (
          <div key={g.clientId || 'active'} data-project={g.clientId || ''} className="flex min-w-0 items-center gap-2 rounded-xl bg-zinc-900/[0.03] py-0.5 pl-2.5 pr-0.5 dark:bg-white/5">
            <Tip label={tip}>
              <span tabIndex={0} aria-label={tip} className="flex min-w-0 items-center gap-2 rounded-lg text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                {g.clientName ? <ClientAvatar client={{ displayName: g.clientName, accent: g.accent, logo: null }} size={16} /> : null}
                <span className="min-w-0 truncate font-semibold text-zinc-700 dark:text-zinc-200">{g.clientName}</span>
                <span className="shrink-0 font-bold tabular-nums text-zinc-500 dark:text-zinc-400">{g.count}</span>
              </span>
            </Tip>
            <span className="flex shrink-0 items-center gap-1">
              {g.lanes.map((l) => {
                const lane = setupIdOf(l);
                const issue = { kind: 'blocked', lane, lanes: [l], clientId: g.clientId, cause: `connect:${lane}`, code: null, fix: { type: 'connect', lane, agent: false } };
                return <IssueFixButton key={l} issue={issue} post={null} onNavigate={nav} iconOnly pill glyph={<ConnectGlyph platform={l} />} />;
              })}
            </span>
          </div>
        );
      })}
    </div>
  );
}
