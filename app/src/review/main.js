// main.js - the client review page (spec 48 R10, surfaces V1/V2/V3). A dependency-free
// vanilla-JS bundle: no React, no framework, so it stays tiny and the review listener
// can inline it into the page shell. It reads its config from window.__REVIEW__ (token,
// locale, strings, contact - injected by the listener at the HOOK(W6) seam) and its
// content from GET /review/<token>/bundle. Approve / decline flow through
// POST /review/<token>/decision, which is the ONE existing setApproval write.
//
// Design guarantees that matter for the Tier 1/2 gates:
//  - The client accent is CHROME ONLY. accentChrome() gives an AA fill+text pair for
//    the header band and Approve button; accentInk() clamps the accent for any place
//    it tints readable text on the page background. Body text never sits on the accent.
//  - No nested-interactive: a card is a plain <article>; Approve/Decline are its only
//    controls (never focusable children of an expandable-card button).
//  - A failed submit NEVER destroys a typed decline note or the chosen verdict.
//  - O1 re-decide: a decided-but-still-pending card carries "Change decision", which
//    re-POSTs a new verdict through the same write + the same stale-hash guard.
//  - prefers-reduced-motion is honoured in CSS; nothing is hover-only.
import { accentChrome, accentInk } from './contrast-clamp.js';
import './review.css';

const cfg = (typeof window !== 'undefined' && window.__REVIEW__) || {};
const TOKEN = cfg.token || '';
const LOCALE = cfg.locale || 'en';
const CONTACT = cfg.contact || null;
const STR = cfg.strings || {};

// --- i18n (mirror of makeT: dotted key + {named} interpolation, raw key on miss) ---
function t(key, vars) {
  let s = Object.prototype.hasOwnProperty.call(STR, key) ? STR[key] : key;
  if (vars && typeof s === 'string') s = s.replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m));
  return s;
}
function platformLabel(id) {
  const k = 'platform.' + id;
  return Object.prototype.hasOwnProperty.call(STR, k) ? STR[k] : id;
}
let dtf = null;
try { dtf = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }); } catch { dtf = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }); }
function whenLabel(iso) {
  if (!iso) return t('review.scheduled.unset');
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return t('review.scheduled.unset');
  return t('review.scheduled', { when: dtf.format(new Date(ms)) });
}

// --- tiny DOM helpers (no innerHTML with untrusted data; textContent everywhere) ---
function el(tag, props, children) {
  const n = document.createElement(tag);
  if (props) for (const k of Object.keys(props)) {
    if (k === 'class') n.className = props[k];
    else if (k === 'text') n.textContent = props[k]; // ALL dynamic text goes through textContent (no innerHTML anywhere: no XSS surface)
    else if (k.startsWith('on') && typeof props[k] === 'function') n.addEventListener(k.slice(2), props[k]);
    else if (props[k] === true) n.setAttribute(k, '');
    else if (props[k] !== false && props[k] != null) n.setAttribute(k, props[k]);
  }
  for (const c of [].concat(children || [])) { if (c != null && c !== false) n.append(c); }
  return n;
}
const root = () => document.getElementById('review-root');
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// --- accent theming (chrome only, always clamped) -----------------------------------
function applyAccent(accent) {
  const chrome = accentChrome(accent);
  const darkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const bg = darkMode ? '#09090b' : '#f8fafc';
  const ink = accentInk(accent, bg).color; // accent made readable AS text on the page bg
  const rs = document.documentElement.style;
  rs.setProperty('--accent', chrome.fill);
  rs.setProperty('--accent-text', chrome.text);
  rs.setProperty('--accent-ink', ink);
}

