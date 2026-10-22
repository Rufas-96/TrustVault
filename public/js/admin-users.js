'use strict';
(async function () {
  const { el, $, icon } = TV;
  const me = await TV.boot({ active: '/admin-users', roles: ['admin'] });
  if (!me) return;

  async function load() {
    const { users } = await TV.api('GET', '/api/admin/users');
    TV.clear($('#users')).append(el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'User' }), el('th', { text: 'Role' }), el('th', { text: 'Status' }),
        el('th', { class: 'num', text: 'Owns' }), el('th', { class: 'num', text: 'Grants' }), el('th', { class: 'num', text: 'Sessions' }),
        el('th', { text: 'Last sign-in' }), el('th', { class: 'num', text: '' }))),
      el('tbody', null, users.map(row)))));
  }

  function row(u) {
    const self = u.id === me.id;
    const role = el('select', { 'aria-label': `Role for ${u.username}`, disabled: self },
      ['viewer', 'owner', 'admin'].map((r) => el('option', { value: r, text: r[0].toUpperCase() + r.slice(1), selected: r === u.role })));
    role.addEventListener('change', async () => {
      const ok = await TV.confirm({ title: `Change ${u.displayName}'s role to ${role.value}?`, message: 'It applies on their next request.', confirmLabel: 'Change role' });
      if (!ok) { role.value = u.role; return; }
      await update(u, { role: role.value }, () => { role.value = u.role; });
    });
    return el('tr', null,
      el('td', null, el('div', { class: 'doc-cell' }, el('div', { class: 'avatar', text: TV.initials(u.displayName) }),
        el('div', null, el('div', { class: 'name', text: u.displayName }), el('div', { class: 'meta', text: `@${u.username} · ${u.email}` })))),
      el('td', null, role),
      el('td', null, u.isActive ? TV.badge('Active', 'success') : TV.badge('Deactivated', 'danger'), u.locked ? [' ', TV.badge('Locked', 'warning')] : null),
      el('td', { class: 'num', text: u.owned }),
      el('td', { class: 'num', text: u.grants }),
      el('td', { class: 'num', text: u.sessions }),
      el('td', { class: 'nowrap subtle', text: u.lastLoginAt ? TV.relTime(u.lastLoginAt) : 'Never' }),
      el('td', { class: 'num nowrap' }, self ? el('span', { class: 'subtle', text: 'You' }) : [
        el('button', { class: `btn sm${u.isActive ? ' danger-text' : ''}`, type: 'button', text: u.isActive ? 'Deactivate' : 'Reactivate', onclick: () => toggle(u) }), ' ',
        el('button', { class: 'btn sm', type: 'button', title: 'Reset password', onclick: () => resetPassword(u) }, icon('key', 'sm')), ' ',
        el('button', { class: 'btn sm', type: 'button', title: 'Sign out everywhere', onclick: () => signOut(u) }, icon('logout', 'sm')),
      ]));
  }

  async function update(u, body, onFail) {
    const ok = await TV.busy(null, async () => {
      const res = await TV.api('PATCH', `/api/admin/users/${u.id}`, body);
      TV.toast(res.sessionsEnded ? `Updated. ${res.sessionsEnded} session(s) ended.` : 'Updated', 'success');
      return true;
    });
    if (!ok && onFail) onFail();
    await load();
  }

  async function toggle(u) {
    const ok = await TV.confirm(u.isActive
      ? { title: `Deactivate ${u.displayName}?`, message: 'They are signed out everywhere at once and cannot sign in. Their grants stop working. Their documents stay in place.', confirmLabel: 'Deactivate', danger: true }
      : { title: `Reactivate ${u.displayName}?`, message: 'They will be able to sign in again, and any grants they still hold will work again.', confirmLabel: 'Reactivate' });
    if (ok) await update(u, { isActive: !u.isActive });
  }

  function resetPassword(u) {
    const input = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New password' });
    const err = el('div', { class: 'form-error' });
    const dlg = el('dialog', null,
      el('form', { method: 'dialog' },
        el('div', { class: 'dlg-body' }, el('h2', { text: `Reset password for ${u.displayName}` }),
          el('p', { text: 'Their sessions end and any lockout is cleared. Give them the new password through a separate channel.' }),
          el('div', { class: 'field' }, el('label', { text: 'New password' }), input), err),
        el('div', { class: 'dlg-foot' },
          el('button', { class: 'btn', value: 'cancel', text: 'Cancel', formnovalidate: true }),
          el('button', { class: 'btn primary', value: 'ok', text: 'Reset password' }))));
    dlg.addEventListener('close', () => dlg.remove());
    dlg.querySelector('form').addEventListener('submit', async (e) => {
      if (e.submitter && e.submitter.value === 'cancel') return;
      e.preventDefault();
      await TV.busy(e.submitter, async () => {
        await TV.api('POST', `/api/admin/users/${u.id}/reset-password`, { newPassword: input.value });
        dlg.close();
        TV.toast('Password reset', 'success');
        await load();
      }, err);
    });
    document.body.append(dlg);
    dlg.showModal();
  }

  async function signOut(u) {
    const ok = await TV.confirm({ title: `Sign ${u.displayName} out everywhere?`, message: 'All of their sessions end immediately.', confirmLabel: 'Sign out' });
    if (!ok) return;
    await TV.busy(null, async () => {
      const res = await TV.api('POST', `/api/admin/users/${u.id}/logout`);
      TV.toast(`${res.sessionsEnded} session(s) ended`, 'success');
      await load();
    });
  }

  $('#create-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const body = Object.fromEntries(['username', 'displayName', 'email', 'role', 'password'].map((k) => [k, f.elements[k].value]));
    TV.busy(f.querySelector('button'), async () => {
      await TV.api('POST', '/api/admin/users', body);
      f.reset();
      TV.toast(`User ${body.username} created`, 'success');
      await load();
    }, $('#create-error'));
  });

  await load();
})().catch((err) => TV.toast(err.message, 'error'));
