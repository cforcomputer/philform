import { MSG, STAGE, STAGE_LABEL } from '../common/messages.js';
import { sitePattern, sameQuestions } from '../common/util.js';
import { devConfig } from '../background/dev.js';
import { drawPhils } from '../common/phil.js';
import { SUPPORT_EMAIL } from '../background/storage.js';

const $ = id => document.getElementById(id);

const STAGE_ORDER = [
  STAGE.INJECTING, STAGE.EXTRACTING, STAGE.ANALYZING, STAGE.MATCHING_SKILL,
  STAGE.CLASSIFYING, STAGE.MATCHING_RESPONSES, STAGE.WRITING, STAGE.FILLING, STAGE.DONE
];

let currentTab = null;

/** A cold background is a connection failure, not an application error. */
const NOT_RUNNING = /receiving end does not exist|could not establish connection|message port closed/i;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Every background call goes through here so errors surface in one place.
 *
 * The popup genuinely needs the background, because filling a form needs
 * scripting access to the active tab. Firefox unloads a Manifest V3 event page
 * after a few seconds idle and starts it again on demand, and a message that
 * arrives while it is still starting is rejected outright rather than queued.
 * Retrying briefly covers that window; a real error is raised on the first
 * attempt and is not retried.
 */
async function send(type, payload, { attempts = 3 } = {}) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({ type, payload });
      if (!res?.ok) throw new Error(res?.error || 'philform background script did not respond.');
      return res.data;
    } catch (err) {
      lastError = err;
      if (!NOT_RUNNING.test(err?.message || '')) throw err;
      await wait(150 * (attempt + 1));
    }
  }

  throw new Error(
    'philform could not reach its background script. Reload the extension and try again.' +
    (lastError?.message ? ` (${lastError.message})` : '')
  );
}

function show(el, visible = true) {
  el.hidden = !visible;
}

// --- progress and the reward -------------------------------------------------

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Which of the three steps (Read, Match, Fill) a stage belongs to. */
const STEP_OF = {
  [STAGE.INJECTING]: 0, [STAGE.EXTRACTING]: 0, [STAGE.ANALYZING]: 0,
  [STAGE.MATCHING_SKILL]: 1, [STAGE.CLASSIFYING]: 1, [STAGE.MATCHING_RESPONSES]: 1,
  [STAGE.WRITING]: 2, [STAGE.FILLING]: 2, [STAGE.DONE]: 3
};

let shownPct = 0;

function setProgress(stage, detail = {}) {
  show($('progress'));
  $('progress-stage').textContent = STAGE_LABEL[stage] || 'Working...';
  const index = STAGE_ORDER.indexOf(stage);
  // Never backwards: stages can arrive out of order while drafts are written.
  const pct = Math.max(shownPct, index < 0 ? 10 : Math.round(((index + 1) / STAGE_ORDER.length) * 100));
  shownPct = pct;
  $('progress-bar').style.width = `${pct}%`;
  // Phil runs along at the front of the bar, never past either end.
  $('progress-runner').style.left = `clamp(15px, ${pct}%, calc(100% - 15px))`;
  const step = STEP_OF[stage] ?? 0;
  for (const li of $('progress-steps').children) {
    const n = Number(li.dataset.step);
    li.classList.toggle('done', n < step);
    li.classList.toggle('now', n === step);
  }
  if (stage === STAGE.ANALYZING && detail.fieldCount) $('progress-count').textContent = `${detail.fieldCount} questions found`;
  if (stage === STAGE.FILLING && detail.count) countUp($('progress-count'), 0, detail.count, 900, n => `${n} of ${detail.count} answers in`);
}

