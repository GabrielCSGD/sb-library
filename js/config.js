// Settings that are safe to publish. Nothing secret lives in this site.

// OAuth client "sb-library web" in Google Cloud project sb-library.
export const CLIENT_ID = '320726520574-79q61vjp1p3dmve4adssjgvkh68a1nhb.apps.googleusercontent.com';

// Accounts that get admin tools (upload, tagging, access). Drive itself also
// enforces this: everyone else only has read access to the folder.
export const ADMINS = ['csgd.films@gmail.com'];

// The library folder is found at sign-in by this marker property (set once by
// tools/setup_library.py), so the folder id never appears in this public code.
export const ROOT_MARKER = { key: 'sblibrary', value: 'root' };

// Hidden folder inside the library holding the tag list and agency names.
export const SYSTEM_FOLDER = '_library';

export const SCOPE_READ = 'https://www.googleapis.com/auth/drive.readonly';
export const SCOPE_WRITE = 'https://www.googleapis.com/auth/drive';
