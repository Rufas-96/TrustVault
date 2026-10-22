'use strict';
(async function () {
  const { el, $, icon } = TV;
  const user = await TV.boot({ active: '/admin-audit', roles: ['admin'] });
  if (!user) return;

  const form = $('#filters');
  const box = $('#entries');
  for (const [k, v] of new URLSearchParams(location.search)) {
    if (!form.elements[k]) continue;
    const field = form.elements[k];
    // Allow links to filter by an action that is not in the dropdown.
    if (field.tagName === 'SELECT' && ![...field.options].some((o) => o.value === v)) field.append(el('option', { value: v, text: v }));
    field.value = v;
  }
  let page = 1;

  function filters() {
    const p = new URLSearchParams();
    for (const f of form.elements) if (f.name && f.value.trim()) p.set(f.name, f.value.trim());
    return p;
  }

  async function load() {
    const p = filters();
    history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
    $('#export-btn').href = `/api/admin/audit/export.csv${p.toString() ? `?${p}` : ''}`;
    p.set('page', page);
    TV.clear(box);
    let data;
    try {
      data = await TV.api('GET', `/api/admin/audit?${p}`);
    } catch (err) {
      box.append(TV.empty('alert', 'Could not load the audit log', err.message));
      return;
    }
    if (!data.entries.length) { box.append(TV.empty('list', 'No matching entries', 'Try different filters.')); return; }
    box.append(el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { class: 'num', text: '#' }), el('th', { text: 'When (local)' }), el('th', { text: 'Who' }),
        el('th', { text: 'Action' }), el('th', { text: 'Details' }), el('th', { text: 'Outcome' }), el('th', { text: 'IP' }))),
      el('tbody', null, data.entries.map((e) => el('tr', null,
        el('td', { class: 'num mono subtle', title: `hash ${e.hash}`, text: e.seq }),
        el('td', { class: 'nowrap', title: new Date(e.ts).toISOString(), text: TV.fmtDateTime(e.ts) }),
        el('td', { class: 'nowrap' }, el('strong', { text: e.actor || '—' })),
        el('td', null, el('div', { text: TV.describe(e) }), el('code', { class: 'subtle', text: e.action })),
        el('td', null,
          el('div', { text: TV.detailText(e) }),
          e.documentId ? el('a', { class: 'subtle', href: `/admin-audit?document=${e.documentId}`, text: 'document history' }) : null),
        el('td', null, TV.outcomeBadge(e.outcome)),
        el('td', { class: 'mono subtle', text: e.ip || '—' })))))));
    box.append(TV.pager(data, (n) => { page = n; load(); }));
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); page = 1; load(); });
  form.addEventListener('reset', () => setTimeout(() => { page = 1; load(); }, 0));

  $('#verify-btn').addEventListener('click', (e) => TV.busy(e.currentTarget, async () => {
    const r = await TV.api('POST', '/api/admin/audit/verify');
    TV.clear($('#verify-result')).append(el('div', { class: `notice ${r.ok ? 'success' : 'danger'} stack-gap` }, icon(r.ok ? 'shield' : 'alert'),
      el('div', null, r.ok
        ? [el('strong', { text: `All ${r.count} entries verified. ` }), 'Every entry links to the one before it and its HMAC matches. Head hash (record this somewhere outside TrustVault): ', el('code', { text: r.headHash })]
        : [el('strong', { text: 'Integrity check failed. ' }), r.reason])));
    page = 1;
    await load();
  }));

  load();
})().catch((err) => TV.toast(err.message, 'error'));