/** "45 sec", "12 min", "1 h 05 min". */
function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} sec`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

const money = (seconds, wage) => `$${((seconds / 3600) * (Number(wage) || 0)).toFixed(2)}`;

/** Count a number up on screen, easing out, then settle on the exact value. */
function countUp(el, from, to, ms, format) {
  if (calm() || to <= from) { el.textContent = format(to); return Promise.resolve(); }
  // A timer rather than animation frames: frames stop when the window is not
  // painted, and the final number must always arrive.
  return new Promise(resolve => {
    const start = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = format(Math.round(from + (to - from) * eased));
      if (t < 1) setTimeout(tick, 16); else resolve();
    };
    tick();
  });
}

const CONFETTI = ['var(--win)', 'var(--sun)', 'var(--sky)', 'var(--win-dark)', '#ffe27a'];

function confetti({ goal = false } = {}) {
  const burst = $('reward-burst');
  burst.replaceChildren();
  if (calm()) return;
  // Twice as much, thrown further, for the daily goal.
  const count = goal ? 56 : 28;
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('i');
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4;
    const dist = (goal ? 80 : 60) + Math.random() * (goal ? 100 : 70);
    piece.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    // Thrown up and out, then falling a little.
    piece.style.setProperty('--dy', `${Math.sin(angle) * dist * 0.7 + 30}px`);
    piece.style.setProperty('--rot', `${Math.round((Math.random() - 0.5) * 720)}deg`);
    piece.style.setProperty('--c', CONFETTI[i % CONFETTI.length]);
    piece.style.animationDelay = `${120 + Math.random() * 120}ms`;
    // Some round, some petals.
    if (i % 3) piece.className = i % 3 === 1 ? 'round' : 'petal';
    burst.append(piece);
  }
}

let wage = 16;
// The wallet, when there is one (null with your own keys): balance and free applications left.
let wallet = null;
let allTime = { seconds: 0, fills: 0, today: 0 };
let lastSaved = 0;

/** How many applications a day the reward cheers towards, Duolingo-style. */
const DAILY_GOAL = 5;

/** All-time spending, in the unit this user pays: the price through the service, the model cost on their own keys. */
const allSpent = total => Number(wallet ? total.spentWalletCents : total.spentCents) || 0;

/** "You've spent $0.31 and saved $42.00 of your time (2 h 38 min)." */
function showAllTime(total, { bump = false } = {}) {
  show($('alltime'), total.seconds > 0);
  $('alltime-time').textContent = duration(total.seconds);
  $('alltime-money').textContent = money(total.seconds, wage);
  const spent = allSpent(total);
  show($('alltime-spent-part'), spent > 0);
  show($('alltime-saved-part'), !(spent > 0));
  $('alltime-spent').textContent = usd(spent);
  showStreak(total);
  if (bump && !calm()) {
    $('alltime').classList.remove('bump');
    void $('alltime').offsetWidth; // restart the animation
    $('alltime').classList.add('bump');
  }
}

const ordinal = n => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
};

/** A line of encouragement: applications today, or a page of one already started. */
function streak(summary) {
  // Only a milestone earns a line: the flame in the header already counts the
  // days, and "Keep going!" after every fill is noise.
  if (!summary.charged) return '';
  const { today = 0, fills = 0, pages = 0 } = summary.allTime || allTime;
  if (pages > 1) return '';
  if (today === DAILY_GOAL) return `Daily goal reached: ${DAILY_GOAL} applications today!`;
  if (fills === 1) return 'Your first application with phil!';
  if (MILESTONES.includes(fills)) return `${fills.toLocaleString('en-US')} applications with phil!`;
  return '';
}

const MILESTONES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

/** The flame in the header: days in a row with an application, when there is a streak. */
function showStreak(total, { grew = false } = {}) {
  const days = total.streakDays || 0;
  show($('streak-chip'), days > 0);
  $('streak-days').textContent = String(days);
  // Lit once today counts; grey while today still needs an application to keep it.
  $('streak-chip').classList.toggle('cold', !total.streakToday);
  if (grew && !calm()) {
    $('streak-chip').classList.remove('lit');
    void $('streak-chip').offsetWidth;
    $('streak-chip').classList.add('lit');
  }
}

/** The milestone line under the reward, shown only when there is one. */
function showGoal(summary) {
  const line = streak(summary);
  $('reward-streak').textContent = line;
  show($('reward-goal'), !!line);
}

/** "1,200× what it cost": the return on a fill, when it cost anything. */
function returnOn(savedSeconds, spent) {
  const worth = (savedSeconds / 3600) * (Number(wage) || 0) * 100;
  if (!(spent > 0) || !(worth > spent)) return '';
  const times = worth / spent;
  return `${times >= 10 ? Math.round(times).toLocaleString('en-US') : times.toFixed(1)}× what it cost`;
}

/**
 * The reward: Phil jumping, the confetti, time saved counting up, then the total.
 * A fill shown again in a reopened popup is shown as it ended, without the show.
 */
async function showReward(summary, { restored = false } = {}) {
  const saved = summary.timeSavedSeconds || 0;
  show($('reward'), saved > 0);
  if (!saved) return;
  lastSaved = saved;
  $('wage-edit').textContent = `$${formatWage(wage)}/hr`;
  // What the fill cost set against what it saved, in the same currency.
  const charge = summary.wallet || null;
  const spent = spentCents(summary.cost, charge);
  show($('reward-spent-line'), spent !== null);
  if (spent !== null) $('reward-spent').textContent = charge?.free ? 'Free' : usd(spent);
  $('reward-return').textContent = charge?.free
    ? (charge.unlimited ? 'on the house' : charge.freeLeft ? `${charge.freeLeft} free left` : 'your last free one')
    : returnOn(saved, spent);
  const total = summary.allTime || allTime;
  showGoal(summary);
  if (restored) {
    $('reward-time').textContent = duration(saved);
    $('reward-money').textContent = money(saved, wage);
    return;
  }
  const previous = allTime.seconds;
  const grew = (total.streakDays || 0) > (allTime.streakDays || 0);
  allTime = total;
  $('reward-money').textContent = money(0, wage);
  // Restart Phil's jump for a second fill in the same popup.
  const medal = $('reward').querySelector('.medal');
  medal.style.animation = 'none';
  void medal.offsetWidth;
  medal.style.animation = '';
  confetti({ goal: summary.charged && total.today === DAILY_GOAL });
  // The time and its worth count up together.
  await Promise.all([
    countUp($('reward-time'), 0, saved, 1100, duration),
    countUp($('reward-money'), 0, saved, 1100, n => money(n, wage))
  ]);
  showStreak(allTime, { grew });
  if (allTime.seconds > previous) {
    await countUp($('alltime-time'), previous, allTime.seconds, 700, duration);
    showAllTime(allTime, { bump: true });
  } else {
    showAllTime(allTime);
  }
}

const formatWage = w => (Number.isInteger(Number(w)) ? String(Number(w)) : Number(w).toFixed(2));

$('wage-edit').addEventListener('click', () => {
  $('wage-input').value = formatWage(wage);
  show($('wage-form'));
  show($('wage-edit'), false);
  $('wage-input').focus();
  $('wage-input').select();
});

$('wage-form').addEventListener('submit', async e => {
  e.preventDefault();
  const value = Math.min(1000, Math.max(0, Number($('wage-input').value)));
  if (!Number.isFinite(value)) return;
  wage = Math.round(value * 100) / 100;
  await send(MSG.SAVE_SETTINGS, { hourlyWage: wage }).catch(() => {});
  $('wage-edit').textContent = `$${formatWage(wage)}/hr`;
  $('reward-money').textContent = money(lastSaved, wage);
  show($('wage-form'), false);
  show($('wage-edit'));
  showAllTime(allTime);
});

function showError(message) {
  show($('progress'), false);
  show($('error'));
  $('error-text').textContent = message;
}

function showResult(summary, { restored = false } = {}) {
  show($('progress'), false);
  show($('result'));
  shownPct = 0;
  if (!restored) walletAfter(summary.wallet);
  // Reopened, the fill is shown in one line: the celebration was had, and
  // the Fill button for the next step must not be pushed out of sight.
  $('result').classList.toggle('compact', restored);
  if (restored) show($('reward'), false);
  else showReward(summary, { restored });

  const secs = (summary.durationMs / 1000).toFixed(1);
  $('result-headline').textContent = restored
    ? `Last fill here: ${summary.filled} of ${summary.fieldsFound} answered` +
      (summary.timeSavedSeconds ? `, ${duration(summary.timeSavedSeconds)} saved` : '')
    : `${summary.filled} of ${summary.fieldsFound} questions answered in ${secs} seconds`;

  // Where the answers came from, in plain words; rows with nothing are left out.
  const stats = [
    ['From your profile', summary.fromHeuristics],
    ['From a site skill', summary.fromSkill],
    ['From your saved answers', summary.fromSavedResponses ?? 0],
    ['Written for you', summary.written],
    ['Files attached', summary.documentsAttached ?? 0],
    ['Double-checked and fixed', summary.overruledByModel ?? 0],
    ['AI requests', summary.modelCalls]
  ].filter(([, value]) => Number(value) > 0);
  $('result-stats').innerHTML = stats
    .map(([label, value]) => `<li>${label}<b>${value}</b></li>`)
    .join('');

  // What to do next, one short line each. "check" lines get an amber dot.
  const notes = [{ text: 'Check every answer before you submit.', kind: 'first' }];
  const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  if (summary.guessed > 0) {
    notes.push({ text: `${n(summary.guessed, 'answer is a best guess', 'answers are best guesses')}, outlined in amber.`, kind: 'check' });
  }
  if (summary.needsReview > 0) {
    notes.push({ text: `${n(summary.needsReview, 'field was', 'fields were')} changed by the page as it was typed, outlined in amber.`, kind: 'check' });
  }
  const missed = summary.possiblyMissed || [];
  show($('result-missed'), missed.length > 0);
  if (missed.length) {
    $('result-missed-text').textContent = missed.length === 1
      ? `This question may have been missed: "${missed[0].slice(0, 90)}". Report it and we'll teach phil to fill it.`
      : `${missed.length} questions may have been missed, such as "${missed[0].slice(0, 70)}". Report them and we'll teach phil to fill them.`;
  }
  if (summary.blockedFrames?.length) {
    notes.push({ text: `Part of the form comes from ${summary.blockedFrames[0]}, which phil may not reach yet.`, kind: 'check' });
  }
  if (summary.written > 0) notes.push({ text: 'Written answers are drafts: make them sound like you.', kind: 'check' });
  if (summary.fromSavedResponses > 0) notes.push({ text: 'Your saved answers were used as you wrote them.' });
  if (summary.adaptedResponses > 0) notes.push({ text: 'A saved answer was tailored to this role.' });
  if (summary.uploadsOffered > 0 && !summary.documentsAttached) {
    notes.push({ text: 'This page wants a file. Add your CV in Settings, or attach it yourself.', kind: 'check' });
  }
  if (summary.cvUsed) {
    const { category, filename } = summary.cvUsed;
    notes.push({ text: category ? `Used your CV for ${category} (${filename}).` : `Used your CV ${filename}.` });
  }
  for (const u of summary.uploadsUnsure || []) {
    const what = u.kind === 'coverLetter' ? 'cover letter' : 'CV';
    notes.push({ text: u.failed ? `The page did not accept your ${what}. Attach it again before you submit.`
      : `Your ${what} was still uploading. Check it finished before you submit.`, kind: 'check' });
  }
  const empty = summary.requiredEmpty || [];
  if (summary.asked > 0) {
    // Marked on the page: the user answers there and ticks, and Phil keeps it.
    notes.push({ text: summary.asked === 1
      ? 'One question needs you. It is marked in green on the page: answer it, tick ✓, and phil remembers it.'
      : `${summary.asked} questions need you. They are marked in green on the page: answer each, tick ✓, and phil remembers them.`,
      kind: 'ask', action: { label: 'Show me', run: () => send('show-asked', { tabId: currentTab.id }).then(() => window.close()).catch(() => {}) } });
  } else if (empty.length) {
    notes.push({ text: empty.length === 1
      ? `A required question is still empty: "${empty[0]}". Answer it before you submit.`
      : `${empty.length} required questions are still empty, such as "${empty[0]}". Answer them before you submit.`, kind: 'check' });
  }
  const adds = summary.addEntries || [];
  if (adds.length) {
    const what = { employment: 'jobs', education: 'schools', references: 'references' }[adds[0].list] || 'entries';
    notes.push({ text: `This page adds ${what} one at a time. Click "${adds[0].text}", then phil this application again.`, kind: 'check' });
  }
  if (summary.multiStep) notes.push({ text: 'More steps to go: on the next page, phil this application again.' });
  if (summary.onlyByChoice === 'demographics') {
    notes.push({ text: 'Only voluntary questions here (such as gender or veteran status), which you answer yourself. You can carry on.' });
  } else if (summary.demographicsOff > 0) {
    notes.push({ text: `${n(summary.demographicsOff, 'voluntary question', 'voluntary questions')} (such as gender or veteran status) left for you to answer. ` +
      'To have phil answer them from your profile, turn on "Answer voluntary demographic questions" in Settings.', kind: 'check' });
  } else if (summary.onlyByChoice === 'answered') {
    notes.push({ text: 'Everything on this page is already answered.' });
  }
  if (!summary.charged && summary.filled > 0) notes.push({ text: 'Same form as before, so this one is free.' });
  $('result-note').replaceChildren(...notes.map(({ text, kind, action }) => {
    const li = document.createElement('li');
    li.textContent = text;
    if (kind) li.className = kind;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = action.label;
      b.addEventListener('click', action.run);
      li.append(' ', b);
    }
    return li;
  }));

  // What the fill cost in model calls, and what it is charged at.
  // In dollars, never cents: "0.19¢" reads as 19 cents at a glance.
  const cost = summary.cost;
  show($('result-cost'), !!cost && !summary.timeSavedSeconds);
  show($('result-cost-details'), !!cost);
  if (cost) {
    // With a time saved, the reward already says what the fill cost.
    const charge = summary.wallet;
    $('result-cost').textContent = charge?.free
      ? 'This fill was free.'
      : `This fill cost you ${usd(spentCents(cost, charge))}.`;
    $('result-cost-parts').replaceChildren(...costParts(cost).map(text => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }));
    show($('result-capped'), !!cost.capped);
    if (cost.capped) {
      $('result-capped').textContent =
        `This page reached the ${usd(cost.capCents)} limit, so some answers were not drafted. Please report it.`;
      if (!restored) openReport();
    }
  }

  // The questions marked on the page are said once, above.
  const said = summary.asked > 0 ? empty.map(e => e.replace(/\.\.\.$/, '')) : [];
  const left = (summary.unfilled || []).filter(u => !said.some(e => cleanLabelText(u.label).startsWith(e)));
  if (left.length) {
    show($('result-details'));
    $('result-unfilled').innerHTML = left
      .slice(0, 12)
      .map(u => `<li>${escapeHtml(u.label || 'Unlabelled field')}: ${escapeHtml(u.reason || '')}</li>`)
      .join('');
  }
}

