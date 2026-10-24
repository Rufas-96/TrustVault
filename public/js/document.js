'use strict';
(async function () {
  const { el, $, icon } = TV;
  const user = await TV.boot({ active: null });
  if (!user) return;
  const id = TV.qs('id');

  async function load() {
    let data;
    try {
      data = await TV.api('GET', `/api/documents/${encodeURIComponent(id || '')}`);
    } catch (err) {
      TV.clear($('#content')).append(el('div', { class: 'card' }, TV.empty('lock', 'Document not available',
        err.status === 404 ? 'It does not exist, or you do not have access to it. If someone shared it with you, their access may have been revoked.' : err.message)));
      return;
    }
    render(data.document);
  }

  function render(d) {
    document.title = `${d.title} · TrustVault`;
    const isOwner = d.myAccess === 'owner';
    const canEdit = isOwner || d.myAccess === 'edit';
    const nav = TV.$(`.nav-link[href="${isOwner ? '/documents' : '/shared'}"]`);
    if (nav) nav.classList.add('active');

    TV.clear($('#doc-badges')).append(TV.badge(d.category), TV.accessBadge(d.myAccess), TV.badge(`Version ${d.currentVersion}`));
    $('#doc-title').textContent = d.title;
    const ext = (d.versions[0] && d.versions[0].extension) || 'file';
    const head = $('#doc-title').parentElement;
    if (!head.querySelector('.file-badge.xl')) head.prepend(el('span', { class: `file-badge xl ${ext}`, text: ext.slice(0, 4) }));
    $('#doc-desc').textContent = d.description || 'No description.';

    const actions = TV.clear($('#doc-actions'));
    actions.append(el('button', { class: 'btn primary', type: 'button', onclick: () => TV.download(d.id) }, icon('download', 'sm'), 'Download'));
    if (isOwner) {
      actions.append(
        el('a', { class: 'btn', href: `/share?id=${d.id}` }, icon('share', 'sm'), 'Manage access'),
        el('a', { class: 'btn', href: `/activity?doc=${d.id}` }, icon('activity', 'sm'), 'Activity'),
        el('button', { class: 'btn danger-text', type: 'button', onclick: () => trash(d) }, icon('trash', 'sm'), 'Move to trash'));
    }

    const notice = TV.clear($('#access-notice'));
    if (TV.qs('uploaded')) {
      notice.append(el('div', { class: 'notice success' }, icon('check'),
        el('div', null, 'Uploaded and encrypted. This document is private: ', el('a', { href: `/share?id=${d.id}`, text: 'grant access' }), ' to the people who need it.')));
    } else if (!isOwner) {
      notice.append(el('div', { class: 'notice info' }, icon('info'), el('div', {
        text: `${d.owner.displayName} shared this with you (${d.myAccess === 'edit' ? 'can edit' : 'view only'})${d.myExpiresAt ? `, until ${TV.fmtDateTime(d.myExpiresAt)}` : ''}. Your opens and downloads are recorded.`,
      })));
    }
    if (notice.firstChild) notice.firstChild.classList.add('stack-gap');

    // "Why can I see this?": the exact rule that lets this person in, in plain words.
    const reasons = isOwner
      ? [['key', 'You own this document', 'Owners always have full access. Nobody else can share it.'],
        ['users', d.grantCount ? `${d.grantCount} ${d.grantCount === 1 ? 'person has' : 'people have'} been granted access` : 'Nobody else can open it', d.grantCount ? 'Each one by name, and you can take it back at any time.' : 'It is private until you grant someone access.']]
      : [['key', `${d.myGrant ? d.myGrant.grantedBy : d.owner.displayName} granted you ${d.myAccess === 'edit' ? 'edit' : 'view'} access`, d.myGrant ? `On ${TV.fmtDate(d.myGrant.grantedAt)}, to you by name.` : 'To you by name.'],
        ['clock', d.myExpiresAt ? `Until ${TV.fmtDateTime(d.myExpiresAt)}` : 'Until the owner takes it back', 'Revoking works on your very next request.']];
    reasons.push(['fingerprint', 'Every copy is traceable', 'Each download is stamped with its own trace ID and recorded.']);
    TV.append(TV.clear($('#why')), el('ul', { class: 'why-list' }, reasons.map(([ic, title, sub]) =>
      el('li', null, el('span', { class: 'why-ic' }, icon(ic, 'sm')), el('div', null, el('strong', { text: title }), el('span', { text: sub }))))));

    const latest = d.versions[0];
    TV.append(TV.clear($('#details')), [
      el('dt', { text: 'Owner' }), el('dd', { text: `${d.owner.displayName} (@${d.owner.username})` }),
      el('dt', { text: 'Category' }), el('dd', { text: d.category }),
      el('dt', { text: 'File' }), el('dd', { text: latest ? latest.fileName : '—' }),
      el('dt', { text: 'Size' }), el('dd', { text: latest ? TV.fmtBytes(latest.sizeBytes) : '—' }),
      el('dt', { text: 'Uploaded' }), el('dd', { text: TV.fmtDateTime(d.createdAt) }),
      el('dt', { text: 'Last updated' }), el('dd', { text: TV.fmtDateTime(d.updatedAt) }),
      isOwner ? el('dt', { text: 'Shared with' }) : null,
      isOwner ? el('dd', null, el('a', { href: `/share?id=${d.id}`, text: d.grantCount ? `${d.grantCount} ${d.grantCount === 1 ? 'person' : 'people'}` : 'Nobody (private)' })) : null,
      el('dt', { text: 'SHA-256' }), el('dd', { class: 'mono truncate', title: latest ? latest.sha256 : '', text: latest ? latest.sha256 : '—' })]);

    TV.clear($('#versions')).append(el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Version' }), el('th', { text: 'File' }), el('th', { text: 'Uploaded by' }), el('th', { text: 'Date' }), el('th', { class: 'num', text: '' }))),
      el('tbody', null, d.versions.map((v) => el('tr', null,
        el('td', null, TV.badge(`v${v.version}`, v.version === d.currentVersion ? 'primary' : '')),
        el('td', null, el('div', { class: 'doc-cell' }, TV.fileBadge(v.extension), el('div', null, el('div', { class: 'name', text: v.fileName }), el('div', { class: 'meta', text: TV.fmtBytes(v.sizeBytes) })))),
        el('td', { text: v.uploadedBy }),
        el('td', { class: 'nowrap subtle', text: TV.fmtDateTime(v.createdAt) }),
        el('td', { class: 'num' }, el('button', { class: 'btn sm', type: 'button', title: `Download version ${v.version}`, 'aria-label': `Download version ${v.version}`, onclick: () => TV.download(d.id, v.version) }, icon('download', 'sm')))))))));

    $('#edit-card').classList.toggle('hidden', !canEdit);
    $('#version-card').classList.toggle('hidden', !canEdit);
    if (canEdit) {
      const f = $('#edit-form');
      f.elements.title.value = d.title;
      f.elements.description.value = d.description;
      f.elements.category.value = d.category;
    }
  }

  async function trash(d) {
    const ok = await TV.confirm({
      title: 'Move to trash?',
      message: `“${d.title}” will become unreachable for everyone you shared it with. You can restore it from the trash.`,
      confirmLabel: 'Move to trash', danger: true,
    });
    if (!ok) return;
    await TV.busy(null, async () => {
      await TV.api('DELETE', `/api/documents/${d.id}`);
      location.href = '/trash';
    });
  }

  const { categories } = await TV.api('GET', '/api/meta/categories');
  for (const c of categories) $('#e-category').append(el('option', { value: c, text: c }));

  $('#edit-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    TV.busy(f.querySelector('button'), async () => {
      const res = await TV.api('PATCH', `/api/documents/${id}`, { title: f.elements.title.value, description: f.elements.description.value, category: f.elements.category.value });
      TV.toast(res.changed.length ? 'Details saved' : 'Nothing changed', 'success');
      await load();
    }, $('#edit-error'));
  });

  $('#version-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const file = f.file.files[0];
    if (!file) { $('#version-error').textContent = 'Choose a file.'; return; }
    const body = new FormData();
    body.append('file', file, file.name);
    TV.busy(f.querySelector('button'), async () => {
      const res = await TV.api('POST', `/api/documents/${id}/versions`, body);
      TV.toast(`Version ${res.version} uploaded`, 'success');
      f.reset();
      await load();
    }, $('#version-error'));
  });

  await load();
})().catch((err) => TV.toast(err.message, 'error'));
