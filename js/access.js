// Access panel (admin): who can open the library.
// Access is plain Drive sharing on the library folder, view only. The agency
// name for each person is kept in _library/agencies.json so a whole agency can
// be removed in one click when the brand changes agency.
import * as drive from './drive.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function openAccess(S, ui) {
  ui.openDialog('<h2>Access</h2><p class="muted">Loading...</p>');
  if (!S.sys) S.sys = await drive.systemFolder(S.root.id, true);
  let { id: fileId, data: agencies } = await drive.readJson(S.sys, 'agencies.json');
  agencies = agencies || {};
  let perms = await drive.listPermissions(S.root.id);

  const save = async () => { fileId = await drive.writeJson(S.sys, 'agencies.json', fileId, agencies); };

  const draw = () => {
    const link = perms.find((p) => p.type === 'anyone');
    const people = perms.filter((p) => p.type === 'user' && p.role !== 'owner');
    const byAgency = new Map();
    for (const p of people) {
      const a = agencies[p.emailAddress?.toLowerCase()] || (p.role === 'reader' ? 'No agency set' : 'Editors (can change files in Drive)');
      (byAgency.get(a) || byAgency.set(a, []).get(a)).push(p);
    }
    const appUrl = location.origin + location.pathname;
    ui.openDialog(`<h2>Access</h2>
      <p class="muted">Agency people get view and download access to every file in the library, nothing else. Send them this link: <b>${esc(appUrl)}</b></p>
      ${link ? `<div class="banner old"><b>Anyone with the folder link can see everything</b>Link sharing is on in Google Drive (${esc(link.role)}). Removing an agency here only cuts them off once link sharing is turned off in Drive: open the folder in Drive, Share, General access, Restricted. Your call.</div>` : ''}
      <div class="row"><input class="input" id="ac-agency" placeholder="Agency, e.g. WGG" style="flex:1;min-width:140px">
      <input class="input" id="ac-email" placeholder="their Google account email" style="flex:2;min-width:200px">
      <button class="btn primary" id="ac-add">Add</button></div>
      <p class="muted small">They need a Google account for that email (a free one works). While the Google app is not published, also add the email under Test users: console.cloud.google.com/auth/audience.</p>
      ${[...byAgency].map(([name, list]) => `<div class="tag-group"><div class="side-label"><span>${esc(name)}</span>${
        name.startsWith('Editors') ? '' : `<button class="link small" data-revoke-agency="${esc(name)}">Remove all</button>`}</div>${
        list.map((p) => `<div class="person"><span class="who">${esc(p.displayName || '')} <span class="muted">${esc(p.emailAddress)}</span></span><span class="muted small">${p.role === 'reader' ? 'view' : esc(p.role)}</span>${
          p.role === 'reader' ? `<button class="btn danger" data-revoke="${p.id}">Remove</button>` : ''}</div>`).join('')}</div>`).join('')}`);

    document.getElementById('ac-add').onclick = async () => {
      const agency = document.getElementById('ac-agency').value.trim();
      const email = document.getElementById('ac-email').value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return ui.toast('That email does not look right.');
      await drive.addReader(S.root.id, email);
      if (agency) { agencies[email] = agency; await save(); }
      perms = await drive.listPermissions(S.root.id);
      ui.toast(`${email} can now open the library. Send them the link.`);
      draw();
    };
    document.getElementById('dialog-body').onclick = async (e) => {
      const one = e.target.closest('[data-revoke]');
      const all = e.target.closest('[data-revoke-agency]');
      if (!one && !all) return;
      const targets = one ? perms.filter((p) => p.id === one.dataset.revoke)
        : people.filter((p) => (agencies[p.emailAddress?.toLowerCase()] || 'No agency set') === all.dataset.revokeAgency && p.role === 'reader');
      // Two clicks to remove, so nobody is removed by accident.
      const btn = one || all;
      if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'Click again to remove'; return; }
      for (const p of targets) {
        await drive.removePermission(S.root.id, p.id);
        delete agencies[p.emailAddress?.toLowerCase()];
      }
      await save();
      perms = await drive.listPermissions(S.root.id);
      ui.toast(`Removed ${targets.length} ${targets.length === 1 ? 'person' : 'people'}.`);
      draw();
    };
  };
  draw();
}
