'use strict';
(async function () {
  const { el, $, icon } = TV;
  const user = await TV.boot({ active: '/admin', roles: ['admin'] });
  if (!user) return;

  function chainNotice(chain) {
    const box = TV.clear($('#chain'));
    const ok = chain.ok;
    box.append(el('div', { class: `notice ${ok ? 'success' : 'danger'} stack-gap` }, icon(ok ? 'shield' : 'alert'),
      el('div', null,
        el('strong', { text: ok ? 'Audit trail intact. ' : 'Audit trail integrity check failed. ' }),
        ok ? `${chain.count} entries verified. Head #${chain.headSeq}: ` : chain.reason,
        ok ? el('code', { text: chain.headHash.slice(0, 24) + '…', title: chain.headHash }) : null)));
  }

  const entryList = (entries, emptyText) => (entries.length
    ? el('ul', { class: 'timeline' }, entries.map((e) => el('li', null,
      el('span', { class: `dot ${e.outcome}` }, icon(e.outcome === 'success' ? 'check' : 'x', 'sm')),
      el('div', null,
        el('div', { class: 'what' }, el('strong', { text: e.actor || (e.details && e.details.username) || '(anonymous)' }), ' ', TV.describe(e).toLowerCase(), ' ', TV.detailText(e)),
        el('div', { class: 'when', text: `${TV.relTime(e.ts)} · ${e.ip || 'no IP'}` })))))
    : el('div', { class: 'card-body subtle', text: emptyText }));

  function chart(days) {
    const box = TV.clear($('#chart'));
    if (!days.length) { box.append(el('div', { class: 'card-body subtle', text: 'No activity in the last 7 days.' })); return; }
    const max = Math.max(...days.map((d) => d.ok + d.denied), 1);
    const bars = el('div', { class: 'bars', role: 'img', 'aria-label': 'Allowed and refused actions per day' });
    for (const d of days) {
      const ok = el('div', { class: 'seg-ok' });
      const denied = el('div', { class: 'seg-denied' });
      // Heights set via the CSSOM (allowed by our CSP), not inline style attributes.
      ok.style.height = `${(d.ok / max) * 120}px`;
      denied.style.height = `${(d.denied / max) * 120}px`;
      const label = new Date(`${d.day}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
      bars.append(el('div', { class: 'col', title: `${d.day}: ${d.ok} allowed, ${d.denied} refused, ${d.downloads} downloads` },
        el('div', { class: 'stackbar' }, ok, d.denied ? denied : null), el('span', { class: 'day', text: label })));
    }
    const total = days.reduce((a, d) => ({ ok: a.ok + d.ok, denied: a.denied + d.denied, downloads: a.downloads + d.downloads }), { ok: 0, denied: 0, downloads: 0 });
    box.append(bars, el('div', { class: 'legend' },
      el('span', null, el('i', { class: 'k-ok' }), `Allowed (${total.ok})`),
      el('span', null, el('i', { class: 'k-denied' }), `Refused (${total.denied})`),
      el('span', { text: `Downloads: ${total.downloads}` })));
  }

  async function load() {
    const data = await TV.api('GET', '/api/admin/overview');
    const c = data.counts;
    chainNotice(data.chain);
    TV.clear($('#stats')).append(
      TV.stat({ label: 'Active users', value: `${c.activeUsers}/${c.users}`, icon: 'users', hint: `${c.activeSessions} active sessions`, href: '/admin-users' }),
      TV.stat({ label: 'Documents', value: c.documents, icon: 'file', hint: `${c.inTrash} in trash`, href: '/admin-documents', tone: 'teal' }),
      TV.stat({ label: 'Grants', value: c.grants, icon: 'key', hint: `${c.permissionChanges24h} changes in 24 h`, href: '/admin-permissions', tone: 'violet' }),
      TV.stat({ label: 'Downloads (24 h)', value: c.downloads24h, icon: 'download', hint: 'Successful downloads', href: '/admin-audit?action=document.download', tone: 'green' }),
      TV.stat({ label: 'Refused (24 h)', value: c.denied24h, icon: 'alert', hint: 'Attempts that were blocked', href: '/admin-audit?outcome=denied', tone: 'red', alert: c.denied24h > 0 }),
      TV.stat({ label: 'Audit entries', value: c.auditEntries, icon: 'list', hint: 'Append-only, hash-chained', href: '/admin-audit', tone: 'amber' }));

    const alerts = TV.clear($('#alerts'));
    if (!data.alerts.length) alerts.append(TV.empty('check', 'Nothing needs attention', 'No unusual refusals, sign-in failures or download spikes.'));
    else {
      alerts.append(el('ul', { class: 'alert-list' }, data.alerts.map((a) => el('li', null,
        TV.badge(a.severity === 'high' ? 'High' : a.severity === 'medium' ? 'Medium' : 'Low', a.severity),
        el('div', { class: 'text' }, el('strong', { text: a.title }), el('span', { text: a.detail })),
        el('a', { class: 'btn sm', href: a.link, text: 'Review' })))));
    }
    chart(data.days);
    TV.clear($('#denied')).append(entryList(data.recentDenied, 'No refused attempts recorded.'));
    TV.clear($('#perm-changes')).append(entryList(data.recentPermissions, 'No permission changes recorded.'));
  }

  $('#verify-btn').addEventListener('click', (e) => TV.busy(e.currentTarget, async () => {
    const res = await TV.api('POST', '/api/admin/audit/verify');
    chainNotice(res);
    TV.toast(res.ok ? `Verified ${res.count} entries` : 'Integrity check failed', res.ok ? 'success' : 'error');
  }));

  await load();
})().catch((err) => TV.toast(err.message, 'error'));