// --- network ------------------------------------------------------------------------
async function getBundle() {
  const res = await fetch(`/review/${TOKEN}/bundle`, { headers: { Accept: 'application/json' } });
  if (res.status === 404) { const e = new Error('inactive'); e.inactive = true; throw e; }
  if (!res.ok) throw new Error('bundle_failed');
  return res.json();
}
async function postDecision(payload) {
  const res = await fetch(`/review/${TOKEN}/decision`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const mediaUrl = (ref) => `/review/${TOKEN}/media/${encodeURIComponent(ref)}`;

// --- state --------------------------------------------------------------------------
// Each item: { campaign, postId, contentHash, caption, platforms, scheduledAt, media,
//              decision: null|'approved'|'rejected', note, approvalWhen, error }
let items = [];
let brand = {};

// --- V3 inactive (client-side, when the token dies while the page is open) -----------
function renderInactive() {
  const r = root(); clear(r);
  const actions = [];
  if (CONTACT) {
    const href = /@/.test(CONTACT) && !/^mailto:/i.test(CONTACT) ? `mailto:${CONTACT}` : CONTACT;
    actions.push(el('a', { class: 'rv-mail', href, text: t('review.inactive.contact') }));
  }
  r.append(el('div', { class: 'rv-inactive' }, [
    el('h1', { text: t('review.inactive.title'), style: 'font-size:1.15rem;margin:0 0 6px' }),
    el('p', { text: t('review.inactive.body') }),
    ...actions,
    el('p', { class: 'rv-wordmark', text: 'pendpost' }),
  ]));
}

// --- loading skeleton (never a spinner) ---------------------------------------------
function skeletonCard() {
  return el('div', { class: 'rv-card', 'aria-hidden': 'true' }, [
    el('div', { class: 'rv-skel rv-skel-cover' }),
    el('div', { class: 'rv-skel rv-skel-line' }),
    el('div', { class: 'rv-skel rv-skel-line short' }),
    el('div', {}, [el('span', { class: 'rv-skel rv-skel-chip' }), el('span', { class: 'rv-skel rv-skel-chip' })]),
  ]);
}
function renderLoading() {
  const r = root(); clear(r);
  const wrap = el('div', { class: 'rv-wrap', role: 'status', 'aria-label': t('review.loading'), 'aria-busy': 'true' },
    [skeletonCard(), skeletonCard()]);
  r.append(wrap);
}

// --- generic load error (network) with retry ----------------------------------------
function renderLoadError() {
  const r = root(); clear(r);
  r.append(el('div', { class: 'rv-wrap' }, [
    el('div', { class: 'rv-card' }, [
      el('p', { class: 'rv-card-error', text: t('review.error.load') }),
      el('button', { class: 'rv-btn rv-btn-quiet', text: t('review.action.retry'), onclick: boot }),
    ]),
  ]));
}

// --- the card ------------------------------------------------------------------------
function mediaEl(item) {
  if (!item.media || !item.media.length) return null;
  return el('img', { class: 'rv-cover', src: mediaUrl(item.media[0]), alt: '', loading: 'lazy', decoding: 'async' });
}
function metaRow(item) {
  const chips = (item.platforms || []).map((p) => el('span', { class: 'rv-chip', text: platformLabel(p) }));
  chips.push(el('span', { class: 'rv-when', text: whenLabel(item.scheduledAt) }));
  return el('div', { class: 'rv-meta' }, chips);
}

function buildCard(item) {
  // A plain <article> - NEVER a button/expandable wrapper - so Approve/Decline are not
  // nested inside an interactive control (axe: no nested-interactive).
  const card = el('article', { class: 'rv-card', 'data-post': item.postId });
  card.__item = item;
  paintCard(card);
  return card;
}

function paintCard(card) {
  const item = card.__item;
  clear(card);
  const media = mediaEl(item);
  if (media) card.append(media);
  if (item.caption) card.append(el('p', { class: 'rv-caption', text: item.caption }));
  card.append(metaRow(item));

  if (item.error) card.append(el('p', { class: 'rv-card-error', role: 'alert', text: item.error }));

  if (!item.decision) {
    // pending: Approve / Decline (the only controls on the card)
    card.append(el('div', { class: 'rv-actions' }, [
      el('button', { class: 'rv-btn rv-approve', text: t('review.action.approve'), onclick: () => decide(card, 'approved') }),
      el('button', { class: 'rv-btn rv-decline', text: t('review.action.decline'), onclick: () => openDeclineSheet(card) }),
    ]));
  } else {
    // decided: show the verdict + (O1) a "Change decision" affordance while still pending
    const approved = item.decision === 'approved';
    const line = el('div', { class: 'rv-decided' }, [
      el('span', { class: 'rv-verdict ' + (approved ? 'approved' : 'declined'), text: approved ? t('review.status.approved') : t('review.status.declined') }),
      item.approvalWhen ? el('span', { class: 'rv-decided-when', text: item.approvalWhen }) : null,
    ]);
    if (!approved && item.note) line.append(el('p', { class: 'rv-decided-note', text: item.note }));
    card.append(line);
    if (!item.published) {
      card.append(el('div', { class: 'rv-actions', style: 'margin-top:10px' }, [
        el('button', { class: 'rv-btn rv-btn-quiet', text: t('review.action.change'), onclick: () => reopen(card) }),
      ]));
    }
  }
}

function reopen(card) {
  card.__item.decision = null;
  card.__item.error = null;
  paintCard(card);
  render(); // move it back out of Done, refresh progress
}

// --- decision submission -------------------------------------------------------------
async function decide(card, verdict, note) {
  const item = card.__item;
  item.error = null;
  const payload = { campaign: item.campaign, postId: item.postId, verdict, contentHash: item.contentHash };
  if (note) payload.note = note;
  let result;
  try { result = await postDecision(payload); }
  catch { item.error = t('review.error.network'); paintCard(card); return false; } // network: verdict/note preserved by caller
  if (result.status === 200) {
    item.decision = verdict;
    item.note = note || item.note || '';
    item.approvalWhen = dtf.format(new Date());
    item.error = null;
    render();
    return true;
  }
  if (result.status === 409 && result.body && result.body.code === 'stale_content') {
    // Row 7: the post changed. Re-fetch, refresh THIS card's content + hash, ask again.
    await refreshStale(item);
    item.decision = null;
    item.error = t('review.error.stale');
    render();
    return false;
  }
  // any other failure: keep the card pending, surface a network-style error, preserve input
  item.error = t('review.error.network');
  paintCard(card);
  return false;
}

async function refreshStale(item) {
  try {
    const bundle = await getBundle();
    const fresh = (bundle.pending || []).find((p) => p.campaign === item.campaign && p.postId === item.postId);
    if (fresh) {
      item.contentHash = fresh.contentHash;
      item.caption = fresh.caption;
      item.platforms = fresh.platforms;
      item.scheduledAt = fresh.scheduledAt;
      item.media = fresh.media;
    } else {
      item.gone = true; // no longer pending (published or removed): drop it on next render
    }
  } catch (e) {
    if (e && e.inactive) { renderInactive(); }
  }
}

// --- V2 decline sheet ----------------------------------------------------------------
const MAX_NOTE = 500;
function openDeclineSheet(card) {
  const item = card.__item;
  const prior = document.activeElement;
  const backdrop = el('div', { class: 'rv-sheet-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('review.decline.title') });
  const counter = el('p', { class: 'rv-counter', 'aria-live': 'polite' });
  const ta = el('textarea', { id: 'rv-note', maxlength: String(MAX_NOTE), rows: '4' });
  ta.value = item.pendingNote || '';
  const errLine = el('p', { class: 'rv-card-error', role: 'alert', style: 'margin:8px 0 0' });
  errLine.hidden = true;
  function updateCounter() {
    const left = MAX_NOTE - ta.value.length;
    counter.textContent = left <= 50 ? t('review.decline.remaining', { n: left }) : '';
  }
  ta.addEventListener('input', () => { item.pendingNote = ta.value; updateCounter(); });
  updateCounter();

  const submitBtn = el('button', { class: 'rv-btn rv-sheet-submit', text: t('review.decline.submit') });
  const cancelBtn = el('button', { class: 'rv-btn rv-decline', text: t('review.decline.cancel') });

  function close() {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (prior && prior.focus) prior.focus();
  }
  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'Tab') { // simple focus trap across the two buttons + textarea
      const f = [ta, submitBtn, cancelBtn];
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); cancelBtn.focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); ta.focus(); }
    }
  }
  cancelBtn.addEventListener('click', close);
  submitBtn.addEventListener('click', async () => {
    submitBtn.disabled = true;
    const note = ta.value.trim();
    const okDone = await decide(card, 'rejected', note);
    if (okDone) { item.pendingNote = ''; close(); }
    else {
      // failure: sheet STAYS open, every character preserved, show the error, allow retry
      submitBtn.disabled = false;
      errLine.hidden = false;
      errLine.textContent = t('review.error.network');
      ta.focus();
    }
  });

  const sheet = el('div', { class: 'rv-sheet' }, [
    el('h2', { text: t('review.decline.title') }),
    item.caption ? el('p', { class: 'rv-sheet-excerpt', text: item.caption }) : null,
    el('label', { for: 'rv-note', text: t('review.decline.label') }),
    ta, counter, errLine,
    el('div', { class: 'rv-sheet-actions' }, [submitBtn, cancelBtn]),
  ]);
  backdrop.append(sheet);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  root().append(backdrop);
  ta.focus();
}

