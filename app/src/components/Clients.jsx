import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Check, Pencil, Archive, ArchiveRestore, Loader2, X, Ban, CircleCheck, Clock, AlertTriangle, PauseCircle, Cloud as CloudIcon, Monitor } from 'lucide-react';
import { useClients, useClientsOverview, createClient, updateClient, archiveClient, useSetActiveClient, uploadAssetFile } from '../lib/api.js';
import { useCloud, useCloudClients, setClientAlwaysOn } from '../lib/cloud.js';
import { useT } from '../lib/i18n.js';
import { validateAccent, DEFAULT_ACCENT, clientAccent } from '../lib/theme.js';
import { INNER_SURFACE, EYEBROW, Skeleton } from './ui.jsx';
import { ClientAvatar } from './ClientSwitcher.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { useConfirm } from './ui/confirm.jsx';

const FIELD = `w-full rounded-xl border-0 px-3 py-2 text-sm ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`;
const FIELD_ERR = `w-full rounded-xl border-0 px-3 py-2 text-sm ${INNER_SURFACE} ring-1 ring-red-500/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500`;
const BTN = 'rounded-xl px-3 py-2 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
const BTN_BRAND = `${BTN} bg-brand text-white dark:bg-brand-light dark:text-zinc-900`;
const BTN_GHOST = `${BTN} text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60`;

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
// logo is the {path,url} object ClientAvatar renders (logo.url || /media/<path>),
// or null for a monogram. NOT the old { file } string shape (which never rendered).
const EMPTY = { id: '', displayName: '', accent: DEFAULT_ACCENT, timezone: '', logo: null };
// A logo is an image only - never a video. uploadAsset also accepts mp4/mov for
// publishable renders, so the UI constrains the picker AND pre-checks the name.
const LOGO_EXT_RE = /\.(png|jpe?g)$/i;

