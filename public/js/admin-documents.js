'use strict';
(async function () {
  const { el, $ } = TV;
  const user = await TV.boot({ active: '/admin-documents', roles: ['admin'] });
  if (!user) return;

  const text = $('#f-text');
  const state = $('#f-state');
  const { documents } = await TV.api('GET', '/api/admin/documents');

  function render() {
    const q = text.value.trim().toLowerCase();
    const list = documents.filter((d) => (!q || d.title.toLowerCase().includes(q) || d.owner.username.toLowerCase().includes(q) || d.owner.displayName.toLowerCase().includes(q))
      && (!state.value || (state.value === 'trash') === (d.deletedAt !== null)));
    const box = TV.clear($('#docs'));
    if (!list.length) { box.append(TV.empty('file', 'No matching documents', 'Nothing matches these filters.')); return; }
    box.append(el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Document' }), el('th', { text: 'Owner' }), el('th', { text: 'Status' }),
        el('th', { class: 'num', text: 'Versions' }), el('th', { class: 'num', text: 'Size' }), el('th', { class: 'num', text: 'Grants' }),
        el('th', { class: 'num', text: 'Downloads' }), el('th', { class: 'num', text: 'Refused' }), el('th', { text: 'Updated' }), el('th', { text: '' }))),
      el('tbody', null, list.map((d) => el('tr', null,
        el('td', null, el('div', { class: 'name', text: d.title }), el('div', { class: 'subtle', text: d.category })),
        el('td', { class: 'nowrap', text: d.owner.displayName }),
        el('td', null, d.deletedAt ? TV.badge('In trash', 'warning') : TV.badge('Active', 'success')),
        el('td', { class: 'num', text: d.versions }),
        el('td', { class: 'num', text: TV.fmtBytes(d.totalBytes) }),
        el('td', { class: 'num', text: d.grantCount }),
        el('td', { class: 'num', text: d.downloads }),
        el('td', { class: 'num' }, d.denied ? TV.badge(String(d.denied), 'danger') : '0'),
        el('td', { class: 'nowrap subtle', text: TV.fmtDate(d.updatedAt) }),
        el('td', null, el('a', { class: 'btn sm', href: `/admin-audit?document=${d.id}`, text: 'History' }))))))));
  }

  $('#filters').addEventListener('submit', (e) => e.preventDefault());
  text.addEventListener('input', render);
  state.addEventListener('change', render);
  render();
})().catch((err) => TV.toast(err.message, 'error'));
