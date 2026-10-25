// Google sign-in with Google Identity Services (token model, no server).
// Agency users get read-only Drive access; admins are asked for full Drive
// access so they can upload and write tags.
import { CLIENT_ID, ADMINS, SCOPE_READ, SCOPE_WRITE } from './config.js';

let client = null;
let token = null;
let expiresAt = 0;
let pending = null;
export const session = { email: null, name: null, isAdmin: false };

const ADMIN_HINT = 'sb-admin-hint';

function hint() {
  try { return localStorage.getItem(ADMIN_HINT); } catch { return null; }
}

function requestToken(scope, prompt) {
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    client = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope,
      login_hint: session.email || hint() || undefined,
      callback: (r) => {
        if (r.error) return pending.reject(new Error(r.error_description || r.error));
        token = r.access_token;
        expiresAt = Date.now() + (r.expires_in - 60) * 1000;
        pending.resolve(r);
      },
      error_callback: (e) => pending.reject(new Error(e.message || e.type)),
    });
    client.requestAccessToken({ prompt });
  });
}

// Must be called from a click (browsers block the Google popup otherwise).
export async function signIn() {
  // Gabriel's browser remembers he is admin, so he gets one popup, not two.
  const wantAdmin = !!hint();
  await requestToken(wantAdmin ? SCOPE_WRITE : SCOPE_READ, '');
  const me = await (await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  session.email = me.user.emailAddress.toLowerCase();
  session.name = me.user.displayName;
  session.isAdmin = ADMINS.includes(session.email);
  try {
    if (session.isAdmin) localStorage.setItem(ADMIN_HINT, session.email);
    else localStorage.removeItem(ADMIN_HINT);
  } catch { /* private mode: fine */ }
  if (session.isAdmin && !wantAdmin) await requestToken(SCOPE_WRITE, '');
  return session;
}

export function tokenValid() {
  return token && Date.now() < expiresAt;
}

// Tokens last one hour. When one runs out the app shows a "Continue" button
// that calls this (a click is needed for the popup).
export async function renew() {
  await requestToken(session.isAdmin ? SCOPE_WRITE : SCOPE_READ, '');
}

export function getToken() {
  if (!tokenValid()) throw new Error('SESSION_EXPIRED');
  return token;
}

// Forgets this browser's session. Access itself is managed in the Access panel.
export function signOut() {
  token = null;
  try { localStorage.removeItem(ADMIN_HINT); } catch { /* fine */ }
  location.reload();
}