/** A label as the summary's short lists print it, to tell the same question in two lists. */
const cleanLabelText = l => String(l || '').replace(/\s+/g, ' ').replace(/\s*[:*]+\s*$/, '').trim();

/** What the user paid for a fill: what the wallet was charged, or the model cost on their own keys. */
function spentCents(cost, charge) {
  if (charge) return charge.free ? 0 : Number(charge.cents) || 0;
  if (!cost) return null;
  return Number(cost.cents) || 0;
}

/** The wallet row: the balance, free applications left, and Add $5. */
function showWallet(w) {
  wallet = w && !w.error ? w : null;
  show($('wallet'), !!wallet);
  show($('usage-line'), !wallet);
  if (!wallet) return;
  $('wallet-balance').textContent = wallet.unlimited ? 'Unlimited' : usd(Math.max(0, wallet.balanceCents));
  $('wallet-free').textContent = wallet.unlimited ? 'applications, on the house'
    : wallet.freeLeft > 0 ? `${wallet.freeLeft} free application${wallet.freeLeft === 1 ? '' : 's'} left`
    : 'in your wallet';
  // Asked for only when it is needed: once the free applications and the money are gone.
  show($('wallet-reload'), !wallet.unlimited && !wallet.canFill);
  $('wallet-reload').textContent = `Add $${(wallet.minReloadCents || 500) / 100}`;
  show($('wallet-dev'), !!wallet.dev);
  // Once it holds something worth keeping (a fill done, or money), offer to
  // keep it under an email, so a reinstall does not lose it.
  const worthKeeping = wallet.balanceCents > 0 || (wallet.freeLeft ?? 10) < 10;
  show($('wallet-keep'), wallet.kind === 'remote' && !wallet.email && !wallet.unlimited && worthKeeping);
  askIfLow();
}

