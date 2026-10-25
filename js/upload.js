// Resumable uploads straight from the browser to Drive (Drive's resumable
// protocol). The file never passes through any server of ours.
//
// - Sent in 16 MB chunks, so a dropped connection only loses the current chunk.
// - After a network error it asks Drive how much arrived and carries on from there.
// - The upload address is remembered in this browser for a week, so if the page
//   is closed, picking the same file again into the same folder resumes it.
import { getToken } from './auth.js';
import { FIELDS } from './drive.js';

const CHUNK = 16 * 1024 * 1024; // must be a multiple of 256 KB
const KEY = 'sb-uploads';

const remembered = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const remember = (all) => { try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* fine */ } };
const fileKey = (file, folderId) => `${folderId}|${file.name}|${file.size}|${file.lastModified}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Upload {
  constructor(file, folderId, onChange) {
    Object.assign(this, { file, folderId, onChange, sent: 0, state: 'waiting', error: null, result: null });
  }

  async start() {
    this.state = 'uploading';
    this.paused = false;
    this.onChange(this);
    try {
      const key = fileKey(this.file, this.folderId);
      const saved = remembered()[key];
      if (saved && Date.now() - saved.at < 6 * 86400e3) {
        this.uri = saved.uri;
        this.sent = await this.askOffset();
      }
      if (!this.uri || this.sent < 0) {
        this.uri = await this.openSession();
        this.sent = 0;
        remember({ ...remembered(), [key]: { uri: this.uri, at: Date.now() } });
      }
      while (!this.result) {
        if (this.paused) { this.state = 'paused'; this.onChange(this); return; }
        try {
          await this.sendChunk();
        } catch (e) {
          if (e.fatal) throw e;
          // Network dropped: wait, ask Drive what it has, continue from there.
          this.state = 'reconnecting';
          this.onChange(this);
          await sleep(3000);
          const at = await this.askOffset().catch(() => null);
          if (at === null) continue;
          if (at < 0) throw Object.assign(new Error('Upload expired, start it again'), { fatal: true });
          this.sent = at;
          this.state = 'uploading';
        }
        this.onChange(this);
      }
      const all = remembered();
      delete all[key];
      remember(all);
      this.state = 'done';
    } catch (e) {
      this.state = 'failed';
      this.error = e.message;
    }
    this.onChange(this);
  }

  pause() { this.paused = true; }

  async openSession() {
    const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=${encodeURIComponent(FIELDS)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getToken()}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': this.file.type || 'application/octet-stream',
        'X-Upload-Content-Length': String(this.file.size),
      },
      body: JSON.stringify({ name: this.file.name, parents: [this.folderId] }),
    });
    if (!res.ok) throw Object.assign(new Error(`Drive refused the upload (${res.status})`), { fatal: true });
    return res.headers.get('Location');
  }

  async sendChunk() {
    const end = Math.min(this.sent + CHUNK, this.file.size);
    const res = await fetch(this.uri, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes ${this.sent}-${end - 1}/${this.file.size}` },
      body: this.file.slice(this.sent, end),
    });
    if (res.status === 308) { this.sent = rangeEnd(res); return; } // chunk stored, more to send
    if (res.ok) { this.sent = this.file.size; this.result = await res.json(); return; }
    if (res.status === 404 || res.status === 410) throw Object.assign(new Error('Upload expired, start it again'), { fatal: true });
    throw new Error(`HTTP ${res.status}`); // 5xx and the like: retried
  }

  // Returns bytes Drive already has, or -1 if the session is gone.
  async askOffset() {
    const res = await fetch(this.uri, { method: 'PUT', headers: { 'Content-Range': `bytes */${this.file.size}` } });
    if (res.status === 308) return rangeEnd(res);
    if (res.ok) { this.result = await res.json(); return this.file.size; }
    return -1;
  }
}

function rangeEnd(res) {
  const r = res.headers.get('Range'); // "bytes=0-16777215"
  return r ? Number(r.split('-')[1]) + 1 : 0;
}
