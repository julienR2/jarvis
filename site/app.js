// ── Theme ──────────────────────────────────────────────────
// Dark by default — every screenshot on the page is the dark app, so a light
// landing around them reads as two different products. Toggle is remembered.
(() => {
  const saved = localStorage.getItem('jarvis-site-theme');
  document.documentElement.classList.toggle('dark', saved !== 'light');
})();

document.getElementById('theme-toggle').addEventListener('click', () => {
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('jarvis-site-theme', dark ? 'dark' : 'light');
});

// ── Sticky nav border ──────────────────────────────────────
const nav = document.querySelector('.nav');
const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
onScroll();
addEventListener('scroll', onScroll, { passive: true });

// ── Copy buttons ───────────────────────────────────────────
for (const btn of document.querySelectorAll('.copy')) {
  btn.addEventListener('click', async () => {
    const text = document.querySelector(btn.dataset.copy).innerText.trim();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // clipboard blocked (insecure origin) — leave the label alone
    }
    const label = btn.textContent;
    btn.textContent = 'Copied';
    btn.classList.add('done');
    setTimeout(() => { btn.textContent = label; btn.classList.remove('done'); }, 1600);
  });
}

// ── Flow tabs ──────────────────────────────────────────────
const tabs = [...document.querySelectorAll('[role="tab"]')];

function select(tab) {
  for (const t of tabs) {
    const panel = document.getElementById(t.getAttribute('aria-controls'));
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    panel.hidden = !on;
    // restart the walkthrough animation on the panel that just became visible
    if (on) {
      for (const el of panel.querySelectorAll('.step, .pulse')) {
        el.style.animation = 'none';
        void el.offsetWidth;
        el.style.animation = '';
      }
    }
  }
}

tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => select(tab));
  tab.addEventListener('keydown', (e) => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = tabs[(i + dir + tabs.length) % tabs.length];
    next.focus();
    select(next);
  });
});