const LOW_CENTS = 30;
const LOW_ASKED = 'lowBalanceAsked';

/**
 * At 30¢ or less, one quiet line offers a top-up, the first time the popup
 * opens that low and never again until the wallet has been topped up.
 */
async function askIfLow() {
  if (!wallet || wallet.unlimited || wallet.freeLeft > 0) return;
  const low = wallet.balanceCents > 0 && wallet.balanceCents <= LOW_CENTS;
  let asked = false;
  try { asked = !!(await chrome.storage.local.get(LOW_ASKED))[LOW_ASKED]; } catch { /* asked stays false */ }
  if (!low) {
    show($('wallet-low'), false);
    // Topped up again: the next time it runs low, ask again.
    if (asked && wallet.balanceCents > LOW_CENTS) chrome.storage.local.remove(LOW_ASKED).catch(() => {});
    return;
  }
  if (asked) return;
  $('wallet-low-text').textContent = `Running low: ${usd(wallet.balanceCents)} left.`;
  show($('wallet-low'));
  chrome.storage.local.set({ [LOW_ASKED]: true }).catch(() => {});
}

$('wallet-low-add').addEventListener('click', () => { show($('wallet-low'), false); $('wallet-reload').click(); });
$('wallet-low-close').addEventListener('click', () => show($('wallet-low'), false));

