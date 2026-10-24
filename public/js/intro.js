'use strict';
// Opening animation: plays once per browser session, before the page appears.
// Loaded synchronously in <head> so the page never flashes before the splash.
// Skipped entirely for people who prefer reduced motion, and it always removes itself
// (a safety timer guarantees the page is shown even if something goes wrong).
(function () {
  let seen = false;
  try { seen = sessionStorage.getItem('tv-intro') === '1'; } catch { seen = true; }
  const calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (seen || calm) return;
  try { sessionStorage.setItem('tv-intro', '1'); } catch { /* private mode: show anyway */ }

  const root = document.documentElement;
  root.classList.add('intro');
  const finish = () => root.classList.remove('intro', 'intro-out');
  const safety = setTimeout(finish, 3500);

  const NS = 'http://www.w3.org/2000/svg';
  function shield() {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'intro-shield');
    for (const [d, cls] of [['M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6l8-3z', 'draw'], ['M9 12l2 2 4-4', 'draw tick']]) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('class', cls);
      p.setAttribute('pathLength', '100');
      svg.append(p);
    }
    return svg;
  }

  function build() {
    const splash = document.createElement('div');
    splash.className = 'intro-splash';
    splash.setAttribute('aria-hidden', 'true');

    const mark = document.createElement('div');
    mark.className = 'intro-mark';
    mark.append(shield());
    const ring1 = document.createElement('span'); ring1.className = 'intro-ring r1';
    const ring2 = document.createElement('span'); ring2.className = 'intro-ring r2';
    mark.append(ring1, ring2);

    const word = document.createElement('div');
    word.className = 'intro-word';
    [...'TrustVault'].forEach((ch, i) => {
      const s = document.createElement('span');
      s.textContent = ch;
      s.style.setProperty('--i', String(i));
      word.append(s);
    });

    const tag = document.createElement('div');
    tag.className = 'intro-tag';
    tag.textContent = 'Secure document sharing · every access verified';

    const bar = document.createElement('div');
    bar.className = 'intro-bar';
    bar.append(document.createElement('i'));

    const scan = document.createElement('div');
    scan.className = 'intro-scan';

    splash.append(scan, mark, word, tag, bar);
    document.body.append(splash);

    setTimeout(() => root.classList.add('intro-out'), 1900);
    setTimeout(() => { splash.remove(); clearTimeout(safety); finish(); }, 2600);
  }

  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build, { once: true });
})();
