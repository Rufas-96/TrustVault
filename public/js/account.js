'use strict';
(async function () {
  const { el, $ } = TV;
  const user = await TV.boot({ active: '/account' });
  if (!user) return;

  TV.clear($('#profile')).append(
    el('dt', { text: 'Name' }), el('dd', { text: user.displayName }),
    el('dt', { text: 'Username' }), el('dd', { text: user.username }),
    el('dt', { text: 'Email' }), el('dd', { text: user.email }),
    el('dt', { text: 'Role' }), el('dd', null, TV.roleBadge(user.role)));

  const HELP = {
    admin: ['Manage users, roles and deactivation', 'See every audit entry and permission', 'Revoke any grant', 'You cannot open document contents or be granted access'],
    owner: ['Upload documents, which start private', 'Grant view or edit access to named people, and revoke it', 'See all activity on your documents', 'Open documents others share with you'],
    viewer: ['Open documents that owners grant to you', 'Edit and upload versions where you have edit access', 'You cannot upload new documents or share'],
  };
  $('#role-help').append(el('h3', { text: 'What your role allows' }), el('ul', { class: 'muted' }, HELP[user.role].map((t) => el('li', { text: t }))));

  async function loadSessions() {
    const { sessions } = await TV.api('GET', '/api/auth/sessions');
    TV.clear($('#sessions')).append(el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Device' }), el('th', { text: 'IP address' }), el('th', { text: 'Signed in' }), el('th', { text: 'Last active' }), el('th', { class: 'num', text: '' }))),
      el('tbody', null, sessions.map((s) => el('tr', null,
        el('td', null, el('div', { class: 'truncate', title: s.userAgent, text: s.userAgent || 'Unknown' }), s.current ? TV.badge('This session', 'success') : null),
        el('td', { class: 'mono', text: s.ip || '—' }),
        el('td', { class: 'nowrap subtle', text: TV.fmtDateTime(s.createdAt) }),
        el('td', { class: 'nowrap subtle', text: TV.relTime(s.lastSeenAt) }),
        el('td', { class: 'num' }, s.current ? null : el('button', { class: 'btn sm danger-text', type: 'button', text: 'End session', onclick: () => end(s) }))))))));
  }

  async function end(s) {
    await TV.busy(null, async () => {
      await TV.api('DELETE', `/api/auth/sessions/${s.id}`);
      TV.toast('Session ended', 'success');
      await loadSessions();
    });
  }

  $('#password-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const error = $('#password-error');
    if (f.next.value !== f.confirm.value) { error.textContent = 'The new passwords do not match.'; return; }
    TV.busy(f.querySelector('button'), async () => {
      const res = await TV.api('POST', '/api/auth/password', { currentPassword: f.current.value, newPassword: f.next.value });
      f.reset();
      TV.toast(`Password changed. ${res.otherSessionsEnded} other session(s) signed out.`, 'success');
      await loadSessions();
    }, error);
  });

  await loadSessions();
})().catch((err) => TV.toast(err.message, 'error'));
