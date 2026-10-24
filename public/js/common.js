'use strict';
// Shared frontend helpers. Every piece of server data is inserted with textContent (via el()),
// never innerHTML, so a document title like <img onerror=...> renders as text.
(function () {
  const TV = (window.TV = {});
  let csrfToken = null;

  // ---- DOM ------------------------------------------------------------------------------
  TV.el = function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    TV.append(node, children);
    // Each person's avatar gets a stable colour from their initials.
    if (node.classList.contains('avatar') && node.textContent) {
      let h = 0;
      for (const ch of node.textContent) h = (h * 31 + ch.charCodeAt(0)) % 997;
      node.dataset.tone = String(h % 6);
    }
    return node;
  };
  TV.append = function append(node, children) {
    for (const c of [children].flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  };
  TV.clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };
  TV.$ = (sel, root = document) => root.querySelector(sel);

  const SVG_NS = 'http://www.w3.org/2000/svg';
  TV.icon = function icon(name, cls = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `icon ${cls}`.trim());
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `/img/icons.svg#${name}`);
    svg.append(use);
    return svg;
  };

  // ---- API ------------------------------------------------------------------------------
  TV.api = async function api(method, url, body, { quiet401 = false } = {}) {
    const opts = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
    if (method !== 'GET' && csrfToken) opts.headers['X-CSRF-Token'] = csrfToken;
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json().catch(() => null) : null;
    if (res.status === 401 && !quiet401) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      throw new Error('Signed out');
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  };
  TV.setCsrf = (t) => { csrfToken = t; };

  // Downloads through fetch so a refusal shows a readable message instead of a JSON page.
  TV.download = async function download(docId, version) {
    const url = `/api/documents/${encodeURIComponent(docId)}/download${version ? `?version=${version}` : ''}`;
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { location.href = '/login'; return; }
      TV.toast(data.error || 'Download failed', 'error');
      return;
    }
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') || '';
    const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
    const name = m ? decodeURIComponent(m[1]) : 'document';
    const a = TV.el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    TV.toast(`Downloaded ${name}. This download was recorded in the audit trail.`, 'success');
  };

  // ---- Formatting -----------------------------------------------------------------------
  const dtf = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const dttf = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  TV.fmtDate = (ms) => (ms ? dtf.format(new Date(ms)) : '—');
  TV.fmtDateTime = (ms) => (ms ? dttf.format(new Date(ms)) : '—');
  TV.fmtBytes = (n) => {
    if (n === null || n === undefined) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };
  TV.relTime = (ms) => {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
    return TV.fmtDate(ms);
  };
  TV.initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  TV.qs = (name) => new URLSearchParams(location.search).get(name);
  TV.badge = (text, variant = '') => TV.el('span', { class: `badge ${variant}`, text });
  TV.accessBadge = (level) => TV.badge(level === 'owner' ? 'Owner' : level === 'edit' ? 'Can edit' : 'Can view', level);
  TV.roleBadge = (role) => TV.badge(role[0].toUpperCase() + role.slice(1), role);
  TV.outcomeBadge = (o) => TV.badge(o === 'success' ? 'Allowed' : o === 'denied' ? 'Refused' : 'Failed', o);
  TV.fileBadge = (ext) => TV.el('span', { class: `file-badge ${ext || ''}`, text: (ext || 'file').slice(0, 4) });

  const ACTIONS = {
    'auth.login': 'Signed in', 'auth.logout': 'Signed out', 'auth.password_change': 'Changed password',
    'auth.session_revoke': 'Ended a session', 'document.upload': 'Uploaded', 'document.version_upload': 'Uploaded a new version',
    'document.view': 'Opened', 'document.download': 'Downloaded', 'document.update': 'Edited details',
    'document.edit': 'Edited details', 'document.delete': 'Moved to trash', 'document.restore': 'Restored', 'document.purge': 'Permanently deleted',
    'document.share': 'Managed access', 'document.view_activity': 'Viewed activity', 'document.upload_rejected': 'Upload rejected',
    'permission.grant': 'Granted access', 'permission.update': 'Changed access', 'permission.revoke': 'Revoked access',
    'suggestion.generated': 'Sharing suggestions generated', 'suggestion.accepted': 'Accepted a sharing suggestion',
    'suggestion.dismissed': 'Dismissed a sharing suggestion', 'access.role_denied': 'Tried a feature outside their role',
    'security.csrf_rejected': 'Request without CSRF token', 'security.cross_origin_rejected': 'Cross-origin request',
    'user.create': 'Created a user', 'user.update': 'Updated a user', 'user.password_reset': 'Reset a password',
    'user.sessions_revoked': 'Signed a user out everywhere', 'audit.verify': 'Verified the audit trail',
    'audit.export': 'Exported the audit trail', 'system.seed': 'Demo data created',
    'document.restore_denied': 'Restore refused',
  };
  TV.describe = (entry) => {
    const verb = ACTIONS[entry.action] || entry.action;
    if (entry.outcome === 'denied' && entry.action.startsWith('document.')) return `Refused: ${verb.toLowerCase()}`;
    return verb;
  };
  TV.detailText = (entry) => {
    const d = entry.details || {};
    const parts = [];
    if (d.title) parts.push(`“${d.title}”`);
    if (d.grantee) parts.push(`→ ${d.grantee}`);
    if (d.level && entry.action.startsWith('permission')) parts.push(`(${d.level})`);
    if (d.previousLevel) parts.push(`was ${d.previousLevel}`);
    if (d.version) parts.push(`v${d.version}`);
    if (d.username && entry.action === 'auth.login') parts.push(`as “${d.username}”`);
    if (d.reason && entry.outcome !== 'success') parts.push(`reason: ${String(d.reason).replace(/_/g, ' ')}`);
    if (d.via === 'suggestion') parts.push('via suggestion');
    if (d.byAdministrator) parts.push('by administrator');
    return parts.join(' ');
  };

  // ---- Feedback -------------------------------------------------------------------------
  TV.toast = function toast(message, kind = '') {
    let box = TV.$('.toasts');
    if (!box) { box = TV.el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
    const t = TV.el('div', { class: `toast ${kind}` }, TV.icon(kind === 'error' ? 'alert' : 'check', 'sm'), message);
    box.append(t);
    setTimeout(() => t.remove(), 5000);
  };

  TV.confirm = function confirm({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const dlg = TV.el('dialog', null,
        TV.el('div', { class: 'dlg-body' }, TV.el('h2', { text: title }), TV.el('p', { text: message })),
        TV.el('div', { class: 'dlg-foot' },
          TV.el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => dlg.close('cancel') }),
          TV.el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', text: confirmLabel, onclick: () => dlg.close('ok') })));
      dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
      document.body.append(dlg);
      dlg.showModal();
    });
  };

  TV.empty = (icon, title, text) => TV.el('div', { class: 'empty' }, TV.icon(icon), TV.el('h3', { text: title }), TV.el('p', { text }));

  TV.pager = function pager({ page, pageSize, total }, onPage) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    return TV.el('div', { class: 'pager' },
      TV.el('span', { text: total ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}` : 'No results' }),
      TV.el('div', { class: 'actions' },
        TV.el('button', { class: 'btn sm', text: 'Previous', disabled: page <= 1, onclick: () => onPage(page - 1) }),
        TV.el('button', { class: 'btn sm', text: 'Next', disabled: page >= pages, onclick: () => onPage(page + 1) })));
  };

  // Wraps an async handler for a form/button: disables it while running and shows errors.
  TV.busy = async function busy(button, fn, errorTarget) {
    if (button) { button.disabled = true; button.classList.add('is-busy'); }
    if (errorTarget) errorTarget.textContent = '';
    try {
      return await fn();
    } catch (err) {
      if (errorTarget) errorTarget.textContent = err.message;
      else TV.toast(err.message, 'error');
      return undefined;
    } finally {
      if (button) { button.disabled = false; button.classList.remove('is-busy'); }
    }
  };

  // ---- Shell ----------------------------------------------------------------------------
  // Top navigation bar: brand, the main sections for this role, an Upload button for owners,
  // and an account menu. The nav only hides links; every page's API still checks the role.
  const NAV = [
    { href: '/dashboard', label: 'Dashboard', icon: 'grid', roles: ['owner', 'viewer'] },
    { href: '/documents', label: 'My documents', icon: 'folder', roles: ['owner'] },
    { href: '/shared', label: 'Shared with me', icon: 'users', roles: ['owner', 'viewer'] },
    { href: '/search', label: 'Search', icon: 'search', roles: ['owner', 'viewer'] },
    { href: '/activity', label: 'Activity', icon: 'activity', roles: ['owner'] },
    { href: '/trash', label: 'Trash', icon: 'trash', roles: ['owner'] },
    { href: '/admin', label: 'Overview', icon: 'grid', roles: ['admin'] },
    { href: '/admin-audit', label: 'Audit log', icon: 'list', roles: ['admin'] },
    { href: '/admin-permissions', label: 'Permissions', icon: 'key', roles: ['admin'] },
    { href: '/admin-documents', label: 'Documents', icon: 'file', roles: ['admin'] },
    { href: '/admin-users', label: 'Users', icon: 'users', roles: ['admin'] },
  ];

  function renderShell(user, active) {
    const { el, icon } = TV;
    const bar = TV.clear(TV.$('#topbar'));
    const avatar = () => el('span', { class: 'avatar', text: TV.initials(user.displayName) });

    const menu = el('details', { class: 'usermenu' },
      el('summary', { 'aria-label': 'Account menu' }, avatar(),
        el('span', { class: 'who' }, el('strong', { text: user.displayName }), el('span', { text: user.role })),
        icon('chevron', 'sm')),
      el('div', { class: 'usermenu-panel' },
        el('div', { class: 'usermenu-head' }, avatar(),
          el('div', null, el('strong', { text: user.displayName }), el('span', { text: `@${user.username}` }), TV.roleBadge(user.role))),
        el('a', { href: '/account' }, icon('user', 'sm'), 'Account & sessions'),
        el('a', { href: '/security' }, icon('info', 'sm'), 'Security model'),
        el('button', { type: 'button', class: 'signout', onclick: signOut }, icon('logout', 'sm'), 'Sign out')));
    document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.open = false; });

    TV.append(bar, [el('div', { class: 'appbar-inner' },
      el('a', { class: 'brand', href: user.role === 'admin' ? '/admin' : '/dashboard' },
        el('span', { class: 'brand-mark' }, icon('shield')), 'TrustVault'),
      el('nav', { class: 'appnav', 'aria-label': 'Main' },
        NAV.filter((i) => i.roles.includes(user.role)).map((i) => el('a', {
          class: `appnav-link${i.href === active ? ' active' : ''}`, href: i.href, 'aria-current': i.href === active ? 'page' : null,
        }, icon(i.icon, 'sm'), i.label))),
      el('div', { class: 'appbar-right' },
        user.role === 'owner' ? el('a', { class: `btn primary sm${active === '/upload' ? ' active' : ''}`, href: '/upload' }, icon('plus', 'sm'), 'Upload') : null,
        menu))]);

    const content = TV.$('#content');
    if (content && !TV.$('.appfoot')) {
      content.after(el('footer', { class: 'appfoot' },
        el('span', null, icon('shield', 'sm'), 'Every access is checked on the server and recorded in a tamper-evident audit trail.'),
        el('span', { text: 'TrustVault' })));
    }
  }

  // Stat tile used by the dashboards. tone: blue (default), violet, green, amber, red, teal.
  TV.stat = function stat({ label, value, icon: iconName, hint, href, tone = '', alert = false }) {
    const valueEl = TV.el('div', { class: 'value', text: value });
    if (/^\d+$/.test(String(value))) TV.countUp(valueEl, Number(value));
    return TV.el(href ? 'a' : 'div', { class: `stat tone-${tone || 'blue'}${alert ? ' alert' : ''}`, href },
      TV.el('div', { class: 'stat-top' },
        TV.el('span', { class: `stat-icon${tone ? ` tone-${tone}` : ''}` }, TV.icon(iconName)),
        href ? TV.icon('arrow', 'sm stat-arrow') : null),
      valueEl,
      TV.el('div', { class: 'label', text: label }),
      hint ? TV.el('div', { class: 'hint', text: hint }) : null);
  };

  // ---- Motion helpers (all skipped when the user prefers reduced motion) -----------------
  const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Counts a number up from 0. The final text is always the exact value.
  TV.countUp = function countUp(node, target, ms = 900) {
    if (calm() || target === 0) { node.textContent = String(target); return; }
    const start = performance.now() + 150;
    node.textContent = '0';
    const tick = (now) => {
      const t = Math.min(1, Math.max(0, (now - start) / ms));
      node.textContent = String(Math.round(target * (1 - (1 - t) ** 3)));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  // Shimmering placeholder rows while a table loads.
  TV.skeleton = (rows = 5) => TV.el('div', { class: 'skeleton', 'aria-label': 'Loading' }, Array.from({ length: rows }, () => TV.el('span')));

  // A soft glow that follows the mouse over panels. Values are set through the CSSOM, which
  // the Content-Security-Policy allows (no inline style attributes are written).
  document.addEventListener('pointermove', (e) => {
    const panel = e.target.closest && e.target.closest('.card, .stat, .feature, .step');
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    panel.style.setProperty('--mx', `${e.clientX - r.left}px`);
    panel.style.setProperty('--my', `${e.clientY - r.top}px`);
  }, { passive: true });


  // Click ripple on every button, starting where the pointer touched it.
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest && e.target.closest('.btn');
    if (!btn || btn.disabled || calm()) return;
    const r = btn.getBoundingClientRect();
    const dot = TV.el('span', { class: 'ripple', 'aria-hidden': 'true' });
    dot.style.left = `${e.clientX - r.left}px`;
    dot.style.top = `${e.clientY - r.top}px`;
    btn.append(dot);
    setTimeout(() => dot.remove(), 650);
  });

  // Large glow that trails the cursor on the public pages.
  TV.cursorGlow = function cursorGlow() {
    if (calm() || !window.matchMedia('(pointer: fine)').matches) return;
    const glow = TV.el('div', { class: 'cursor-glow', 'aria-hidden': 'true' });
    document.body.prepend(glow);
    document.addEventListener('pointermove', (e) => {
      glow.classList.add('on');
      glow.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    }, { passive: true });
    document.addEventListener('pointerleave', () => glow.classList.remove('on'));
  };

  async function signOut() {
    try { await TV.api('POST', '/api/auth/logout'); } catch { /* already signed out */ }
    location.href = '/login';
  }

  // Loads the signed-in user, draws the shell, and checks the page's role list.
  // The role check here is only for a friendly message; the API enforces it regardless.
  TV.boot = async function boot({ active, roles } = {}) {
    const me = await TV.api('GET', '/api/auth/me');
    csrfToken = me.csrfToken;
    TV.user = me.user;
    renderShell(me.user, active);
    if (roles && !roles.includes(me.user.role)) {
      const content = TV.$('#content');
      TV.clear(content).append(TV.el('div', { class: 'card' }, TV.empty('lock', 'Not available for your role',
        `This page is for ${roles.join(' or ')} accounts. You are signed in as ${me.user.role}.`)));
      document.body.classList.add('ready');
      return null;
    }
    document.body.classList.add('ready');
    return me.user;
  };
})();
