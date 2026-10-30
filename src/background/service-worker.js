/**
 * Applicator background service worker.
 *
 * Holds no long-lived state beyond the in-flight run: Manifest V3 stops the
 * worker whenever it is idle, so everything durable lives in chrome.storage.
 */

import { MSG } from '../common/messages.js';
import {
  getSettings, saveSettings, getProfile, saveProfile,
  getResponses, saveResponses, getDocuments, saveDocument, saveResumes, getRuns, clearRuns,
  exportAll, importAll, EXPORT_PARTS
} from './storage.js';
import { starterResponses } from './responses.js';
import { listSkills, putSkill, deleteSkill, shareSkill, adoptSkill, forgetAllSkills, getSkill } from './skills/store.js';
import { runFill, clearHighlights, showAsked } from './orchestrator.js';
import { extractAll } from './frames.js';
import { devConfig, reportRun } from './dev.js';
import { beginTrace, endTrace } from './trace.js';
import { forgetRun, lastRunFor, rememberRun, reportIssue } from './issues.js';
import { loadRulesPack, refreshRulesPack } from './rules.js';
import { detectPlatform, hostnameOf, markerList, supportLevel } from '../common/rulespack.js';
import { getTimeSaved } from './timesaved.js';
import { getIssues, clearIssues, effectiveLongTextMode, lockStatus, unlock } from './storage.js';
import { proposeLearning, applyLearning } from './learn.js';
import { siteKey, pageQuestions } from '../common/util.js';
import { usageSummary } from './quota.js';
import { walletStatus, reloadWallet, endRun, startEmail, verifyEmail } from './billing.js';
import { testDeepSeek } from './llm/deepseek.js';
import { testTypeSafe } from './llm/typesafe.js';

/** The one run that may be in flight, so the popup can cancel it. */
let activeRun = null;

/**
 * Seed credentials from the gitignored local development config, if there is
 * one. Only ever fills a blank setting, so a key typed into the options page
 * always wins and is never overwritten on the next background start.
 */
async function seedLocalConfig() {
  let config;
  try {
    ({ LOCAL_CONFIG: config } = await import('../common/local-config.js'));
  } catch {
    return; // No local config: the normal case for an installed copy.
  }
  if (!config) return;

  const settings = await getSettings();
  const patch = {};
  for (const key of ['typesafeApiKey', 'deepseekApiKey']) {
    if (config[key] && !settings[key]) patch[key] = config[key];
  }
  // Keys seeded into a fresh install mean local testing: call the models directly.
  if (Object.keys(patch).length && !settings.typesafeApiKey && !settings.deepseekApiKey) patch.mode = 'direct';
  if (Object.keys(patch).length) await saveSettings(patch);
}

/**
 * A development build may carry an exported profile and settings, loaded only
 * into an empty profile, so a fresh dev browser starts ready to fill.
 */
async function seedDevProfile() {
  const dev = await devConfig();
  if (!dev?.seed) return;
  const profile = await getProfile();
  const empty = !Object.values(profile || {}).some(v => (Array.isArray(v) ? v.length : String(v || '').trim() !== ''));
  if (!empty) return;
  if (dev.seed.profile) await saveProfile(dev.seed.profile);
  if (dev.seed.settings) await saveSettings(dev.seed.settings);
}

/**
 * A development build may carry projects to add to the profile once
 * (`addProjects`, written by dev.py): only those it does not hold yet, by
 * name or link, appended to the stored list as it is; nothing else changes.
 * A project the user deletes afterwards is not added back.
 */
