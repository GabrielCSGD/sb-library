// Smoking Beards Library: the interface.
// Reads everything from Drive at sign-in, then filters in the browser, so
// searching is instant. Admin actions write back to Drive through drive.js.
import { signIn, session, signOut, renew } from './auth.js';
import * as drive from './drive.js';
import { crawl, enrich, loadCache, saveCache, dupKey, groupDuplicates, applyEras, projectOf } from './library.js';
import { norm, showDate } from './autotags.js';
import { Vocab, GROUPS, GROUP_LABEL, PKG_LABEL, tagProperties } from './tags.js';
import { Upload } from './upload.js';
import { openAccess } from './access.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const PAGE = 120;

export const S = {
  root: null, sys: null, folders: new Map(), files: [], byId: new Map(),
  vocab: new Vocab(), vocabId: null, events: { aliases: {}, folders: {} },
  folder: null, filters: [], sort: 'new', selected: new Set(), lastClicked: null,
  shown: PAGE, list: [], detail: null, groupBy: 'none', collapsed: new Set(),
};

// ---------------------------------------------------------------- facets
// Everything you can filter by besides tags. Each facet reads a value off a file.
const FACETS = {
  kind: { label: 'Type', get: (f) => f.auto.kind },
  shape: { label: 'Format', get: (f) => f.auto.orientation?.shape },
  ratio: { label: 'Ratio', get: (f) => f.auto.orientation?.ratio },
  duration: { label: 'Length', get: (f) => f.auto.duration },
  event: { label: 'Event', get: (f) => f.auto.event },
  year: { label: 'Year', get: (f) => f.auto.year },
  type: { label: 'Content type', get: (f) => f.auto.kind === 'document' ? 'Document'
    : `${f.auto.stage === 'raw' ? 'Raw' : 'Edited'} ${f.auto.kind === 'video' ? (f.auto.stage === 'raw' ? 'footage' : 'video') : 'picture'}` },
  pkg: { label: 'Packaging', get: (f) => PKG_LABEL[f.pack?.value] || 'Not checked yet' },
  review: { label: 'Tagging', get: (f) => f.tags.state === 'ok' ? 'Reviewed' : f.tags.state === 'ai' ? 'AI to review' : 'Untagged' },
};

// A filter with neg: true excludes what it matches ("NOT Talking").
function matches(f, flt) {
  let hit = true;
  if (flt.type === 'tag') hit = f.tags.confirmed.has(flt.key) || f.tags.ai.has(flt.key);
  else if (flt.type === 'facet') hit = FACETS[flt.key].get(f) === flt.value;
  else if (flt.type === 'text') hit = norm(f.path).includes(norm(flt.value));
  return flt.neg ? !hit : hit;
}

function inFolder(f) {
  if (!S.folder) return true;
  for (let id = f.folder; id; id = S.folders.get(id)?.parent) if (id === S.folder) return true;
  return false;
}

const dateOf = (f) => f.auto.date || f.createdTime.slice(0, 10);
const SORTS = {
  new: (a, b) => dateOf(b).localeCompare(dateOf(a)) || a.name.localeCompare(b.name),
  old: (a, b) => dateOf(a).localeCompare(dateOf(b)) || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
  long: (a, b) => (b.auto.seconds || 0) - (a.auto.seconds || 0),
};

// Each file shows once even if Drive holds several identical copies.
function compute() {
  const seen = new Set();
  S.list = S.files.filter((f) => inFolder(f) && S.filters.every((flt) => matches(f, flt))).sort(SORTS[S.sort])
    .filter((f) => !seen.has(dupKey(f)) && seen.add(dupKey(f)));
}

// ---------------------------------------------------------------- start up
$('#signin-btn').addEventListener('click', async () => {
  const msg = $('#signin-msg');
  msg.textContent = 'Signing in...';
  try {
    await signIn();
    document.body.classList.toggle('admin', session.isAdmin);
    msg.textContent = 'Finding the library...';
    S.root = await drive.findRoot();
    if (!S.root) { msg.textContent = 'This account has no access to the library yet. Ask Gabriel to add you.'; return; }
    $('#signin').hidden = true;
    $('#app').hidden = false;
    $('#who').textContent = `${session.name}${session.isAdmin ? ' (admin)' : ''}`;
    await boot();
  } catch (e) {
    msg.textContent = `Could not sign in: ${e.message}`;
  }
});

async function boot() {
  S.events = await fetch('config/events.json').then((r) => r.json()).catch(() => S.events);
  const cached = await loadCache(S.root.id);
  if (cached) { ingest(cached); render(); status('Updating from Drive...'); }
  else status('Loading the library from Drive. The first time takes a few seconds...');
  await Promise.all([loadVocab(), refresh()]);
}

async function loadVocab() {
  S.sys = await drive.systemFolder(S.root.id, false);
  if (!S.sys) return;
  const { id, data } = await drive.readJson(S.sys, 'tags.json');
  if (data) { S.vocab = new Vocab(data); S.vocabId = id; render(); }
}

async function refresh() {
  try {
    const data = await crawl(S.root, (n) => status(`Loading from Drive: ${n} files...`));
    ingest(data);
    saveCache(S.root.id, data);
    status(null);
    render();
  } catch (e) { fail(e); }
}

function ingest({ folders, files }) {
  S.folders = new Map(folders.map((f) => [f.id, { ...f }]));
  S.files = files.map((f) => enrich(f, S.folders, S.events));
  S.byId = new Map(S.files.map((f) => [f.id, f]));
  groupDuplicates(S.files);
  applyEras(S.files, S.folders, S.events);
}

function status(text) {
  const el = $('#status');
  el.hidden = !text;
  if (text) el.textContent = text;
}

function fail(e) {
  if (String(e.message).includes('SESSION_EXPIRED')) {
    toast('Your session ended after an hour. Click Continue to carry on.', 'Continue', async () => { await renew(); toast('Signed in again. Repeat the last action if it did not finish.'); });
  } else {
    console.error(e);
    toast(`Something went wrong: ${e.message}`);
  }
}

