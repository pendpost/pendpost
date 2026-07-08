import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, FileText, CalendarDays, CheckCircle2, Activity, BarChart3, FolderOpen, Settings as SettingsIcon, Plus, Moon, Sun, RefreshCw, CornerDownLeft, CornerUpLeft, Users, Check, Send, Wrench } from 'lucide-react';
import { prettyCampaign } from '../lib/format.js';
import { useT } from '../lib/i18n.js';

// Dep-free subsequence ranker. Returns null when `query` is not a
// case-insensitive subsequence of `text`; otherwise a score that rewards
// contiguous runs and characters that land at a word start.
const WORD_BOUNDARY = new Set([' ', '-', '_', '/', '·']); // · = middle dot
function fuzzyScore(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let run = 0;
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi];
    let found = -1;
    for (let j = ti; j < t.length; j += 1) {
      if (t[j] === ch) {
        found = j;
        break;
      }
    }
    if (found === -1) return null;
    if (found === ti) {
      run += 1;
      score += 1 + run; // contiguous run bonus grows with run length
    } else {
      run = 0;
      score += 1;
    }
    if (found === 0 || WORD_BOUNDARY.has(t[found - 1])) score += 3; // word-start bonus
    ti = found + 1;
  }
  return score;
}

// The ten routable pages, with their (upstream-localized) label key and an icon
// each. labelKey reuses the shared nav.* pack entries, and the icons mirror
// Sidebar.jsx, so the palette and the sidebar always read the same page names.
const PAGE_COMMANDS = [
  { key: 'planner', labelKey: 'nav.planner', icon: CalendarDays },
  { key: 'freigaben', labelKey: 'nav.approvals', icon: CheckCircle2 },
  { key: 'published', labelKey: 'nav.published', icon: Send },
  { key: 'activity', labelKey: 'nav.activity', icon: Activity },
  { key: 'insights', labelKey: 'nav.insights', icon: BarChart3 },
  { key: 'assets', labelKey: 'nav.assets', icon: FolderOpen },
  { key: 'clients', labelKey: 'nav.clients', icon: Users },
  { key: 'settings', labelKey: 'nav.settings', icon: SettingsIcon },
  { key: 'setup', labelKey: 'nav.setup', icon: Wrench },
];

