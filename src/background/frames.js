/**
 * Reading and filling a page across its frames.
 *
 * Applicant tracking systems are often embedded: a company's careers page
 * shows a Greenhouse, iCIMS or Workable form inside an iframe from the ATS's
 * own site. Reading only the top page finds nothing there, so every step here
 * runs in every frame the extension may reach, and the results are merged into
 * one list of fields that each remember their frame.
 *
 * Clicking the toolbar button (activeTab) grants the page's own site only. A
 * form embedded from another site needs that site granted as well, which the
 * popup asks for, one origin at a time, when `blockedEmbeds` reports one.
 */

import { siteOf } from '../common/util.js';

// Rooted paths: Firefox resolves a relative one against the calling page.
const CONTENT_FILES = ['/src/content/extract.js', '/src/content/fill.js'];

/** Inject the content scripts into every reachable frame. */
export async function injectAll(tabId, files = CONTENT_FILES) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files });
  } catch {
    // A frame that refuses injection must not stop the page itself being read.
    await chrome.scripting.executeScript({ target: { tabId }, files });
  }
}

/**
 * Run a function in frames and return [{frameId, result}]. With no frameIds
 * it runs everywhere reachable, falling back to the top frame alone.
 */
export async function runInFrames(tabId, func, args = [], frameIds = null) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  let results;
  try {
    results = await chrome.scripting.executeScript({ target, func, args });
  } catch (err) {
    if (frameIds) throw err;
    results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  }
  return (results || [])
    .filter(r => r && r.result !== undefined && r.result !== null)
    .map(r => ({ frameId: r.frameId || 0, result: r.result }));
}

/**
 * Count the page's own requests in flight, so a fill can wait for them: forms
 * such as Ashby's save every answer to their server as it changes and submit
 * the server's copy, so an answer whose save had not landed is "missing"
 * though the box shows it. Runs in the page's world (the only place its
 * fetch and XMLHttpRequest can be seen) and keeps the count in one attribute
 * on <html>. Where the browser will not allow that, the waits are skipped.
 */
export async function trackRequests(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => {
        if (window.__applicatorCounting) return;
        window.__applicatorCounting = true;
        let n = 0;
        const note = d => { n = Math.max(0, n + d); document.documentElement.setAttribute('data-applicator-pending', String(n)); };
        // A request still open after 20 s is a long-lived connection (a poll,
        // a stream, a captcha), not an answer being saved: it stops counting,
        // or every field waited out its whole limit (Lyft's Greenhouse frame:
        // 98 s for one page).
        const begin = () => {
          let open = true;
          note(1);
          const end = () => { if (open) { open = false; clearTimeout(timer); note(-1); } };
          const timer = setTimeout(end, 20000);
          return end;
        };
        const fetch0 = window.fetch;
        if (fetch0) {
          window.fetch = function (...args) {
            const end = begin();
            return fetch0.apply(this, args).finally(end);
          };
        }
        const send0 = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function (...args) {
          this.addEventListener('loadend', begin(), { once: true });
          return send0.apply(this, args);
        };
        note(0);
      }
    });
  } catch {
    // Not allowed here: fills go ahead without waiting for the page's saves.
  }
}

/**
 * Load embedded forms the page has not loaded yet. A careers page often
 * embeds its Greenhouse form as a lazy iframe far down the page (Lyft's,
 * 2,000 px below the fold): until scrolled to it holds no document, nothing
 * in it can be read, and it looked like a frame phil had no access to.
 * Each lazy frame is told to load now, and the read waits for it (at most
 * 8 s). Nothing happens on a page without one.
 */
export async function wakeEmbeds(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => new Promise(resolve => {
        const lazy = [...document.querySelectorAll('iframe[loading="lazy"]')].filter(f => f.src && !f.dataset.applicatorWoken);
        if (!lazy.length) return resolve(0);
        let left = lazy.length;
        const done = () => { if (--left <= 0) resolve(lazy.length); };
        for (const f of lazy) {
          f.dataset.applicatorWoken = '1';
          f.addEventListener('load', done, { once: true });
          f.loading = 'eager';
        }
        setTimeout(() => resolve(lazy.length), 8000);
      })
    });
  } catch {
    // A page that refuses the script is read as it is.
  }
}