// --- render (V1 pending + at-scale grouping + Done group + empty) --------------------
function render() {
  items = items.filter((i) => !i.gone);
  const decidedCount = items.filter((i) => i.decision).length;
  const total = items.length;

  const r = root(); clear(r);
  const wrap = el('div', { class: 'rv-wrap' });

  // header band (chrome)
  const band = el('div', { class: 'rv-band' });
  if (brand.logo) band.append(el('img', { src: mediaUrl(brand.logo), alt: '' }));
  band.append(el('h1', { text: brand.name || 'pendpost' }));
  wrap.append(band);
  wrap.append(el('p', { class: 'rv-purpose', text: t('review.header.purpose') }));

  if (total === 0) { renderEmpty(wrap); r.append(wrap); return; }

  // sticky progress (always shown; carries its weight most at scale)
  const bar = el('span'); bar.style.width = total ? `${Math.round((decidedCount / total) * 100)}%` : '0';
  wrap.append(el('div', { class: 'rv-progress' }, [
    el('span', { text: t('review.progress', { decided: decidedCount, total }) }),
    el('div', { class: 'rv-bar' }, [bar]),
  ]));

  const pending = items.filter((i) => !i.decision);
  const done = items.filter((i) => i.decision);

  // pending, grouped by campaign, soonest first (bundle already sorted)
  wrap.append(el('h2', { class: 'rv-group-label', text: t('review.section.pending') }));
  let lastCampaign = null;
  for (const item of pending) {
    if (item.campaign !== lastCampaign) { wrap.append(el('div', { class: 'rv-group-label', text: item.campaign })); lastCampaign = item.campaign; }
    wrap.append(buildCard(item));
  }
  if (pending.length === 0) wrap.append(el('p', { class: 'rv-purpose', text: t('review.empty.body') }));

  // Done group (collapsible; tap-reachable)
  if (done.length) {
    const region = el('div', { class: 'rv-done-region', id: 'rv-done' });
    for (const item of done) region.append(buildCard(item));
    const collapsed = done.length >= 3; // ship collapsed at scale
    region.hidden = collapsed;
    const toggle = el('button', {
      class: 'rv-done-toggle', 'aria-expanded': String(!collapsed), 'aria-controls': 'rv-done',
    }, [el('span', { class: 'rv-caret', 'aria-hidden': 'true', text: '▾' }), el('span', { text: `${t('review.section.done')} (${done.length})` })]);
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      region.hidden = open;
    });
    wrap.append(toggle, region);
  }

  r.append(wrap);
}

