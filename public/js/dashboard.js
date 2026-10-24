'use strict';
(async function () {
  const { el, $, icon } = TV;
  const user = await TV.boot({ active: '/dashboard', roles: ['owner', 'viewer'] });
  if (!user) return;
  const isOwner = user.role === 'owner';

  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  $('#greeting').textContent = `${part}, ${user.displayName.split(' ')[0]}`;
  if (isOwner) {
    $('#head-actions').append(
      el('a', { class: 'btn', href: '/search' }, icon('search', 'sm'), 'Search'),
      el('a', { class: 'btn primary', href: '/upload' }, icon('upload', 'sm'), 'Upload document'));
    $('#activity-card').classList.remove('hidden');
  } else {
    $('#viewer-card').classList.remove('hidden');
  }

  const data = await TV.api('GET', '/api/dashboard');
  const s = data.stats;
  const stats = $('#stats');
  const QUICK = isOwner
    ? [['/upload', 'upload', 'Upload a document', 'Starts private, encrypted on arrival', 'violet'], ['/search', 'search', 'Search the vault', 'Only what you can open', 'blue'], ['/shared', 'users', 'Shared with me', 'Files others granted you', 'teal'], ['/activity', 'activity', 'Who opened my files', 'Including refused attempts', 'amber']]
    : [['/shared', 'users', 'Shared with me', 'Files granted to you by name', 'teal'], ['/search', 'search', 'Search the vault', 'Only what you can open', 'blue'], ['/account', 'user', 'My sessions', 'See and end where you are signed in', 'violet'], ['/security', 'shield', 'How access works', 'Why you see what you see', 'amber']];
  stats.after(el('nav', { class: 'quick', 'aria-label': 'Quick actions' }, QUICK.map(([href, ic, title, sub, tone]) =>
    el('a', { class: `quick-tile tone-${tone}`, href }, el('span', { class: 'qi' }, icon(ic)), el('span', { class: 'qt' }, el('strong', { text: title }), el('span', { text: sub })), icon('arrow', 'sm qa')))));
  if (isOwner) {
    stats.append(
      TV.stat({ label: 'Documents I own', value: s.owned, icon: 'folder', hint: 'Private unless you share them', href: '/documents' }),
      TV.stat({ label: 'Shared with me', value: s.sharedWithMe, icon: 'users', hint: 'Granted by other owners', href: '/shared', tone: 'teal' }),
      TV.stat({ label: 'Grants I have given', value: s.grantsGiven, icon: 'key', hint: 'Across all my documents', href: '/documents', tone: 'violet' }),
      TV.stat({ label: 'Refused attempts (7 days)', value: s.deniedOnMine, icon: 'alert', hint: 'On my documents', href: '/activity?outcome=denied', tone: 'red', alert: s.deniedOnMine > 0 }),
      TV.stat({ label: 'In trash', value: s.inTrash, icon: 'trash', hint: 'Nobody can open these', href: '/trash', tone: 'amber' }));
  } else {
    stats.append(
      TV.stat({ label: 'Shared with me', value: s.sharedWithMe, icon: 'users', hint: 'Documents you can open', href: '/shared', tone: 'teal' }),
      TV.stat({ label: 'Expiring soon', value: data.expiring.length, icon: 'clock', hint: 'Grants with an end date', href: '/shared', tone: 'amber' }),
      TV.stat({ label: 'Your role', value: 'Viewer', icon: 'eye', hint: 'You can open what is granted to you', tone: 'violet' }),
      TV.stat({ label: 'Every access', value: 'Recorded', icon: 'list', hint: 'Opens and downloads are audited', tone: 'green' }));
  }

  const recent = $('#recent');
  if (!data.recent.length) {
    recent.append(TV.empty('folder', 'No documents yet', isOwner ? 'Upload your first document to get started.' : 'Nothing has been shared with you yet.'));
  } else {
    recent.append(el('div', { class: 'table-wrap' }, el('table', null,
      el('thead', null, el('tr', null, el('th', { text: 'Document' }), el('th', { text: 'Access' }), el('th', { text: 'Updated' }))),
      el('tbody', null, data.recent.map((d) => el('tr', null,
        el('td', null, el('div', { class: 'doc-cell' }, TV.fileBadge(d.extension),
          el('div', null, el('a', { class: 'name', href: `/document?id=${d.id}`, text: d.title }),
            el('div', { class: 'meta', text: `${d.category} · ${d.owner.displayName}` })))),
        el('td', null, TV.accessBadge(d.myAccess)),
        el('td', { class: 'nowrap subtle', text: TV.relTime(d.updatedAt) })))))));
  }

  if (isOwner) {
    const act = $('#activity');
    if (!data.activity.length) act.append(TV.empty('activity', 'No activity yet', 'Opens, downloads and refusals on your documents appear here.'));
    else act.append(timeline(data.activity));
  }

  if (data.expiring.length) {
    $('#expiring-card').classList.remove('hidden');
    $('#expiring').append(el('ul', { class: 'timeline' }, data.expiring.map((x) => el('li', null,
      el('span', { class: 'dot' }, icon('clock', 'sm')),
      el('div', null, el('a', { class: 'what', href: `/document?id=${x.id}`, text: x.title }),
        el('div', { class: 'when', text: `Your access ends ${TV.fmtDateTime(x.expiresAt)}` }))))));
  }

  function timeline(entries) {
    return el('ul', { class: 'timeline' }, entries.map((e) => el('li', null,
      el('span', { class: `dot ${e.outcome}` }, icon(e.outcome === 'success' ? 'check' : 'x', 'sm')),
      el('div', null,
        el('div', { class: 'what' }, el('strong', { text: e.actor || 'Someone' }), ' ', TV.describe(e).toLowerCase(), ' ', TV.detailText(e)),
        el('div', { class: 'when', text: TV.relTime(e.ts) })))));
  }
})().catch((err) => TV.toast(err.message, 'error'));
