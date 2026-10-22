'use strict';
// If already signed in, point the call-to-action buttons at the app instead of the sign-in page.
fetch('/api/auth/me', { credentials: 'same-origin' })
  .then((res) => (res.ok ? res.json() : null))
  .then((me) => {
    if (!me) return;
    const target = me.user.role === 'admin' ? '/admin' : '/dashboard';
    for (const id of ['cta-nav', 'cta-main']) {
      const a = document.getElementById(id);
      a.href = target;
      a.textContent = 'Open TrustVault';
    }
  })
  .catch(() => {});
