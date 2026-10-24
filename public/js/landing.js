'use strict';
// Landing page: point the call-to-action at the app when signed in, and add the motion
// effects (scroll reveal, panel spotlight, cursor glow). Everything degrades to a static page.
(function () {
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

  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (calm || !('IntersectionObserver' in window)) return;

  // Reveal sections and cards as they scroll into view, staggered within each group.
  const groups = [
    ['.strip .item'],
    ['.section-head'],
    ['#features .feature'],
    ['.usecase'],
    ['.pipe-step'],
    ['.standard'],
    ['.forensics-points li'],
    ['.copies .copy, .copies .copy-match'],
    ['.cta'],
  ];
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) { entry.target.classList.add('in'); io.unobserve(entry.target); }
    }
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  for (const [selector] of groups) {
    document.querySelectorAll(selector).forEach((node, i) => {
      node.classList.add('reveal');
      node.style.setProperty('--d', `${(i % 6) * 0.08}s`);
      io.observe(node);
    });
  }

  // Click ripple on buttons.
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest && e.target.closest('.btn');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const dot = document.createElement('span');
    dot.className = 'ripple';
    dot.style.left = (e.clientX - r.left) + 'px';
    dot.style.top = (e.clientY - r.top) + 'px';
    btn.append(dot);
    setTimeout(() => dot.remove(), 650);
  });

  // Spotlight that follows the mouse over cards.
  document.addEventListener('pointermove', (e) => {
    const panel = e.target.closest && e.target.closest('.feature, .step, .usecase, .pipe-step, .standard');
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    panel.style.setProperty('--mx', `${e.clientX - r.left}px`);
    panel.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, { passive: true });

  // Large soft glow trailing the cursor.
  if (window.matchMedia('(pointer: fine)').matches) {
    const glow = document.createElement('div');
    glow.className = 'cursor-glow';
    glow.setAttribute('aria-hidden', 'true');
    document.body.prepend(glow);
    document.addEventListener('pointermove', (e) => {
      glow.classList.add('on');
      glow.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    }, { passive: true });
  }
})();