function renderEmpty(wrap) {
  wrap.append(el('div', { class: 'rv-empty' }, [
    el('h2', { text: t('review.empty.title') }),
    el('p', { text: t('review.empty.body') }),
  ]));
  const receipt = brand.decided || [];
  if (receipt.length) {
    wrap.append(el('h2', { class: 'rv-group-label', text: t('review.receipt.title') }));
    for (const d of receipt) {
      const approved = d.verdict === 'approved';
      wrap.append(el('div', { class: 'rv-receipt-row' }, [
        el('span', { class: 'rv-verdict ' + (approved ? 'approved' : 'declined'), text: approved ? t('review.receipt.approved') : t('review.receipt.declined') }),
        el('span', { text: (d.caption || '').slice(0, 80) }),
        el('span', { class: 'rv-when', text: whenLabel(d.scheduledAt) }),
      ]));
    }
  }
}

// --- boot ----------------------------------------------------------------------------
async function boot() {
  renderLoading();
  try {
    const bundle = await getBundle();
    brand = bundle.brand || {};
    brand.decided = bundle.decided || [];
    applyAccent(brand.accent);
    items = (bundle.pending || []).map((p) => ({
      campaign: p.campaign, postId: p.postId, contentHash: p.contentHash,
      caption: p.caption || '', platforms: p.platforms || [], scheduledAt: p.scheduledAt || null,
      media: p.media || [], decision: null, note: '', error: null,
    }));
    render();
  } catch (e) {
    if (e && e.inactive) { renderInactive(); return; }
    renderLoadError();
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}

export { boot };