/** After a fill, the wallet as it now stands. */
function walletAfter(charge) {
  if (!wallet || !charge) return;
  showWallet({ ...wallet, balanceCents: charge.balanceCents, freeLeft: charge.freeLeft,
    canFill: !!wallet.unlimited || charge.freeLeft > 0 || charge.balanceCents > 0 });
}

$('wallet-reload').addEventListener('click', async () => {
  $('wallet-reload').disabled = true;
  try {
    const res = await send(MSG.RELOAD_WALLET, { cents: wallet?.minReloadCents || 500 });
    // The dev build's wallet is topped up at once; the service opens a checkout page.
    if (res?.wallet) {
      showWallet({ ...wallet, ...res.wallet });
      show($('warning'), false);
      $('fill').disabled = false;
      $('wallet').classList.remove('bump');
      void $('wallet').offsetWidth;
      $('wallet').classList.add('bump');
    }
  } catch (err) {
    showError(err.message);
  } finally {
    $('wallet-reload').disabled = false;
  }
});

/**
 * Cents as dollars a person can read: "$0.002", "$0.0004", "$0.10". Under a
 * cent, one significant figure, so a tiny cost never looks like a big one.
 */
function usd(value) {
  const d = (Number(value) || 0) / 100;
  if (d <= 0) return '$0';
  if (d >= 0.01) return `$${d.toFixed(2)}`;
  if (d < 0.0001) return 'under $0.0001';
  return `$${Number(d.toPrecision(1))}`;
}

/** One line per provider: what it was asked, and what that cost; then the total and price. */
function costParts(cost) {
  const n = v => Number(v || 0).toLocaleString('en-US');
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const ts = cost.byProvider?.typesafe;
  const ds = cost.byProvider?.deepseek;
  return [
    ts ? `TypeSafe ${usd(ts.cents)}: ${n(ts.inputTokens)} input tokens, ${plural(ts.calls, 'request')}`
       : 'TypeSafe: not called',
    ds ? `DeepSeek ${usd(ds.cents)}: ${n(ds.inputTokens)} in, ${n(ds.outputTokens)} out, ${plural(ds.calls, 'request')}`
       : 'DeepSeek: not called (nothing to write)',
    `Model cost ${usd(cost.cents)}, price ${usd(cost.priceCents)}`
  ];
}

function openReport() {
  show($('report'));
  $('report-intro').textContent = lastRating
    ? 'This page is on its way to us for review. A note helps us fix it faster.'
    : 'Tell us what went wrong and we will look at this page.';
  $('report-result').textContent = '';
  $('report-send').disabled = false;
}

// A thumb after a fill. Up is a thank-you; down sends the page's address for
// review at once (its answers stay in the browser), then offers a note.
let lastRating = null;

function resetRating() {
  lastRating = null;
  for (const id of ['rate-up', 'rate-down']) {
    $(id).disabled = false;
    $(id).removeAttribute('aria-pressed');
  }
  $('rate-result').textContent = '';
  show($('report'), false);
}

