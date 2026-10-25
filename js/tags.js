// The tag list and how tags are stored on each Drive file.
//
// Storage: Drive allows only 30 shared properties per file, too few for one
// property per tag. So tag keys are packed as comma separated lists:
//   sbt1, sbt2, ...  confirmed tags        sba1, sba2, ...  AI-suggested tags
//   sbpkg   packaging: new | old | none | check
//   sbpkgs  who set it: ai | ok (ok = confirmed by Gabriel)
//   sbst    tagging state: ai (AI done, waiting for review) | ok (reviewed)
//   sbstage raw | edited, only when Gabriel overrides the automatic guess
// Each property holds at most 124 bytes (key plus value), hence the chunks.
//
// The tag list itself (labels, groups, aliases) is _library/tags.json.
import { norm } from './autotags.js';

export const GROUPS = ['product', 'person', 'action', 'content', 'dish', 'setting', 'shot', 'colour', 'deliverable', 'other'];
export const GROUP_LABEL = {
  product: 'Products', person: 'People', action: 'Action', content: 'Content', dish: 'Cuts and dishes',
  setting: 'Setting', shot: 'Shot', colour: 'Colour', deliverable: 'Deliverables', other: 'Other',
};
export const PKG_LABEL = { new: 'New packaging', old: 'Old packaging', none: 'No packaging visible', check: 'Check packaging' };

const CHUNK = 100; // value bytes per property, safely under the 124 byte limit
const MAX_CHUNKS = 12;

// Starting tag list, used only if _library/tags.json does not exist yet.
const seed = (label, group, aliases = []) => [norm(label), { label, group, aliases }];
export const SEED = {
  version: 1,
  tags: Object.fromEntries([
    seed('The Original', 'product', ['original']),
    seed('Southern Kiss', 'product'),
    seed('Bayou Blaze', 'product'),
    seed("Santa's Sprinkle", 'product', ['santa sprinkle']),
    seed('Fred', 'person', ['frederic', 'frederic casagrande', 'fred casagrande']),
    seed('Ribeye', 'dish', ['rib eye']),
    seed('S-Log3', 'colour', ['log', 'slog', 's-log 3']),
    seed('Rec709', 'colour', ['rec 709']),
    seed('Powder', 'scene', ['spice pour', 'rub close-up', 'seasoning']),
  ]),
};

export class Vocab {
  constructor(data) {
    this.data = data || structuredClone(SEED);
    this.reindex();
  }

  reindex() {
    this.lookup = new Map(); // any spelling (normalised) -> tag key
    for (const [key, t] of Object.entries(this.data.tags)) {
      this.lookup.set(key, key);
      this.lookup.set(norm(t.label), key);
      for (const a of t.aliases || []) this.lookup.set(norm(a), key);
    }
  }

  label(key) { return this.data.tags[key]?.label || key; }
  group(key) { return this.data.tags[key]?.group || 'other'; }

  // Exact match on label or alias, ignoring case, spaces and punctuation.
  resolve(text) { return this.lookup.get(norm(text)) || null; }

  // Near-duplicates for a new tag: small spelling differences or one name
  // containing the other ("ribeye" vs "ribeyes", "bone in ribeye" vs "ribeye").
  similar(text) {
    const k = norm(text);
    if (!k) return [];
    const out = new Set();
    for (const [spelling, key] of this.lookup) {
      if (spelling === k) continue;
      const d = editDistance(spelling, k);
      if (d <= (k.length > 7 ? 2 : 1) || (k.length >= 5 && spelling.length >= 5 && (spelling.includes(k) || k.includes(spelling)))) out.add(key);
    }
    return [...out];
  }

  add(label, group) {
    const key = norm(label);
    if (!key) throw new Error('Empty tag');
    if (this.lookup.has(key)) return this.lookup.get(key);
    this.data.tags[key] = { label: label.trim(), group, aliases: [] };
    this.reindex();
    return key;
  }

  addAlias(key, alias) {
    const t = this.data.tags[key];
    if (t && !this.lookup.has(norm(alias))) { t.aliases.push(alias.trim()); this.reindex(); }
  }

  // Search suggestions for a typed prefix.
  search(text, limit = 8) {
    const k = norm(text);
    if (!k) return [];
    const hits = new Map();
    for (const [spelling, key] of this.lookup) {
      if (spelling.startsWith(k)) hits.set(key, 0);
      else if (spelling.includes(k) && !hits.has(key)) hits.set(key, 1);
    }
    return [...hits].sort((a, b) => a[1] - b[1] || this.label(a[0]).localeCompare(this.label(b[0]))).slice(0, limit).map(([key]) => key);
  }
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// ---- reading and writing a file's tags

const packList = (prefix, keys) => {
  const props = {};
  const chunks = [];
  let cur = '';
  for (const k of [...keys].sort()) {
    if (cur && (cur + ',' + k).length > CHUNK) { chunks.push(cur); cur = k; }
    else cur = cur ? `${cur},${k}` : k;
  }
  if (cur) chunks.push(cur);
  if (chunks.length > MAX_CHUNKS) throw new Error('Too many tags on one file');
  for (let i = 1; i <= MAX_CHUNKS; i++) props[`${prefix}${i}`] = chunks[i - 1] || null; // null clears
  return props;
};

const unpackList = (props, prefix) => {
  const out = new Set();
  for (let i = 1; i <= MAX_CHUNKS; i++) for (const k of (props[`${prefix}${i}`] || '').split(',')) if (k) out.add(k);
  return out;
};

export function readTags(file) {
  const p = file.properties || {};
  const confirmed = unpackList(p, 'sbt');
  const ai = unpackList(p, 'sba');
  for (const k of confirmed) ai.delete(k);
  return { confirmed, ai, pkg: p.sbpkg || null, pkgBy: p.sbpkgs || null, state: p.sbst || null };
}

// Full property set for a tag state; unchanged chunks are simply rewritten.
export function tagProperties(t) {
  return {
    ...packList('sbt', t.confirmed),
    ...packList('sba', [...t.ai].filter((k) => !t.confirmed.has(k))),
    sbpkg: t.pkg || null,
    sbpkgs: t.pkg ? t.pkgBy || 'ok' : null,
    sbst: t.state || null,
  };
}
