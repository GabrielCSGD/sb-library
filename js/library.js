// Loads the whole library (every folder and file under the root) into memory.
// A copy is cached in the browser so the next visit opens instantly, then the
// live listing from Drive replaces it.
import { listChildren, FOLDER } from './drive.js';
import { autoTags, isJunk } from './autotags.js';
import { readTags } from './tags.js';
import { SYSTEM_FOLDER } from './config.js';

const DB = 'sb-library', STORE = 'cache';

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

export async function loadCache(key) {
  try { return await idb('readonly', (s) => s.get(key)); } catch { return null; }
}

export async function saveCache(key, value) {
  try { await idb('readwrite', (s) => s.put(value, key)); } catch { /* cache is optional */ }
}

// Breadth-first walk, several folders at a time.
export async function crawl(root, onProgress) {
  // names: folder names from the root down (folder names may contain "/").
  const folders = new Map([[root.id, { id: root.id, name: root.name, parent: null, names: [], path: '' }]]);
  const files = [];
  let queue = [root.id];
  while (queue.length) {
    const batch = queue.splice(0, 8);
    const results = await Promise.all(batch.map((id) => listChildren(id).then((items) => [id, items])));
    for (const [parentId, items] of results) {
      const parent = folders.get(parentId);
      for (const f of items) {
        if (f.mimeType === FOLDER) {
          if (f.name === SYSTEM_FOLDER && parentId === root.id) continue; // platform files stay hidden
          const names = [...parent.names, f.name];
          folders.set(f.id, { id: f.id, name: f.name, parent: parentId, names, path: names.join(' / '), era: f.properties?.sbera || null });
          queue.push(f.id);
        } else if (!isJunk(f)) {
          f.folder = parentId;
          files.push(f);
        }
      }
    }
    onProgress?.(files.length, folders.size);
  }
  return { folders: [...folders.values()], files };
}

// Adds the computed fields the interface needs. Called after loading and
// after any change to a file.
export function enrich(f, folders, events) {
  const folder = folders.get(f.folder);
  f.path = folder?.path ? `${folder.path} / ${f.name}` : f.name;
  f.auto = autoTags(f, folder?.names || [], events);
  f.tags = readTags(f);
  return f;
}

// Two files are the same when their content checksum and size match (names can
// differ). Files without a checksum are never treated as duplicates.
export const dupKey = (f) => f.md5Checksum ? `${f.md5Checksum}:${f.size}` : f.id;

export function groupDuplicates(files) {
  const groups = new Map();
  for (const f of files) (groups.get(dupKey(f)) || groups.set(dupKey(f), []).get(dupKey(f))).push(f);
  for (const f of files) f.copies = groups.get(dupKey(f)).filter((x) => x !== f);
}

// ---- packaging by shoot
// Gabriel never has old and new bottles on the same shoot, so packaging is
// really a property of the shoot ("era"). The shoot (project) of a file is its
// deepest dated or year folder ("24/10/2025 - X", "24 02 23 - X", "2024"),
// otherwise its top-level folder.
const SHOOT_NAME = /^(\d{1,2}[/.-]\d{1,2}[/.-]20\d\d\s*-|\d\d \d\d \d\d - |20(19|[23]\d)$)/;

export function projectOf(folderId, folders) {
  const chain = [];
  for (let id = folderId; id; id = folders.get(id)?.parent) chain.unshift(folders.get(id));
  const below = chain.slice(1); // skip the library root
  if (!below.length) return null;
  const dated = below.filter((fo) => SHOOT_NAME.test(fo.name)).pop();
  return (dated || below[0]).id;
}

// Works out each file's packaging to show:
//  1. Gabriel's own choice on the file wins.
//  2. Otherwise, if a bottle is visible (AI said new, old or unsure), the shoot's
//     era decides: the era Gabriel set on the folder, else the shoot date against
//     the launch of the new packaging (September 2025), else the majority of
//     what the AI saw in that shoot.
//  3. Otherwise the AI's answer ("none" = no bottle visible).
export function applyEras(files, folders, events) {
  const notShoots = new Set(events.notShoots || []);
  const votes = new Map();
  for (const f of files) {
    f.project = projectOf(f.folder, folders);
    const v = votes.get(f.project) || votes.set(f.project, { old: 0, new: 0 }).get(f.project);
    const w = f.tags.pkgBy === 'ok' ? 10 : 1;
    if (f.tags.pkg === 'old' || f.tags.pkg === 'new') v[f.tags.pkg] += w;
  }
  // Shoot date: the earliest date found on its files (folder name or photo data).
  const dates = new Map();
  for (const f of files) {
    const d = f.auto.date || f.auto.year;
    if (d && (!dates.has(f.project) || d < dates.get(f.project))) dates.set(f.project, d);
  }
  const launch = events.newPackaging?.from; // "2025-09": the month the new bottle arrived
  const byDate = (d) => {
    if (!launch || !d) return null;
    const ym = d.slice(0, 7);
    if (d.length === 4) return d < launch.slice(0, 4) ? 'old' : d > launch.slice(0, 4) ? 'new' : null; // year only
    return ym < launch ? 'old' : ym > launch ? 'new' : null; // the launch month itself stays open
  };
  for (const [id, v] of votes) {
    const fo = folders.get(id);
    if (!fo) continue;
    if (notShoots.has(fo.name)) { fo.eraAuto = null; continue; }
    fo.eraDate = byDate(dates.get(id));
    fo.eraAi = v.old >= 2 && v.old >= 2 * v.new ? 'old' : v.new >= 2 && v.new >= 2 * v.old ? 'new' : null;
    fo.eraAuto = fo.eraDate || fo.eraAi;
    fo.eraFrom = fo.eraDate ? 'date' : fo.eraAi ? 'ai' : null;
  }
  for (const f of files) {
    const t = f.tags, fo = folders.get(f.project);
    const era = fo?.era || fo?.eraAuto;
    if (t.pkgBy === 'ok' && t.pkg) f.pack = { value: t.pkg, by: 'you' };
    else if (era && ['new', 'old', 'check'].includes(t.pkg)) f.pack = { value: era, by: fo.era ? 'shoot' : fo.eraFrom === 'date' ? 'shoot-date' : 'shoot-ai' };
    else f.pack = { value: t.pkg, by: t.pkg ? 'ai' : null };
    f.oldShoot = era === 'old';
  }
}
