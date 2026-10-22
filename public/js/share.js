'use strict';
(async function () {
  const { el, $, icon } = TV;
  const user = await TV.boot({ active: '/documents', roles: ['owner'] });
  if (!user) return;
  const id = TV.qs('id');
  let selected = null;

  let doc;
  try {
    doc = (await TV.api('GET', `/api/documents/${encodeURIComponent(id || '')}/permissions`)).document;
  } catch (err) {
    TV.clear($('#content')).append(el('div', { class: 'card' }, TV.empty('lock', 'You cannot manage access to this document',
      'Only the owner of a document can share it. It may also not exist or be in the trash.')));
    return;
  }
  document.title = `Access: ${doc.title} · TrustVault`;
  $('#share-title').textContent = `Manage access: ${doc.title}`;
  $('#back-link').href = `/document?id=${doc.id}`;

  // ---- People with access ---------------------------------------------------------------
  async function loadGrants() {
    const { grants } = await TV.api('GET', `/api/documents/${doc.id}/permissions`);
    renderGrants(grants);
  }

  function renderGrants(grants) {
    const box = TV.clear($('#grants'));
    if (!grants.length) {
      box.append(TV.empty('lock', 'Private', 'Only you can open this document.'));
      return;
    }
    box.append(el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Person' }), el('th', { text: 'Access' }), el('th', { text: 'Expires' }), el('th', { text: 'Granted' }), el('th', { class: 'num', text: '' }))),
      el('tbody', null, grants.map((g) => {
        // An expired grant cannot be edited in place: changing its level must not silently renew it.
        const level = el('select', { 'aria-label': `Access for ${g.displayName}`, disabled: g.expired, title: g.expired ? 'Expired. Grant again to renew.' : null },
          el('option', { value: 'read', text: 'Can view', selected: g.level === 'read' }),
          el('option', { value: 'edit', text: 'Can edit', selected: g.level === 'edit' }));
        level.addEventListener('change', () => change(g, level.value));
        return el('tr', null,
          el('td', null, el('div', { class: 'doc-cell' }, el('div', { class: 'avatar', text: TV.initials(g.displayName) }),
            el('div', null, el('div', { class: 'name', text: g.displayName }), el('div', { class: 'meta' }, `@${g.username} · `, TV.roleBadge(g.role), g.isActive ? null : ' deactivated')))),
          el('td', null, level),
          el('td', { class: 'nowrap' }, g.expiresAt ? (g.expired ? TV.badge('Expired', 'danger') : TV.fmtDate(g.expiresAt)) : el('span', { class: 'subtle', text: 'Never' })),
          el('td', { class: 'subtle nowrap', text: `${TV.fmtDate(g.grantedAt)} by ${g.grantedBy}` }),
          el('td', { class: 'num' }, el('button', { class: 'btn sm danger-text', type: 'button', onclick: () => revoke(g) }, icon('x', 'sm'), 'Revoke')));
      })))));
  }

  async function change(g, levelValue) {
    await TV.busy(null, async () => {
      const expiresOn = g.expiresAt ? new Date(g.expiresAt).toISOString().slice(0, 10) : undefined;
      const res = await TV.api('PUT', `/api/documents/${doc.id}/permissions/${g.userId}`, { level: levelValue, expiresOn });
      renderGrants(res.grants);
      TV.toast(`${g.displayName} can now ${levelValue === 'edit' ? 'edit' : 'only view'}`, 'success');
    });
  }

  async function revoke(g) {
    const ok = await TV.confirm({
      title: `Revoke access for ${g.displayName}?`,
      message: 'Their next request for this document will be refused, including any download they start from a page already open.',
      confirmLabel: 'Revoke access', danger: true,
    });
    if (!ok) return;
    await TV.busy(null, async () => {
      const res = await TV.api('DELETE', `/api/documents/${doc.id}/permissions/${g.userId}`);
      renderGrants(res.grants);
      TV.toast(`Access revoked for ${g.displayName}`, 'success');
      loadSuggestions();
    });
  }

  // ---- Grant form with person search ------------------------------------------------------
  const search = $('#g-user');
  const results = $('#g-results');
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    selected = null;
    $('#g-selected').textContent = 'Nobody selected yet.';
    timer = setTimeout(async () => {
      const q = search.value.trim();
      TV.clear(results);
      if (q.length < 2) return;
      const { users } = await TV.api('GET', `/api/users/directory?q=${encodeURIComponent(q)}`);
      if (!users.length) { results.append(el('div', { class: 'help', text: 'No matching people.' })); return; }
      results.append(el('div', { class: 'card' }, el('ul', { class: 'timeline' }, users.map((u) => el('li', null,
        el('div', { class: 'avatar', text: TV.initials(u.displayName) }),
        el('div', { class: 'text' }, el('div', { class: 'name', text: u.displayName }), el('div', { class: 'subtle' }, `@${u.username} `, TV.roleBadge(u.role))),
        el('button', { class: 'btn sm', type: 'button', text: 'Select', onclick: () => pick(u) }))))));
    }, 250);
  });

  function pick(u) {
    selected = u;
    search.value = u.displayName;
    TV.clear(results);
    $('#g-selected').textContent = `Selected: ${u.displayName} (@${u.username})`;
  }

  $('#grant-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!selected) { $('#grant-error').textContent = 'Search for a person and select them first.'; return; }
    const level = $('#g-level').value;
    const expiresOn = $('#g-expires').value || undefined;
    TV.busy($('#grant-btn'), async () => {
      const res = await TV.api('PUT', `/api/documents/${doc.id}/permissions/${selected.id}`, { level, expiresOn });
      renderGrants(res.grants);
      TV.toast(`${selected.displayName} now has ${level === 'edit' ? 'edit' : 'view'} access`, 'success');
      selected = null;
      e.target.reset();
      $('#g-selected').textContent = 'Nobody selected yet.';
      loadSuggestions();
    }, $('#grant-error'));
  });

  // ---- Suggestions --------------------------------------------------------------------
  async function loadSuggestions() {
    const box = TV.clear($('#suggestions'));
    const { suggestions } = await TV.api('GET', `/api/documents/${doc.id}/suggestions`);
    if (!suggestions.length) {
      box.append(el('div', { class: 'card-body subtle', text: 'No suggestions right now.' }));
      return;
    }
    box.append(el('ul', { class: 'alert-list' }, suggestions.map((s) => el('li', null,
      el('div', { class: 'avatar', text: TV.initials(s.displayName) }),
      el('div', { class: 'text' }, el('strong', { text: s.displayName }), el('span', { text: s.reason })),
      el('div', { class: 'actions' },
        el('button', { class: 'btn sm primary', type: 'button', text: 'Grant view', onclick: () => decide(s, 'accept') }),
        el('button', { class: 'btn sm', type: 'button', text: 'Dismiss', onclick: () => decide(s, 'dismiss') }))))));
  }

  async function decide(s, verb) {
    if (verb === 'accept') {
      const ok = await TV.confirm({ title: `Give ${s.displayName} view access?`, message: `Suggested because: ${s.reason}. This is your decision and will be recorded.`, confirmLabel: 'Grant view access' });
      if (!ok) return;
    }
    await TV.busy(null, async () => {
      await TV.api('POST', `/api/documents/${doc.id}/suggestions/${s.id}/${verb}`);
      TV.toast(verb === 'accept' ? `${s.displayName} can now view this document` : 'Suggestion dismissed', 'success');
      await Promise.all([loadGrants(), loadSuggestions()]);
    });
  }

  await Promise.all([loadGrants(), loadSuggestions()]);
})().catch((err) => TV.toast(err.message, 'error'));