let toastTimer;
export function toast(text, action, onAction) {
  const el = $('#toast');
  el.innerHTML = `${esc(text)}${action ? ` <button class="btn">${esc(action)}</button>` : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; onAction(); };
  clearTimeout(toastTimer);
  if (!action) toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

// ---------------------------------------------------------------- render
function render() {
  compute();
  renderViews();
  renderTree();
  renderFacets();
  renderChips();
  renderCrumbs();
  renderGrid();
  renderBulk();
}

function countBy(fn, files = S.files) {
  const m = new Map();
  for (const f of files) { const v = fn(f); if (v != null) m.set(v, (m.get(v) || 0) + 1); }
  return m;
}

function navItem(label, n, attrs, active, extra = '') {
  return `<button class="nav-item${active ? ' active' : ''}" ${attrs}>${extra}<span>${esc(label)}</span>${n != null ? `<span class="n">${n}</span>` : ''}</button>`;
}

const hasFilter = (type, key, value) => S.filters.some((x) => x.type === type && x.key === key && (value === undefined || x.value === value));

function renderViews() {
  const pkg = countBy(FACETS.pkg.get), rev = countBy(FACETS.review.get);
  const v = (label, key, value, colour) => navItem(label, (key === 'pkg' ? pkg : rev).get(value) || 0,
    `data-act="facet" data-key="${key}" data-value="${esc(value)}"`, hasFilter('facet', key, value),
    colour ? `<span class="dot" style="background:${colour}"></span>` : '');
  $('#views').innerHTML =
    navItem('All files', new Set(S.files.map(dupKey)).size, 'data-act="all"', !S.folder && !S.filters.length) +
    v('Old packaging', 'pkg', 'Old packaging', 'var(--old)') +
    v('Check packaging', 'pkg', 'Check packaging', 'var(--check)') +
    (session.isAdmin ? v('Untagged', 'review', 'Untagged', '#9e978b') + v('AI to review', 'review', 'AI to review', 'var(--gold)') : '');
}

const openFolders = new Set();
function renderTree() {
  // file counts include everything below a folder
  const counts = new Map();
  for (const f of S.files) for (let id = f.folder; id; id = S.folders.get(id)?.parent) counts.set(id, (counts.get(id) || 0) + 1);
  const kids = new Map();
  for (const fo of S.folders.values()) if (fo.parent) (kids.get(fo.parent) || kids.set(fo.parent, []).get(fo.parent)).push(fo);
  for (const list of kids.values()) list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const rows = [];
  const walk = (id, depth) => {
    for (const fo of kids.get(id) || []) {
      const has = kids.has(fo.id), open = openFolders.has(fo.id);
      rows.push(`<button class="nav-item${S.folder === fo.id ? ' active' : ''}" style="--depth:${depth}" data-act="folder" data-id="${fo.id}">` +
        `<span class="tw" ${has ? `data-act="twist" data-id="${fo.id}"` : ''}>${has ? (open ? '&#9662;' : '&#9656;') : ''}</span>` +
        `<span>${esc(fo.name)}</span><span class="n">${counts.get(fo.id) || 0}</span></button>`);
      if (has && open) walk(fo.id, depth + 1);
    }
  };
  walk(S.root.id, 0);
  $('#tree').innerHTML = rows.join('');
}

function renderFacets() {
  // Counts follow the current folder, so the sidebar answers "what is in here".
  const scope = S.files.filter(inFolder);
  const out = [];
  const groups = new Map();
  for (const f of scope) for (const k of new Set([...f.tags.confirmed, ...f.tags.ai])) {
    const g = S.vocab.group(k);
    const m = groups.get(g) || groups.set(g, new Map()).get(g);
    m.set(k, (m.get(k) || 0) + 1);
  }
  const section = (title, items, open) => items.length ? `<details class="group"${open ? ' open' : ''}><summary class="side-label">${esc(title)}</summary>${items.join('')}</details>` : '';
  for (const g of GROUPS) {
    const m = groups.get(g);
    if (!m) continue;
    const items = [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) =>
      navItem(S.vocab.label(k), n, `data-act="tag" data-key="${esc(k)}"`, hasFilter('tag', k)));
    out.push(section(GROUP_LABEL[g], items, g === 'product' || g === 'person'));
  }
  for (const key of ['event', 'year', 'type', 'shape', 'duration', 'pkg']) {
    const m = countBy(FACETS[key].get, scope);
    const items = [...m].sort((a, b) => key === 'year' ? String(b[0]).localeCompare(String(a[0])) : b[1] - a[1])
      .map(([v, n]) => navItem(v, n, `data-act="facet" data-key="${key}" data-value="${esc(v)}"`, hasFilter('facet', key, v)));
    out.push(section(FACETS[key].label, items, key === 'event'));
  }
  $('#facets').innerHTML = out.join('');
}

function chipLabel(flt) {
  const not = flt.neg ? '<b class="not">NOT</b> ' : '';
  if (flt.type === 'tag') return not + esc(S.vocab.label(flt.key));
  if (flt.type === 'text') return `${not}<span class="k">name:</span> ${esc(flt.value)}`;
  return `${not}<span class="k">${esc(FACETS[flt.key].label)}:</span> ${esc(flt.value)}`;
}

// Clicking a chip flips it between "only these" and "NOT these".
function renderChips() {
  $('#chips').innerHTML = S.filters.map((flt, i) => `<span class="chip${flt.neg ? ' neg' : ''}"><span data-act="negate" data-i="${i}" title="Click to switch between include and exclude">${chipLabel(flt)}</span><button data-act="unfilter" data-i="${i}" aria-label="Remove">&times;</button></span>`).join('');
}

function renderCrumbs() {
  const parts = [];
  for (let id = S.folder; id && id !== S.root.id; id = S.folders.get(id)?.parent) parts.unshift(S.folders.get(id));
  $('#crumbs').innerHTML = [`<button data-act="all-folders">All folders</button>`,
    ...parts.map((p) => `<span class="sep">/</span><button data-act="folder" data-id="${p.id}">${esc(p.name)}</button>`)].join('');
  $('#count').textContent = `${S.list.length} file${S.list.length === 1 ? '' : 's'}`;
  $('#sort').value = S.sort;
  $('#groupby').value = S.groupBy;
  renderEra();
}

// Packaging of the shoot being browsed. Admins can set it for the whole shoot.
function renderEra() {
  const el = $('#era');
  const pid = S.folder && projectOf(S.folder, S.folders);
  const fo = pid && S.folders.get(pid);
  if (!fo || (S.events.notShoots || []).includes(fo.name)) { el.hidden = true; return; }
  const era = fo.era || fo.eraAuto;
  const why = fo.era ? '' : fo.eraFrom === 'date' ? (era === 'old' ? ' (shot before September 2025)' : ' (shot after September 2025)') : ' (from AI, not confirmed)';
  const label = era ? `${era === 'old' ? 'Old' : 'New'} packaging${why}` : 'not set';
  el.hidden = false;
  el.innerHTML = `<span class="muted small">Shoot packaging:</span> <b class="${era === 'old' ? 'era-old' : ''}">${esc(label)}</b>` +
    (session.isAdmin ? ` <span class="seg">${['new', 'old', 'auto'].map((v) => `<button class="${(fo.era || 'auto') === v ? 'on' : ''}${v === 'old' ? ' old' : ''}" data-act="era" data-era="${v}" data-id="${fo.id}">${{ new: 'New', old: 'Old', auto: 'Auto' }[v]}</button>`).join('')}</span>` : '');
}

function fmtDur(s) {
  if (s == null) return '';
  s = Math.round(s);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}

function pkgBadge(f) {
  const p = f.pack?.value;
  if (p === 'old') return `<span class="badge pkg old" title="Old packaging: spice and powder close-ups only">OLD PACK</span>`;
  if (p === 'check') return `<span class="badge pkg check" title="Packaging not confirmed">CHECK PACK</span>`;
  return '';
}

function card(f) {
  const t = drive.thumb(f, 440);
  const a = f.auto;
  const sub = [a.orientation?.ratio, a.event].filter(Boolean).join(' · ');
  const aiPending = session.isAdmin && f.tags.state === 'ai';
  return `<div class="card${S.selected.has(f.id) ? ' sel' : ''}${f.pack?.value === 'old' ? ' is-old' : ''}" data-id="${f.id}">
    <div class="thumb${a.orientation?.shape === 'vertical' ? ' contain' : ''}">
      ${t ? `<img loading="lazy" src="${esc(t)}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'${a.kind === 'video' ? 'VIDEO' : 'PHOTO'}'}))">` : `<div class="ph">${a.kind.toUpperCase()}</div>`}
      <span class="tick" data-act="tick">${S.selected.has(f.id) ? '&#10003;' : ''}</span>
      ${a.kind === 'video' ? `<span class="badge dur">${fmtDur(a.seconds) || 'VIDEO'}</span>` : ''}
      ${pkgBadge(f)}
      ${a.doNotUse ? `<span class="badge dnu">DO NOT USE</span>` : aiPending ? `<span class="badge ai">AI</span>` : ''}
    </div>
    <div class="meta"><div class="name" title="${esc(f.name)}">${esc(f.name)}</div><div class="sub">${esc(sub)}</div></div>
  </div>`;
}

function renderGrid() {
  const grid = $('#grid');
  grid.classList.toggle('selecting', S.selected.size > 0);
  if (!S.list.length) {
    grid.innerHTML = `<div class="empty">Nothing matches. Remove a filter, or ask Gabriel if the footage you need is not tagged yet.</div>`;
    $('#more').textContent = '';
    return;
  }
  if (S.groupBy !== 'none') return renderGroups(grid);
  grid.innerHTML = S.list.slice(0, S.shown).map(card).join('');
  $('#more').textContent = S.shown < S.list.length ? 'Loading more...' : '';
}

// ---------------------------------------------------------------- group by
// Splits the results into sections ("Talking 50", "BBQ 30"...) that fold away.
// A file goes in the first section that fits, in tag-list order, so a clip
// with both BBQ and Talking sits under BBQ and "Talking" holds the pure talk.
function firstTag(f, group) {
  for (const k of Object.keys(S.vocab.data.tags)) {
    if (S.vocab.group(k) === group && (f.tags.confirmed.has(k) || f.tags.ai.has(k))) return S.vocab.label(k);
  }
  return null;
}
const GROUP_BY = {
  action: (f) => firstTag(f, 'action') || 'No action tag',
  content: (f) => firstTag(f, 'content') || 'Other content',
  type: (f) => FACETS.type.get(f),
  event: (f) => f.auto.event || 'No event',
  shape: (f) => f.auto.orientation?.shape || 'Unknown format',
};
const SECTION_CAP = 48;
const sectionOpen = new Map(); // section name -> show all cards

function renderGroups(grid) {
  const secs = new Map();
  for (const f of S.list) { const k = GROUP_BY[S.groupBy](f); (secs.get(k) || secs.set(k, []).get(k)).push(f); }
  const html = [];
  const leftover = (n) => /^(No |Other |Unknown )/.test(n); // catch-all sections go last
  for (const [name, files] of [...secs].sort((a, b) => leftover(a[0]) - leftover(b[0]) || b[1].length - a[1].length)) {
    const closed = S.collapsed.has(`${S.groupBy}:${name}`);
    const all = sectionOpen.get(name);
    html.push(`<div class="sec-head"><button class="sec-toggle" data-act="toggle-sec" data-name="${esc(name)}">${closed ? '&#9656;' : '&#9662;'} ${esc(name)} <span class="muted">${files.length}</span></button>
      <span class="sec-actions"><button class="link small" data-act="select-sec" data-name="${esc(name)}">Select</button>
      <button class="link small" data-act="exclude-sec" data-name="${esc(name)}">Hide</button></span></div>`);
    if (closed) continue;
    html.push(files.slice(0, all ? files.length : SECTION_CAP).map(card).join(''));
    if (!all && files.length > SECTION_CAP) html.push(`<div class="sec-more"><button class="btn" data-act="more-sec" data-name="${esc(name)}">Show all ${files.length}</button></div>`);
  }
  grid.innerHTML = html.join('');
  $('#more').textContent = '';
  S.sections = secs;
}

// Show more cards as the user scrolls near the bottom.
new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && S.groupBy === 'none' && S.shown < S.list.length) {
    const start = S.shown;
    S.shown += PAGE;
    $('#grid').insertAdjacentHTML('beforeend', S.list.slice(start, S.shown).map(card).join(''));
    $('#more').textContent = S.shown < S.list.length ? 'Loading more...' : '';
  }
}, { rootMargin: '600px' }).observe($('#more'));

function renderBulk() {
  const n = S.selected.size;
  $('#bulk').hidden = !n;
  $('#bulk-count').textContent = `${n} selected`;
}

function rerender(resetScroll) {
  if (resetScroll) { S.shown = PAGE; $('.main').scrollTop = 0; }
  render();
}

// ---------------------------------------------------------------- filters and search
function addFilter(flt) {
  if (!S.filters.some((x) => JSON.stringify(x) === JSON.stringify(flt))) S.filters.push(flt);
  rerender(true);
}

function toggleFilter(flt) {
  const i = S.filters.findIndex((x) => JSON.stringify(x) === JSON.stringify(flt));
  if (i >= 0) S.filters.splice(i, 1); else S.filters.push(flt);
  rerender(true);
}

// Suggestions for what is typed: tags first, then events, formats and so on.
function suggestions(text) {
  // "not talking" or "-talking" suggests exclude filters
  const m = text.match(/^\s*(?:not\s+|-)(.*)$/i);
  if (m) return m[1].trim() ? suggestions(m[1]).filter((x) => x.flt.type !== 'text').map((x) => ({ ...x, flt: { ...x.flt, neg: true }, label: `NOT ${x.label}` })) : [];
  const k = norm(text);
  if (!k) return [];
  const out = S.vocab.search(text, 6).map((key) => ({ flt: { type: 'tag', key }, label: S.vocab.label(key), kind: GROUP_LABEL[S.vocab.group(key)] }));
  for (const [key, fc] of Object.entries(FACETS)) {
    for (const v of countBy(fc.get).keys()) {
      if (norm(v).includes(k) && out.length < 12) out.push({ flt: { type: 'facet', key, value: v }, label: v, kind: fc.label });
    }
  }
  out.push({ flt: { type: 'text', value: text.trim() }, label: `File or folder name contains "${text.trim()}"`, kind: 'Name' });
  return out;
}

// "Fred + Ribeye + vertical" becomes three filters.
function resolveTerm(term) {
  return suggestions(term).find((s) => s.flt.type !== 'text' && norm(s.label) === norm(term))?.flt
    || suggestions(term)[0]?.flt;
}

let hi = 0, sugg = [];
const q = $('#q');
q.addEventListener('input', () => {
  sugg = q.value.includes('+') ? [] : suggestions(q.value);
  hi = 0;
  drawSuggest();
});
function drawSuggest() {
  const box = $('#suggest');
  box.hidden = !sugg.length;
  box.innerHTML = sugg.map((s, i) => `<button class="${i === hi ? 'hi' : ''}" data-i="${i}"><span>${esc(s.label)}</span><span class="k">${esc(s.kind)}</span></button>`).join('');
}
$('#suggest').addEventListener('mousedown', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();
  pickSuggestion(sugg[+b.dataset.i]);
});
function pickSuggestion(s) {
  q.value = '';
  sugg = [];
  drawSuggest();
  addFilter(s.flt);
}
q.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { hi = Math.min(hi + 1, sugg.length - 1); drawSuggest(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { hi = Math.max(hi - 1, 0); drawSuggest(); e.preventDefault(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (q.value.includes('+')) {
      for (const term of q.value.split('+').map((t) => t.trim()).filter(Boolean)) { const f = resolveTerm(term); if (f) S.filters.push(f); }
      q.value = '';
      rerender(true);
    } else if (sugg[hi]) pickSuggestion(sugg[hi]);
  } else if (e.key === 'Backspace' && !q.value && S.filters.length) { S.filters.pop(); rerender(true); }
  else if (e.key === 'Escape') { q.value = ''; sugg = []; drawSuggest(); q.blur(); }
});
q.addEventListener('blur', () => setTimeout(() => { sugg = []; drawSuggest(); }, 150));

$('#sort').addEventListener('change', (e) => { S.sort = e.target.value; rerender(true); });
$('#groupby').addEventListener('change', (e) => { S.groupBy = e.target.value; rerender(true); });

// "Hide" on a section adds the matching NOT filter (e.g. NOT Talking).
function excludeSection(name) {
  if (S.groupBy === 'action' || S.groupBy === 'content') {
    const key = S.vocab.resolve(name);
    if (key) return addFilter({ type: 'tag', key, neg: true });
    S.collapsed.add(`${S.groupBy}:${name}`);
    return renderGrid();
  }
  const facet = { type: 'type', event: 'event', shape: 'shape' }[S.groupBy];
  addFilter({ type: 'facet', key: facet, value: name, neg: true });
}

async function setEra(folderId, era) {
  const fo = S.folders.get(folderId);
  await drive.setProperties(folderId, { sbera: era === 'auto' ? null : era });
  fo.era = era === 'auto' ? null : era;
  applyEras(S.files, S.folders, S.events);
  render();
  toast(era === 'auto' ? 'Shoot packaging back to automatic.' : `Every file with a bottle in this shoot now counts as ${era} packaging.`);
}

// ---------------------------------------------------------------- clicks
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  const cardEl = e.target.closest('.card');
  if (cardEl && (!el || el.dataset.act === 'tick')) return onCard(cardEl.dataset.id, e, el?.dataset.act === 'tick');
  if (!el) return;
  const d = el.dataset;
  try {
    switch (d.act) {
      case 'all': S.folder = null; S.filters = []; rerender(true); break;
      case 'all-folders': S.folder = null; rerender(true); break;
      case 'folder': S.folder = d.id; openFolders.add(d.id); closeSidebar(); rerender(true); break;
      case 'twist': e.stopPropagation(); openFolders.has(d.id) ? openFolders.delete(d.id) : openFolders.add(d.id); renderTree(); break;
      case 'tag': toggleFilter({ type: 'tag', key: d.key }); break;
      case 'facet': toggleFilter({ type: 'facet', key: d.key, value: d.value }); break;
      case 'unfilter': S.filters.splice(+d.i, 1); rerender(true); break;
      case 'negate': S.filters[+d.i].neg = !S.filters[+d.i].neg; rerender(true); break;
      case 'toggle-sec': { const k = `${S.groupBy}:${d.name}`; S.collapsed.has(k) ? S.collapsed.delete(k) : S.collapsed.add(k); renderGrid(); break; }
      case 'more-sec': sectionOpen.set(d.name, true); renderGrid(); break;
      case 'select-sec': S.sections.get(d.name).forEach((f) => S.selected.add(f.id)); render(); break;
      case 'exclude-sec': excludeSection(d.name); break;
      case 'era': setEra(d.id, d.era); break;
      case 'select-all': S.list.forEach((f) => S.selected.add(f.id)); render(); break;
      case 'clear-selection': S.selected.clear(); render(); break;
      case 'download': download([...S.selected].map((id) => S.byId.get(id))); break;
      case 'bulk-tag': pickTag(selectedFiles(), 'add'); break;
      case 'bulk-untag': pickTag(selectedFiles(), 'remove'); break;
      case 'bulk-confirm': confirmAI(selectedFiles()); break;
      case 'pkg': setPackaging(el.closest('.detail') ? [S.detail] : selectedFiles(), d.pkg); break;
      case 'detail-confirm': confirmAI([S.detail]); break;
      case 'close-detail': closeDetail(); break;
      case 'prev': step(-1); break;
      case 'next': step(1); break;
      case 'detail-download': download([S.detail]); break;
      case 'detail-tag': pickTag([S.detail], 'add'); break;
      case 'tag-ok': editTags([S.detail], (t) => { t.ai.delete(d.key); t.confirmed.add(d.key); }); break;
      case 'tag-x': editTags([S.detail], (t) => { t.ai.delete(d.key); t.confirmed.delete(d.key); }); break;
      case 'stage': editStage(S.detail, d.stage); break;
      case 'goto-folder': closeDetail(); S.folder = d.id; rerender(true); break;
      case 'upload': openUpload(); break;
      case 'new-folder': newFolder(); break;
      case 'access': openAccess(S, { toast, closeDialog, openDialog }); break;
      case 'close-dialog': closeDialog(); break;
      case 'open-sidebar': $('#sidebar').classList.add('open'); break;
      case 'close-sidebar': closeSidebar(); break;
      case 'signout': signOut(); break;
    }
  } catch (err) { fail(err); }
});

const closeSidebar = () => $('#sidebar').classList.remove('open');
const selectedFiles = () => [...S.selected].map((id) => S.byId.get(id)).filter(Boolean);

// Click opens; the tick, Cmd/Ctrl-click or Shift-click selects (Shift selects a range).
function onCard(id, e, tick) {
  if (tick || e.metaKey || e.ctrlKey || e.shiftKey || S.selected.size) {
    if (e.shiftKey && S.lastClicked) {
      const ids = S.list.map((f) => f.id);
      const [a, b] = [ids.indexOf(S.lastClicked), ids.indexOf(id)].sort((x, y) => x - y);
      ids.slice(a, b + 1).forEach((x) => S.selected.add(x));
    } else S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
    S.lastClicked = id;
    document.querySelectorAll('.card').forEach((c) => {
      const on = S.selected.has(c.dataset.id);
      c.classList.toggle('sel', on);
      c.querySelector('.tick').innerHTML = on ? '&#10003;' : '';
    });
    $('#grid').classList.toggle('selecting', S.selected.size > 0);
    renderBulk();
    return;
  }
  openDetail(S.byId.get(id));
}

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (typing) return;
  const inDetail = !$('#detail').hidden, inDialog = !$('#dialog').hidden;
  if (e.key === 'Escape') {
    if (inDialog) closeDialog(); else if (inDetail) closeDetail(); else { S.selected.clear(); render(); }
    return;
  }
  if (inDialog) return;
  if (e.key === '/') { e.preventDefault(); q.focus(); return; }
  if (inDetail && e.key === 'ArrowLeft') return step(-1);
  if (inDetail && e.key === 'ArrowRight') return step(1);
  if ((e.metaKey || e.ctrlKey) && e.key === 'a' && !inDetail) { e.preventDefault(); S.list.forEach((f) => S.selected.add(f.id)); render(); return; }
  const targets = inDetail ? [S.detail] : selectedFiles();
  if (!targets.length) return;
  if (e.key === 'd') download(targets);
  if (!session.isAdmin) return;
  if (e.key === 't') { e.preventDefault(); pickTag(targets, 'add'); }
  if (e.key === 'c') confirmAI(targets);
  if (e.key === '1') setPackaging(targets, 'new');
  if (e.key === '2') setPackaging(targets, 'old');
  if (e.key === '3') setPackaging(targets, 'none');
});

// ---------------------------------------------------------------- detail view
function openDetail(f) {
  S.detail = f;
  $('#detail').hidden = false;
  const media = $('#detail-media');
  // Videos play in Drive's own player (it streams any size and format);
  // photos show a large rendition straight away.
  media.innerHTML = f.auto.kind === 'video' || !f.thumbnailLink
    ? `<iframe src="${drive.previewUrl(f.id)}" allow="autoplay; fullscreen" allowfullscreen></iframe>`
    : `<img src="${esc(drive.thumb(f, 1800))}" alt="" referrerpolicy="no-referrer">`;
  drawInfo();
}

function drawInfo() {
  const f = S.detail, a = f.auto, t = f.tags, admin = session.isAdmin;
  const banners = [];
  const pk = f.pack || {}, how = { you: '', shoot: ' (set for the whole shoot)', 'shoot-ai': ' (from the rest of this shoot, AI)', 'shoot-date': ' (shoot date, new packaging launched September 2025)', ai: ' (AI, not yet confirmed)' }[pk.by] || '';
  if (pk.value === 'old') banners.push(`<div class="banner old"><b>Old packaging${how}</b>Use only for spice and powder close-ups. Never show the bottles.</div>`);
  if (pk.value === 'check') banners.push(`<div class="banner check"><b>Packaging not confirmed</b>A bottle may be visible. Treat as old packaging until checked.</div>`);
  if (!pk.value) banners.push(`<div class="banner check"><b>Packaging not checked yet</b>Treat as old packaging until checked.</div>`);
  if (pk.value === 'none' && f.oldShoot) banners.push(`<div class="banner old"><b>Old packaging shoot</b>No bottle seen in this file, but this shoot used the old packaging. Make sure no bottle shows.</div>`);
  if (pk.value === 'new' && how) banners.push(`<div class="banner dnu"><b>New packaging${how}</b></div>`);
  if (a.doNotUse) banners.push(`<div class="banner dnu"><b>Do not use</b>The folder this file is in is marked "do not use".</div>`);
  const folder = S.folders.get(f.folder);
  const rows = [
    ['Type', `${a.kind}${f.mimeType ? ` (${esc(f.name.split('.').pop().toUpperCase())})` : ''}`],
    ['Format', a.orientation ? `${a.orientation.ratio} ${a.orientation.shape}` : ''],
    ['Length', a.seconds != null ? fmtDur(a.seconds) : ''],
    ['Shoot', folder ? `<button class="link" data-act="goto-folder" data-id="${folder.id}">${esc(folder.path || folder.name)}</button>` : ''],
    ['Event', esc(a.event || '')],
    ['Date', esc(showDate(a.date) || a.year || '')],
    ['Raw or edited', admin ? `<span class="seg">${['raw', 'edited'].map((s) => `<button class="${a.stage === s ? 'on' : ''}" data-act="stage" data-stage="${s}">${s}</button>`).join('')}</span>` : a.stage],
    ['Size', f.size ? `${(f.size / 1e6).toFixed(f.size > 1e8 ? 0 : 1)} MB` : ''],
    ['Also in', (f.copies || []).map((c) => `<button class="link" data-act="goto-folder" data-id="${c.folder}">${esc(S.folders.get(c.folder)?.path || 'Top level')}</button>`).join('<br>')],
  ].filter(([, v]) => v);
  const groups = new Map();
  for (const k of t.confirmed) (groups.get(S.vocab.group(k)) || groups.set(S.vocab.group(k), []).get(S.vocab.group(k))).push([k, false]);
  for (const k of t.ai) (groups.get(S.vocab.group(k)) || groups.set(S.vocab.group(k), []).get(S.vocab.group(k))).push([k, true]);
  const tagHtml = GROUPS.filter((g) => groups.has(g)).map((g) => `<div class="tag-group"><div class="side-label">${GROUP_LABEL[g]}</div><div class="tags">${
    groups.get(g).map(([k, ai]) => `<span class="tag${ai ? ' ai' : ''}">${esc(S.vocab.label(k))}${admin ? `${ai ? `<button class="ok" data-act="tag-ok" data-key="${esc(k)}" title="Confirm">&#10003;</button>` : ''}<button data-act="tag-x" data-key="${esc(k)}" title="Remove">&times;</button>` : ''}</span>`).join('')
  }</div></div>`).join('') || `<p class="muted">No tags yet.</p>`;
  $('#detail-info').innerHTML = `
    <h2>${esc(f.name)}</h2>
    ${banners.join('')}
    <dl class="info">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${admin ? `<div class="side-label">Packaging</div><div class="seg">${['new', 'old', 'none'].map((p) => `<button class="${f.pack?.value === p ? 'on' : ''}${p === 'old' ? ' old' : ''}" data-act="pkg" data-pkg="${p}">${{ new: 'New', old: 'Old', none: 'None visible' }[p]}</button>`).join('')}</div>`
      : ''}
    ${tagHtml}
    <div class="row">
      <button class="btn primary" data-act="detail-download">Download</button>
      ${admin ? `<button class="btn" data-act="detail-tag">Add tag (T)</button>${t.ai.size || t.pkgBy === 'ai' ? `<button class="btn" data-act="detail-confirm">Confirm AI (C)</button>` : ''}` : ''}
    </div>
    <p class="muted small">Arrow keys: previous and next. D: download.${admin ? ' 1, 2, 3: packaging new, old, none.' : ''}</p>`;
}

function closeDetail() {
  $('#detail').hidden = true;
  $('#detail-media').innerHTML = ''; // stops video playback
  S.detail = null;
}

function step(dir) {
  const i = S.list.indexOf(S.detail);
  const next = S.list[i + dir];
  if (next) openDetail(next);
}

// ---------------------------------------------------------------- download
// Each file downloads through Google's own download link, so large videos
// stream straight to disk. Several files are started one after another; the
// browser may ask once to allow multiple downloads.
async function download(files) {
  files = files.filter(Boolean);
  const old = files.filter((f) => f.pack?.value !== 'new' && f.pack?.value !== 'none').length;
  if (old) toast(`${old} of these ${files.length} file${files.length > 1 ? 's' : ''} ${old > 1 ? 'have' : 'has'} old or unchecked packaging: use for spice and powder close-ups only.`);
  for (const [i, f] of files.entries()) {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.src = drive.downloadUrl(f.id);
    document.body.appendChild(frame);
    setTimeout(() => frame.remove(), 120000);
    if (i < files.length - 1) await new Promise((r) => setTimeout(r, 900));
  }
  if (files.length > 1 && !old) toast(`Started ${files.length} downloads.`);
}

// ---------------------------------------------------------------- tagging (admin)
// Re-reads the stored tag list first, so tags the AI batch added meanwhile are kept.
async function saveVocab() {
  if (!S.sys) S.sys = await drive.systemFolder(S.root.id, true);
  const { id, data } = await drive.readJson(S.sys, 'tags.json');
  if (data) {
    for (const [k, t] of Object.entries(S.vocab.data.tags)) data.tags[k] ??= t;
    S.vocab = new Vocab(data);
  }
  S.vocabId = await drive.writeJson(S.sys, 'tags.json', id || S.vocabId, S.vocab.data);
}

// Applies a change to many files: 4 Drive writes at a time, progress shown.
async function editTags(files, mutate) {
  files = [...new Set(files.filter(Boolean).flatMap((f) => [f, ...(f.copies || [])]))];
  let done = 0;
  const work = files.map((f) => async () => {
    const t = { confirmed: new Set(f.tags.confirmed), ai: new Set(f.tags.ai), pkg: f.tags.pkg, pkgBy: f.tags.pkgBy, state: f.tags.state };
    mutate(t, f);
    const updated = await drive.setProperties(f.id, tagProperties(t));
    f.properties = updated.properties;
    enrich(f, S.folders, S.events);
    if (++done % 10 === 0 && files.length > 10) status(`Saving tags: ${done} of ${files.length}...`);
  });
  const workers = Array.from({ length: Math.min(4, work.length) }, async () => { while (work.length) await work.shift()(); });
  try { await Promise.all(workers); } finally { status(null); applyEras(S.files, S.folders, S.events); }
  if (files.length > 1) toast(`Saved ${files.length} files${files.some((f) => f.copies?.length) ? ' (identical copies included)' : ''}.`);
  saveCache(S.root.id, { folders: [...S.folders.values()], files: S.files });
  render();
  if (S.detail) drawInfo();
}

// A file counts as reviewed once Gabriel has set its packaging and no AI
// suggestions are left. Until then the AI batch may still add suggestions.
const reviewed = (t) => { if (!t.ai.size && t.pkg && t.pkg !== 'check' && t.pkgBy === 'ok') t.state = 'ok'; };

function setPackaging(files, pkg) {
  return editTags(files, (t) => { t.pkg = pkg; t.pkgBy = 'ok'; reviewed(t); });
}

function confirmAI(files) {
  return editTags(files, (t) => {
    t.ai.forEach((k) => t.confirmed.add(k));
    t.ai.clear();
    // "check" means the AI was unsure: a person still has to choose.
    if (t.pkgBy === 'ai' && t.pkg !== 'check') t.pkgBy = 'ok';
    reviewed(t);
  });
}

function editStage(f, stage) {
  const props = { sbstage: stage === f.auto.stage && !f.properties?.sbstage ? null : stage };
  return drive.setProperties(f.id, props).then((u) => { f.properties = u.properties; enrich(f, S.folders, S.events); applyEras(S.files, S.folders, S.events); drawInfo(); render(); }).catch(fail);
}

// Tag picker: type, pick a suggestion or create a new tag. Near-duplicates are
// offered first so "rib eye" does not become a second Ribeye.
function pickTag(files, mode) {
  if (!files.length) return;
  const pool = mode === 'remove'
    ? [...new Set(files.flatMap((f) => [...f.tags.confirmed, ...f.tags.ai]))]
    : null;
  openDialog(`<h2>${mode === 'add' ? 'Add tag' : 'Remove tag'} <span class="muted small">${files.length} file${files.length > 1 ? 's' : ''}</span></h2>
    <input class="input" id="tp-in" placeholder="${mode === 'add' ? 'Type a tag, Enter to apply' : 'Filter tags'}" autocomplete="off">
    <div id="tp-list" class="picker-list"></div>`);
  const input = $('#tp-in'), list = $('#tp-list');
  let options = [], sel = 0;
  const draw = () => {
    const text = input.value.trim();
    if (mode === 'remove') {
      options = pool.filter((k) => norm(S.vocab.label(k)).includes(norm(text))).map((k) => ({ key: k }));
    } else {
      options = (text ? S.vocab.search(text, 8) : Object.keys(S.vocab.data.tags).slice(0, 8)).map((k) => ({ key: k }));
      const exact = text && S.vocab.resolve(text);
      if (text && !exact) {
        for (const k of S.vocab.similar(text)) if (!options.some((o) => o.key === k)) options.push({ key: k, near: true });
        GROUPS.forEach((g) => options.push({ create: text, group: g }));
      }
    }
    sel = Math.min(sel, Math.max(options.length - 1, 0));
    list.innerHTML = options.map((o, i) => `<div class="suggest" style="position:static;box-shadow:none;border:0;padding:0"><button class="${i === sel ? 'hi' : ''}" data-i="${i}">${
      o.create ? `<span>Create "${esc(o.create)}"</span><span class="k">as ${GROUP_LABEL[o.group]}</span>`
        : `<span>${esc(S.vocab.label(o.key))}</span><span class="k">${o.near ? 'similar existing tag' : GROUP_LABEL[S.vocab.group(o.key)]}</span>`
    }</button></div>`).join('') || `<p class="muted">No tags.</p>`;
  };
  const choose = async (o) => {
    if (!o) return;
    closeDialog();
    let key = o.key;
    if (o.create) { key = S.vocab.add(o.create, o.group); await saveVocab(); }
    if (mode === 'add') await editTags(files, (t) => { t.confirmed.add(key); t.ai.delete(key); });
    else await editTags(files, (t) => { t.confirmed.delete(key); t.ai.delete(key); });
  };
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, options.length - 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
    if (e.key === 'Enter') { e.preventDefault(); choose(options[sel]).catch(fail); }
    if (e.key === 'Escape') closeDialog();
  });
  list.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) choose(options[+b.dataset.i]).catch(fail); });
  draw();
  input.focus();
}

// ---------------------------------------------------------------- dialogs
export function openDialog(html) {
  $('#dialog-body').innerHTML = `<button class="icon-btn close" data-act="close-dialog" aria-label="Close">&times;</button>${html}`;
  $('#dialog').hidden = false;
}
export function closeDialog() { $('#dialog').hidden = true; $('#dialog-body').innerHTML = ''; }
$('#dialog').addEventListener('mousedown', (e) => { if (e.target.id === 'dialog' && !uploading()) closeDialog(); });

// ---------------------------------------------------------------- folders and uploads (admin)
const targetFolder = () => S.folder || S.root.id;
const folderName = (id) => id === S.root.id ? 'Top level of the library' : S.folders.get(id)?.path;

// New folders follow the house format "DD/MM/YYYY - PROJECT", so the date and
// project become tags automatically.
async function newFolder() {
  const today = new Date().toISOString().slice(0, 10);
  openDialog(`<h2>New folder</h2><p class="muted">Inside: ${esc(folderName(targetFolder()))}</p>
    <div class="row"><input class="input" id="nf-date" type="date" value="${today}" style="width:auto">
    <input class="input" id="nf-name" placeholder="Project, e.g. Taste of Abu Dhabi" style="flex:1;min-width:180px"></div>
    <p class="muted small">Folder name: <b id="nf-preview"></b><br>Leave the date empty for a plain folder (e.g. PICS inside a shoot).</p>
    <div class="row"><button class="btn primary" id="nf-ok">Create</button></div>`);
  const nameOf = () => {
    const project = $('#nf-name').value.trim();
    const d = $('#nf-date').value;
    return d && project ? `${showDate(d)} - ${project}` : project;
  };
  const preview = () => { $('#nf-preview').textContent = nameOf() || '...'; };
  $('#nf-name').addEventListener('input', preview);
  $('#nf-date').addEventListener('input', preview);
  preview();
  const go = async () => {
    const name = nameOf();
    if (!name) return;
    const parent = targetFolder();
    const fo = await drive.createFolder(name, parent);
    const p = S.folders.get(parent);
    const names = [...(p?.names || []), name];
    S.folders.set(fo.id, { id: fo.id, name, parent, names, path: names.join(' / ') });
    openFolders.add(parent);
    S.folder = fo.id;
    closeDialog();
    rerender(true);
    toast(`Folder "${name}" created.`);
  };
  $('#nf-ok').onclick = () => go().catch(fail);
  $('#nf-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') go().catch(fail); });
  $('#nf-name').focus();
}

const uploads = [];
const uploading = () => uploads.some((u) => ['uploading', 'reconnecting', 'waiting'].includes(u.state));
window.addEventListener('beforeunload', (e) => { if (uploading()) { e.preventDefault(); e.returnValue = ''; } });

function openUpload() {
  const folderId = targetFolder();
  openDialog(`<h2>Upload</h2>
    <p class="muted">To: <b>${esc(folderName(folderId))}</b>. Pick a folder in the sidebar first to upload somewhere else.</p>
    <label class="drop" id="drop"><input type="file" id="up-in" multiple hidden>Drop photos and videos here, or click to choose.</label>
    <p class="muted small">Files go straight to Google Drive. Large camera files are fine. If the connection drops it picks up where it stopped. If you close this page, choose the same files again into the same folder to resume.</p>
    <div id="up-list"></div>`);
  const add = (fileList) => {
    for (const file of fileList) uploads.push(new Upload(file, folderId, drawUploads));
    drawUploads();
    pump();
  };
  $('#up-in').onchange = (e) => add(e.target.files);
  const drop = $('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); add(e.dataTransfer.files); });
  drawUploads();
}

// Two uploads at a time.
function pump() {
  const active = uploads.filter((u) => u.state === 'uploading' || u.state === 'reconnecting').length;
  uploads.filter((u) => u.state === 'waiting').slice(0, Math.max(0, 2 - active)).forEach((u) => u.start());
}

function drawUploads(changed) {
  if (changed?.state === 'done' && !changed.added) {
    changed.added = true;
    const f = enrich({ ...changed.result, folder: changed.folderId }, S.folders, S.events);
    S.files.push(f);
    S.byId.set(f.id, f);
    groupDuplicates(S.files);
    applyEras(S.files, S.folders, S.events);
    render();
  }
  if (changed && ['done', 'failed', 'paused'].includes(changed.state)) pump();
  const list = $('#up-list');
  if (!list) return;
  list.innerHTML = uploads.map((u, i) => {
    const pct = u.file.size ? Math.floor((u.sent / u.file.size) * 100) : 100;
    const label = { waiting: 'Waiting', uploading: `${pct}%`, reconnecting: 'Connection lost, retrying...', paused: `Paused at ${pct}%`, done: 'Done', failed: `Failed: ${u.error}` }[u.state];
    const btn = u.state === 'uploading' ? `<button class="link" data-up="pause" data-i="${i}">Pause</button>`
      : ['paused', 'failed'].includes(u.state) ? `<button class="link" data-up="resume" data-i="${i}">${u.state === 'failed' ? 'Retry' : 'Resume'}</button>` : '';
    return `<div class="up-row"><span>${esc(u.file.name)} <span class="muted">${(u.file.size / 1e6).toFixed(1)} MB</span></span><span>${label} ${btn}</span><div class="bar"><i style="width:${pct}%"></i></div></div>`;
  }).join('');
  list.onclick = (e) => {
    const b = e.target.closest('[data-up]');
    if (!b) return;
    const u = uploads[+b.dataset.i];
    if (b.dataset.up === 'pause') u.pause();
    else { if (u.state === 'failed') { u.uri = null; } u.state = 'waiting'; pump(); }
  };
}

// ---------------------------------------------------------------- local test mode
// http://localhost:8080/?mock opens a saved copy of the file list (web/mock,
// never published) without signing in, to check the interface. Writes fail.
if (location.hostname === 'localhost' && new URLSearchParams(location.search).has('mock')) {
  Object.assign(session, { email: 'test', name: 'Test mode', isAdmin: true });
  document.body.classList.add('admin');
  $('#signin').hidden = true;
  $('#app').hidden = false;
  $('#who').textContent = 'Local test mode';
  Promise.all([fetch('mock/library.json').then((r) => r.json()), fetch('config/events.json').then((r) => r.json()),
    fetch('mock/tags.json').then((r) => r.json()).catch(() => null)])
    .then(([data, events, seed]) => { S.root = data.folders[0]; S.events = events; if (seed) S.vocab = new Vocab(seed); ingest(data); render(); });
}
