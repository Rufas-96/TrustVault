'use strict';
(async function () {
  const { el, $, icon } = TV;
  const user = await TV.boot({ active: '/trace', roles: ['owner', 'admin'] });
  if (!user) return;

  const error = $('#trace-error');
  const box = $('#trace-result');
  const drop = $('#drop');

  function render(data) {
    TV.clear(box);
    if (!data.matches.length) {
      box.append(el('div', { class: 'trace-none' }, TV.empty('fingerprint', 'No matching copy found',
        user.role === 'admin' ? 'No download in the audit trail carries this trace ID or fingerprint.'
          : 'No download of a document you own matches. If you do not own the document, its owner or an administrator can trace it.')));
      return;
    }
    box.append(el('div', { class: 'trace-hit' },
      el('div', { class: 'hit-head' }, TV.icon('fingerprint'), el('div', null,
        el('strong', { text: data.matches.length === 1 ? 'Copy identified' : `${data.matches.length} matching downloads` }),
        el('span', { text: data.traceId ? `Trace ${data.traceId}` : 'Matched by file fingerprint' }))),
      el('ol', { class: 'hit-list' }, data.matches.map((m) => el('li', null,
        el('div', { class: 'avatar', text: TV.initials(m.downloadedBy) }),
        el('div', { class: 'hit-body' },
          el('div', { class: 'hit-who' }, el('strong', { text: m.downloadedBy }), ' downloaded ', el('a', { href: `/document?id=${m.documentId}`, text: `“${m.title}”` }), m.version ? ` v${m.version}` : ''),
          el('div', { class: 'subtle', text: `${TV.fmtDateTime(m.ts)} · trace ${m.traceId}${m.method ? ` · stamped as ${m.method}` : ''}${m.ip ? ` · IP ${m.ip}` : ''}` })),
        m.exactCopy ? TV.badge('Exact copy', 'danger') : TV.badge('Trace ID match', 'warning'))))));
  }

  async function trace(body) {
    TV.clear(box);
    error.textContent = '';
    box.append(TV.skeleton(3));
    try {
      render(await TV.api('POST', '/api/trace', body));
    } catch (err) {
      TV.clear(box);
      error.textContent = err.message;
    }
  }

  function traceFile(file) {
    const body = new FormData();
    body.append('file', file, file.name);
    $('#trace-id').value = '';
    trace(body);
  }

  $('#leak-file').addEventListener('change', (e) => e.target.files[0] && traceFile(e.target.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files[0]) traceFile(e.dataTransfer.files[0]);
  });
  $('#trace-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const traceId = $('#trace-id').value.trim();
    if (!traceId) { error.textContent = 'Enter a trace ID, or drop the leaked file.'; return; }
    TV.busy($('#trace-btn'), () => trace({ traceId }));
  });
  void icon;
})().catch((err) => TV.toast(err.message, 'error'));
