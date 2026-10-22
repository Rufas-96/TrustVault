'use strict';
(async function () {
  const { el, $ } = TV;
  const user = await TV.boot({ active: '/upload', roles: ['owner'] });
  if (!user) return;

  const ALLOWED = ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'txt', 'csv'];
  const MAX = 10 * 1024 * 1024;
  const form = $('#upload-form');
  const input = $('#file');
  const zone = $('#dropzone');
  const error = $('#upload-error');
  let chosen = null;

  const { categories } = await TV.api('GET', '/api/meta/categories');
  for (const c of categories) form.elements.category.append(el('option', { value: c, text: c, selected: c === 'General' }));

  // Client-side checks are only for quick feedback. The server re-checks everything.
  function choose(file) {
    error.textContent = '';
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!ALLOWED.includes(ext) || !file.name.includes('.')) { error.textContent = `.${ext} files are not allowed.`; return; }
    if (file.size === 0) { error.textContent = 'That file is empty.'; return; }
    if (file.size > MAX) { error.textContent = 'That file is larger than 10 MB.'; return; }
    chosen = file;
    if (!form.elements.title.value) form.elements.title.value = file.name.replace(/\.[^.]+$/, '');
    TV.clear($('#chosen')).append(el('div', { class: 'file-chosen' }, TV.fileBadge(ext),
      el('div', null, el('strong', { text: file.name }), el('div', { class: 'subtle', text: TV.fmtBytes(file.size) }))));
  }

  input.addEventListener('change', () => input.files[0] && choose(input.files[0]));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    if (e.dataTransfer.files[0]) choose(e.dataTransfer.files[0]);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!chosen) { error.textContent = 'Choose a file to upload.'; return; }
    const body = new FormData();
    body.append('title', form.elements.title.value.trim());
    body.append('category', form.elements.category.value);
    body.append('description', form.elements.description.value.trim());
    body.append('file', chosen, chosen.name);
    TV.busy($('#upload-btn'), async () => {
      const res = await TV.api('POST', '/api/documents', body);
      location.href = `/document?id=${res.id}&uploaded=1`;
    }, error);
  });
})().catch((err) => TV.toast(err.message, 'error'));
