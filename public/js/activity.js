'use strict';
(async function () {
  const { el, $, icon } = TV;
  const user = await TV.boot({ active: '/activity', roles: ['owner'] });
  if (!user) return;
  const docId = TV.qs('doc');
  const outcome = $('#outcome');
  outcome.value = TV.qs('outcome') || '';
  let page = 1;

  function table(entries, showDoc) {
    return el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'When' }), el('th', { text: 'Who' }), el('th', { text: 'What' }),
        showDoc ? el('th', { text: 'Document' }) : null, el('th', { text: 'Outcome' }))),
      el('tbody', null, entries.map((e) => el('tr', null,
        el('td', { class: 'nowrap subtle', title: new Date(e.ts).toISOString(), text: TV.fmtDateTime(e.ts) }),
        el('td', { class: 'nowrap' }, el('strong', { text: e.actor || '(not signed in)' })),
        el('td', null, TV.describe(e), el('div', { class: 'subtle', text: TV.detailText(e) })),
        showDoc ? el('td', null, e.documentId ? el('a', { href: `/activity?doc=${e.documentId}`, text: (e.details && e.details.title) || 'Document' }) : '—') : null,
        el('td', null, TV.outcomeBadge(e.outcome)))))));
  }

  async function load() {
    const box = TV.clear($('#entries'));
    try {
      if (docId) {
        const data = await TV.api('GET', `/api/documents/${encodeURIComponent(docId)}/activity`);
        $('#activity-title').textContent = `Activity: ${data.document.title}`;
        $('#activity-sub').textContent = 'Every recorded event for this document, newest first.';
        const list = outcome.value ? data.entries.filter((e) => e.outcome === outcome.value) : data.entries;
        box.append(list.length ? table(list, false) : TV.empty('activity', 'No matching activity', 'Try a different filter.'));
        box.append(el('div', { class: 'pager' }, el('a', { href: `/document?id=${docId}`, text: '← Back to document' }), el('a', { href: '/activity', text: 'All my documents' })));
        return;
      }
      const p = new URLSearchParams({ page });
      if (outcome.value) p.set('outcome', outcome.value);
      const data = await TV.api('GET', `/api/activity?${p}`);
      if (!data.entries.length) { box.append(TV.empty('activity', 'No activity yet', 'Events on documents you own will appear here.')); return; }
      box.append(table(data.entries, true), TV.pager(data, (n) => { page = n; load(); }));
    } catch (err) {
      box.append(TV.empty('lock', 'Activity not available', err.message));
    }
  }

  outcome.addEventListener('change', () => { page = 1; load(); });
  void icon;
  load();
})().catch((err) => TV.toast(err.message, 'error'));
