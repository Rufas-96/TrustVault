'use strict';
// Shared by My documents, Shared with me and Search. The page's #doclist element says which scope.
(async function () {
  const { el, $, icon } = TV;
  const root = $('#doclist');
  const scope = root.dataset.scope;
  const user = await TV.boot({ active: root.dataset.active, roles: root.dataset.roles.split(',') });
  if (!user) return;

  const form = $('#filters');
  const results = $('#results');
  const { categories } = await TV.api('GET', '/api/meta/categories');
  if (form.elements.category) for (const c of categories) form.elements.category.append(el('option', { value: c, text: c }));

  const params = new URLSearchParams(location.search);
  for (const [k, v] of params) if (form.elements[k]) form.elements[k].value = v;
  let page = Number(params.get('page')) || 1;

  function query() {
    const p = new URLSearchParams();
    for (const field of form.elements) if (field.name && field.value) p.set(field.name, field.value);
    if (page > 1) p.set('page', page);
    return p;
  }

  async function load() {
    const p = query();
    history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
    p.set('scope', scope);
    TV.clear(results).append(el('div', { class: 'empty', text: 'Loading…' }));
    try {
      render(await TV.api('GET', `/api/documents?${p}`));
    } catch (err) {
      TV.clear(results).append(TV.empty('alert', 'Could not load documents', err.message));
    }
  }

  function render(data) {
    TV.clear(results);
    if (!data.documents.length) {
      const filtered = [...query().keys()].some((k) => k !== 'page' && k !== 'sort');
      if (filtered) results.append(TV.empty('search', 'No matching documents', 'Try different filters. Only documents you are allowed to open are searched.'));
      else if (scope === 'mine') results.append(TV.empty('folder', 'You have not uploaded anything yet', 'Upload a document. It stays private until you share it.'));
      else results.append(TV.empty('users', 'Nothing has been shared with you', 'When an owner grants you a document, it will appear here.'));
      return;
    }
    results.append(el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null,
        el('th', { text: 'Document' }), el('th', { text: 'Category' }),
        scope !== 'mine' ? el('th', { text: 'Owner' }) : null,
        el('th', { text: 'Your access' }), el('th', { text: 'Updated' }), el('th', { class: 'num', text: '' }))),
      el('tbody', null, data.documents.map(row)))));
    results.append(TV.pager(data, (p) => { page = p; load(); }));
  }

  function row(d) {
    return el('tr', null,
      el('td', null, el('div', { class: 'doc-cell' }, TV.fileBadge(d.extension),
        el('div', null,
          el('a', { class: 'name', href: `/document?id=${d.id}`, text: d.title }),
          el('div', { class: 'meta', text: `${d.fileName} · ${TV.fmtBytes(d.sizeBytes)} · v${d.currentVersion}` })))),
      el('td', null, TV.badge(d.category)),
      scope !== 'mine' ? el('td', { class: 'nowrap', text: d.owner.displayName }) : null,
      el('td', null, TV.accessBadge(d.myAccess), d.expiresAt ? el('div', { class: 'subtle', text: `until ${TV.fmtDate(d.expiresAt)}` }) : null),
      el('td', { class: 'nowrap subtle', text: TV.fmtDate(d.updatedAt) }),
      el('td', { class: 'num nowrap' },
        el('button', { class: 'btn sm', type: 'button', title: 'Download', onclick: () => TV.download(d.id) }, icon('download', 'sm')),
        ' ',
        d.myAccess === 'owner' ? el('a', { class: 'btn sm', href: `/share?id=${d.id}`, title: 'Manage access' }, icon('share', 'sm')) : null));
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); page = 1; load(); });
  form.addEventListener('reset', () => setTimeout(() => { page = 1; load(); }, 0));
  load();
})().catch((err) => TV.toast(err.message, 'error'));
