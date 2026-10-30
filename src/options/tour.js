/**
 * The guided tour, shown on first install (options.html#tour) and from
 * "Take the tour".
 *
 * phil walks through the settings page one bubble at a time: each step
 * switches to its tab and lights up the part it is about, so the user never
 * has to find anything. It ends by opening the practice form on the website,
 * where the next steps (pin phil, press the button, rate the fill) are
 * written on the page itself.
 *
 * The page stays usable underneath: the user can upload a CV while the
 * bubble is open. Esc or "Skip" ends it; the arrow keys move between steps.
 */

import { philSvg } from '../common/phil.js';
import { SERVICE_URL } from '../background/storage.js';

const DONE_KEY = 'tourDone';

const THUMB = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 9h3v9H2zM7 18V9l3.6-6.6c.6-1.1 2.4-.7 2.4.6V8h4.2c1.3 0 2.2 1.2 1.9 2.4l-1.5 6c-.2.9-1 1.6-1.9 1.6z"/></svg>';

/** The steps. `target` is lit up on `tab`; a step without one is a card in the middle. */
const STEPS = [
  {
    mood: 'happy',
    title: "Hi, I'm phil!",
    text: 'I fill in job applications for you, from details you give me once. Let me show you around: it takes about a minute.',
    next: "Let's go"
  },
  {
    tab: 'profile', target: '[data-block="p-cv"]',
    title: 'Start with your CV',
    text: 'Upload your CV here and I read it: your jobs, schools and skills. A PDF or Word file works.'
  },
  {
    tab: 'profile', target: '#profile-sections',
    title: 'Then check your details',
    text: 'Open each section and fill in what forms ask for: your phone, address, work history and the yes/no questions. <b>I can only put in a form what you fill in here.</b>'
  },
  {
    tab: 'profile', target: '#save-profile',
    title: 'Press Save profile',
    text: '<b>Nothing is kept until you press Save profile.</b> Save whenever you change something, so I have it next time.'
  },
  {
    tab: 'data', target: '[data-block="d-export"]',
    title: 'Keep a backup',
    text: '<b>Export to file</b> saves everything in one file. On a new computer or another browser, <b>Import from file</b> and you are set up again in seconds.'
  },
  {
    tab: 'data', target: '[data-block="d-account"]', when: () => !document.querySelector('[data-block="d-account"]')?.hidden,
    title: 'Keep your wallet',
    text: 'Add your email and your free applications and any money you add stay yours, even if you reinstall me. Optional.'
  },
  {
    tab: 'data', target: '[data-block="d-lock"]',
    title: 'Lock it, if you like',
    text: 'You can lock your details with a password. I ask for it once each time you open your browser. Optional, and if you forget it, it cannot be recovered.'
  },
  {
    mood: 'calm',
    title: 'Tell me how I did',
    text: `After each fill I ask <b>How did phil do?</b> Press the thumbs down if I got something wrong or missed a page:
      <span class="tour-thumbs" aria-hidden="true"><span class="tour-thumb">${THUMB}</span><span class="tour-thumb down">${THUMB}</span></span>
      the page goes to my team (never your answers) and I learn to fill it. That is how I get better.`
  },
  {
    mood: 'happy',
    title: 'Now try me on a practice form',
    text: 'First, <b>pin me to your toolbar</b>: click the puzzle piece at the top of your browser and the pin next to philform. Then open the practice form and press <b>phil this application</b>. Practice fills are free.',
    next: 'Open the practice form',
    final: true
  }
];

let state = null;

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function end({ done = true } = {}) {
  if (!state) return;
  state.spot.remove();
  state.shade.remove();
  state.bubble.remove();
  document.removeEventListener('keydown', state.keys);
  window.removeEventListener('resize', state.place);
  window.removeEventListener('scroll', state.place, true);
  state = null;
  if (done) chrome.storage.local.set({ [DONE_KEY]: true }).catch(() => {});
  if (location.hash === '#tour') history.replaceState(null, '', '#profile');
}