async function mergeDevProjects() {
  const dev = await devConfig();
  const list = Array.isArray(dev?.addProjects) ? dev.addProjects : [];
  if (!list.length) return;
  const mark = `devProjectsMerged:${list.map(p => p.name).join('|')}`;
  if ((await chrome.storage.local.get(mark))[mark]) return;
  // With the password lock on, the profile is not a plain key: leave it be.
  if ((await chrome.storage.local.get('vault')).vault) return;
  const stored = (await chrome.storage.local.get('profile')).profile || {};
  const have = Array.isArray(stored.projects) ? stored.projects : [];
  const norm = t => String(t || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/^https?:\/\/(www\.)?/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const names = have.map(p => norm(p.name)).filter(Boolean);
  const links = new Set(have.map(p => norm(p.link)).filter(Boolean));
  const known = p => (p.link && links.has(norm(p.link))) || names.some(n => n === norm(p.name) || n.includes(norm(p.name)) || norm(p.name).includes(n));
  const added = list.filter(p => p?.name && !known(p));
  if (added.length) await chrome.storage.local.set({ profile: { ...stored, projects: [...have, ...added] } });
  await chrome.storage.local.set({ [mark]: added.map(p => p.name) });
}

// Runs on every background start, which in Manifest V3 is often.
/** A dev build runs in the mode dev.py chose, whatever its profile saved. */
async function applyDevMode() {
  const dev = await devConfig();
  if (!dev?.mode) return;
  if ((await getSettings()).mode !== dev.mode) await saveSettings({ mode: dev.mode });
}

seedLocalConfig().then(seedDevProfile).then(mergeDevProjects).then(applyDevMode).catch(() => {});

// A development build adds a keyboard shortcut that fills the current tab.
chrome.commands?.onCommand?.addListener(async command => {
  if (command !== 'fill-page') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  handlers[MSG.RUN_FILL]({ tabId: tab.id, url: tab.url }).catch(() => {});
});

// A tab that loads a new page, or closes, has no last fill to show or report.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') forgetRun(tabId);
});
chrome.tabs.onRemoved.addListener(tabId => forgetRun(tabId));

