// Tags that need no AI: worked out from folder names and Drive file metadata.
// Nothing here is stored in Drive; it is recomputed every time the library loads,
// so fixing a rule (or renaming a folder) fixes every file at once.

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Tag key used everywhere for matching: "Rib eye", "rib-eye" and "Ribeye" all
// become "ribeye". A trailing plural "s" is dropped ("Ribs" -> "rib").
export function norm(s) {
  let k = (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (k.length > 3 && k.endsWith('s') && !k.endsWith('ss')) k = k.slice(0, -1);
  return k;
}

const SMALL = new Set(['of', 'and', 'the', 'in', 'on', 'at', 'a', 'de', 'du']);

// "TASTE-OF-ABU-DHABI" -> "Taste of Abu Dhabi", "BurgerDay" -> "Burger Day"
export function humanize(name) {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim().split(/\s+/);
  return words.map((w, i) => {
    const lw = w.toLowerCase();
    if (i > 0 && SMALL.has(lw)) return lw;
    if (/^[A-Z0-9&]{2,4}$/.test(w) && !/^(DAY|MEAT|BBQ)$/i.test(w)) return w; // keep short acronyms: TOAD, OFFF
    return lw.charAt(0).toUpperCase() + lw.slice(1);
  }).join(' ');
}

export function orientation(f) {
  const m = f.videoMediaMetadata || f.imageMediaMetadata || {};
  let { width: w, height: h } = m;
  if (!w || !h) return null;
  if (m.rotation === 1 || m.rotation === 3) [w, h] = [h, w];
  const r = w / h;
  const named = [['9:16', 9 / 16], ['2:3', 2 / 3], ['3:4', 3 / 4], ['4:5', 4 / 5], ['1:1', 1],
    ['5:4', 5 / 4], ['4:3', 4 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9]];
  const hit = named.find(([, v]) => Math.abs(r - v) / v < 0.03);
  return {
    ratio: hit ? hit[0] : `${w}x${h}`,
    shape: r < 0.95 ? 'vertical' : r > 1.05 ? 'horizontal' : 'square',
  };
}

export function durationBucket(sec) {
  if (sec == null) return null;
  if (sec < 5) return 'under 5 s';
  if (sec < 15) return '5 to 15 s';
  if (sec < 60) return '15 to 60 s';
  return 'over 1 min';
}

// Camera and phone file names mean straight-from-camera (raw); renamed files are exports (edited).
const RAW_NAMES = [
  /^C\d{4}(_\d+)?\.(mp4|mov)$/i,            // Sony clip, optionally cut at a frame number
  /^FX3-(CSGD-)?\d{4}_\d+\.(mp4|mov)$/i,     // FX3 selects
  /^V\d-\d{4}_SB-\d{4}-STOCK-\d+\.mp4$/i,    // stock selects
  /^\d{8}\.(mp4|mov)$/i,
  /^_?DSC\d{4,5}\.(jpe?g|arw)$/i, /^\dV\dA\d{4}\.(jpe?g|cr3)$/i, /^IMG[_-]/i,
  /^\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}/, /^(Photo|Video) \d{2}-\d{2}-\d{4}/, /^WhatsApp /,
  /^\d{8}_\d{6}/, /^img_\d+/i,
];

export function stage(f) {
  return RAW_NAMES.some((re) => re.test(f.name)) ? 'raw' : 'edited';
}

function dateFromFile(f) {
  const t = f.imageMediaMetadata?.time; // "2026:07:12 10:00:00"
  if (t && /^\d{4}:\d\d:\d\d/.test(t) && !t.startsWith('0000')) return t.slice(0, 10).replace(/:/g, '-');
  let m = f.name.match(/(20\d\d)-(\d\d)-(\d\d)[ _]/) || f.name.match(/^(20\d\d)(\d\d)(\d\d)_\d{6}/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = f.name.match(/(\d\d)-(\d\d)-(20\d\d)/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

// segs = folder names from the library root down to the file's folder. A list,
// not a "/" path, because the house format "DD/MM/YYYY - PROJECT" contains slashes.
// events = config/events.json: { aliases: { normKey: label }, folders: { topFolder: { event, date } } }
export function autoTags(f, segs, events = { aliases: {} }) {
  let eventName = null, date = null, year = null, day = null;
  for (const s of segs) {
    // House format for new folders: "14/10/2026 - Taste of Abu Dhabi"
    let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](20\d\d)\s*-\s*(.+)$/);
    if (m) { date = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; eventName = m[4]; continue; }
    m = s.match(/^(\d\d) (\d\d) (\d\d) - (.+)$/); // older format: "24 02 23 - Taste of Dubai"
    if (m) { date = `20${m[1]}-${m[2]}-${m[3]}`; eventName = m[4]; continue; }
    if (/^20\d\d$/.test(s) && +s >= 2019 && +s <= 2035) { year = s; continue; } // "2010" is 20/10, not a year
    m = s.match(/\bD(?:AY)?\s?(\d)\b/i); // "FAV D2"
    if (m && segs.indexOf(s) > 0) { day = `Day ${m[1]}`; continue; }
  }
  const top = segs[0];
  if (!eventName && top && top !== 'Photos Historique' && !/^(ASSETS|BOTTLES TRANSPARENT)$/i.test(top)) {
    const m = top.match(/^(\d\d)(\d\d)$/); // "1207" = 12 July; the year comes from the photos inside
    const fd = dateFromFile(f);
    if (m && fd) date = `${fd.slice(0, 4)}-${m[2]}-${m[1]}`;
    eventName = top;
  }
  const fileDate = dateFromFile(f);
  if (!year) year = (date && !date.startsWith('?') ? date.slice(0, 4) : null) || fileDate?.slice(0, 4) || null;
  const fix = (events.folders || {})[top] || {}; // per-folder corrections Gabriel confirmed
  if (fix.date) date = fix.date;
  if (fix.event) eventName = fix.event;
  let event = null;
  // Names typed with spaces (Photos Historique) are kept as written; slugs like TASTE-OF-DUBAI are tidied.
  if (eventName) event = events.aliases[norm(eventName)] || (/\s/.test(eventName) ? eventName : humanize(eventName));

  const isVideo = f.mimeType.startsWith('video/');
  const sec = isVideo && f.videoMediaMetadata?.durationMillis ? f.videoMediaMetadata.durationMillis / 1000 : null;
  return {
    kind: isVideo ? 'video' : f.mimeType.startsWith('image/') ? 'photo' : 'document',
    orientation: orientation(f),
    seconds: sec,
    duration: durationBucket(sec),
    event, year, day,
    date: date || fileDate,
    stage: f.properties?.sbstage || stage(f), // Gabriel can override per file
    doNotUse: segs.some((s) => /do not use/i.test(s)),
    shoot: segs.join(' / ') || 'Top level',
  };
}

// macOS "._name" copies and similar junk never show in the library.
export const isJunk = (f) => f.name.startsWith('._') || f.name === '.DS_Store';

// "2026-10-14" -> "14/10/2026", the format used everywhere in the interface.
export const showDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return d ? `${d}/${m}/${y}` : m ? `${m}/${y}` : y;
};
