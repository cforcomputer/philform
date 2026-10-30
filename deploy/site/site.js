// philform's website: Phil, the demo that fills a form, the savings sliders,
// and the early-access form. No tracking, no cookies.
import { drawPhils } from '/phil.js';

/**
 * On launch day, put the store links here: the buttons become "Add to
 * Chrome" / "Add to Firefox" and the early-access form goes away.
 */
const STORES = {
  chrome: '',   // e.g. https://chromewebstore.google.com/detail/philform/<id>
  firefox: ''   // e.g. https://addons.mozilla.org/firefox/addon/philform/
};

const $ = id => document.getElementById(id);
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
document.documentElement.classList.add('js');
drawPhils();

// --- calls to action ------------------------------------------------------------

const isFirefox = /firefox/i.test(navigator.userAgent);
const browser = isFirefox ? 'firefox' : 'chrome';
const storeUrl = STORES[browser] || STORES.chrome || STORES.firefox;
if (storeUrl) {
  $('waitlist').hidden = true;
  $('install').hidden = false;
  for (const [name, url] of Object.entries(STORES)) {
    const btn = $(`get-${name}`);
    if (url) btn.href = url; else btn.hidden = true;
  }
  for (const a of document.querySelectorAll('.cta-link')) {
    a.href = storeUrl;
    const label = a.querySelector('.cta-label');
    if (label) label.textContent = `Add to ${isFirefox ? 'Firefox' : 'Chrome'}, it's free`;
  }
}

// The Firefox preview: the newest signed build listed in updates.json, which
// tools/publish-firefox.py keeps up to date (the link in the page is a fallback).
fetch('/firefox/updates.json', { cache: 'no-cache' }).then(r => r.json()).then(data => {
  const newer = (a, b) => {
    const [x, y] = [a, b].map(v => v.split('.').map(Number));
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  };
  const latest = (Object.values(data.addons)[0]?.updates || []).reduce((a, b) => (!a || newer(b.version, a.version) ? b : a), null);
  if (!latest) return;
  $('get-firefox-preview').href = new URL(latest.update_link).pathname;
  $('firefox-version').textContent = latest.version;
}).catch(() => {});

// --- the nav gets a line once the page moves ------------------------------------

const nav = $('nav');
const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// --- sections rise into view --------------------------------------------------------

const io = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('seen'); io.unobserve(e.target); }
}, { rootMargin: '0px 0px -8% 0px' });
for (const el of document.querySelectorAll('.reveal')) io.observe(el);

// --- the demo: Phil fills the form, then celebrates ---------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));
const popup = $('demo-popup');
const fields = [...document.querySelectorAll('[data-fill]')];
const button = popup.querySelector('.popup-fill');
const bar = $('demo-bar');
const runner = popup.querySelector('.runner');

/**
 * Each box starts as tall as its finished answer, so the form never grows
 * while it types (which moved the headline beside it, centred on it).
 */
function holdHeights() {
  for (const f of fields) {
    const typed = f.textContent;
    f.style.minHeight = '';
    f.textContent = f.dataset.fill;
    f.style.minHeight = `${f.offsetHeight}px`;
    f.textContent = typed;
  }
}
holdHeights();
document.fonts?.ready.then(holdHeights);   // the web font can wrap the answer differently
addEventListener('resize', holdHeights);

function reset() {
  for (const f of fields) { f.textContent = ''; f.classList.remove('filled', 'typing'); }
  popup.dataset.stage = 'ready';
  bar.style.width = '0';
  runner.style.left = '0';
}

function progress(share) {
  bar.style.width = `${share * 100}%`;
  runner.style.left = `calc(${share * 100}% - ${share * 26}px)`;
}

async function type(el, text, perChar) {
  el.classList.add('typing');
  for (let i = 1; i <= text.length; i++) {
    el.textContent = text.slice(0, i);
    await sleep(perChar);
  }
  el.classList.remove('typing');
}

async function play() {
  reset();
  await sleep(900);
  button.classList.add('pressed');
  await sleep(160);
  button.classList.remove('pressed');
  popup.dataset.stage = 'filling';
  // The short fields go in at once, a beat apart; the written answer is typed.
  const short = fields.slice(0, -1);
  for (const [i, f] of short.entries()) {
    f.textContent = f.dataset.fill;
    f.classList.add('filled');
    progress((i + 1) / (fields.length + 1));
    await sleep(170);
  }
  const long = fields.at(-1);
  await type(long, long.dataset.fill, 16);
  long.classList.add('filled');
  progress(1);
  await sleep(450);
  popup.dataset.stage = 'done';
  await sleep(3800);
}

function still() {
  for (const f of fields) { f.textContent = f.dataset.fill; f.classList.add('filled'); }
  popup.dataset.stage = 'done';
}

if (calm) {
  still();
} else {
  // Plays only while on screen, so it is not burning a laptop's battery below the fold.
  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(popup.parentElement);
  (async () => {
    for (;;) {
      if (visible) await play(); else await sleep(500);
    }
  })();
}

// --- what it saves -------------------------------------------------------------------

const CENTS_PER_FILL = 1.25;     // about 400 applications per $5
const WEEKS_PER_MONTH = 4.33;

function money(dollars) {
  return dollars >= 100 ? `$${Math.round(dollars).toLocaleString('en-US')}` : `$${dollars.toFixed(2)}`;
}

function recalc() {
  const apps = +$('apps').value, mins = +$('mins').value, wage = +$('wage').value;
  $('c-apps').textContent = apps;
  $('c-min').textContent = mins;
  $('c-wage').textContent = `$${wage}`;
  const monthly = apps * WEEKS_PER_MONTH;
  const hours = monthly * mins / 60;
  $('c-hours').textContent = `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hours`;
  $('c-worth').textContent = money(hours * wage);
  $('c-cost').textContent = money(monthly * CENTS_PER_FILL / 100);
}
for (const id of ['apps', 'mins', 'wage']) $(id).addEventListener('input', recalc);
recalc();

// --- early access ---------------------------------------------------------------------

const form = $('waitlist');
const note = $('waitlist-note');
form.addEventListener('submit', async e => {
  e.preventDefault();
  const email = form.email.value.trim();
  note.className = 'form-note';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    note.textContent = 'That email address does not look right.';
    note.classList.add('err');
    form.email.focus();
    return;
  }
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    const res = await fetch('/v1/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, website: form.website.value, browser })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    form.querySelector('.waitlist-row').hidden = true;
    note.textContent = "You're on the list. phil will be in touch.";
    note.classList.add('ok');
  } catch (err) {
    note.textContent = err.message || 'Could not reach philform. Please try again.';
    note.classList.add('err');
    btn.disabled = false;
  }
});