// Suggest a slug from a display name (used while the slug field is untouched).
function suggestSlug(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// The create / edit form. In edit mode the id is locked (it is the on-disk
// directory name; renaming is an out-of-band operator action, not a UI feature).
function ClientForm({ mode, initial, existingIds, onCancel, onSaved }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(initial || EMPTY);
  const [slugTouched, setSlugTouched] = useState(mode === 'edit');
  const [errors, setErrors] = useState({});
  const [banner, setBanner] = useState(null);
  const [saving, setSaving] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState(null);

  const editing = mode === 'edit';
  const accentCheck = validateAccent(form.accent);

  const setField = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  // Pick an image file -> upload it via the existing asset_upload twin -> store
  // the {path,url} logo shape ClientAvatar renders (NOT the old broken {file}).
  // Image extensions only (a logo is never a video); errors surface inline and
  // never produce a partial logo on the form.
  const onLogoFile = async (file) => {
    setLogoError(null);
    if (!file) return;
    if (!LOGO_EXT_RE.test(file.name)) {
      setLogoError(t('clientForm.error.logoNotImage'));
      return;
    }
    setLogoUploading(true);
    try {
      const res = await uploadAssetFile(file);
      const rel = res.file;
      setField('logo', { path: rel, url: `/media/${rel}` });
    } catch (err) {
      setLogoError(err.message || t('clientForm.error.logoUploadFailed'));
    } finally {
      setLogoUploading(false);
    }
  };
  const onName = (v) => {
    setForm((p) => ({ ...p, displayName: v, id: !slugTouched && !editing ? suggestSlug(v) : p.id }));
  };

  // Inline validation gathered up front so the operator sees every problem.
  const validate = () => {
    const e = {};
    if (!editing) {
      if (!form.id) e.id = t('clientForm.error.slugRequired');
      else if (!SLUG_RE.test(form.id)) e.id = t('clientForm.error.slugFormat');
      else if (existingIds.includes(form.id)) e.id = t('clientForm.error.slugExists');
    }
    if (!form.displayName.trim()) e.displayName = t('clientForm.error.displayNameRequired');
    if (!accentCheck.ok) e.accent = t(accentCheck.reasonKey, accentCheck.reasonVars);
    // Mirror the server isTimezone check (lib/config.mjs): a trimmed timezone must
    // be a valid IANA identifier or Intl throws, so an operator never saves a value
    // like '12:00' or 'UTC+1' that fails silently downstream. Empty stays optional.
    const tz = form.timezone.trim();
    if (tz) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { e.timezone = t('clientForm.error.timezoneInvalid'); }
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (ev) => {
    ev.preventDefault();
    setBanner(null);
    if (!validate()) return;
    setSaving(true);
    try {
      const body = {
        displayName: form.displayName.trim(),
        accent: form.accent,
        ...(form.timezone.trim() ? { timezone: form.timezone.trim() } : {}),
        ...(form.logo ? { logo: form.logo } : {}),
      };
      // Optimistic concurrency: echo the rev we read so a concurrent edit 409s
      // instead of silently last-writer-wins (server enforces stale_write).
      if (editing) await updateClient(form.id, { ...body, ifRev: form.rev });
      else await createClient({ id: form.id, ...body });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      onSaved();
    } catch (err) {
      setBanner(err.message || t('clientForm.error.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className={`space-y-3 rounded-2xl p-4 ${INNER_SURFACE}`} aria-label={editing ? t('clientForm.ariaEdit') : t('clientForm.ariaNew')}>
      <div className="flex items-center justify-between">
        <h3 className="font-display text-sm font-bold">{editing ? t('clientForm.titleEdit', { name: initial.displayName }) : t('clientForm.titleNew')}</h3>
        <button type="button" onClick={onCancel} aria-label={t('clientForm.cancel')} className="rounded-full p-1 text-zinc-500 hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60">
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className={EYEBROW}>{t('clientForm.field.displayName')}</span>
          <input
            value={form.displayName}
            onChange={(e) => onName(e.target.value)}
            placeholder={t('clientForm.field.displayNamePlaceholder')}
            className={errors.displayName ? FIELD_ERR : FIELD}
            aria-invalid={errors.displayName ? 'true' : undefined}
          />
          {errors.displayName ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{errors.displayName}</p> : null}
        </label>

        <label className="block space-y-1">
          <span className={EYEBROW}>{editing ? t('clientForm.field.idSlugImmutable') : t('clientForm.field.idSlug')}</span>
          <input
            value={form.id}
            onChange={(e) => { setSlugTouched(true); setField('id', e.target.value); }}
            placeholder={t('clientForm.field.idSlugPlaceholder')}
            disabled={editing}
            className={`${errors.id ? FIELD_ERR : FIELD} ${editing ? 'cursor-not-allowed opacity-60' : ''}`}
            aria-invalid={errors.id ? 'true' : undefined}
            aria-describedby="slug-hint"
          />
          {errors.id ? (
            <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{errors.id}</p>
          ) : (
            <p id="slug-hint" className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {editing ? t('clientForm.hint.slugEdit') : t('clientForm.hint.slugNew')}
            </p>
          )}
        </label>

        <label className="block space-y-1">
          <span className={EYEBROW}>{t('clientForm.field.accent')}</span>
          <span className="flex items-center gap-2">
            <input
              type="color"
              value={validateAccent(form.accent).ok || /^#[0-9a-fA-F]{6}$/.test(form.accent) ? form.accent : DEFAULT_ACCENT}
              onChange={(e) => setField('accent', e.target.value)}
              aria-label={t('clientForm.field.accentPicker')}
              className="h-9 w-12 shrink-0 cursor-pointer rounded-lg border-0 bg-transparent p-0.5"
            />
            <input
              value={form.accent}
              onChange={(e) => setField('accent', e.target.value)}
              placeholder={t('clientForm.field.accentPlaceholder')}
              aria-label={t('clientForm.field.accentHex')}
              className={errors.accent ? FIELD_ERR : FIELD}
              aria-invalid={errors.accent ? 'true' : undefined}
            />
          </span>
          {errors.accent ? (
            <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{errors.accent}</p>
          ) : accentCheck.ok ? (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('clientForm.hint.contrast', { ratio: accentCheck.ratio.toFixed(2) })}</p>
          ) : null}
        </label>

        <label className="block space-y-1">
          <span className={EYEBROW}>{t('clientForm.field.timezone')}</span>
          <input
            value={form.timezone}
            onChange={(e) => setField('timezone', e.target.value)}
            placeholder={t('clientForm.field.timezonePlaceholder')}
            className={errors.timezone ? FIELD_ERR : FIELD}
            aria-invalid={errors.timezone ? 'true' : undefined}
          />
          {errors.timezone ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{errors.timezone}</p> : null}
        </label>

        <div className="block space-y-1 sm:col-span-2">
          <label htmlFor="logo-file" className={EYEBROW}>{t('clientForm.field.logo')}</label>
          <div className="flex items-center gap-2">
            {form.logo ? (
              <img src={form.logo.url || `/media/${form.logo.path}`} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" />
            ) : null}
            <input
              id="logo-file"
              type="file"
              accept="image/png,image/jpeg"
              onChange={(e) => onLogoFile(e.target.files?.[0])}
              disabled={logoUploading}
              aria-describedby="logo-hint"
              className="block w-full text-xs text-zinc-600 file:mr-3 file:rounded-lg file:border-0 file:bg-brand file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-white dark:text-zinc-300 dark:file:bg-brand-light dark:file:text-zinc-900"
            />
            {logoUploading ? <Loader2 size={15} className="shrink-0 animate-spin text-zinc-400" aria-hidden="true" /> : null}
            {form.logo ? (
              <button
                type="button"
                onClick={() => { setField('logo', null); setLogoError(null); }}
                aria-label={t('clientForm.field.logoClear')}
                className="shrink-0 rounded-full p-1 text-zinc-500 hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60"
              >
                <X size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          {logoError ? (
            <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{logoError}</p>
          ) : (
            <p id="logo-hint" className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('clientForm.hint.logo')}</p>
          )}
        </div>
      </div>

      {banner ? <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">{banner}</p> : null}

      <div className="flex items-center gap-2">
        <button type="submit" disabled={saving || logoUploading} aria-busy={saving} className={BTN_BRAND}>
          {saving ? <Loader2 size={14} className="mr-1.5 inline animate-spin" aria-hidden="true" /> : null}
          {editing ? t('clientForm.submitSave') : t('clientForm.submitCreate')}
        </button>
        <button type="button" onClick={onCancel} className={BTN_GHOST}>{t('clientForm.cancel')}</button>
      </div>
    </form>
  );
}

// The per-client health cell rendered INSIDE the admin table. The standalone
// cross-client Overview was merged in here so each client appears exactly once
// (identity + status + health + actions in one row). Pending/overdue work, the
// per-client scheduler state, and the Meta-368 breaker - all via NON-COLOR signals
// (text label + count + icon, never color alone). Falls back to the registry's
// basic block signal when the richer overview roll-up is absent for an id.
function ClientHealthCell({ row, blocked, t }) {
  if (!row) {
    return blocked ? (
      <span className="inline-flex items-center gap-1.5 font-bold text-zinc-700 dark:text-zinc-200" title={t('clients.health.blockedTitle')}>
        <Ban size={13} aria-hidden="true" /> {t('clients.health.blocked')}
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
        <CircleCheck size={13} aria-hidden="true" /> {t('clients.health.ok')}
      </span>
    );
  }
  if (row.error != null) {
    return (
      <span className="inline-flex items-center gap-1.5 font-bold text-zinc-700 dark:text-zinc-200">
        <AlertTriangle size={13} aria-hidden="true" /> {t('clientsOverview.signal.corrupt')}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-zinc-600 dark:text-zinc-300">
      <span className="inline-flex items-center gap-1.5">
        <Clock size={13} aria-hidden="true" />
        {t('clientsOverview.signal.pending', { count: row.pending })}
      </span>
      {row.overdue > 0 ? (
        <span className="inline-flex items-center gap-1.5 font-bold text-zinc-800 dark:text-zinc-100">
          <AlertTriangle size={13} aria-hidden="true" />
          {t('clientsOverview.signal.overdue', { count: row.overdue })}
        </span>
      ) : null}
      {!row.schedulerRunning ? (
        <span className="inline-flex items-center gap-1.5 font-bold text-zinc-800 dark:text-zinc-100">
          <PauseCircle size={13} aria-hidden="true" />
          {t('clientsOverview.signal.schedulerOff')}
        </span>
      ) : null}
      {row.metaBlocked ? (
        <span className="inline-flex items-center gap-1.5 font-bold text-zinc-800 dark:text-zinc-100" title={t('clients.health.blockedTitle')}>
          <Ban size={13} aria-hidden="true" />
          {t('clientsOverview.signal.blocked')}
        </span>
      ) : null}
    </span>
  );
}

// LOCAL client / workspace administration: create, edit, archive, make-active.
// Not tenant/account management - there is no auth, no billing.
export default function Clients() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useClients();
  const setActive = useSetActiveClient();
  const confirm = useConfirm();
  const [form, setForm] = useState(null); // null | {mode:'create'} | {mode:'edit', client}
  const [busyId, setBusyId] = useState(null);
  const [announce, setAnnounce] = useState(''); // SR-only confirmation of the active-client switch
  const [actionError, setActionError] = useState(null);

  const clients = data?.clients || [];
  // Archived projects sink to the bottom (stable within each group) and read
  // muted, so the active roster stays front-and-centre while a one-click restore
  // stays fully legible. Only the table order changes - counts/forms keep `clients`.
  const sortedClients = [...clients].sort((a, b) => (a.status === 'archived' ? 1 : 0) - (b.status === 'archived' ? 1 : 0));
  const firstArchivedId = sortedClients.find((c) => c.status === 'archived')?.id;
  const activeId = data?.activeClientId || null;
  // Per-brand cloud delivery, joined from the cloud view (read only when connected so an
  // unconfigured install makes no cloud call). Drives the per-row delivery icon and the
  // "turn cloud off before archiving" safeguard.
  const { data: cloud } = useCloud();
  const cloudConnected = Boolean(cloud?.workspaceId && cloud?.apiKey?.present);
  const { data: cloudClientsData } = useCloudClients(cloudConnected);
  const alwaysOnById = useMemo(
    () => Object.fromEntries(((cloudClientsData?.clients) || []).map((c) => [c.clientId, c.alwaysOn])),
    [cloudClientsData],
  );
  // The cross-client health roll-up, joined into the table by id (the standalone
  // overview was merged into the table so each client renders as a single row).
  const { data: overviewData } = useClientsOverview();
  const overviewById = useMemo(
    () => Object.fromEntries((overviewData?.clients || []).map((c) => [c.id, c])),
    [overviewData],
  );

  const makeActive = async (c) => {
    setBusyId(c.id);
    try {
      // useSetActiveClient invalidates ['clients'] + every CLIENT_SCOPED_KEY from
      // one source of truth, so the table and the ClientSwitcher can never drift.
      await setActive(c.id);
      // a11y: a client switch silently re-scopes every page; announce it to SR users.
      setAnnounce(t('clients.announce.activated', { name: c.displayName }));
    } finally {
      setBusyId(null);
    }
  };

  const toggleArchive = async (c) => {
    const archiving = (c.status || 'active') === 'active';
    const ok = await confirm({
      title: archiving ? t('clients.confirm.archiveTitle', { name: c.displayName }) : t('clients.confirm.restoreTitle', { name: c.displayName }),
      body: archiving
        ? t('clients.confirm.archiveBody', { name: c.displayName })
        : t('clients.confirm.restoreBody', { name: c.displayName }),
      confirmLabel: archiving ? t('clients.confirm.archive') : t('clients.confirm.restore'),
      danger: archiving,
    });
    if (!ok) return;
    setBusyId(c.id);
    setActionError(null);
    try {
      // 24/7 cloud is billed per always-on brand. Archiving a cloud-on brand must turn its
      // cloud OFF first (it stops billing and leaves the cloud overview); if that call fails
      // we ABORT the archive rather than hide a brand that is still being billed.
      if (archiving && cloudConnected && alwaysOnById[c.id]) {
        await setClientAlwaysOn(c.id, false);
      }
      await archiveClient(c.id);
      queryClient.invalidateQueries({ queryKey: ['clients'] });
      queryClient.invalidateQueries({ queryKey: ['cloud'] });
    } catch (err) {
      setActionError(err.message || t('clients.action.error'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      <p role="status" aria-live="polite" className="sr-only">{announce}</p>
      {actionError ? <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">{actionError}</p> : null}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-lg font-bold">{t('clients.title')}</h2>
          <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            {t('clients.subtitle')}
          </p>
        </div>
        {!form ? (
          <button type="button" onClick={() => setForm({ mode: 'create' })} className={`flex items-center gap-1.5 ${BTN_BRAND}`}>
            <Plus size={15} aria-hidden="true" />
            {t('clients.new')}
          </button>
        ) : null}
      </header>

      {form ? (
        <ClientForm
          mode={form.mode}
          initial={form.mode === 'edit' ? { id: form.client.id, displayName: form.client.displayName, accent: clientAccent(form.client) || DEFAULT_ACCENT, timezone: form.client.timezone || '', logo: form.client.logo || null, rev: form.client.rev } : null}
          existingIds={clients.map((c) => c.id)}
          onCancel={() => setForm(null)}
          onSaved={() => setForm(null)}
        />
      ) : null}

      {isLoading ? (
        <div className="space-y-2" aria-hidden="true">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : isError || data?.error ? (
        <div role="alert" className="rounded-2xl bg-red-500/10 p-4 text-sm font-bold text-red-700 ring-1 ring-red-500/30 dark:text-red-300">
          {t('clients.registryUnreadable')}
          <span className="mt-1 block text-xs font-medium text-red-700/80 dark:text-red-300/80">
            {data?.error?.message || error?.message || t('clients.registryFallback')}
          </span>
        </div>
      ) : clients.length === 0 ? (
        <div className="grid place-items-center rounded-2xl p-8 text-center">
          <p className="text-sm font-bold">{t('clients.empty.title')}</p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t('clients.empty.body')}</p>
          <button type="button" onClick={() => setForm({ mode: 'create' })} className={`mt-3 flex items-center gap-1.5 ${BTN_BRAND}`}>
            <Plus size={15} aria-hidden="true" />
            {t('clients.createFirst')}
          </button>
        </div>
      ) : (
        <div className={`overflow-hidden rounded-2xl ${INNER_SURFACE}`}>
          <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t('clients.tableCaption')}</caption>
            <thead>
              <tr className="border-b border-zinc-200/70 text-[11px] tracking-tight text-zinc-400 dark:border-zinc-700/70 dark:text-zinc-500">
                <th scope="col" className="px-3 py-2 font-bold">{t('clients.col.client')}</th>
                <th scope="col" className="px-3 py-2 font-bold">{t('clients.col.status')}</th>
                <th scope="col" className="px-3 py-2 font-bold">{t('clients.col.health')}</th>
                <th scope="col" className="px-3 py-2 font-bold">{t('clients.col.timezone')}</th>
                <th scope="col" className="px-3 py-2 text-right font-bold">{t('clients.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedClients.map((c) => {
                const isActive = c.id === activeId;
                const archived = c.status === 'archived';
                const busy = busyId === c.id;
                // Mute the archived row's content cells (not the actions cell, so
                // Restore stays fully legible); a hairline separates the groups.
                const muted = archived ? 'opacity-60' : '';
                const sep = c.id === firstArchivedId ? 'border-t-2 border-zinc-200 dark:border-zinc-700' : '';
                return (
                  <tr key={c.id} aria-current={isActive ? 'true' : undefined} className={`border-b border-zinc-200/50 last:border-0 dark:border-zinc-700/50 ${sep}`}>
                    <td className={`px-3 py-2 ${muted}`}>
                      <span className="flex items-center gap-2">
                        <ClientAvatar client={c} size={24} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="font-bold">{c.displayName}</span>
                            {isActive ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-brand/15 px-2 py-0.5 text-[10px] font-bold text-brand dark:text-brand-light">
                                <Check size={11} aria-hidden="true" /> {t('clients.selected')}
                              </span>
                            ) : null}
                          </span>
                          <span className="block font-mono text-[10px] text-zinc-400 dark:text-zinc-500">{c.id}</span>
                        </span>
                      </span>
                    </td>
                    <td className={`px-3 py-2 text-xs ${muted}`}>
                      <span className="flex items-center gap-2">
                        <span>{archived ? t('clients.status.archived') : t('clients.status.active')}</span>
                        {cloudConnected && !archived ? (
                          alwaysOnById[c.id] ? (
                            <Tip label={t('clients.delivery.cloud')}>
                              <span className="inline-flex text-brand dark:text-brand-light" role="img" aria-label={t('clients.delivery.cloud')}>
                                <CloudIcon size={14} aria-hidden="true" />
                              </span>
                            </Tip>
                          ) : (
                            <Tip label={t('clients.delivery.local')}>
                              <span className="inline-flex text-zinc-400 dark:text-zinc-500" role="img" aria-label={t('clients.delivery.local')}>
                                <Monitor size={14} aria-hidden="true" />
                              </span>
                            </Tip>
                          )
                        ) : null}
                      </span>
                    </td>
                    <td className={`px-3 py-2 text-xs ${muted}`}>
                      {archived ? null : <ClientHealthCell row={overviewById[c.id]} blocked={c.actionBlocked} t={t} />}
                    </td>
                    <td className={`px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400 ${muted}`}>{c.timezone || '-'}</td>
                    <td className="px-3 py-2">
                      <span className="flex items-center justify-end gap-1">
                        {!isActive && !archived ? (
                          <button type="button" onClick={() => makeActive(c)} disabled={busy} aria-label={t('clients.action.makeActive', { name: c.displayName })} className="rounded-lg px-2 py-1 text-xs font-bold text-brand transition hover:bg-brand/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60 dark:text-brand-light">
                            {busy ? <Loader2 size={13} className="inline animate-spin" aria-hidden="true" /> : t('clients.makeActive')}
                          </button>
                        ) : null}
                        <Tip label={t('clients.action.edit', { name: c.displayName })}>
                          <button type="button" onClick={() => setForm({ mode: 'edit', client: c })} aria-label={t('clients.action.edit', { name: c.displayName })} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60">
                            <Pencil size={14} aria-hidden="true" />
                          </button>
                        </Tip>
                        <Tip label={archived ? t('clients.action.restore', { name: c.displayName }) : t('clients.action.archive', { name: c.displayName })}>
                          <button type="button" onClick={() => toggleArchive(c)} disabled={busy} aria-label={archived ? t('clients.action.restore', { name: c.displayName }) : t('clients.action.archive', { name: c.displayName })} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60 dark:hover:bg-zinc-700/60">
                            {archived ? <ArchiveRestore size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}
                          </button>
                        </Tip>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}