export default function CommandPalette({ posts, onNavigate, onNew, onNewThread, onToggleTheme, onRecheckHealth, onOpenPost, dark, clients, activeClientId, onSwitchClient }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const restoreFocusRef = useRef(null);

  // Hotkey: only the Cmd-K / Ctrl-K COMBO toggles the palette, never a bare key
  // (so typing in the composer is never hijacked). When open, Escape also closes
  // from anywhere inside the dialog - mirroring the sibling modals (confirm.jsx,
  // ui.jsx slide-over) which exit on a document/window Escape regardless of which
  // element holds focus (e.g. after a backdrop click moves focus off the input).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (open && e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Open lifecycle: remember where focus was, reset query + active row, focus the
  // input on the next frame. Close lifecycle: restore focus to the prior element.
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement;
      setQuery('');
      setActive(0);
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
    restoreFocusRef.current?.focus?.();
    return undefined;
  }, [open]);

  const close = () => setOpen(false);

  // Static commands: page jumps + the three actions.
  const staticCommands = useMemo(() => {
    const pages = PAGE_COMMANDS.map((p) => ({
      id: `page:${p.key}`,
      label: t('palette.goTo', { label: t(p.labelKey) }),
      hint: t('palette.hintPage'),
      icon: p.icon,
      // Keep the route key searchable so a page stays findable by its internal
      // name even when its label diverges from it (e.g. the "clients" route now
      // labelled "Projects" - typing either term still surfaces the jump).
      _hay: p.key,
      run: () => onNavigate(p.key),
    }));
    return [
      ...pages,
      { id: 'new', label: t('composer.newPost'), hint: t('palette.hintAction'), icon: Plus, run: () => onNew() },
      { id: 'new-thread', label: t('threadComposer.new'), hint: t('palette.hintAction'), icon: CornerUpLeft, run: () => onNewThread?.() },
      { id: 'theme', label: dark ? t('palette.lightTheme') : t('palette.darkTheme'), hint: t('palette.hintAction'), icon: dark ? Sun : Moon, run: () => onToggleTheme() },
      { id: 'health', label: t('palette.recheckStatus'), hint: t('palette.hintAction'), icon: RefreshCw, run: () => { onRecheckHealth().catch(() => {}); } },
    ];
  }, [dark, onNavigate, onNew, onNewThread, onToggleTheme, onRecheckHealth, t]);

  // Post commands: open the post detail; searchable on id + first caption line +
  // title + campaign via a precomputed haystack string.
  const postCommands = useMemo(
    () =>
      (posts || []).map((p) => {
        const firstLine = p.caption ? p.caption.split('\n')[0] : '';
        return {
          id: `post:${p.campaign}/${p.id}`,
          label: p.title || firstLine || p.id,
          hint: `${p.id} · ${prettyCampaign(p.campaign)} · ${t(`type.${p.type}`)}`,
          icon: FileText,
          _hay: `${p.id} ${p.title || ''} ${firstLine} ${p.campaign} ${t(`type.${p.type}`)}`,
          run: () => onOpenPost(p),
        };
      }),
    [posts, onOpenPost, t],
  );

  // Switch-client commands (C4): one "Switch to {name}" per NON-ARCHIVED client.
  // Prop-driven (clients + activeClientId + onSwitchClient threaded from App.jsx),
  // so the palette stays pure/testable. The active client is marked (aria-current
  // + Check) and selecting it is a no-op close - it never calls onSwitchClient,
  // mirroring ClientSwitcher.pick. An archived client gets no switch action.
  const switchCommands = useMemo(
    () =>
      (clients || [])
        .filter((c) => (c.status || 'active') !== 'archived')
        .map((c) => {
          const isActive = c.id === activeClientId;
          return {
            id: `client:${c.id}`,
            label: t('palette.switchTo', { name: c.displayName || c.id }),
            hint: t('palette.hintClient'),
            icon: isActive ? Check : Users,
            current: isActive,
            // Selecting the active client is a no-op close (act() already closes);
            // only a real switch fires onSwitchClient.
            run: () => { if (!isActive) onSwitchClient?.(c.id); },
          };
        }),
    [clients, activeClientId, onSwitchClient, t],
  );

  // Empty query -> all static commands + a short slice of posts. Non-empty ->
  // score every command, drop misses, sort desc, cap the list.
  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return [...staticCommands, ...switchCommands, ...postCommands.slice(0, 8)];
    const ql = q.toLowerCase();
    return [...staticCommands, ...switchCommands, ...postCommands]
      .map((cmd) => {
        const base = fuzzyScore(q, `${cmd.label} ${cmd.hint} ${cmd._hay || ''}`);
        if (base === null) return { cmd, score: null };
        // Reward a literal name match so a short page/action label ("Go to
        // Planner") outranks a diffuse p-l-a-n subsequence scattered across a
        // long post caption. A prefix of the label is the strongest signal; a
        // whole-substring appearance is next.
        const label = cmd.label.toLowerCase();
        let score = base;
        if (label.startsWith(ql)) score += 50;
        else if (label.includes(ql)) score += 25;
        // Break ties toward commands (pages + actions + client switches) over
        // post matches, whose ids are namespaced 'post:'.
        if (!cmd.id.startsWith('post:')) score += 1;
        return { cmd, score };
      })
      .filter((r) => r.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30)
      .map((r) => r.cmd);
  }, [query, staticCommands, switchCommands, postCommands]);

  // Keep the active row in range when the result list shrinks under it.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, results.length - 1)));
  }, [results.length]);

  // Keep the highlighted row visible during keyboard navigation: once the active
  // option scrolls past the overflow-y-auto window the user would lose sight of
  // their selection. Same precedent as DateTimePicker.jsx (scrollIntoView); block
  // 'nearest' avoids jumping when the row is already on screen, and the browser
  // honours the user's reduced-motion preference by default.
  const activeOptionId = results[active] ? `cmdk-opt-${results[active].id}` : undefined;
  useEffect(() => {
    if (!open || !activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeOptionId]);

  if (!open) return null;

  const act = (cmd) => {
    close();
    cmd.run();
  };

  const onInputKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = results[active];
      if (cmd) act(cmd);
    } else if (e.key === 'Tab') {
      // Minimal focus trap: only the input is focusable; the list is driven by
      // active-descendant + mouse.
      e.preventDefault();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
      <button type="button" aria-label={t('palette.close')} onClick={close} className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.label')}
        className="glass-panel relative z-10 flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl animate-slide-in motion-reduce:animate-none"
      >
        <div className="flex items-center gap-2.5 border-b border-zinc-900/5 px-4 py-3 dark:border-white/10">
          <Search size={16} className="shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder={t('palette.searchPlaceholder')}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-listbox"
            aria-activedescendant={activeOptionId}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck="false"
            className="min-w-0 flex-1 bg-transparent text-sm font-bold text-zinc-800 placeholder:font-normal placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
          <kbd aria-hidden="true" className="hidden shrink-0 rounded-md bg-zinc-200/60 px-1.5 py-0.5 text-[10px] font-bold text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400 sm:inline-block">
            {t('palette.escKey')}
          </kbd>
        </div>

        {/* Live region: announces the matched-option count (or the no-match
            state) to screen readers as the query rewrites the option set. */}
        <span className="sr-only" role="status" aria-live="polite">
          {results.length === 0 ? t('palette.noMatches') : t('palette.resultCount', { count: results.length })}
        </span>

        {results.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-zinc-400 dark:text-zinc-500">{t('palette.noMatches')}</p>
        ) : (
          <ul id="cmdk-listbox" role="listbox" aria-label={t('palette.results')} className="min-h-0 flex-1 overflow-y-auto p-2">
            {results.map((cmd, i) => {
              const isActive = i === active;
              const Icon = cmd.icon;
              return (
                <li
                  key={cmd.id}
                  id={`cmdk-opt-${cmd.id}`}
                  role="option"
                  aria-selected={isActive}
                  aria-current={cmd.current ? 'true' : undefined}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    act(cmd);
                  }}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 ${
                    isActive ? 'bg-brand/10 text-brand dark:bg-brand-light/15 dark:text-brand-light' : 'text-zinc-700 dark:text-zinc-200'
                  }`}
                >
                  {Icon ? <Icon size={15} className="shrink-0" aria-hidden="true" /> : null}
                  <span className="min-w-0 flex-1 truncate text-sm font-bold">{cmd.label}</span>
                  {cmd.hint ? <span className="shrink-0 truncate text-[11px] font-normal text-zinc-400 dark:text-zinc-500">{cmd.hint}</span> : null}
                  {isActive ? <CornerDownLeft size={13} className="shrink-0 text-brand/60 dark:text-brand-light/60" aria-hidden="true" /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
