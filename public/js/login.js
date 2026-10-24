'use strict';
(function () {
  const { $, api } = TV;
  const form = $('#login-form');
  const error = $('#login-error');
  TV.cursorGlow();

  // Only same-site paths are accepted as a redirect target (no //evil.example, no https://...).
  function safeNext() {
    const next = TV.qs('next');
    return next && /^\/(?!\/)[\w\-./?=&%]*$/.test(next) ? next : null;
  }

  api('GET', '/api/auth/me', undefined, { quiet401: true })
    .then((me) => { location.replace(safeNext() || (me.user.role === 'admin' ? '/admin' : '/dashboard')); })
    .catch(() => { /* not signed in: stay here */ });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = form.username.value.trim();
    const password = form.password.value;
    if (!username || !password) { error.textContent = 'Enter your username and password.'; return; }
    TV.busy($('#login-btn'), async () => {
      const res = await api('POST', '/api/auth/login', { username, password }, { quiet401: true });
      location.replace(safeNext() || (res.user.role === 'admin' ? '/admin' : '/dashboard'));
    }, error).then(() => { form.password.value = ''; });
  });
})();