/** Send progress to the popup. The popup is often closed; that is not an error. */
function broadcast(type, payload) {
  chrome.runtime.sendMessage({ type, payload }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async details => {
  await seedLocalConfig().catch(() => {});
  // A development build is reinstalled on every save; it opens nothing.
  if (details.reason === 'install' && !(await devConfig())) {
    // A first run with an empty profile fills nothing, so send the user to
    // the page where they fill it in.
    // The guided tour: phil shows where everything is, then opens the practice form.
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#tour') });
  }
});

const handlers = {
  async [MSG.RUN_FILL]({ tabId, url }) {
    if (activeRun) throw new Error('A fill is already running.');

    const controller = new AbortController();
    activeRun = { tabId, controller };
    // Every fill is traced in memory, so a report about it can show what it
    // did; a development build also sends each one to tools/dev.py.
    const dev = await devConfig();
    beginTrace();
    let outcome = {};

    try {
      const summary = await runFill({
        tabId,
        url,
        signal: controller.signal,
        onProgress: (stage, detail) => broadcast(MSG.RUN_PROGRESS, { stage, detail })
      });
      outcome = { summary };
      broadcast(MSG.RUN_DONE, summary);
      return summary;
    } catch (err) {
      const message = err?.message || String(err);
      outcome = { error: { message, stack: String(err?.stack || '').slice(0, 2000) } };
      broadcast(MSG.RUN_ERROR, { message });
      throw new Error(message);
    } finally {
      activeRun = null;
      // A fill that failed or was cancelled stops sending requests through the relay.
      endRun();
      const trace = endTrace();
      await rememberRun(tabId, { url, ...outcome, trace });
      if (dev) reportRun({ tabId, url, ...outcome, trace });
    }
  },

  async [MSG.CANCEL_RUN]() {
    if (!activeRun) return { cancelled: false };
    activeRun.controller.abort();
    activeRun = null;
    return { cancelled: true };
  },

  async [MSG.GET_STATUS]() {
    const settings = await getSettings();
    // With the password lock closed, the popup asks for the password first.
    const lock = await lockStatus();
    if (lock.enabled && !lock.unlocked) return { locked: true, mode: settings.mode, wallet: await walletStatus().catch(() => null) };
    const profile = await getProfile();
    const filled = Object.values(profile).filter(v => String(v || '').trim() !== '').length;
    const usage = await usageSummary();

    // TypeSafe decides fields; DeepSeek drafts the written answers, so its
    // key is needed only while the writer is on (or it matches fields).
    const needsTypeSafe = settings.classifier === 'typesafe';
    const needsDeepSeek = !needsTypeSafe || effectiveLongTextMode(settings) === 'write';
    // Through the service, an account is made on first use: the address is enough.
    const configured = settings.mode === 'proxy'
      ? !!settings.proxyUrl
      : (!needsTypeSafe || !!settings.typesafeApiKey) && (!needsDeepSeek || !!settings.deepseekApiKey);

    return {
      running: !!activeRun,
      runningTabId: activeRun?.tabId ?? null,
      profileFields: filled,
      profileReady: filled >= 5,
      configured,
      mode: settings.mode,
      usage,
      // The balance and free applications left, or null with your own keys.
      wallet: await walletStatus(),
      // For the time-saved counter in the popup.
      allTime: await getTimeSaved(),
      hourlyWage: settings.hourlyWage
    };
  },

  async [MSG.GET_PAGE_SUMMARY]({ tabId }) {
    const data = await extractAll(tabId);
    return {
      fieldCount: data.fields.length,
      skippedSensitive: data.skippedSensitive,
      role: data.context.role,
      company: data.context.company,
      multiStep: data.context.multiStep,
      questions: pageQuestions(data.fields),
      frames: data.frames,
      // Embedded forms from another site that need the user's permission.
      blocked: data.blocked
    };
  },

  /** Read back what the user typed on this page, as proposals to review. */
  async [MSG.LEARN_PREVIEW]({ tabId, url }) {
    const extraction = await extractAll(tabId);
    if (!extraction?.ok) throw new Error('Could not read this page.');
    const proposals = proposeLearning({
      fields: extraction.fields || [],
      profile: await getProfile(),
      site: siteKey(url || '')
    });
    return { proposals };
  },

  /** The last fill on a tab, for a reopened popup to show again. */
  async [MSG.GET_LAST_RUN]({ tabId }) {
    const run = await lastRunFor(tabId);
    return run ? { url: run.url, summary: run.summary || null, error: run.error?.message || null, at: run.at } : null;
  },

  /**
   * How well phil knows this kind of page, for the popup's circle: the
   * platform by hostname, else by markers found on the page, else what was
   * learned on the site before.
   */
  async [MSG.GET_PAGE_SUPPORT]({ tabId, url }) {
    await refreshRulesPack().catch(() => {});
    const pack = await loadRulesPack();
    const hostname = hostnameOf(url);
    let platform = detectPlatform(pack, { hostname });
    if (!platform && tabId != null) {
      try {
        const [hit] = await chrome.scripting.executeScript({
          target: { tabId },
          func: markers => markers.filter(m => { try { return !!document.querySelector(m.selector); } catch { return false; } }).map(m => m.id),
          args: [markerList(pack)]
        });
        platform = detectPlatform(pack, { hostname, markers: hit?.result || [] });
      } catch { /* a page phil may not read: judged by its site alone */ }
    }
    const skill = await getSkill(siteKey(url)).catch(() => null);
    return { platform: platform?.id || null, name: platform?.name || null, note: platform?.note || '', version: pack.version, ...supportLevel(platform, skill) };
  },

  /** The password lock, opened from the popup. */
  async [MSG.UNLOCK]({ password }) {
    return { ok: await unlock(String(password || '')) };
  },

  /** An email for the wallet: a code is sent, and the code links or restores it. */
  [MSG.EMAIL_START]: ({ email }) => startEmail(email),
  [MSG.EMAIL_VERIFY]: ({ email, code }) => verifyEmail(email, code),

  /** Flag the last fill on a tab, with the user's note, for review. */
  [MSG.REPORT_ISSUE]: payload => reportIssue(payload || {}),
  [MSG.LIST_ISSUES]: () => getIssues(),
  [MSG.CLEAR_ISSUES]: () => clearIssues(),

  /** Save the proposals the user kept. */
  async [MSG.LEARN_APPLY]({ proposals }) {
    const { profile, applied } = applyLearning(await getProfile(), proposals || []);
    await saveProfile(profile);
    return { applied };
  },

  async 'clear-highlights'({ tabId }) {
    return clearHighlights(tabId);
  },

  /** A required question answered on the page and ticked: a saved answer from now on. */
  async 'save-asked-answer'({ question, answer, site }) {
    if (!String(question || '').trim() || !String(answer || '').trim()) return { applied: 0 };
    const { profile, applied } = applyLearning(await getProfile(), [{ type: 'custom', question, answer, site }]);
    await saveProfile(profile);
    return { applied };
  },

  async 'show-asked'({ tabId }) {
    return showAsked(tabId);
  },

  // --- settings and profile ----------------------------------------------
  [MSG.GET_SETTINGS]: () => getSettings(),
  [MSG.SAVE_SETTINGS]: payload => saveSettings(payload),
  [MSG.GET_PROFILE]: () => getProfile(),
  [MSG.SAVE_PROFILE]: payload => saveProfile(payload),

  // --- saved responses ----------------------------------------------------
  [MSG.LIST_RESPONSES]: () => getResponses(),
  [MSG.SAVE_RESPONSES]: payload => saveResponses(payload?.responses || []),

  /** Add the starter library, without disturbing anything already saved. */
  async [MSG.SEED_RESPONSES]() {
    const existing = await getResponses();
    const next = [...existing, ...starterResponses()];
    await saveResponses(next);
    return next;
  },

  // --- skills -------------------------------------------------------------
  [MSG.GET_DOCUMENTS]: () => getDocuments(),
  [MSG.SAVE_DOCUMENT]: ({ kind, doc, id }) => saveDocument(kind, doc, { id }),
  [MSG.SAVE_RESUMES]: ({ resumes }) => saveResumes(resumes),
  [MSG.LIST_SKILLS]: () => listSkills(),
  [MSG.SHARE_SKILL]: ({ site }) => shareSkill(site),
  [MSG.ADOPT_SKILL]: ({ shared }) => adoptSkill(shared),
  [MSG.FORGET_ALL_SKILLS]: () => forgetAllSkills(),
  [MSG.SAVE_SKILL]: ({ site, skill }) => putSkill(site, skill),
  [MSG.DELETE_SKILL]: ({ site }) => deleteSkill(site),

  // --- history and usage --------------------------------------------------
  [MSG.LIST_RUNS]: () => getRuns(),
  [MSG.CLEAR_RUNS]: () => clearRuns(),
  [MSG.GET_USAGE]: () => usageSummary(),
  [MSG.GET_WALLET]: () => walletStatus(),
  // The dev build's wallet takes the money at once; the service's returns a checkout page to open.
  async [MSG.RELOAD_WALLET]({ cents } = {}) {
    const res = await reloadWallet(cents);
    if (res.checkoutUrl) await chrome.tabs.create({ url: res.checkoutUrl });
    return res;
  },

  // --- data ---------------------------------------------------------------
  [MSG.EXPORT_PARTS]: () => EXPORT_PARTS,
  [MSG.EXPORT_DATA]: payload => exportAll(payload || {}),
  [MSG.IMPORT_DATA]: payload => importAll(payload?.file, { parts: payload?.parts }),

  async [MSG.TEST_PROVIDER]({ provider, settings }) {
    const merged = { ...(await getSettings()), ...(settings || {}) };
    if (provider === 'typesafe') {
      const detail = await testTypeSafe({ apiKey: merged.typesafeApiKey, model: merged.typesafeModel });
      return { ok: true, detail };
    }
    if (provider === 'deepseek') {
      const text = await testDeepSeek({ apiKey: merged.deepseekApiKey, model: merged.deepseekModel });
      return { ok: true, detail: text || 'Connected.' };
    }
    throw new Error(`Unknown provider: ${provider}`);
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown message: ${message?.type}` });
    return false;
  }

  // The popup is often closed before a long run finishes, which makes
  // sendResponse throw. The run itself has already completed, so the failure to
  // deliver its result is not an error worth surfacing.
  const reply = payload => {
    try {
      sendResponse(payload);
    } catch {
      /* receiver is gone */
    }
  };

  Promise.resolve(handler(message.payload || {}))
    .then(data => reply({ ok: true, data }))
    .catch(err => reply({ ok: false, error: err?.message || String(err) }));

  // Keep the message channel open for the async response above.
  return true;
});