async function rate(verdict) {
  if (lastRating?.verdict === verdict) return;
  for (const id of ['rate-up', 'rate-down']) {
    $(id).disabled = true;
    $(id).removeAttribute('aria-pressed');
  }
  $(verdict === 'up' ? 'rate-up' : 'rate-down').setAttribute('aria-pressed', 'true');
  $('rate-result').textContent = verdict === 'down' ? 'Sending...' : '';
  try {
    const reply = await send(MSG.REPORT_ISSUE, { tabId: currentTab.id, url: currentTab.url, verdict });
    lastRating = { ...reply, verdict };
    $('rate-result').textContent = verdict === 'down' ? (reply.sent ? 'Sent. Thank you.' : 'Saved. Thank you.') : 'Thanks!';
    if (verdict === 'down') openReport();
  } catch (err) {
    $('rate-result').textContent = err.message;
    for (const id of ['rate-up', 'rate-down']) $(id).disabled = false;
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function setRunning(running) {
  $('fill').disabled = running;
  if (running) resetRating();
  $('fill-label').textContent = running ? 'phil is philling...' : 'phil this application';
  show($('cancel'), running);
}

/**
 * The page's own site, when phil may not yet keep working on it. Opening the
 * popup lends phil the page only until it navigates (activeTab); the first
 * Fill on a site asks for that site for good, so later pages and steps of an
 * application need nothing more. Never anything broader than the one site.
 */
let siteToAsk = null;

async function checkSiteAccess(url) {
  siteToAsk = null;
  if (!/^https?:/i.test(url || '')) return;
  const pattern = sitePattern(new URL(url).origin);
  const granted = await chrome.permissions.contains({ origins: [pattern] }).catch(() => true);
  if (!granted) siteToAsk = pattern;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  await checkSiteAccess(tab?.url);

  let status;
  try {
    status = await send(MSG.GET_STATUS);
  } catch (err) {
    showError(err.message);
    return;
  }

  // The password lock is closed: the password first, then everything else.
  if (status.locked) {
    show($('locked'));
    show($('page-info'), false);
    show($('learn'), false);
    $('fill').disabled = true;
    $('unlock-password').focus();
    return;
  }

  wage = Number(status.hourlyWage) || 16;
  showWallet(status.wallet);
  allTime = status.allTime || allTime;
  showAllTime(allTime);

  $('usage-line').textContent =
    status.mode === 'proxy'
      ? `${status.usage.completions} applications filled`
      : `${status.usage.thisMonth} filled this month`;

  // philform can only read a page it is allowed to touch.
  const restricted = !tab?.url || /^(chrome|edge|about|moz-extension|chrome-extension|view-source):/.test(tab.url);
  if (restricted) {
    $('page-role').textContent = 'Open a job application to start';
    $('page-fields').textContent = 'philform fills application forms on any job site.';
    return;
  }

  if (!status.configured) {
    show($('warning'));
    $('warning-text').textContent = 'philform is not set up yet. Finish setup to start filling.';
    $('warning-action').textContent = 'Finish setup';
    $('page-role').textContent = 'Setup needed';
    $('page-fields').textContent = '';
    return;
  }

  if (!status.profileReady) {
    show($('warning'));
    $('warning-text').textContent = 'Your profile is almost empty. Add your details so there is something to fill in.';
  }

  // Out of free applications and money: say so before the click, not after.
  if (wallet && !wallet.canFill) {
    show($('warning'));
    // The wallet row below carries the Add $5 button; one is enough.
    $('warning-text').textContent = 'Your wallet is empty. Add $5 to keep filling: that covers hundreds of applications.';
    show($('warning-action'), false);
  }

  // How well phil knows this kind of page: a circle beside the page line.
  send(MSG.GET_PAGE_SUPPORT, { tabId: tab.id, url: tab.url }).then(support => {
    if (!support?.level) return;
    $('support-dot').className = `support-dot ${support.level}`;
    $('support-text').textContent = support.text;
    $('page-support').title = support.note || '';
    show($('page-support'));
  }).catch(() => {});

  const restored = await restoreLastRun(tab, status);

  try {
    const summary = await send(MSG.GET_PAGE_SUMMARY, { tabId: tab.id });
    // Workday keeps one address for every step: a page asking other
    // questions is the next step, not the one filled.
    if (restored && !sameQuestions(restored.summary?.questions, summary.questions)) {
      show($('result'), false);
      show($('error'), false);
    }
    $('page-role').textContent = summary.role
      ? `${summary.role}${summary.company ? ` at ${summary.company}` : ''}`
      : 'Application form found';

    const parts = [`${summary.fieldCount} question${summary.fieldCount === 1 ? '' : 's'} to fill`];
    if (summary.skippedSensitive) parts.push(`${summary.skippedSensitive} sensitive field skipped`);
    if (summary.multiStep) parts.push('multi-step form');
    $('page-fields').textContent = parts.join(' · ');

    await showBlockedFrames(summary.blocked || []);
    $('fill').disabled = summary.fieldCount === 0 || (!!wallet && !wallet.canFill);
    if (summary.fieldCount === 0) {
      $('page-fields').textContent = summary.blocked?.length
        ? 'The form is inside an embedded frame. Allow access above, then fill.'
        : 'No questions found here. Open the application form first.';
    }
  } catch (err) {
    $('page-role').textContent = 'Could not read this page.';
    $('page-fields').textContent = err.message;
  }
}

/** The same page, ignoring the part after "#", which single-page forms change freely. */
const samePage = (a, b) => !!a && String(a).split('#')[0] === String(b || '').split('#')[0];

/**
 * The popup closes whenever the user clicks away. Opened again on the page it
 * just filled (or is filling), it shows that fill again, so the user can still
 * report it. A new page in the tab forgets it.
 */
async function restoreLastRun(tab, status) {
  if (status.running && status.runningTabId === tab.id) {
    setRunning(true);
    setProgress(null);
    return;
  }
  const run = await send(MSG.GET_LAST_RUN, { tabId: tab.id }).catch(() => null);
  if (!run || !samePage(run.url, tab.url)) return null;
  if (run.summary) showResult(run.summary, { restored: true });
  else if (run.error && run.error !== 'Fill cancelled.') showError(run.error);
  return run;
}

/**
 * An application embedded from another site (a Greenhouse or iCIMS frame on a
 * company's careers page) is out of reach until the user grants that one
 * site. Nothing broader is ever requested.
 */
let blockedOrigins = [];

/**
 * Embeds still out of reach: those not yet allowed ask for access; those
 * allowed that still do not answer need the page reloaded, or failing that
 * the browser restarted, and the popup says so rather than asking again.
 */
async function showBlockedFrames(origins) {
  const allowed = await Promise.all(origins.map(o =>
    chrome.permissions.contains({ origins: [sitePattern(o)] }).catch(() => false)));
  blockedOrigins = origins.filter((_, i) => !allowed[i]);
  const stuck = origins.filter((_, i) => allowed[i]);
  show($('frames'), origins.length > 0);
  show($('frames-allow'), blockedOrigins.length > 0);
  show($('frames-reload'), !blockedOrigins.length && stuck.length > 0);
  if (!origins.length) return;
  const hosts = list => list.map(o => o.replace(/^https?:\/\//, '')).join(', ');
  $('frames-text').textContent = blockedOrigins.length
    ? `This form is embedded from ${hosts(blockedOrigins)}. phil needs your permission to read and fill it.`
    : `Access to ${hosts(stuck)} is allowed, but the form has not loaded with it yet. ` +
      'Reload the page, then open philform again. If it still cannot read the form, restart the browser.';
}

$('frames-allow').addEventListener('click', async () => {
  try {
    // Must run straight from the click: browsers only show the prompt then.
    // The whole site is asked for, so an embed that redirects within it
    // (boards.greenhouse.io to job-boards.greenhouse.io) is covered.
    const granted = await chrome.permissions.request({ origins: [...new Set(blockedOrigins.map(sitePattern))] });
    if (granted) init();
  } catch (err) {
    showError(err.message);
  }
});

$('frames-reload').addEventListener('click', async () => {
  await chrome.tabs.reload(currentTab.id).catch(() => {});
  window.close();
});

$('fill').addEventListener('click', async () => {
  // Asked before anything is awaited: browsers show the prompt only straight
  // from a click. The fill does not wait for the answer: it runs on the page
  // the popup was opened on either way, and Firefox may close the popup for
  // the prompt (the run carries on, and reopening shows it).
  if (siteToAsk) {
    chrome.permissions.request({ origins: [siteToAsk] }).catch(() => false);
    siteToAsk = null;
  }
  show($('error'), false);
  show($('result'), false);
  setRunning(true);
  setProgress(STAGE.INJECTING);

  try {
    await send(MSG.RUN_FILL, { tabId: currentTab.id, url: currentTab.url });
  } catch (err) {
    showError(err.message);
  } finally {
    setRunning(false);
  }
});

$('cancel').addEventListener('click', async () => {
  await send(MSG.CANCEL_RUN).catch(() => {});
  setRunning(false);
  show($('progress'), false);
});

$('unlock-form').addEventListener('submit', async e => {
  e.preventDefault();
  const { ok } = await send(MSG.UNLOCK, { password: $('unlock-password').value }).catch(() => ({ ok: false }));
  if (!ok) {
    $('unlock-result').textContent = 'That is not the password.';
    $('unlock-password').select();
    return;
  }
  location.reload();
});

$('wallet-keep').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#data') });
  window.close();
});

$('rate-up').addEventListener('click', () => rate('up'));
for (const button of document.querySelectorAll('.rate-down')) {
  button.addEventListener('click', () => rate('down'));
}
$('report-close').addEventListener('click', () => show($('report'), false));
// An email to support, with the page's address only (never the answers on it).
$('report-mail').addEventListener('click', e => {
  e.preventDefault();
  const subject = encodeURIComponent('philform feedback');
  const body = encodeURIComponent(`${$('report-note').value.trim()}\n\nPage: ${currentTab?.url || ''}\nphilform ${chrome.runtime.getManifest().version}\n`);
  chrome.tabs.create({ url: `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}` });
  window.close();
});
$('report-send').addEventListener('click', async () => {
  $('report-send').disabled = true;
  $('report-result').textContent = 'Sending...';
  try {
    const reply = await send(MSG.REPORT_ISSUE, { tabId: currentTab.id, url: currentTab.url, verdict: 'down', note: $('report-note').value, id: lastRating?.id });
    lastRating = { ...reply, verdict: 'down' };
    $('report-result').textContent = reply.sent ? 'Sent. Thank you.' : 'Saved. Thank you.';
    $('report-note').value = '';
  } catch (err) {
    $('report-result').textContent = err.message;
    $('report-send').disabled = false;
  }
});

$('clear-highlights').addEventListener('click', async () => {
  await send('clear-highlights', { tabId: currentTab.id }).catch(() => {});
});

// --- save answers the user gave on the page themselves ----------------------

let learnProposals = [];

/** One row per answer: the page's question, the answer, where it goes, and a button. */
function learnRow(p, i) {
  const to = p.replaces
    ? `Replaces your saved ${escapeHtml(p.saveTo || 'answer')}: ${escapeHtml(String(p.replaces).slice(0, 80))}`
    : `Saves to: ${escapeHtml(p.saveTo || 'your profile')}`;
  return `<li data-row="${i}">
      <div class="text"><div class="q">${escapeHtml(String(p.question || p.title).slice(0, 140))}</div>
        <div class="a">${escapeHtml(String(p.answer ?? p.detail ?? '').slice(0, 200))}</div>
        <div class="to">${to}</div></div>
      <button class="secondary act" type="button" data-save="${i}">${p.replaces ? 'Replace' : 'Save'}</button>
    </li>`;
}

async function saveLearned(indexes) {
  const items = indexes.map(i => {
    const p = learnProposals[i];
    return p.replaces ? { ...p, replace: true } : p;
  });
  const { applied } = await send(MSG.LEARN_APPLY, { proposals: items });
  for (const i of indexes) {
    const row = $('learn-list').querySelector(`[data-row="${i}"]`);
    const button = row?.querySelector('[data-save]');
    if (button) button.outerHTML = '<span class="done">Saved ✓</span>';
    learnProposals[i] = null;
  }
  const left = learnProposals.filter(Boolean).length;
  show($('learn-save'), left > 1);
  if (!left) $('learn-headline').textContent = 'Saved. phil will fill these for you next time.';
  return applied;
}

$('learn').addEventListener('click', async () => {
  show($('error'), false);
  show($('result'), false);
  $('learn').disabled = true;
  try {
    const { proposals } = await send(MSG.LEARN_PREVIEW, { tabId: currentTab.id, url: currentTab.url });
    learnProposals = proposals || [];
    const n = learnProposals.length;
    $('learn-headline').textContent = n
      ? `${n} answer${n === 1 ? '' : 's'} on this page that phil does not have yet.`
      : 'Nothing new here. Type your answers into the form first, then click this again.';
    show($('learn-hint'), n > 0);
    $('learn-list').innerHTML = learnProposals.map(learnRow).join('');
    show($('learn-save'), n > 1);
    show($('learn-panel'));
  } catch (err) {
    showError(err.message);
  } finally {
    $('learn').disabled = false;
  }
});

$('learn-list').addEventListener('click', async e => {
  const button = e.target.closest('[data-save]');
  if (!button) return;
  button.disabled = true;
  try {
    await saveLearned([Number(button.dataset.save)]);
  } catch (err) {
    button.disabled = false;
    showError(err.message);
  }
});

// Save all: everything not yet saved, except replacements, which change what
// the user already had and so are only ever done one at a time.
$('learn-save').addEventListener('click', async () => {
  const indexes = learnProposals.map((p, i) => (p && !p.replaces ? i : -1)).filter(i => i >= 0);
  if (!indexes.length) return;
  try {
    await saveLearned(indexes);
  } catch (err) {
    showError(err.message);
  }
});

$('learn-close').addEventListener('click', () => show($('learn-panel'), false));

$('open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('warning-action').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('open-skills').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#skills') });
});