/**
 * Open the form's collapsed sections. SuccessFactors' career portal (PG&E)
 * shows only its section bars, "Profile Information", "Education" and so on,
 * each a button with aria-expanded="false": all 68 boxes were in the page but
 * hidden, and phil saw one language picker. A toggle is opened when the section
 * it heads holds form boxes none of which can be seen; dropdown triggers, menus
 * and navigation are not sections. A closed <details> holding boxes is opened
 * too. Waits up to 2 s for the opened sections to show their boxes.
 */
export async function openSections(tabId, sections = {}) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [sections],
      func: sections => new Promise(resolve => {
        const BOXES = 'input:not([type=hidden]), select, textarea, [role=combobox], [role=listbox], [role=radiogroup]';
        // The rules pack may name other toggles, or more places a toggle is not a section.
        const TOGGLES = sections.toggles || 'button[aria-expanded="false"], [role=button][aria-expanded="false"], a[aria-expanded="false"]';
        const NOT_IN = sections.notIn || 'nav, header, [role=menu], [role=menubar], [role=listbox], [role=combobox]';
        const WAIT = Number(sections.waitMs) || 2000;
        const seen = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
        const hidden = region => {
          const boxes = [...region.querySelectorAll(BOXES)];
          return boxes.length > 0 && !boxes.some(seen);
        };
        let toggles = [];
        try { toggles = [...document.querySelectorAll(TOGGLES)]; } catch { toggles = [...document.querySelectorAll('button[aria-expanded="false"]')]; }
        const notIn = t => { try { return !!t.closest(NOT_IN); } catch { return false; } };
        toggles = toggles.filter(t => seen(t) && !notIn(t)
            && !t.hasAttribute('aria-haspopup') && !t.matches('input, [role=combobox]'));
        // What a toggle opens: the region it names, else the nearest
        // ancestor holding boxes, provided it heads no other toggle's section.
        const regionOf = t => {
          const named = (t.getAttribute('aria-controls') || '').split(/\s+/).map(id => id && document.getElementById(id)).find(Boolean);
          if (named) return named;
          for (let el = t.parentElement, i = 0; el && el !== document.body && i < 5; el = el.parentElement, i++) {
            if (!el.querySelector(BOXES)) continue;
            return toggles.some(o => o !== t && el.contains(o)) ? null : el;
          }
          return null;
        };
        const opened = [];
        for (const t of toggles) {
          const region = regionOf(t);
          if (!region || !hidden(region)) continue;
          for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
            t.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, view: window }));
          }
          // SuccessFactors' section bars are buttons with no type, in the
          // form: a submit set off by this click is stopped.
          const form = t.tagName === 'BUTTON' && t.type === 'submit' ? t.form : null;
          const hold = e => e.preventDefault();
          form?.addEventListener('submit', hold, true);
          try { t.click(); } finally { form?.removeEventListener('submit', hold, true); }
          opened.push(region);
        }
        for (const d of document.querySelectorAll('details:not([open])')) {
          if (d.querySelector(BOXES)) { d.open = true; opened.push(d); }
        }
        if (!opened.length) return resolve(0);
        const started = Date.now();
        const check = () => {
          if (opened.every(r => !hidden(r)) || Date.now() - started > WAIT) return resolve(opened.length);
          setTimeout(check, 50);
        };
        check();
      })
    });
  } catch {
    // A page that refuses the script is read as it is.
  }
}

/**
 * Read every frame of the tab. With `probe`, custom dropdowns are opened to
 * read their options, and collapsed sections are opened; only a fill does that.
 */
export async function extractAll(tabId, { probe = false, skip = [], context = false, structure = false, rules = null } = {}) {
  await wakeEmbeds(tabId);
  if (probe) await openSections(tabId, rules?.sections || {});
  await injectAll(tabId);
  const results = await runInFrames(tabId, opts => globalThis.__applicatorExtract?.(opts) || null, [{ probe, skip, context, structure, rules: rules || {} }]);
  return mergeExtractions(results);
}

