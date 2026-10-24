'use strict';
(async function () {
  const { el, $, icon } = TV;
  const user = await TV.boot({ active: '/reviews', roles: ['owner'] });
  if (!user) return;
  const filter = $('#review-filter');
  let data = null;

  async function load() {
    data = await TV.api('GET', '/api/reviews');
    $('#review-days').textContent = String(data.reviewAfterDays);
    const due = data.grants.filter((g) => g.due).length;
    TV.clear($('#review-stats')).append(
      TV.stat({ label: 'Due for review', value: due, icon: 'review', hint: `Not confirmed in ${data.reviewAfterDays} days`, tone: due ? 'amber' : 'green', alert: false }),
      TV.stat({ label: 'Grants given', value: data.grants.length, icon: 'key', hint: 'On your live documents', tone: 'violet' }),
      TV.stat({ label: 'With no end date', value: data.grants.filter((g) => g.expiresAt === null).length, icon: 'clock', hint: 'Last until someone revokes them', tone: 'blue' }),
      TV.stat({ label: 'Edit access', value: data.grants.filter((g) => g.level === 'edit').length, icon: 'edit', hint: 'Can change files and add versions', tone: 'teal' }));
    if (!due && filter.value === 'due') filter.value = 'all';
    render();
  }

  function render() {
    const list = filter.value === 'due' ? data.grants.filter((g) => g.due) : data.grants;
    const box = TV.clear($('#review-list'));
    if (!list.length) { box.append(TV.empty('review', 'All access is up to date', 'Nothing has gone unreviewed. Grants come back here as they age.')); return; }
    box.append(el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Person' }), el('th', { text: 'Document' }), el('th', { text: 'Access' }),
        el('th', { text: 'Last confirmed' }), el('th', { text: 'Status' }), el('th', { class: 'num', text: '' }))),
      el('tbody', null, list.map((g) => el('tr', null,
        el('td', null, el('div', { class: 'doc-cell' }, el('div', { class: 'avatar', text: TV.initials(g.displayName) }),
          el('div', null, el('div', { class: 'name', text: g.displayName }), el('div', { class: 'meta' }, `@${g.username}`, g.userActive ? null : [' · ', TV.badge('Deactivated', 'danger')])))),
        el('td', null, el('a', { class: 'name', href: `/share?id=${g.documentId}`, text: g.title }), el('div', { class: 'subtle', text: g.category })),
        el('td', null, TV.accessBadge(g.level), g.expiresAt ? el('div', { class: 'subtle', text: g.expired ? 'expired' : `until ${TV.fmtDate(g.expiresAt)}` }) : null),
        el('td', { class: 'nowrap' }, el('div', { text: `${g.ageDays} days ago` }), el('div', { class: 'subtle', text: g.reviewedAt ? 'by your review' : 'when granted' })),
        el('td', null, g.due ? TV.badge('Review due', 'warning') : TV.badge('Up to date', 'success')),
        el('td', { class: 'num nowrap' },
          el('button', { class: 'btn sm', type: 'button', onclick: (e) => keep(g, e.currentTarget) }, icon('check', 'sm'), 'Keep'), ' ',
          el('button', { class: 'btn sm danger-text', type: 'button', onclick: () => revoke(g) }, icon('x', 'sm'), 'Revoke'))))))));
  }

  async function keep(g, button) {
    await TV.busy(button, async () => {
      await TV.api('POST', `/api/documents/${g.documentId}/permissions/${g.userId}/confirm`);
      TV.toast(`Kept ${g.displayName}'s access to “${g.title}”. Recorded in the audit trail.`, 'success');
      await load();
    });
  }

  async function revoke(g) {
    const ok = await TV.confirm({ title: `Revoke ${g.displayName}'s access?`, message: `“${g.title}” will be refused to them from their very next request.`, confirmLabel: 'Revoke', danger: true });
    if (!ok) return;
    await TV.busy(null, async () => {
      await TV.api('DELETE', `/api/documents/${g.documentId}/permissions/${g.userId}`);
      TV.toast('Access revoked', 'success');
      await load();
    });
  }

  filter.addEventListener('change', render);
  await load();
})().catch((err) => TV.toast(err.message, 'error'));
