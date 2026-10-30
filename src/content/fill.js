/**
 * Form filling, injected into the active tab.
 *
 * Setting `el.value` directly is invisible to React, Vue and Angular, which
 * track their own state. Every write here goes through the native property
 * setter and then dispatches the input and change events the framework is
 * listening for, which is what makes the value survive a re-render.
 *
 * Applicator never clicks a submit button. The user reviews and submits.
 */

(() => {
  const HIGHLIGHT_CLASS = 'applicator-filled';
  const REVIEW_CLASS = 'applicator-review';

  /**
   * What a person sees of a control, for its outline. A dropdown's search
   * input is a few pixels wide inside the box drawn around it (react-select),
   * and an outline on it cannot be seen.
   */
  function shownBox(el) {
    const control = el.closest?.('[class*="__control"], [class*="-control"]:not(input)');
    if (control && control !== el && control.contains(el)) return control;
    if (el.tagName !== 'INPUT' || el.getBoundingClientRect().width >= 40) return el;
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 5; n = n.parentElement, i++) {
      const box = n.getBoundingClientRect();
      if (box.width >= 80 && box.height >= 16) return n;
    }
    return el;
  }

  const FORBIDDEN_TYPES = new Set(['password', 'hidden', 'file', 'image', 'submit', 'reset', 'button']);
  const FORBIDDEN_PATTERNS = [
    /pass(word|phrase)/i, /\bpin\b/i, /\bcvv\b|\bcvc\b/i, /card[-_ ]?number/i,
    /routing[-_ ]?number|account[-_ ]?number|iban/i, /ssn|social[-_ ]?security/i,
    /passport[-_ ]?number/i, /date[-_ ]?of[-_ ]?birth|\bdob\b/i,
    /\botp\b|one[-_ ]?time[-_ ]?code|verification[-_ ]?code/i
  ];

  const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  // Cancel in the popup stops the fill here too: every wait ends, typing and
  // pressing stop, and the fields not yet written are left. A flag on the
  // page, since each fill injects this script afresh.
  const stopped = () => globalThis.__applicatorStopped === true;
  function stop() {
    globalThis.__applicatorStopped = true;
    return { ok: true };
  }

  /**
   * Find a control by the extractor's selector. A selector for a control
   * inside a web component is a chain through shadow hosts, joined by " >>> ".
   */
  function find(selector) {
    let node = null;
    let scope = document;
    for (const part of String(selector || '').split(' >>> ')) {
      try {
        node = scope?.querySelector(part) || null;
      } catch {
        return null;
      }
      scope = node?.shadowRoot || null;
    }
    return node;
  }

  /** Every element matching `selector`, including inside open shadow roots. */
  function findAll(selector, root = document, out = []) {
    for (const el of root.querySelectorAll('*')) {
      if (el.matches(selector)) out.push(el);
      if (el.shadowRoot) findAll(selector, el.shadowRoot, out);
    }
    return out;
  }

  /** Inside a shadow root the focused element is the root's, not the document's. */
  /**
   * How fast this connection is, from the page's own downloads (the browser
   * already timed them; nothing extra is fetched): median throughput of the
   * larger files it loaded. Slow means waits for server answers (suggestion
   * lists, uploads) are stretched, so a weak hotspot does not read as "no
   * matching option". Checked once per page.
   */
  let network;
  function networkSpeed() {
    if (network) return network;
    // The download alone: a request's whole duration also counts its time in
    // the queue and the server's thinking, which made Workday's line look a
    // third of its speed and every wait four times longer.
    const rates = performance.getEntriesByType('resource')
      .filter(e => e.transferSize > 20000 && e.responseEnd - e.responseStart > 5)
      .map(e => e.transferSize / (e.responseEnd - e.responseStart)) // bytes per ms = kB/s
      .sort((a, b) => a - b);
    const kBps = rates.length ? Math.round(rates[Math.floor(rates.length / 2)]) : null;
    network = { kBps, slow: kBps !== null && kBps < 150 };
    return network;
  }
  const waitScale = () => (networkSpeed().slow ? 4 : 1);

  /**
   * Wait until the page has no requests of its own in flight, for a moment
   * (frames.js trackRequests keeps the count). A form that saves each answer
   * to its server needs its session ready before the first answer and every
   * save landed after the last. Without a count, nothing is waited for.
   */
  function pageIdle(ms, quiet = 300) {
    const pending = () => Number(document.documentElement.getAttribute('data-applicator-pending'));
    if (Number.isNaN(pending()) || document.documentElement.getAttribute('data-applicator-pending') === null) return Promise.resolve(true);
    return new Promise(resolve => {
      const deadline = Date.now() + ms;
      let calmSince = 0;
      const check = () => {
        if (Date.now() > deadline) return resolve(false);
        if (pending() > 0) calmSince = 0;
        else if (!calmSince) calmSince = Date.now();
        else if (Date.now() - calmSince >= quiet) return resolve(true);
        waitFor(() => false, 100).then(check);
      };
      check();
    });
  }

  const hasRealFocus = el => document.hasFocus() && el.getRootNode().activeElement === el;

  function nativeSet(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function announce(el, events = ['input', 'change']) {
    for (const type of events) {
      el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    }
  }

  /**
   * Focus and blur that a framework will actually hear.
   *
   * Many forms (Ashby among them) commit a field's value to their own state
   * only when it loses focus, and React hears that through `focusout`. When
   * the user has just clicked the toolbar button, the page does not have
   * focus, so `el.focus()` and `el.blur()` fire nothing at all: the box shows
   * the text while the form still believes it is empty, and submitting fails
   * with "missing entry". In that case the events are sent explicitly.
   */
  // Whether the browser itself fired `type` on el during act(). Asking whether
  // the page has focus first is not enough: the window can lose focus to
  // another app mid-fill, and then blur() fires nothing for that one box.
  function fired(el, type, act) {
    let heard = false;
    const hear = () => { heard = true; };
    el.addEventListener(type, hear, true);
    try { act(); } finally { el.removeEventListener(type, hear, true); }
    return heard;
  }

  function focusIn(el) {
    if (fired(el, 'focusin', () => el.focus({ preventScroll: true }))) return;
    if (hasRealFocus(el)) return; // already focused: nothing new to hear
    el.dispatchEvent(new FocusEvent('focus', { composed: true }));
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
  }

  function focusOut(el) {
    if (fired(el, 'focusout', () => el.blur())) return;
    el.dispatchEvent(new FocusEvent('blur', { composed: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
  }

  /**
   * The editable page of a framed rich-text editor (TinyMCE, CKEditor 4): the
   * editor hides the real textarea and draws its own document in a frame
   * beside it, where a person types. Null for anything else.
   */
  function framedEditor(el) {
    if (!el || el.tagName !== 'TEXTAREA' || !el.parentElement) return null;
    for (const frame of el.parentElement.querySelectorAll('iframe')) {
      let doc = null;
      try { doc = frame.contentDocument; } catch { doc = null; }
      const body = doc?.body;
      if (body && (body.isContentEditable || doc.designMode === 'on') && frame.getClientRects().length) return body;
    }
    return null;
  }

  const readBack = el => (framedEditor(el)?.textContent ?? (el.isContentEditable ? el.textContent : el.value)) || '';
  const digits = v => String(v || '').replace(/\D/g, '');

  /**
   * Whether the box now holds what was meant. A masked box reformats what it
   * is given ("4155550134" becomes "(415) 555-0134", and a US-only mask drops
   * the +1), so a value made of digits counts when the digits agree.
   */
  function accepted(el, value) {
    const got = readBack(el);
    if (norm(got) === norm(value)) return true;
    // A mask still showing empty slots ("(603) 814-694_") lost digits.
    if (/_/.test(got) && !/_/.test(String(value))) return false;
    const want = digits(value);
    const have = digits(got);
    if (want.length >= 6 && have.length >= 6 && have.endsWith(want)) return true;
    // Fewer digits only as a dropped country code: the box keeps the last ten
    // (CalCareers' mask once dropped an area-code digit instead).
    if (want.length > 10 && have === want.slice(-10)) return true;
    return false;
  }

  /** Typing into a framework-controlled box: focus, set, announce, blur. */
  function setOnce(el, value) {
    const editor = framedEditor(el);
    if (editor) {
      // Paragraphs in the editor's own page, where the editor reads them from
      // when the form is sent, and the same text in its textarea.
      const doc = editor.ownerDocument;
      editor.replaceChildren(...String(value).split(/\n+/).map(line => {
        const p = doc.createElement('p');
        p.textContent = line;
        return p;
      }));
      for (const type of ['input', 'keyup', 'change']) editor.dispatchEvent(new Event(type, { bubbles: true }));
      nativeSet(el, value);
      announce(el);
      return;
    }
    focusIn(el);
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    } else {
      nativeSet(el, value);
      announce(el);
    }
    focusOut(el);
  }

  /**
   * Type one character at a time, the way a person does. Input masks and
   * some validators ignore a value that arrives all at once, and only accept
   * characters they saw go in through key and input events.
   */
  function typeInto(el, value) {
    focusIn(el);
    nativeSet(el, '');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
    for (const ch of String(value)) {
      const init = { key: ch, bubbles: true, composed: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', init));
      const before = new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true, inputType: 'insertText', data: ch });
      if (el.dispatchEvent(before)) {
        nativeSet(el, (el.value || '') + ch);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ch }));
      }
      el.dispatchEvent(new KeyboardEvent('keyup', init));
    }
    announce(el, ['change']);
    focusOut(el);
  }

  /**
   * Write text and confirm it stuck. When a box rejects the whole value, it
   * is typed instead, and a phone number is retried without its country code
   * for boxes that only take a national number.
   *
   * @returns {{ok: boolean, altered?: boolean, reason?: string}}
   */
  function setText(el, value, field = {}) {
    setOnce(el, value);
    if (accepted(el, value) || el.isContentEditable || framedEditor(el)) return { ok: accepted(el, value) || readBack(el) !== '' };

    const tries = [value];
    const phone = /tel/.test(field.type || '') || /phone|mobile|cell/i.test(`${field.label || ''} ${field.name || ''}`);
    if (phone && digits(value).length > 10) tries.push(digits(value).slice(-10));
    else if (digits(value).length >= 6 && digits(value) !== value) tries.push(digits(value));

    for (const attempt of tries) {
      typeInto(el, attempt);
      if (accepted(el, attempt) || accepted(el, value)) return { ok: true };
    }
    // Something went in, but not what was meant: keep it, flagged for review.
    if (readBack(el).trim()) return { ok: true, altered: true };
    return { ok: false, reason: 'The page did not accept the value' };
  }

  function setSelect(el, value) {
    const target = norm(value);
    const options = Array.from(el.options);
    const match =
      options.find(o => norm(o.textContent) === target) ||
      options.find(o => norm(o.value) === target) ||
      options.find(o => norm(o.textContent).startsWith(target)) ||
      options.find(o => target && norm(o.textContent).includes(target));

    if (!match) return false;
    // Already showing it: no change event, which on PeopleSoft is a round trip
    // to the server that can wipe the next box written while it is in flight.
    if (el.selectedIndex === match.index) return true;

    focusIn(el);
    nativeSet(el, match.value);
    el.selectedIndex = match.index;
    announce(el);
    focusOut(el);
    return true;
  }

  function setRadio(field, value) {
    const target = norm(value);
    for (const option of field.options || []) {
      if (norm(option.label) !== target && norm(option.value) !== target) continue;
      const radio = option.selector ? find(option.selector) : null;
      if (!radio) continue;
      focusIn(radio);
      radio.click();
      if (!radio.checked) {
        radio.checked = true;
        announce(radio, ['click', 'input', 'change']);
      }
      focusOut(radio);
      return radio;
    }
    return null;
  }

  function setCheckbox(el, value) {
    const wanted = /^(true|yes|checked|on|1)$/i.test(String(value).trim());
    focusIn(el);
    if (el.checked !== wanted) {
      el.click();
      if (el.checked !== wanted) {
        el.checked = wanted;
        announce(el, ['click', 'input', 'change']);
      }
    }
    focusOut(el);
    return true;
  }

  const isChecked = el => el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || !!el.checked;

  /** Press an element the way a pointer does; many widgets ignore a bare click(). */
  function press(el) {
    const opts = { bubbles: true, composed: true, cancelable: true, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    // A button in a form submits it unless told otherwise (Ashby's Yes/No).
    // Applicator never submits: a submit set off by this click is stopped.
    const form = el.tagName === 'BUTTON' && el.type === 'submit' ? el.form : null;
    const hold = e => e.preventDefault();
    form?.addEventListener('submit', hold, true);
    try {
      el.click();
    } finally {
      form?.removeEventListener('submit', hold, true);
    }
  }

  async function setAriaRadio(field, value) {
    const option = chooseOption((field.options || []).map(o => o.label), value);
    if (option < 0) return null;
    const radio = find(field.options[option].selector);
    if (!radio) return null;
    if (!isChecked(radio)) {
      press(radio);
      // React marks the choice on its next render, not during the click.
      await waitFor(() => isChecked(radio), 600);
      // Workable's wrapper answers only a click on its own hidden radio.
      const own = radio.querySelector('input[type="radio"]');
      if (!isChecked(radio) && own) {
        own.click();
        await waitFor(() => isChecked(radio), 600);
      }
    }
    return isChecked(radio) ? radio : null;
  }

  /** Tick the box in a group whose label answers `value`; others are left as they are. */
  async function setCheckboxInGroup(field, value) {
    // Several answers, one per line ("US", "EU"): each is ticked.
    const many = String(value ?? '').split('\n').map(v => v.trim()).filter(Boolean);
    if (many.length > 1) {
      const boxes = [];
      for (const v of many) boxes.push(await setCheckboxInGroup(field, v));
      return boxes.every(Boolean) ? boxes[0] : null;
    }
    const i = chooseOption((field.options || []).map(o => o.label), value);
    if (i < 0) return null;
    const box = find(field.options[i].selector);
    if (!box) return null;
    if (!isChecked(box)) {
      if (box.tagName === 'INPUT') {
        box.click();
        if (!box.checked) {
          box.checked = true;
          announce(box, ['click', 'input', 'change']);
        }
      } else {
        press(box);
        // A button drawn as a tick box (Fillout) shows it a render later.
        await waitFor(() => isChecked(box), 600);
      }
    }
    return isChecked(box) ? box : null;
  }

  async function setAriaCheckbox(el, value) {
    const wanted = /^(true|yes|checked|on|1)$/i.test(String(value).trim());
    if (isChecked(el) !== wanted) {
      press(el);
      await waitFor(() => isChecked(el) === wanted, 600);
    }
    return isChecked(el) === wanted;
  }

  /**
   * Which of these option texts answers `value`: the same words, then the
   * start of an option, then yes/no by meaning. -1 when none does.
   */
  function chooseOption(labels, value) {
    const want = norm(value);
    const list = labels.map(norm);
    let i = list.indexOf(want);
    if (i >= 0) return i;
    if (!want) return -1;
    i = list.findIndex(l => l.startsWith(want));
    if (i >= 0) return i;
    if (/^(yes|true)$/.test(want)) return list.findIndex(l => /^(yes|y|i am|i do|i agree|i can)\b/.test(l));
    if (/^(no|false)$/.test(want)) return list.findIndex(l => /^(no|n|i am not|i do not|i don't|i cannot)\b/.test(l));
    return want.length > 2 ? list.findIndex(l => l.includes(want)) : -1;
  }

  const OPTION_LIKE = '[role="option"], [class*="__option" i], [class*="-option" i]';
  // A class only counts when it names the option itself ("select__option"),
  // not a piece inside one ("...-option-container-code": SmartRecruiters).
  const isOptionEl = o => o.getAttribute('role') === 'option' ||
    [...(o.classList || [])].some(c => /(__|-)option$/i.test(c));

  /** Options on screen now: ARIA options, or react-select's classed ones. */
  function visibleOptions() {
    return findAll(OPTION_LIKE).filter(o => isOptionEl(o) && o.tagName !== 'OPTION' && visible(o) &&
      ![...o.querySelectorAll(OPTION_LIKE)].some(isOptionEl) && o.getAttribute('aria-disabled') !== 'true' &&
      !/notice|group-heading/i.test(o.className?.baseVal ?? o.className ?? '') &&
      (o.textContent || '').trim() && !/^(no (options|results|items|matches)|nothing found|loading)/i.test((o.textContent || '').trim()) &&
      // An entry the site keeps but retired ("Airflow_Do Not Use") is never chosen.
      !RETIRED.test(o.textContent || ''));
  }
  const RETIRED = /\bdo[\s_-]*not[\s_-]*use\b|\bdeprecated\b|\binactive\b|\bobsolete\b|\bretired\b|\bdon'?t use\b/i;

  const optionText = o => (o.textContent || '').replace(/\s+/g, ' ').trim();

  const SUGGESTION_BOX = /(dropdown|results|suggest|autocomplete|typeahead|predictions)/i;

  /**
   * Entries of a suggestion list a plain text box draws beside itself, with
   * no ARIA roles to find them by (Lever's location: <div class=
   * "dropdown-results"><div class="dropdown-location">...</div></div>). The
   * innermost visible elements with text count as entries.
   */
  function nearSuggestions(trigger) {
    const boxes = Array.from(trigger.parentElement?.children || [])
      .filter(c => c !== trigger && SUGGESTION_BOX.test(c.getAttribute?.('class') || ''));
    const out = [];
    for (const box of boxes) {
      for (const el of box.querySelectorAll('*')) {
        if (!visible(el) || !optionText(el)) continue;
        const shown = Array.from(el.children).filter(c => visible(c) && optionText(c));
        // A wrapper around its only entry repeats the entry; one around
        // several is the list itself ("Berkeley, CA, USABerkeley, NJ, USA"),
        // not an entry to click.
        if (shown.some(c => optionText(c) === optionText(el)) || shown.length > 1) continue;
        if (/no (location|results?)|loading|try entering/i.test(optionText(el))) continue;
        out.push(el);
      }
    }
    return out;
  }

  async function waitForNewOptions(before, ms) {
    const fresh = () => { const f = visibleOptions().filter(o => !before.has(o)); return f.length ? f : null; };
    const found = await waitFor(fresh, ms);
    if (found) return found;
    // A list that loads its options shows a notice first (Greenhouse's in a
    // slow frame took ~2 s): the options are on their way, so wait for them
    // rather than typing into it as if it were a text box.
    const loading = findAll('[class*="loading" i], [aria-busy="true"]').some(n => n.getClientRects().length > 0 && /loading|\u2026|\.\.\./i.test(n.textContent || n.className || ''));
    return loading ? (await waitFor(fresh, 3000 * waitScale())) || [] : [];
  }

  /**
   * A whole key press, down and up. Widgets differ in which half they act
   * on: react-select opens on keydown, Greenhouse's wrapper only on keyup.
   */
  const KEY_CODES = { ArrowDown: 40, Escape: 27, Enter: 13 };
  function key(el, name) {
    const init = { key: name, code: name, keyCode: KEY_CODES[name], which: KEY_CODES[name], bubbles: true, composed: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  /**
   * Type a search into a box one character at a time, each with its key down,
   * key press, input and key up, the way a keyboard does. Search boxes listen
   * to different parts of that: Lever's location box ignores a value that
   * arrives in one input event and searches only on typed keys.
   */
  async function typeQuery(el, value) {
    const text = String(value);
    nativeSet(el, '');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
    for (const ch of text) {
      if (stopped()) return;
      const code = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0);
      const init = {
        key: ch, code: /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : /\d/.test(ch) ? `Digit${ch}` : ch === ' ' ? 'Space' : '',
        keyCode: code, which: code, charCode: ch.charCodeAt(0), bubbles: true, composed: true, cancelable: true
      };
      el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keypress', init));
      nativeSet(el, (el.value || '') + ch);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ch }));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
      await yieldToPage();
    }
  }


  /**
   * Type a search, and press Enter when no list comes up for the typing
   * alone: Workday's school box searches only on Enter, then shows the
   * schools to choose from. Enter is only pressed with nothing listed, so it
   * never chooses an entry by itself.
   */
  async function typeAndSearch(el, value, fresh) {
    const shownBefore = fresh().map(optionText).join('|');
    // Workday redraws its search box while it is typed into, and letters
    // landed out of order ("Pyhton"): the whole search goes in at once, and
    // is put in again until the box holds it.
    if (isPrompt(el)) {
      for (let tries = 0; tries < 3 && !stopped(); tries++) {
        focusIn(el);
        nativeSet(el, '');
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
        nativeSet(el, String(value));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertFromPaste', data: String(value) }));
        await yieldToPage();
        if (el.value === String(value)) break;
        await new Promise(r => setTimeout(r, 150));
      }
    } else {
      await typeQuery(el, value);
    }
    if (stopped()) return;
    // Workday's prompt searches only on Enter, and until then keeps showing
    // the last search's results: Enter always, then the new list.
    if (isPrompt(el)) {
      key(el, 'Enter');
      await waitFor(() => { const now = fresh().map(optionText).join('|'); return now && now !== shownBefore; }, 2500 * waitScale());
      return;
    }
    // A list that shows up but has nothing to do with the typing is the
    // whole list opening (Workday's Field of Study: "Accident and Emergency
    // Care..." for "Computer Science"); Enter is what searches it.
    const asked = wordsOf(value);
    const related = () => fresh().some(o => wordsOf(optionText(o)).some(w => asked.some(a => w.startsWith(a))));
    const listed = await waitFor(related, 800);
    if (!listed && !stopped()) key(el, 'Enter');
  }

  /**
   * A prompt that takes several entries (Workday's "Type to Add Skills"):
   * each saved one searched and clicked in turn. One the list does not have
   * is left out; never "Other".
   */
  async function setMany(el, field) {
    // One per line when the entries' own names may hold commas (the second
    // round, with the list's own names); otherwise the saved "A, B, C".
    const text = String(field.value);
    const items = (text.includes('\n') ? text.split(/\s*\n\s*/) : text.split(/\s*[,;]\s*/)).filter(Boolean).slice(0, 10);
    let picked = 0;
    // A skill with no entry of its own: what the list offered for it, for the
    // model to say whether one is close enough.
    const unmatched = [];
    for (const item of items) {
      if (stopped()) break;
      if (promptPicked(el).split(' | ').includes(norm(item))) { picked++; continue; }
      const r = await setListbox(el, item, { ...field, value: item });
      if (r.ok) picked++;
      else if (r.options?.length) unmatched.push({ skill: item, options: r.options.slice(0, 20) });
    }
    // A prompt that takes several keeps its list open, and the last search
    // typed in its box: both cleared, so nothing is left half-typed.
    closeList(el);
    if (el.value) {
      nativeSet(el, '');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
    }
    focusOut(el);
    press(document.body);
    return picked ? { ok: true, unmatched, ...(picked < items.length ? { altered: true } : {}) }
      : { ok: false, unmatched, reason: 'None of your skills is in this list' };
  }

  /**
   * What to press to choose a list entry: Workday listens on the node inside
   * it, and a click does not travel down to it (a lone result only looked
   * chosen because Enter picks it).
   */
  const entryTarget = o => o.querySelector?.('[data-automation-id="promptLeafNode"], [data-automation-id="promptOption"]') || o;

  /** The list once it has stopped changing for a moment (or [] if none came, or it says it has none). */
  async function settledList(fresh, ms) {
    let last = null, since = Date.now();
    const got = await waitFor(() => {
      const shown = fresh();
      if (!shown.length) return saysNoResults() ? [] : null;
      const text = shown.map(optionText).join('|');
      if (text !== last) { last = text; since = Date.now(); return null; }
      return Date.now() - since > 500 ? shown : null;
    }, ms);
    return got || fresh();
  }

  /** An open list saying it found nothing ("No Items.", "No results"). */
  const saysNoResults = () => [...document.querySelectorAll('[role="listbox"] *, [data-automation-id="activeListContainer"] *, [class*="menu" i] *')]
    .some(n => !n.children.length && visible(n) && /^(no (items|results|matches|options)( found)?\.?|nothing found)$/i.test((n.textContent || '').trim()));

  /** Only the entries of this control's own list (see extract.js ownOptions). */
  function ownOptions(el, options) {
    const id = el.getAttribute('data-uxi-multiselect-id');
    if (id) return options.filter(o => o.matches?.(`[data-uxi-multiselect-id="${id}"]`) || o.querySelector?.(`[data-uxi-multiselect-id="${id}"]`));
    const lists = `${el.getAttribute('aria-controls') || ''} ${el.getAttribute('aria-owns') || ''}`.split(/\s+/).filter(Boolean)
      .map(i => el.getRootNode().getElementById?.(i) || document.getElementById(i)).filter(Boolean);
    const mine = lists.length ? options.filter(o => lists.some(l => l.contains(o))) : [];
    // A list the box names as its own is the only one that is: another
    // box's list, opening late, is not this one's (SuccessFactors' country
    // list was read as the next box's Yes/No). A named node that holds the
    // box itself is a wrapper, not the list, and says nothing.
    if (!mine.length && lists.length && !lists.some(l => l.contains(el))) return [];
    return mine.length ? mine : options;
  }

  /** Workday's search prompt: a box whose choices are pills beside it. */
  const isPrompt = el => el?.tagName === 'INPUT' && el.getAttribute('data-uxi-widget-type') === 'selectinput';

  /** The entries a prompt holds as chosen, as one text ('' for none). */
  function promptPicked(trigger) {
    const box = trigger.closest('[data-automation-id="multiSelectContainer"]') || trigger.parentElement?.parentElement;
    if (!box) return '';
    const pills = [...box.querySelectorAll('[data-automation-id="selectedItemList"] [data-automation-id="promptOption"], [data-automation-id="selectedItem"]')]
      .map(p => norm(p.getAttribute('data-automation-label') || p.textContent)).filter(Boolean);
    if (pills.length) return [...new Set(pills)].join(' | ');
    const said = /\d+ items? selected,?\s*(.*)$/i.exec(box.querySelector('[data-automation-id="promptAriaInstruction"]')?.textContent || '');
    return said ? norm(said[1]) : '';
  }

  /** What the dropdown shows as chosen, whether on itself or beside its input. */
  const PROMPT = /^(select|choose|please (select|choose)|pick|--|—)|\.\.\.$|…$/;

  /**
   * What the dropdown shows as chosen: its own text, or, when the trigger is
   * an input (react-select) or an empty button beside the value (Greenhouse's
   * newer forms), the text drawn next to it.
   */
  function shownChoice(trigger) {
    // A text box that kept the chosen suggestion shows it as its value.
    if (trigger.tagName === 'INPUT' && trigger.value && trigger.value.trim()) return norm(trigger.value);
    let own = '';
    if (trigger.tagName !== 'INPUT') {
      const clone = trigger.cloneNode(true);
      clone.querySelectorAll('svg, title, desc, style, script, template').forEach(n => n.remove());
      own = norm(clone.textContent);
    }
    if (own && !PROMPT.test(own)) return own;
    let node = trigger.parentElement;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      const clone = node.cloneNode(true);
      // A style sheet inside the widget is no choice (Saildrone's react-select).
      clone.querySelectorAll('input, label, svg, title, desc, style, script, template, [class*="placeholder" i], [role="listbox"], [class*="menu" i]').forEach(n => n.remove());
      const shown = norm(clone.textContent);
      if (shown && !PROMPT.test(shown)) return shown;
    }
    return '';
  }

  function closeList(trigger) {
    key(trigger, 'Escape');
    if (trigger !== document.activeElement) key(document.body, 'Escape');
  }

  /**
   * The option to choose among those on screen. With a hint (the state and
   * country beside a city), the option naming the most of it wins, so
   * "Portland, Oregon, United States" beats "Portland, Maine, United States".
   */
  /**
   * The entry that is this value, give or take a note in brackets: "Python
   * (Programming Language)" for Python, "Extract Transform Load (ETL)" for
   * ETL. Not "Airflow Management" for Airflow, nor "SQL Data Mining" for SQL.
   */
  function sameEntry(options, value) {
    const want = norm(value).replace(/[^a-z0-9+#]+/g, ' ').trim();
    const flat = t => norm(t).replace(/[^a-z0-9+#]+/g, ' ').trim();
    const labels = options.map(optionText);
    let i = labels.findIndex(l => flat(l) === want);
    if (i < 0) i = labels.findIndex(l => flat(l.replace(/\([^)]*\)/g, '')) === want);
    if (i < 0) i = labels.findIndex(l => (l.match(/\(([^)]*)\)/g) || []).some(p => flat(p) === want));
    return i;
  }

  function bestOption(options, value, hint) {
    const labels = options.map(optionText);
    const hints = norm(hint).split(/[\s,]+/).filter(h => h.length > 1);
    if (hints.length) {
      const want = norm(value);
      const words = l => new Set(norm(l).split(/[\s,()-]+/));
      const scored = labels
        .map((l, i) => ({ i, l: norm(l), score: hints.filter(h => words(l).has(h)).length }))
        .filter(x => x.l.includes(want));
      scored.sort((a, b) => b.score - a.score || Number(b.l.startsWith(want)) - Number(a.l.startsWith(want)));
      if (scored.length) return scored[0].i;
    }
    return chooseOption(labels, value);
  }

  /**
   * Choose from a dropdown drawn by a design system rather than a <select>:
   * MUI and Radix (a div that opens a list), or react-select (a text input
   * that opens one, used by Greenhouse and others).
   *
   * It is opened the way each library listens (the keyboard, then the
   * pointer), and the option is chosen by its text. When the option is not on
   * screen, as in a long or searchable list, the value is typed to narrow it.
   * The choice counts only if the dropdown then shows it. When no option fits,
   * the options are reported back so the next pass can decide among them.
   */
  async function setListbox(trigger, value, field = {}) {
    trigger.scrollIntoView?.({ block: 'center' });
    // Options already on screen belong to something else (a phone number's
    // country list, say); only ones that appear now are this dropdown's.
    const candidates = () => ownOptions(trigger, field.suggests ? [...visibleOptions(), ...nearSuggestions(trigger)] : visibleOptions());
    const before = new Set(candidates());
    const fresh = () => candidates().filter(o => !before.has(o));
    // The list a trigger names as its own is its own, even if already open.
    const own = () => {
      const ids = `${trigger.getAttribute('aria-controls') || ''} ${trigger.getAttribute('aria-owns') || ''}`.split(/\s+/).filter(Boolean);
      const boxes = ids.map(id => trigger.getRootNode().getElementById?.(id) || document.getElementById(id)).filter(Boolean);
      return visibleOptions().filter(o => boxes.some(b => b.contains(o)));
    };
    focusIn(trigger);
    let options = own();
    // The way this page's dropdowns opened while being read comes first.
    const order = globalThis.__applicatorOpenBy === 'pointer' ? ['pointer', 'keyboard'] : ['keyboard', 'pointer'];
    for (const way of order) {
      // A box that suggests only once typed into has nothing to open.
      if (options.length || field.suggests) break;
      if (way === 'keyboard') key(trigger, 'ArrowDown');
      else press(trigger);
      options = await waitForNewOptions(before, way === 'keyboard' ? 300 : 400);
      if (options.length) globalThis.__applicatorOpenBy = way;
    }
    if (!options.length) options = own();
    // Opened with all its options before anything was typed: a dropdown, not
    // a box that suggests as you type, so free text never answers it. A long
    // list (Greenhouse's schools show their first 100) is searched instead.
    // Workday's search prompts show their whole list (or the last results) when opened: still searched.
    const fixedList = options.length > 0 && options.length < 50 && !field.suggests && !field.prompt && !isPrompt(trigger);
    const opened = options.map(optionText).filter(Boolean).slice(0, 250);

    // One of several (a skill) is only ever the entry that is that skill.
    const pick = (opts, v) => (field.multi || field.exact ? sameEntry(opts, v) : bestOption(opts, v, field.placeHint));
    let i = options.length ? pick(options, value) : -1;
    // An answer decided before this list's options could be read (a drafted
    // "Yes" became "I am willing to relocate" for someone living in the US,
    // Lyft) stands only if it is one of them word for word. Otherwise the
    // options go back and the answer is decided among them.
    if (fixedList && !field.options?.length && !(i >= 0 && norm(optionText(options[i])) === norm(value))) {
      closeList(trigger);
      focusOut(trigger);
      return { ok: false, reason: 'Decided before its options could be read', options: opened, fixedList };
    }
    // Not among those shown: a searchable list narrows as you type, and one
    // that loads from a server needs the typing before it shows anything.
    // A place is searched by its first part ("Portland"); the rest
    // ("California") helps choose among what comes back, which may spell it
    // differently ("CA").
    // Only a place splits at its commas: "Transfer Pathway, Early
    // Start" is one field of study.
    const place = !!field.placeHint || /\b(location|city|town|address|where)\b/i.test(field.label || '');
    const [query, ...rest] = place ? String(value).split(',').map(x => x.trim()) : [String(value).trim()];
    const where = rest.length ? `${rest.join(' ')} ${field.placeHint || ''}` : field.placeHint;
    let broadened = false;
    // One box never holds up the fill: after this, no more searches.
    const giveUpAt = Date.now() + (networkSpeed().slow ? 30000 : 15000);
    const timeLeft = () => !stopped() && Date.now() < giveUpAt;
    if (i < 0 && trigger.tagName === 'INPUT') {
      // Suggestions often come from a server. The wait ends at a match, or
      // once the results have come and held still without one, or the list
      // says it has none: never the whole timeout for a name it lacks.
      const search = async () => {
        let last = null, since = Date.now();
        const hit = await waitFor(() => {
          const shown = fresh();
          let at = shown.length ? pick(shown, value) : -1;
          if (at < 0 && rest.length && shown.length) at = bestOption(shown, query, where);
          if (at >= 0) return { shown, at };
          if (!shown.length) return saysNoResults() ? { none: true } : null;
          const text = shown.map(optionText).join('|');
          if (text !== last) { last = text; since = Date.now(); return null; }
          return Date.now() - since > 700 ? { none: true } : null;
        }, 3000 * waitScale());
        return hit && !hit.none ? hit : null;
      };
      await typeAndSearch(trigger, rest.length ? query : value, fresh);
      let hit = await search();
      // A place search that has shown nothing yet may have been slow, or
      // dropped the typing: type it once more before giving up (Ashby's
      // location box, live, once came back empty).
      if (!hit && !fresh().length && timeLeft()) {
        await typeAndSearch(trigger, rest.length ? query : value, fresh);
        hit = await search();
      }
      // Not listed under its own name (Workday's schools: "Lakeside College"
      // is "Lakeside Community College"): the closest entry, or "Other".
      // Flagged for review.
      // Not listed under its own name. With the matching model at hand, the
      // entries the searches turn up go back to it to say which one means
      // the saved answer (a major, a school); "Other" only if none does.
      // A dropdown that opened by itself goes back with its options instead: the model chooses among them.
      if (!hit && timeLeft() && !rest.length && !field.multi && !field.exact && field.askModel && !fixedList) {
        const found = await gatherEntries(trigger, value, fresh, timeLeft);
        // Workday picks a lone result on Enter: the search may have chosen
        // it already ("Lakeside" found only "Lakeside Community College").
        const pill = (field.prompt || isPrompt(trigger)) ? promptPicked(trigger) : '';
        if (pill && wordsOf(pill).some(w => wordsOf(value).includes(w))) {
          closeList(trigger);
          focusOut(trigger);
          return { ok: true, chosen: pill, altered: true };
        }
        if (trigger.tagName === 'INPUT' && trigger.value) {
          nativeSet(trigger, '');
          trigger.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
        }
        closeList(trigger);
        focusOut(trigger);
        return { ok: false, reason: 'Not listed under its own name', candidates: found };
      }
      if (!hit && timeLeft() && !rest.length && !field.multi && !field.exact && !fixedList) {
        hit = await closestEntry(trigger, value, fresh, timeLeft, field);
        if (hit) broadened = true;
      }
      // A list of countries or states (Runway's Location): the city finds
      // nothing, the broader part of the place does. Flagged for review.
      if (!hit && timeLeft() && (rest.length || field.placeHint)) {
        const broader = [...new Set([...rest, ...String(field.placeHint || '').split(',')].map(x => x.trim()).filter(x => x.length > 3))];
        for (const part of broader) {
          if (!timeLeft()) break;
          await typeAndSearch(trigger, part, fresh);
          hit = await waitFor(() => {
            const shown = fresh();
            const at = shown.length ? chooseOption(shown.map(optionText), part) : -1;
            return at >= 0 ? { shown, at } : null;
          }, 3000 * waitScale());
          if (hit) { broadened = true; break; }
        }
      }
      if (hit) ({ shown: options, at: i } = hit);
      else options = fresh();
    }
    if (i < 0) {
      const labels = (options.length ? options : fresh()).map(optionText).filter(Boolean).slice(0, 250);
      if (trigger.tagName === 'INPUT') {
        nativeSet(trigger, '');
        trigger.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
      }
      closeList(trigger);
      focusOut(trigger);
      return { ok: false, reason: 'No matching option on the page', options: labels.length ? labels : opened, fixedList };
    }

    let chosen = optionText(options[i]);
    let picked = options[i];
    // A list still answering earlier keystrokes redraws in place: React reuses
    // the element for another entry ("United States" became "US Virgin
    // Islands" under the click: ElevenLabs). Wait for it to hold still, then
    // find the chosen entry again by its words.
    if (trigger.tagName === 'INPUT') {
      let last = null;
      let since = Date.now();
      await waitFor(() => {
        const now = visibleOptions().map(optionText).join('|');
        if (now !== last) { last = now; since = Date.now(); }
        return Date.now() - since >= 250;
      }, 1500);
      const again = visibleOptions().filter(o => optionText(o) === chosen);
      if (again.length) picked = again[0];
    }
    const shownBefore = shownChoice(trigger);
    const onScreen = new Set(visibleOptions());
    const listText = () => visibleOptions().map(optionText).join('|');
    const textBefore = listText();
    const wordsBefore = new Set([...onScreen].map(optionText));
    // Workday marks a category with a side arrow; its own list loads from the
    // server, sometimes into the same elements, so it is waited for by text.
    const category = !!picked.closest?.('[data-uxi-multiselectlistitem-hassidecharm="true"]') ||
      /^(true|listbox|menu)$/.test(picked.getAttribute('aria-haspopup') || '');
    // What was typed to search is not a choice: Workday keeps the query in
    // its search box while a category's own list loads.
    const typedBefore = category && trigger.tagName === 'INPUT' ? norm(trigger.value) : '';
    picked.scrollIntoView?.({ block: 'nearest' });
    press(entryTarget(picked));
    if (category) await waitFor(() => listText() !== textBefore && visibleOptions().length > 0, 2500);
    // A control may show only part of the option: "United States +1" as "+1".
    const kept = () => {
      // Workday's prompt keeps the choice as a pill beside the box; what is
      // typed in the box is only the search (the school was "kept" as the
      // typed query and cleared once left).
      if (field.prompt || isPrompt(trigger)) {
        const pill = promptPicked(trigger);
        return !!pill && (pill.includes(norm(chosen)) || norm(chosen).includes(pill));
      }
      const shown = shownChoice(trigger);
      if (typedBefore && shown === typedBefore && visibleOptions().length) return picked.getAttribute('aria-selected') === 'true';
      return shown.includes(norm(chosen)) || (shown && shown !== shownBefore && norm(chosen).includes(shown)) ||
        picked.getAttribute('aria-selected') === 'true';
    };
    // A prompt shows its pill once its server has the choice: a moment longer.
    let ok = !!(await waitFor(() => kept() || visibleOptions().some(o => !onScreen.has(o)), field.prompt || isPrompt(trigger) ? 2000 : 600)) && kept();
    // A category (Workday's "Job Board") opens its own list rather than
    // being chosen. Its entry is picked by the saved value, or is the only one.
    if (!ok) ok = !!(await waitFor(kept, 150));
    // A list drawn again with the same entries is the same list, not a sub-list.
    const inner = ok ? [] : visibleOptions().filter(o => !onScreen.has(o) || (category && !wordsBefore.has(optionText(o))));
    if (inner.length && !inner.some(o => norm(optionText(o)) === norm(chosen))) {
      let j = bestOption(inner, field.savedValue || value, field.placeHint);
      if (j < 0 && field.savedValue) j = bestOption(inner, value);
      if (j < 0 && inner.length === 1) j = 0;
      if (j < 0) {
        const labels = inner.map(optionText).filter(Boolean).slice(0, 250);
        closeList(trigger);
        focusOut(trigger);
        return { ok: false, reason: `"${chosen}" has its own list; choose one of its entries`, options: labels };
      }
      chosen = optionText(inner[j]);
      picked = inner[j];
      picked.scrollIntoView?.({ block: 'nearest' });
      press(entryTarget(picked));
      ok = !!(await waitFor(kept, 600));
    }
    // A prompt's list may redraw under the first press: once it holds
    // still, the entry is pressed again.
    if (!ok && (field.prompt || isPrompt(trigger))) {
      await new Promise(r => setTimeout(r, 400));
      const again = visibleOptions().find(o => norm(optionText(o)) === norm(chosen));
      if (again) { press(entryTarget(again)); ok = !!(await waitFor(kept, 1500)); }
    }
    // A prompt's pill arrives once the page's own request for the choice
    // comes back, however slow the line: waited for, not timed.
    if (!ok && (field.prompt || isPrompt(trigger))) {
      await pageIdle(8000 * waitScale());
      ok = !!(await waitFor(kept, 500));
    }
    if (!ok && trigger.tagName === 'INPUT') {
      // react-select also commits the highlighted option on Enter.
      key(trigger, 'Enter');
      ok = !!(await waitFor(kept, 200));
    }
    // A Workday prompt leaves its list open after a choice: closed here.
    if (!ok || field.prompt || isPrompt(trigger)) closeList(trigger);
    focusOut(trigger);
    return ok ? { ok: true, chosen, ...(broadened ? { altered: true } : {}) } : { ok: false, reason: 'The dropdown did not keep the choice' };
  }

  const COMMON_WORDS = new Set(['the', 'and', 'of', 'for', 'at', 'in', 'university', 'college', 'school', 'institute',
    'community', 'state', 'inc', 'llc', 'ltd', 'company', 'corporation']);
  const wordsOf = t => norm(t).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !['the', 'and', 'for'].includes(w));

  /**
   * The entry closest to a value the list does not hold: searched by its
   * most telling words ("Lakeside" for "Lakeside College"), the entry sharing
   * most of its words is chosen if it shares at least half. Otherwise the
   * list's own "Other", if it has one.
   */
  async function closestEntry(trigger, value, fresh, timeLeft = () => !stopped(), field = null) {
    const want = wordsOf(value);
    // In their own order: "Computer Science & Game Design" is
    // searched as "computer science", then "computer".
    const telling = want.filter(w => !COMMON_WORDS.has(w));
    const queries = [...new Set([telling.slice(0, 2).join(' '), telling[0]].filter(Boolean))].slice(0, 2);
    // Nothing close: the list's own "Other" (a transfer pathway is not
    // "Liberal Arts"). One of several (a skill) is never given as "Other".
    for (const q of field?.multi ? queries : [...queries, 'Other']) {
      if (!timeLeft()) return null;
      await typeAndSearch(trigger, q, fresh);
      // Workday adds results in stages: chosen from once the list holds still.
      const options = await settledList(fresh, 2500 * waitScale());
      if (!options.length) continue;
      if (q === 'Other') {
        const at = options.findIndex(o => norm(optionText(o)).startsWith(norm(q)));
        if (at >= 0) return { shown: options, at };
        continue;
      }
      // Most of the saved words, then fewest others.
      let best = -1, score = 0, extra = Infinity;
      options.forEach((o, i) => {
        const have = wordsOf(optionText(o));
        const s = want.filter(w => have.includes(w)).length / Math.max(1, want.length);
        const x = have.filter(w => !want.includes(w)).length;
        if (s > score || (s === score && s > 0 && x < extra)) { score = s; best = i; extra = x; }
      });
      if (best >= 0 && score >= 0.5) return { shown: options, at: best };
    }
    return null;
  }

  /**
   * A date part drawn as a spin button (Workday's Month and Year): clicked
   * into, typed as whole key presses, then left with a click outside, the
   * way a person does. Set as a value alone, the box showed 07/2023 while
   * Workday held only "07/" and called the date invalid.
   */
  async function setSpinbutton(el, value) {
    const want = String(value).trim();
    const section = el.parentElement || el;
    press(section);
    focusIn(el);
    await typeQuery(el, want);
    await yieldToPage();
    press(document.body);
    focusOut(el);
    const num = v => String(v ?? '').replace(/^0+(?=\d)/, '');
    const held = () => num(el.getAttribute('aria-valuenow') ?? el.value) === num(want) || num(el.value) === num(want);
    return { ok: !!(await waitFor(held, 600)) };
  }

  /**
   * What a list offers near a value it does not hold: the results of
   * searching its telling words ("computer science", "computer") and
   * "Other", for the matching model to choose from. At most 30.
   */
  async function gatherEntries(trigger, value, fresh, timeLeft) {
    const telling = wordsOf(value).filter(w => !COMMON_WORDS.has(w));
    const queries = [...new Set([telling.slice(0, 2).join(' '), telling[0], telling[1], 'Other'].filter(Boolean))];
    const found = new Set();
    for (const q of queries) {
      if (!timeLeft() || found.size >= 30) break;
      await typeAndSearch(trigger, q, fresh);
      for (const o of await settledList(fresh, 2500 * waitScale())) found.add(optionText(o));
    }
    return [...found].filter(Boolean).slice(0, 30);
  }

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
    'October', 'November', 'December'];

  /**
   * react-datepicker (Abbott's month and year pickers) reads typed text in a
   * format it never shows and drops what it cannot read, so the date is
   * chosen in its calendar: open it, move to the year (its year dropdown, or
   * the previous and next buttons), then press the cell whose accessible name
   * is the day, month or year ("Choose July 2023", "Choose 2017").
   */
  async function setReactDatepicker(el, value) {
    const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(String(value).trim());
    if (!m) return { ok: false, reason: 'Not a date this calendar can show' };
    const year = Number(m[1]);
    const month = m[2] ? MONTH_NAMES[Number(m[2]) - 1] : '';
    const day = m[3] ? Number(m[3]) : 0;
    const want = day ? new RegExp(`\\b${month} ${day}(st|nd|rd|th)?,? ${year}\\b`, 'i')
      : month ? new RegExp(`\\b${month} ${year}$`, 'i') : new RegExp(`\\b${year}$`);
    el.scrollIntoView?.({ block: 'center' });
    focusIn(el);
    press(el);
    const popup = await waitFor(() => document.querySelector('.react-datepicker'), 1500 * waitScale());
    if (!popup) return { ok: false, reason: 'The calendar did not open' };
    const cells = () => [...popup.querySelectorAll('[role="option"], .react-datepicker__day, .react-datepicker__month-text, .react-datepicker__year-text')];
    const cell = () => cells().find(c => want.test(c.getAttribute('aria-label') || '') && !/disabled/.test(c.className));
    const yearSelect = [...popup.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === String(year)));
    if (yearSelect && !cell()) setSelect(yearSelect, String(year));
    // Without a year dropdown, step toward the year the cells name.
    for (let i = 0; i < 60 && !(await waitFor(cell, 150)); i++) {
      const shown = cells().map(c => Number(((c.getAttribute('aria-label') || '').match(/\b(1[89]|20)\d{2}\b/) || [])[0])).filter(Boolean);
      if (!shown.length) break;
      if (year >= Math.min(...shown) && year <= Math.max(...shown)) break; // on screen, but not offered
      const back = year < Math.min(...shown);
      const step = popup.querySelector(back ? '.react-datepicker__navigation--previous, [aria-label^="Previous"]'
        : '.react-datepicker__navigation--next, [aria-label^="Next"]');
      if (!step || step.disabled) break;
      press(step);
    }
    const target = cell();
    if (!target) {
      closeList(el);
      return { ok: false, reason: 'The calendar does not offer that date' };
    }
    press(target);
    const kept = await waitFor(() => el.value.trim() && !document.querySelector('.react-datepicker'), 1000 * waitScale()) ||
      await waitFor(() => el.value.trim(), 300);
    if (document.querySelector('.react-datepicker')) closeList(el);
    focusOut(el);
    return kept ? { ok: true } : { ok: false, reason: 'The calendar did not keep the date' };
  }

  function guard(el, field) {
    if (!el) return 'Field is no longer on the page';
    const type = (el.getAttribute?.('type') || '').toLowerCase();
    if (el.tagName === 'INPUT' && FORBIDDEN_TYPES.has(type)) return 'Refused: sensitive input type';
    const probe = [el.name, el.id, field.label, el.getAttribute?.('placeholder')].filter(Boolean).join(' ');
    if (FORBIDDEN_PATTERNS.some(re => re.test(probe))) return 'Refused: looks like a credential or government ID';
    if (el.disabled || el.getAttribute?.('aria-disabled') === 'true') return 'Field is disabled';
    // A read-only box that opens a picker is answered through the picker.
    if (el.readOnly && !(field.combobox || field.datePicker || field.widget === 'listbox')) return 'Field is read-only';
    return null;
  }

  /** The highlight styles, added to the document or to a shadow root, since page styles stop at its edge. */
  function ensureStyles(root = document) {
    const scope = root && root !== document && root.host ? root : document;
    if (scope.getElementById('applicator-style')) return;
    const style = document.createElement('style');
    style.id = 'applicator-style';
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        outline: 2px solid rgba(64, 132, 244, 0.9) !important;
        outline-offset: 1px !important;
        background-color: rgba(64, 132, 244, 0.06) !important;
        transition: outline-color 1.2s ease;
      }
      .${REVIEW_CLASS} {
        outline: 2px dashed rgba(217, 119, 6, 0.95) !important;
        outline-offset: 1px !important;
        background-color: rgba(217, 119, 6, 0.07) !important;
      }
      .applicator-ask {
        outline: 2px solid #06c755 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 6px rgba(6, 199, 85, 0.18) !important;
      }`;
    (scope === document ? document.documentElement : scope).appendChild(style);
  }

  /**
   * @param {object} plan
   * @param {Array}  plan.items    [{selector, type, tag, value, options, label, thin}]
   * @param {boolean} plan.highlight
   */
  async function fill(plan) {
    globalThis.__applicatorStopped = false;
    ensureStyles();
    // The page's own start-up requests first (its form session, say).
    await pageIdle(Math.min(30000, 8000 * waitScale()));

    const results = [];
    let firstTouched = null;
    const written = new Set();

    for (const field of plan.items || []) {
      if (stopped()) { results.push({ id: field.id, ok: false, reason: 'Stopped' }); continue; }
      const began = Date.now();
      let el;
      try {
        el = find(field.selector);
      } catch {
        el = null;
      }

      const refusal = guard(el, field);
      if (refusal) {
        results.push({ id: field.id, ok: false, reason: refusal });
        continue;
      }

      const stateBefore = postbackState();
      try {
        let touched = el;
        let outcome;

        if (field.type === 'radio') {
          const radio = field.widget === 'aria' ? await setAriaRadio(field, field.value) : setRadio(field, field.value);
          outcome = { ok: !!radio };
          touched = radio || el;
        } else if (field.type === 'checkboxgroup') {
          const box = await setCheckboxInGroup(field, field.value);
          outcome = { ok: !!box };
          touched = box || el;
        } else if (field.type === 'checkbox') {
          outcome = { ok: field.widget === 'aria' ? await setAriaCheckbox(el, field.value) : setCheckbox(el, field.value) };
        } else if (field.widget === 'listbox' || (field.combobox && el.tagName === 'INPUT')) {
          // A box that suggests as you type is chosen from the same way as a
          // dropdown: open, type to narrow, choose, confirm it stuck.
          outcome = field.multi && (field.prompt || isPrompt(el))
            ? await setMany(el, field)
            : await setListbox(el, field.value, field);
          // Workday's search prompt keeps only a clicked entry: free text never stands.
          if (!outcome.ok && field.combobox && field.widget !== 'listbox' && !field.prompt && !outcome.fixedList) {
            // Some suggestion boxes also accept free text. Keep typed text
            // only if the page still holds it once the box is left.
            const typed = setText(el, field.value, field);
            // A box that clears unpicked text (Lever's location) does it a
            // moment after it is left.
            if (typed.ok) await waitFor(() => !readBack(el).trim(), 400);
            outcome = typed.ok && readBack(el).trim()
              ? { ok: true, altered: true }
              : { ok: false, reason: outcome.reason || 'None of the suggestions matched your saved answer' };
          }
        } else if (field.tag === 'select') {
          outcome = { ok: setSelect(el, field.value) };
        } else if (el.closest?.('.react-datepicker__input-container')) {
          outcome = await setReactDatepicker(el, field.value);
        } else if (el.getAttribute('role') === 'spinbutton') {
          outcome = await setSpinbutton(el, field.value);
        } else {
          outcome = setText(el, field.value, field);
        }

        const ok = !!outcome.ok;
        if (ok && plan.highlight && touched) {
          const target = touched.type === 'radio' || touched.type === 'checkbox'
            ? (touched.closest('label') || touched)
            : shownBox(touched);
          ensureStyles(target.getRootNode());
          target.classList.add(field.thin || outcome.altered ? REVIEW_CLASS : HIGHLIGHT_CLASS);
          if (!firstTouched) firstTouched = target;
        }

        results.push({
          id: field.id,
          ok,
          altered: !!outcome.altered,
          reason: ok ? '' : (outcome.reason || 'No matching option on the page'),
          options: outcome.options,
          ...(outcome.unmatched?.length ? { unmatched: outcome.unmatched } : {}),
          ...(outcome.candidates?.length ? { candidates: outcome.candidates } : {}),
          // The option a list kept, when it differs from the one asked for (a category's entry).
          ...(outcome.chosen && outcome.chosen !== field.value ? { chosen: outcome.chosen } : {}),
          via: field.via
        });
      } catch (err) {
        results.push({ id: field.id, ok: false, reason: err?.message || 'Could not write to this field' });
      }
      // Let the page save this answer before the next one arrives. Some forms
      // (Ashby) save each change a moment later on a copy of their state, so
      // answers written in one go overwrite each other: every box shows its
      // answer and the form still says they are missing. Two hops, to run
      // behind a save the page queued from inside its own handler.
      await yieldToPage();
      await yieldToPage();
      // And for the save itself: Ashby sends the whole form with each change
      // and puts the reply back as its state, so an answer written while a
      // save is out is undone when that reply lands (savewhole.html).
      const writtenAt = Date.now();
      await pageIdle(Math.min(15000, 4000 * waitScale()), 150);
      // Where a slow fill's time goes, for its trace: writing, then waiting for the page.
      const last = results[results.length - 1];
      if (last && last.id === field.id) Object.assign(last, { ms: writtenAt - began, idleMs: Date.now() - writtenAt });
      if (el && last?.id === field.id && last.ok) written.add(el);
      // A control whose change posts the page back (PeopleSoft's
      // submitAction_win0, ASP.NET's __doPostBack) redraws the form when the
      // server answers: a box written meanwhile is put back as it was.
      if (el && postsBack(el)) await postbackDone(stateBefore);
    }

    // An entry written in an inline editor (Workable's Education, with its
    // own Update and Cancel) is kept only once its own Update is pressed:
    // Submit otherwise says "You have unsaved changes".
    if (!stopped()) await saveEntryEditors(written);

    // And every save the answers set off, before the user can press Submit.
    const saved = await pageIdle(Math.min(60000, 15000 * waitScale()));

    if (firstTouched && plan.scroll !== false) {
      firstTouched.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    return {
      ok: true,
      results,
      network: { ...networkSpeed(), saved },
      filled: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length
    };
  }

  /** Remove every highlight Applicator added, without touching page styles. */
  function clearHighlights() {
    findAll(`.${HIGHLIGHT_CLASS}, .${REVIEW_CLASS}, .${ASK_CLASS}`)
      .forEach(el => el.classList.remove(HIGHLIGHT_CLASS, REVIEW_CLASS, ASK_CLASS));
    // Every fill injects this script afresh: an earlier copy's layer too.
    document.querySelectorAll('applicator-ask-layer').forEach(n => n.remove());
    askLayer = null;
    asked.length = 0;
    return { ok: true };
  }

  // --- "Add another" -----------------------------------------------------

  const CONTROLS = 'input:not([type="hidden"]), select, textarea, [role="combobox"], [role="radio"], [role="checkbox"]';

  /**
   * Press an "Add another" button and wait for the block it adds: more boxes
   * on the page than before. Reports whether one appeared, so the fill stops
   * pressing a button that adds nothing (or opens a dialog it cannot see).
   */
  async function pressAdd({ selector }) {
    if (stopped()) return { added: false, reason: 'stopped' };
    const b = find(selector);
    if (!b || b.disabled) return { added: false, reason: 'gone' };
    const before = findAll(CONTROLS).length;
    b.scrollIntoView?.({ block: 'center' });
    press(b);
    const grew = await waitFor(() => findAll(CONTROLS).length > before, 4000);
    // Its boxes may arrive in more than one render.
    if (grew) await new Promise(r => setTimeout(r, 300));
    return { added: !!grew };
  }

  // --- questions Phil could not answer ------------------------------------
  //
  // A required box left empty is marked on the page with a tag under it. The
  // user answers it there and ticks; the answer is saved as one of their
  // saved answers, so Phil fills it next time, and a later change to the box
  // updates it without asking again. The tags sit in their own layer over
  // the page, never inside the form, so the page's own code never sees them.

  const ASK_CLASS = 'applicator-ask';
  let askLayer = null;
  const asked = []; // { el, box, tag, question, saved }

  /** What the user answered in `el`, as they see it. */
  function answerIn(el) {
    if (!el) return '';
    if (el.type === 'radio') {
      const group = el.name ? [...(el.form || document).querySelectorAll('input[type="radio"]')].filter(r => r.name === el.name) : [el];
      const on = group.find(r => r.checked);
      return on ? norm(on.labels?.[0]?.textContent || on.closest('label')?.textContent || on.value).replace(/^./, c => c.toUpperCase()) : '';
    }
    if (el.type === 'checkbox') return el.checked ? 'Yes' : '';
    if (el.tagName === 'SELECT') return el.selectedIndex > 0 || el.value ? (el.options[el.selectedIndex]?.text || '').trim() : '';
    const typed = 'value' in el && el.tagName !== 'BUTTON' ? String(el.value || '').trim() : '';
    if (typed) return typed;
    // A custom dropdown (react-select on Greenhouse) keeps its search box
    // empty and shows the choice as text in the box drawn around it.
    const box = shownBox(el);
    if (box === el && 'value' in el) return '';
    const shown = (box.querySelector?.('[class*="single-value"], [class*="singleValue"], [class*="__value"], [class*="selected"]') || box).cloneNode(true);
    // A style sheet inside the widget is no answer (Saildrone's react-select).
    shown.querySelectorAll?.('style, script, template').forEach(n => n.remove());
    return String(shown.textContent || '').replace(/\s+/g, ' ').trim()
      .replace(/^(select|select\.\.\.|choose|please select|start typing\.\.\.)$/i, '');
  }

  function askStyles() {
    return `
      :host { all: initial; }
      .tag { position: fixed; z-index: 2147483646; display: flex; align-items: center; gap: 8px;
        max-width: 320px; padding: 3px 3px 3px 10px; border-radius: 10px; white-space: nowrap; background: #fff;
        border: 2px solid #06c755; box-shadow: 0 4px 14px rgba(0,0,0,.14);
        font: 500 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color: #2b2b2b; }
      .tag[hidden] { display: none; }
      .msg b { color: #04873b; font-weight: 700; }
      .tick { flex: none; width: 24px; height: 22px; border: 0; border-radius: 7px; cursor: pointer;
        background: #06c755; color: #fff; font: 700 14px/1 system-ui, sans-serif;
        box-shadow: 0 2px 0 #04873b; transition: transform .08s; }
      .tick:active { transform: translateY(2px); box-shadow: 0 1px 0 #04873b; }
      .tick:disabled { background: #d9dde1; box-shadow: 0 3px 0 #b8bec4; cursor: default; }
      .tag.ready .tick { animation: nudge 1.4s ease-in-out infinite; }
      @keyframes nudge { 0%, 70%, 100% { transform: scale(1); } 80% { transform: scale(1.15); } }
      .tag.saved { border-color: #f5b800; animation: pop .45s cubic-bezier(.2,1.6,.4,1); }
      .tag.saved .tick { background: #f5b800; box-shadow: 0 3px 0 #c48f00; }
      .tag.gone { opacity: 0; transform: translateY(-4px); transition: opacity .4s, transform .4s; }
      @keyframes pop { 0% { transform: scale(.85); } 60% { transform: scale(1.08); } 100% { transform: scale(1); } }
      @media (prefers-reduced-motion: reduce) { .tag.saved, .tag.ready .tick { animation: none; } .tag.gone { transition: none; } }`;
  }

  /** An open list of choices on the page (a dropdown, suggestions): never covered by a tag. */
  function openLists() {
    return findAll('[role="listbox"], [role="menu"], [class*="__menu"], [class*="-menu"]:not(input)')
      .map(n => n.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
  }

  /**
   * Put each tag just above its box, at its right edge: dropdowns open
   * below their box, and the gap above a question is free on every form.
   * Only at the top of the screen, with no room above, does it go below.
   * On any site, a tag that would cover an open list, or the box the user
   * is in, hides until it would not.
   */
  function placeTags() {
    const lists = openLists();
    const focus = document.activeElement && document.activeElement !== document.body
      ? document.activeElement.getBoundingClientRect() : null;
    for (const a of asked) {
      if (!a.tag.isConnected) continue;
      const r = a.box.getBoundingClientRect();
      let shown = a.box.isConnected && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
      if (!shown) { a.tag.hidden = true; continue; }
      a.tag.hidden = false;
      const w = a.tag.offsetWidth || 200;
      const h = a.tag.offsetHeight || 32;
      const left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8));
      const top = r.top - h - 4 >= 4 ? r.top - h - 4 : r.bottom + 4;
      const hits = q => q && left < q.right && left + w > q.left && top < q.bottom && top + h > q.top;
      shown = !lists.some(hits) && !hits(focus);
      a.tag.hidden = !shown;
      a.tag.style.left = `${left}px`;
      a.tag.style.top = `${top}px`;
    }
  }

  function saveAnswer(a, plan, { quiet = false } = {}) {
    const answer = answerIn(a.el);
    if (!answer) return Promise.resolve(false);
    a.saved = answer;
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'save-asked-answer', payload: { question: a.question, answer, site: plan.site } },
          reply => resolve(!!reply?.ok));
      } catch {
        resolve(false);
      }
    }).then(ok => {
      if (!ok || quiet) return ok;
      a.tag.classList.add('saved');
      a.tag.querySelector('.msg').innerHTML = '<b>Saved.</b> phil fills it next time';
      a.box.classList.remove(ASK_CLASS);
      a.box.classList.add(HIGHLIGHT_CLASS);
      setTimeout(() => a.tag.classList.add('gone'), 2200);
      setTimeout(() => a.tag.remove(), 2700);
      return ok;
    });
  }

  /**
   * Mark the required questions left empty and wait for the user's answers.
   *
   * @param {object} plan
   * @param {Array}  plan.items  [{selector, question}]
   * @param {string} plan.site
   * @returns {{marked: number}}
   */
  function askUser(plan) {
    ensureStyles();
    if (!askLayer) {
      document.querySelectorAll('applicator-ask-layer').forEach(n => n.remove());
      askLayer = document.createElement('applicator-ask-layer');
      const root = askLayer.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = askStyles();
      root.appendChild(style);
      document.documentElement.appendChild(askLayer);
      addEventListener('scroll', placeTags, { capture: true, passive: true });
      addEventListener('resize', placeTags, { passive: true });
      setInterval(placeTags, 300); // the page's own layout moves, and lists open
    }
    const root = askLayer.shadowRoot;
    let marked = 0;
    for (const item of plan.items || []) {
      const el = find(item.selector);
      if (!el || asked.some(a => a.el === el) || answerIn(el)) continue;
      const box = shownBox(el);
      box.classList.add(ASK_CLASS);
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.setAttribute('role', 'group');
      tag.setAttribute('aria-label', 'phil needs your answer');
      tag.innerHTML = '<span class="msg"><b>phil needs you here.</b> Answer, then tick</span>' +
        '<button class="tick" type="button" aria-label="Save this answer" disabled>✓</button>';
      root.appendChild(tag);
      const a = { el, box, tag, question: item.question, saved: '' };
      asked.push(a);
      marked++;
      const tick = tag.querySelector('.tick');
      tick.addEventListener('click', () => saveAnswer(a, plan));
      // Saved once, a later change updates it: no tag, no question.
      let later = null;
      const changed = () => {
        tick.disabled = !answerIn(el);
        a.tag.classList.toggle('ready', !tick.disabled);
        if (!a.saved) return;
        clearTimeout(later);
        later = setTimeout(() => { if (answerIn(el) && answerIn(el) !== a.saved) saveAnswer(a, plan, { quiet: true }); }, 800);
      };
      const watch = el.type === 'radio' && el.name ? (el.form || document) : el;
      watch.addEventListener('input', changed, true);
      watch.addEventListener('change', changed, true);
      // A custom dropdown changes no value: its text does.
      if (!('value' in el) || box !== el) new MutationObserver(changed).observe(box, { childList: true, subtree: true, characterData: true });
      // Clicks on a custom list's choices change no box the page tells us about.
      document.addEventListener('click', () => setTimeout(changed, 150), true);
      if (el.tagName === 'INPUT' && el.type !== 'radio' && el.type !== 'checkbox') {
        el.addEventListener('keydown', e => { if (e.key === 'Enter' && !a.saved && answerIn(el)) { e.preventDefault(); saveAnswer(a, plan); } });
      }
    }
    placeTags();
    return { marked };
  }

  /** Bring the first question waiting for an answer into view, and put the cursor in it. */
  function showAsked() {
    const a = asked.find(x => !x.saved && x.el.isConnected);
    if (!a) return { shown: false };
    a.box.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    try { a.el.focus({ preventScroll: true }); } catch { /* not focusable */ }
    setTimeout(placeTags, 400);
    return { shown: true };
  }

  /**
   * Attach a document the user stored in Applicator to a file input.
   *
   * A page cannot be given a file from disk without the person choosing it, and
   * Applicator never tries to. What it attaches is the file the user uploaded
   * into their own settings, carried here as bytes and rebuilt into a File.
   * Nothing is read from the page, and only inputs the extractor identified as
   * wanting a CV or cover letter are touched.
   */
  async function attachFiles(plan) {
    ensureStyles();
    const results = [];
    const attached = [];

    for (const item of plan.items || []) {
      let el;
      try {
        el = find(item.selector);
      } catch {
        el = null;
      }

      if (!el || el.tagName !== 'INPUT' || el.type !== 'file') {
        results.push({ kind: item.kind, ok: false, reason: 'That upload field is no longer on the page' });
        continue;
      }
      if (el.disabled) {
        results.push({ kind: item.kind, ok: false, reason: 'The upload field is disabled' });
        continue;
      }
      if (((el.files && el.files.length) || fileShownNear(el)) && !plan.replaceExisting) {
        results.push({ kind: item.kind, ok: false, reason: 'A file is already attached', already: true });
        continue;
      }

      try {
        const bytes = Uint8Array.from(atob(item.data), c => c.charCodeAt(0));
        const file = new File([bytes], item.filename, { type: item.mimeType || 'application/octet-stream' });

        const textBefore = (uploadBox(el).textContent || '').replace(/\s+/g, ' ');
        const transfer = new DataTransfer();
        transfer.items.add(file);
        el.files = transfer.files;
        announce(el, ['input', 'change']);

        const ok = !!(el.files && el.files.length);
        if (ok) attached.push({ el, index: results.length, textBefore });
        if (ok && plan.highlight) {
          const target = el.closest('label') || el;
          ensureStyles(target.getRootNode());
          target.classList.add(HIGHLIGHT_CLASS);
        }
        results.push({
          kind: item.kind,
          ok,
          reason: ok ? '' : 'The page would not accept the file'
        });
      } catch (err) {
        results.push({ kind: item.kind, ok: false, reason: err?.message || 'Could not attach the file' });
      }
    }

    // Answers are written once the upload is done: some forms (Ashby) save a
    // finished upload over a copy of the form taken when it started, wiping
    // anything typed meanwhile.
    if (attached.length && plan.settle !== false) {
      const settled = await uploadsSettled(attached.map(a => a.el), (plan.settleMs || 20000) * Math.min(3, waitScale()));
      await pageIdle(Math.min(60000, 15000 * waitScale())); // and its save
      // Started is not done: a required CV that failed to upload blocks the
      // submit. The page's own word on it decides.
      const FAILED = /\b(upload(ing)? failed|failed to upload|could ?n[o']t (be )?upload|error|too large|not (a )?supported|try again|invalid file)\b/gi;
      for (const { el, index, textBefore } of attached) {
        const said = (uploadBox(el).textContent || '').replace(/\s+/g, ' ');
        // Only a complaint that appeared after the attach: the box's own
        // instructions may say "files over 5 MB are too large".
        const complaint = (said.match(FAILED) || []).some(w => !textBefore.toLowerCase().includes(w.toLowerCase()));
        if (complaint) {
          Object.assign(results[index], { ok: false, reason: 'The page did not accept the upload' });
        } else if (!settled) {
          Object.assign(results[index], { unconfirmed: true, reason: 'Still uploading when the fill ended' });
        }
      }
    }
    return { ok: true, results, attached: results.filter(r => r.ok).length };
  }

  /**
   * Whether the uploads near these inputs are still in progress: a busy or
   * progress marker, a spinner, or "Uploading" in the upload's own box, or
   * its buttons disabled while it works. Resolves once none shows for a
   * moment, or at the deadline.
   */
  /** Whether changing this control sends the page to the server. */
  function postsBack(el) {
    const handler = `${el.getAttribute?.('onchange') || ''} ${el.getAttribute?.('onclick') || ''}`;
    return /submitAction_|__doPostBack|\.submit\(\)|postback/i.test(handler);
  }

  /** PeopleSoft counts each round trip in ICStateNum; elsewhere the page's markup stands in. */
  function postbackState() {
    return document.querySelector('input[name="ICStateNum"]')?.value ?? null;
  }

  /**
   * Until the postback has come back: PeopleSoft's counter moves, or the
   * page changes and then holds still for 200 ms. At most 2 s, so a control
   * that only looked like it posts back costs little.
   */
  async function postbackDone(before) {
    const deadline = Date.now() + 2000 * Math.min(3, waitScale());
    if (before !== null) await waitFor(() => postbackState() !== before, Math.max(0, deadline - Date.now()));
    let last = Date.now();
    const observer = new MutationObserver(() => { last = Date.now(); });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    try {
      await waitFor(() => Date.now() - last >= 200 || Date.now() > deadline, Math.max(0, deadline - Date.now()) + 50);
    } finally {
      observer.disconnect();
    }
  }

  /** The upload's own box: the nearest wrapper with a button and some text. */
  /**
   * A file this upload already shows (Workday lists it beside its drop zone,
   * and takes more than one: a second fill attached the CV twice). Looked
   * for up to the box that holds another upload, so a CV does not count for
   * the cover letter.
   */
  function fileShownNear(el) {
    for (let n = el.parentElement, depth = 0; n && n !== document.body && depth < 6; n = n.parentElement, depth++) {
      if ([...n.querySelectorAll('input[type="file"]')].some(i => i !== el)) break;
      const named = [...n.querySelectorAll('[data-automation-id="file-upload-item-name"], p, span, a, div')]
        .some(e => !e.children.length && /^\S.{0,150}\.(pdf|docx?|rtf|txt|odt|pages)$/i.test((e.textContent || '').trim()));
      if (named) return true;
    }
    return false;
  }

  function uploadBox(el) {
    let box = el.parentElement;
    for (let i = 0; i < 5 && box?.parentElement; i++) {
      if (box.querySelector('button, [role=button]') && box.textContent.trim()) break;
      box = box.parentElement;
    }
    return box || el;
  }

  function uploadsSettled(inputs, ms) {
    const boxes = inputs.map(uploadBox);
    const busy = () => boxes.some(box =>
      box.querySelector('[aria-busy="true"], [role=progressbar], progress, [class*="spin" i], [class*="loading" i], [class*="uploading" i]') ||
      /\buploading\b/i.test(box.textContent || '') ||
      [...box.querySelectorAll('button')].some(b => b.disabled));
    return new Promise(resolve => {
      const deadline = Date.now() + ms;
      let calmSince = 0;
      const check = () => {
        if (Date.now() > deadline) return resolve(false);
        if (busy()) calmSince = 0;
        else if (!calmSince) calmSince = Date.now();
        else if (Date.now() - calmSince >= 400) return resolve(true);
        // Not a timer alone: a background tab runs timers once a second.
        waitFor(() => false, 100).then(check);
      };
      check();
    });
  }

  /**
   * Wait until `test()` returns something truthy, checking again on every
   * change to the page. A timer is only the deadline: a background tab
   * throttles timers to a second or more, while mutation callbacks run at
   * once, so a list that renders on keydown is seen straight away.
   */
  function waitFor(test, ms) {
    return new Promise(resolve => {
      const first = test();
      if (first) return resolve(first);
      let done = false;
      const observer = new MutationObserver(() => {
        const value = test();
        if (value) finish(value);
      });
      const finish = value => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        clearInterval(poll);
        resolve(value);
      };
      const watch = { subtree: true, childList: true, attributes: true, characterData: true };
      observer.observe(document, watch);
      // Changes inside open shadow roots do not reach a document observer.
      for (const host of findShadowHosts()) observer.observe(host.shadowRoot, watch);
      const timer = setTimeout(() => finish(test()), ms);
      // What changes without a mutation (a list fading in, so it becomes
      // visible only when its transition ends) is caught by looking again.
      const poll = setInterval(() => {
        if (stopped()) return finish(null);
        const value = test();
        if (value) finish(value);
      }, 50);
    });
  }

  function findShadowHosts(root = document, out = []) {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        out.push(el);
        findShadowHosts(el.shadowRoot, out);
      }
    }
    return out;
  }

  /** Let the page run its own queued work, without a (throttleable) timer. */
  const yieldToPage = () => new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  });
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  /**
   * The visible suggestions of any autocomplete on the page. Libraries mark
   * them differently: an ARIA role, a custom element such as <spl-select-option>,
   * or just a class. Only the outermost of nested matches is kept.
   */
  function suggestionElements() {
    const all = findAll('[role="option"], [role="menuitem"], [class*="option" i]')
      .concat(findAll('*').filter(e => /-(option|menu-item|suggestion)$/i.test(e.tagName)))
      .filter(e => e.tagName !== 'OPTION' && visible(e) && (e.textContent || '').trim());
    const deepContains = (a, b) => { for (let n = b; n; n = n.parentElement || n.parentNode?.host) if (n === a) return true; return false; };
    return all.filter(e => !all.some(o => o !== e && deepContains(o, e)));
  }

  /**
   * Pick a suggestion in each autocomplete box that was just typed into.
   *
   * A location box such as SmartRecruiters' "City" only accepts a place chosen
   * from its list; typed text alone leaves it invalid. The suggestion chosen is
   * one that starts with what was typed and, among those, the one that also
   * contains the most of the hint (the state and country). Nothing is chosen
   * when no suggestion starts with the typed text.
   */
  async function pickSuggestions(plan) {
    const results = [];
    for (const item of plan.items || []) {
      const el = find(item.selector);
      if (!el) { results.push({ id: item.id, ok: false }); continue; }
      // Type it again: the list opened by the first pass has usually closed
      // while the rest of the form was being filled.
      const before = new Set(suggestionElements());
      focusIn(el);
      nativeSet(el, '');
      announce(el, ['input']);
      await typeQuery(el, item.value);
      const chosen = await waitFor(() => {
        const options = suggestionElements().filter(o => !before.has(o));
        const i = options.length ? bestOption(options, item.value, item.hint) : -1;
        return i >= 0 ? options[i] : null;
      }, 3000);
      if (chosen) {
        chosen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
        chosen.click();
      }
      focusOut(el);
      results.push({ id: item.id, ok: !!chosen, picked: chosen ? norm(chosen.textContent) : '' });
    }
    return { results };
  }

  /**
   * The Update or Save of an inline entry editor (a button beside a Cancel,
   * never the form's submit) whose boxes this fill wrote, pressed once.
   */
  async function saveEntryEditors(written) {
    if (!written.size) return;
    const SAVE = /^(update|save|save entry|done)$/i;
    for (const button of findAll('button')) {
      if ((button.getAttribute('type') || 'submit') !== 'button' || !SAVE.test(norm(button.textContent)) || button.disabled) continue;
      const row = button.parentElement;
      if (!row || ![...row.querySelectorAll('button')].some(b => b !== button && /^cancel$/i.test(norm(b.textContent)))) continue;
      // Its editor is the nearest block holding boxes: pressed only if this fill wrote one of them.
      let block = row;
      for (let i = 0; i < 5 && block.parentElement && !block.querySelector('input, textarea, select'); i++) block = block.parentElement;
      if (![...written].some(el => block.contains(el))) continue;
      press(button);
      await pageIdle(Math.min(8000, 2000 * waitScale()), 150);
    }
  }

  globalThis.__applicatorFill = fill;
  globalThis.__applicatorPickSuggestions = pickSuggestions;
  globalThis.__applicatorAttachFiles = attachFiles;
  globalThis.__applicatorClearHighlights = clearHighlights;
  globalThis.__applicatorAsk = askUser;
  globalThis.__applicatorPressAdd = pressAdd;
  globalThis.__applicatorStop = stop;
  globalThis.__applicatorShowAsked = showAsked;
})();