/**
 * One extraction for the whole tab.
 *
 * Field and upload ids are made unique across frames by prefixing the frame,
 * and each carries `frameId` so the filler can be sent to the right one. The
 * page context comes from the top frame unless the form lives in an embed
 * that knows the role better.
 */
export function mergeExtractions(results) {
  const ok = (results || []).filter(r => r.result?.ok);
  const top = ok.find(r => r.frameId === 0) || ok[0];
  const tag = (frameId, id) => (frameId ? `${frameId}:${id}` : id);

  const fields = [];
  const uploads = [];
  let skippedSensitive = 0;
  let skippedTraps = 0;
  const texts = [];

  for (const { frameId, result } of ok) {
    // The second and later boxes with one id and name, in page order: what
    // tells them apart from one pass to the next (fieldIdentity).
    const seen = new Map();
    for (const f of result.fields || []) {
      const handle = f.idAttr || f.name ? `${f.idAttr || ''}#${f.name || ''}` : '';
      const n = handle ? (seen.get(handle) || 0) : 0;
      if (handle) seen.set(handle, n + 1);
      fields.push({ ...f, id: tag(frameId, f.id), frameId, ...(n ? { handleIndex: n } : {}) });
    }
    for (const u of result.uploads || []) uploads.push({ ...u, frameId });
    skippedSensitive += result.skippedSensitive || 0;
    skippedTraps += result.skippedTraps || 0;
    if (result.pageText) texts.push(result.pageText);
  }

  // The frame holding most of the form describes the job best when the top
  // page is only a wrapper around it.
  const busiest = ok.slice().sort((a, b) => (b.result.fields?.length || 0) - (a.result.fields?.length || 0))[0];
  const topContext = top?.result.context || {};
  const context = busiest && busiest !== top && !(top?.result.fields?.length)
    ? { ...busiest.result.context, role: busiest.result.context?.role || topContext.role, company: topContext.company || busiest.result.context?.company }
    : topContext;

  return {
    ok: ok.length > 0,
    fields,
    uploads,
    skippedSensitive,
    skippedTraps,
    pageText: texts.join('\n').slice(0, 60000),
    context: { ...context, multiStep: ok.some(r => r.result.context?.multiStep) },
    // Questions on the form no field was read for, from every frame.
    unread: ok.flatMap(r => r.result.unread || []).slice(0, 10),
    // The platforms whose markers any frame holds (rulespack.detectPlatform).
    platformMarkers: [...new Set(ok.flatMap(r => r.result.platformMarkers || []))],
    addButtons: ok.flatMap(r => (r.result.addButtons || []).map(b => ({ ...b, frameId: r.frameId }))).slice(0, 8),
    blocked: blockedEmbeds(ok),
    frames: ok.length,
    // Each frame's page lines, field ids tagged like the fields (structure.js).
    structures: ok.filter(r => r.result.structure?.lines?.length).map(({ frameId, result }) => ({
      frameId,
      offset: result.structure.offset,
      lines: result.structure.lines,
      fields: Object.fromEntries(Object.entries(result.structure.fields).map(([id, v]) => [tag(frameId, id), v]))
    }))
  };
}

/**
 * Embedded frames from another site that did not answer, which means the
 * extension has no access to them yet. Reported by origin, deduplicated.
 */
export function blockedEmbeds(results) {
  // By site: an embed from boards.greenhouse.io that answered from
  // job-boards.greenhouse.io, where it redirected, was reached.
  const answered = new Set(results.map(r => r.result?.origin).filter(Boolean).map(o => `${o.split(':')[0]}:${siteOf(o)}`));
  const out = [];
  for (const r of results) {
    for (const embed of r.result?.embeds || []) {
      if (answered.has(`${embed.origin.split(':')[0]}:${siteOf(embed.origin)}`) || out.includes(embed.origin)) continue;
      out.push(embed.origin);
    }
  }
  return out;
}

/** Group planned items by the frame they belong to. */
export function byFrame(items) {
  const groups = new Map();
  for (const item of items) {
    const id = item.frameId || 0;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
  }
  return groups;
}
