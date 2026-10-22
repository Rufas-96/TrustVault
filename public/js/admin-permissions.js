'use strict';
(async function () {
  const { el, $, icon } = TV;
  const user = await TV.boot({ active: '/admin-permissions', roles: ['admin'] });
  if (!user) return;

  const text = $('#f-text');
  const kind = $('#f-kind');
  kind.value = TV.qs('filter') || '';
  let grants = [];

  function matches(g) {
    const q = text.value.trim().toLowerCase();
    if (q && ![g.title, g.owner, g.username, g.displayName].some((v) => String(v).toLowerCase().includes(q))) return false;
    if (kind.value === 'edit') return g.level === 'edit';
    if (kind.value === 'expiring') return g.expiresAt !== null && !g.expired;
    if (kind.value === 'expired') return g.expired;
    if (kind.value === 'inactive') return !g.userActive;
    return true;
  }

  function render() {
    const list = grants.filter(matches);
    const box = TV.clear($('#grants'));
    if (!list.length) { box.append(TV.empty('key', 'No matching grants', 'Nothing matches these filters.')); return; }
    box.append(el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Document' }), el('th', { text: 'Owner' }), el('th', { text: 'Granted to' }),
        el('th', { text: 'Access' }), el('th', { text: 'Expires' }), el('th', { text: 'Granted' }), el('th', { class: 'num', text: '' }))),
      el('tbody', null, list.map((g) => el('tr', null,
        el('td', null, el('div', { class: 'name', text: g.title }), g.documentDeleted ? TV.badge('In trash', 'warning') : null),
        el('td', { class: 'nowrap', text: g.owner }),
        el('td', null, el('div', { text: g.displayName }), el('div', { class: 'subtle' }, `@${g.username}`, g.userActive ? null : [' ', TV.badge('Deactivated', 'danger')])),
        el('td', null, TV.accessBadge(g.level)),
        el('td', { class: 'nowrap' }, g.expiresAt ? (g.expired ? TV.badge('Expired', 'danger') : TV.fmtDate(g.expiresAt)) : el('span', { class: 'subtle', text: 'Never' })),
        el('td', { class: 'nowrap subtle', text: `${TV.fmtDate(g.grantedAt)} by ${g.grantedBy}` }),
        el('td', { class: 'num' }, el('button', { class: 'btn sm danger-text', type: 'button', onclick: () => revoke(g) }, icon('x', 'sm'), 'Revoke'))))))));
  }

  async function revoke(g) {
    const ok = await TV.confirm({
      title: `Revoke ${g.displayName}'s access?`,
      message: `“${g.title}” (owned by ${g.owner}) will be refused to them from their next request. Only the owner can grant it again.`,
      confirmLabel: 'Revoke', danger: true,
    });
    if (!ok) return;
    await TV.busy(null, async () => {
      await TV.api('DELETE', `/api/admin/permissions/${g.documentId}/${g.userId}`);
      TV.toast('Access revoked', 'success');
      await load();
    });
  }

  async function load() {
    const [{ grants: g }, history] = await Promise.all([
      TV.api('GET', '/api/admin/permissions'),
      TV.api('GET', '/api/admin/audit?action=permission.'),
    ]);
    grants = g;
    render();
    const box = TV.clear($('#history'));
    if (!history.entries.length) { box.append(el('div', { class: 'card-body subtle', text: 'No permission changes yet.' })); return; }
    box.append(el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'When' }), el('th', { text: 'Who' }), el('th', { text: 'Change' }), el('th', { text: 'Details' }))),
      el('tbody', null, history.entries.slice(0, 25).map((e) => el('tr', null,
        el('td', { class: 'nowrap subtle', text: TV.fmtDateTime(e.ts) }),
        el('td', { class: 'nowrap' }, el('strong', { text: e.actor || '—' })),
        el('td', null, TV.badge(TV.describe(e), e.action === 'permission.revoke' ? 'danger' : e.action === 'permission.grant' ? 'success' : 'warning')),
        el('td', { text: TV.detailText(e) })))))));
  }

  $('#filters').addEventListener('submit', (e) => e.preventDefault());
  text.addEventListener('input', render);
  kind.addEventListener('change', render);
  await load();
})().catch((err) => TV.toast(err.message, 'error'));