chrome.runtime.onMessage.addListener(message => {
  if (message.type === MSG.RUN_PROGRESS) setProgress(message.payload.stage, message.payload.detail || {});
  if (message.type === MSG.RUN_DONE) { setRunning(false); showResult(message.payload); }
  if (message.type === MSG.RUN_ERROR) {
    setRunning(false);
    // Cancelled by the user: stopped, not a problem to report.
    if (message.payload.message === 'Fill cancelled.') show($('progress'), false);
    else showError(message.payload.message);
  }
});

/** "Build 51" in a dev build, matching dev.py's "Reloaded build 51"; otherwise the version. */
async function showBuild() {
  const label = $('build');
  const dev = await devConfig();
  if (dev?.build?.number) {
    label.textContent = `#${dev.build.number}`;
    label.classList.add('dev');
    label.title = `Development build ${dev.build.number}, made ${dev.build.at || ''}`.trim();
  } else {
    label.textContent = `v${chrome.runtime.getManifest().version}`;
  }
  show(label);
  // Site skills keep themselves up; only a dev build shows them.
  $('open-skills').hidden = !dev;
}

/** 1.0.10 is newer than 1.0.9. */
function newerVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/**
 * A copy installed from the website updates itself, but Firefox looks only
 * once a day and offers no way to look sooner. The popup reads the same list
 * and, when a newer version is there, offers it: opening the signed file
 * installs it over this one and keeps the user's data. Store and dev builds
 * have no update_url and skip this.
 */
async function offerUpdate() {
  const manifest = chrome.runtime.getManifest();
  const url = manifest.browser_specific_settings?.gecko?.update_url;
  const id = manifest.browser_specific_settings?.gecko?.id;
  if (!url || !id) return;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const updates = (await res.json())?.addons?.[id]?.updates || [];
    const latest = updates.reduce((best, u) => (!best || newerVersion(u.version, best.version) ? u : best), null);
    if (!latest?.update_link || !newerVersion(latest.version, manifest.version)) return;
    $('update-text').textContent = `A new version of philform is ready (${latest.version}). Your profile and answers stay as they are.`;
    $('update-action').onclick = () => chrome.tabs.create({ url: latest.update_link });
    show($('update'));
  } catch {
    // Offline or the list is unreachable: Firefox's own check still runs.
  }
}

showBuild();
offerUpdate();
drawPhils();
init();
