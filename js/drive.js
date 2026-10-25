// Every Drive call the platform makes goes through this file.
//
// Allowed writes, by design: tag properties on files, new folders, new uploads,
// the platform's own JSON files in _library, and sharing (agency access).
// There is deliberately no function here that renames, moves, overwrites or
// deletes a media file. Keep it that way.
import { getToken } from './auth.js';
import { ROOT_MARKER, SYSTEM_FOLDER } from './config.js';

const API = 'https://www.googleapis.com/drive/v3';
export const FOLDER = 'application/vnd.google-apps.folder';
export const FIELDS =
  'id,name,mimeType,size,md5Checksum,parents,createdTime,modifiedTime,properties,thumbnailLink,' +
  'imageMediaMetadata(width,height,rotation,time),videoMediaMetadata(width,height,durationMillis)';

async function call(path, { method = 'GET', params = {}, body, raw = false } = {}) {
  const url = new URL(path.startsWith('http') ? path : API + path);
  for (const [k, v] of Object.entries({ supportsAllDrives: true, ...params })) url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${getToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    // Drive asks clients to back off and retry on 429 and 5xx.
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (res.status === 401) throw new Error('SESSION_EXPIRED');
    if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 300)}`);
    if (raw) return res;
    return res.status === 204 ? null : res.json();
  }
}

export async function listChildren(folderId) {
  const out = [];
  let pageToken;
  do {
    const r = await call('/files', {
      params: {
        q: `'${folderId}' in parents and trashed = false`,
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: 1000,
        includeItemsFromAllDrives: true,
        ...(pageToken ? { pageToken } : {}),
      },
    });
    out.push(...r.files);
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

// The library root is the folder carrying the sblibrary=root property.
export async function findRoot() {
  const r = await call('/files', {
    params: {
      q: `properties has { key='${ROOT_MARKER.key}' and value='${ROOT_MARKER.value}' } and mimeType = '${FOLDER}' and trashed = false`,
      fields: 'files(id,name)',
      includeItemsFromAllDrives: true,
    },
  });
  return r.files[0] || null;
}

export const getFile = (id) => call(`/files/${id}`, { params: { fields: FIELDS } });

// Writes tag metadata only. A property set to null is removed by Drive.
export function setProperties(id, properties) {
  return call(`/files/${id}`, { method: 'PATCH', params: { fields: FIELDS }, body: { properties } });
}

export function createFolder(name, parentId) {
  return call('/files', { method: 'POST', params: { fields: FIELDS }, body: { name, parents: [parentId], mimeType: FOLDER } });
}

// ---- the platform's own small JSON files, kept in the hidden _library folder

export async function systemFolder(rootId, create) {
  const r = await call('/files', {
    params: { q: `'${rootId}' in parents and name = '${SYSTEM_FOLDER}' and mimeType = '${FOLDER}' and trashed = false`, fields: 'files(id)' },
  });
  if (r.files[0]) return r.files[0].id;
  return create ? (await createFolder(SYSTEM_FOLDER, rootId)).id : null;
}

export async function readJson(folderId, name) {
  const r = await call('/files', { params: { q: `'${folderId}' in parents and name = '${name}' and trashed = false`, fields: 'files(id)' } });
  if (!r.files[0]) return { id: null, data: null };
  const res = await call(`/files/${r.files[0].id}`, { params: { alt: 'media' }, raw: true });
  return { id: r.files[0].id, data: await res.json() };
}

export async function writeJson(folderId, name, fileId, data) {
  const meta = fileId ? {} : { name, parents: [folderId], mimeType: 'application/json' };
  const boundary = 'sb' + Math.random().toString(36).slice(2);
  const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data, null, 1)}\r\n--${boundary}--`;
  const url = `https://www.googleapis.com/upload/drive/v3/files${fileId ? '/' + fileId : ''}?uploadType=multipart&fields=id`;
  const res = await fetch(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Saving ${name} failed: ${res.status}`);
  return (await res.json()).id;
}

// ---- sharing, used by the Access panel

export const listPermissions = (id) =>
  call(`/files/${id}/permissions`, { params: { fields: 'permissions(id,type,role,emailAddress,displayName)' } }).then((r) => r.permissions);

export const addReader = (id, email) =>
  call(`/files/${id}/permissions`, {
    method: 'POST',
    params: { sendNotificationEmail: false }, // Gabriel sends the link himself
    body: { type: 'user', role: 'reader', emailAddress: email },
  });

export const removePermission = (id, permissionId) =>
  call(`/files/${id}/permissions/${permissionId}`, { method: 'DELETE' });

// ---- viewing and downloading

// Drive's thumbnail links end in =s220; any size can be asked for.
export const thumb = (f, size = 400) => f.thumbnailLink ? f.thumbnailLink.replace(/=s\d+$/, `=s${size}`) : null;
export const previewUrl = (id) => `https://drive.google.com/file/d/${id}/preview`;
export const downloadUrl = (id) => `https://drive.usercontent.google.com/download?id=${id}&export=download`;
