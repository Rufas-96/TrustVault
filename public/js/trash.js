'use strict';
(async function () {
  const { el, $, icon } = TV;
  const user = await TV.boot({ active: '/trash', roles: ['owner'] });
  if (!user) return;

  async function load() {
    const box = TV.clear($('#trash-list'));
    const { documents } = await TV.api('GET', '/api/trash');
    if (!documents.length) { box.append(TV.empty('trash', 'The trash is empty', 'Documents you move to the trash appear here.')); return; }
    box.append(el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Document' }), el('th', { text: 'Deleted' }), el('th', { class: 'num', text: 'Versions' }),
        el('th', { class: 'num', text: 'Size' }), el('th', { text: 'Grants on hold' }), el('th', { class: 'num', text: '' }))),
      el('tbody', null, documents.map((d) => el('tr', null,
        el('td', null, el('div', { class: 'name', text: d.title }), el('div', { class: 'subtle', text: d.category })),
        el('td', { class: 'nowrap subtle', text: TV.fmtDateTime(d.deletedAt) }),
        el('td', { class: 'num', text: d.versions }),
        el('td', { class: 'num', text: TV.fmtBytes(d.totalBytes) }),
        el('td', null, d.grantCount ? TV.badge(`${d.grantCount} would return`, 'warning') : el('span', { class: 'subtle', text: 'None' })),
        el('td', { class: 'num nowrap' },
          el('button', { class: 'btn sm', type: 'button', onclick: () => restore(d) }, icon('restore', 'sm'), 'Restore'), ' ',
          el('button', { class: 'btn sm danger-text', type: 'button', onclick: () => purge(d) }, icon('trash', 'sm'), 'Delete forever'))))))));
  }

  async function restore(d) {
    const ok = await TV.confirm({
      title: 'Restore this document?',
      message: d.grantCount ? `${d.grantCount} ${d.grantCount === 1 ? 'person' : 'people'} you shared it with will get their access back. Review access after restoring.` : 'It will be back in My documents, still private.',
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    await TV.busy(null, async () => {
      await TV.api('POST', `/api/documents/${d.id}/restore`);
      location.href = `/share?id=${d.id}`;
    });
  }

  async function purge(d) {
    const ok = await TV.confirm({
      title: 'Delete forever?',
      message: `Every version of “${d.title}” will be destroyed and all its grants removed. This cannot be undone. The audit trail keeps the record of what happened.`,
      confirmLabel: 'Delete forever', danger: true,
    });
    if (!ok) return;
    await TV.busy(null, async () => {
      await TV.api('DELETE', `/api/documents/${d.id}/purge`);
      TV.toast('Document permanently deleted', 'success');
      await load();
    });
  }

  await load();
})().catch((err) => TV.toast(err.message, 'error'));