function place() {
  if (!state) return;
  const step = state.steps[state.at];
  const target = step.target && document.querySelector(step.target);
  const { spot, bubble, shade } = state;
  if (!target) {
    spot.className = 'tour-spot center';
    spot.removeAttribute('style');
    shade.style.clipPath = 'none';
    bubble.className = 'tour-bubble center';
    bubble.removeAttribute('style');
    return;
  }
  const r = target.getBoundingClientRect();
  const pad = 8;
  spot.className = 'tour-spot';
  const hole = { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: Math.min(r.height, innerHeight * 0.6) + pad * 2 };
  Object.assign(spot.style, { top: `${hole.y}px`, left: `${hole.x}px`, width: `${hole.w}px`, height: `${hole.h}px` });
  // The whole window, minus the lit part (even-odd fill leaves the inner rectangle out).
  shade.style.clipPath = `path(evenodd, 'M0 0H${innerWidth}V${innerHeight}H0Z M${hole.x} ${hole.y}h${hole.w}v${hole.h}h${-hole.w}Z')`;
  bubble.className = 'tour-bubble';
  const bw = Math.min(360, innerWidth - 32);
  const below = r.top + Math.min(r.height, innerHeight * 0.6) + pad + 14;
  const bh = bubble.offsetHeight || 220;
  const top = below + bh < innerHeight - 12 ? below : Math.max(12, r.top - pad - 14 - bh);
  const left = Math.min(Math.max(16, r.left), innerWidth - bw - 16);
  Object.assign(bubble.style, { top: `${top}px`, left: `${left}px`, width: `${bw}px` });
}

function render() {
  const step = state.steps[state.at];
  if (step.tab) state.showTab(step.tab);
  const target = step.target && document.querySelector(step.target);
  if (target) {
    // An opened block is easier to see; a <details> is opened for the tour.
    if (target.tagName === 'DETAILS') target.open = true;
    target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  const last = state.at === state.steps.length - 1;
  const dots = state.steps.map((_, i) => `<span class="tour-dot${i === state.at ? ' on' : ''}"></span>`).join('');
  state.bubble.innerHTML = `
    <div class="tour-head">
      <span class="tour-phil">${philSvg({ mood: step.mood || 'calm' })}</span>
      <p class="tour-title" id="tour-title">${step.title}</p>
    </div>
    <p class="tour-text">${step.text}</p>
    <div class="tour-foot">
      <span class="tour-dots" aria-label="Step ${state.at + 1} of ${state.steps.length}">${dots}</span>
      <span class="tour-buttons">
        ${state.at > 0 ? '<button class="tour-back" type="button">Back</button>' : '<button class="tour-skip" type="button">Skip</button>'}
        <button class="tour-next primary" type="button">${step.next || (last ? 'Done' : 'Next')}</button>
      </span>
    </div>`;
  state.bubble.querySelector('.tour-next').addEventListener('click', next);
  state.bubble.querySelector('.tour-back')?.addEventListener('click', back);
  state.bubble.querySelector('.tour-skip')?.addEventListener('click', () => end());
  // Placed once the page has scrolled to the target.
  place();
  setTimeout(place, 350);
  state.bubble.querySelector('.tour-next').focus({ preventScroll: true });
}

function next() {
  const step = state.steps[state.at];
  if (step.final) {
    chrome.tabs.create({ url: `${SERVICE_URL}/demo` }).catch(() => window.open(`${SERVICE_URL}/demo`, '_blank'));
    end();
    return;
  }
  if (state.at < state.steps.length - 1) {
    state.at++;
    render();
  } else end();
}

function back() {
  if (state.at > 0) {
    state.at--;
    render();
  }
}

export function startTour(showTab) {
  if (state) end({ done: false });
  const shade = el('div', 'tour-shade');
  const spot = el('div', 'tour-spot center');
  const bubble = el('div', 'tour-bubble center');
  bubble.setAttribute('role', 'dialog');
  bubble.setAttribute('aria-labelledby', 'tour-title');
  document.body.append(shade, spot, bubble);
  const keys = e => {
    if (e.key === 'Escape') end();
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') back();
  };
  state = { at: 0, showTab, shade, spot, bubble, keys, place, steps: STEPS.filter(s => !s.when || s.when()) };
  document.addEventListener('keydown', keys);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  render();
}

window.addEventListener('philform-tour', e => startTour(e.detail.showTab));
