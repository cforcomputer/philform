/**
 * Page extraction, injected into the active tab on demand.
 *
 * This reduces a job application page to a list of field descriptors: label,
 * control type, options, and a selector that can find the control again. Only
 * those descriptors leave the browser. Page HTML, other people's data and
 * anything outside the form are never sent anywhere.
 *
 * Injected as a classic script, so it publishes one function on globalThis
 * rather than exporting.
 */

(() => {
  const MAX_FIELDS = 400;
  const MAX_OPTIONS = 250;

  /**
   * Everything a person would recognise as a place to answer: native controls,
   * and the ARIA widgets that design systems build from divs and buttons (a
   * MUI or Workday dropdown, a styled radio or tick box, a rich text box).
   */
  const CONTROL_SELECTOR = [
    'input', 'select', 'textarea',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="textbox"]', '[role="combobox"]', '[aria-haspopup="listbox"]',
    '[role="radio"]', '[role="checkbox"]', '[role="switch"]',
    // Ashby's Yes/No: a pair of toggle buttons, one pressed.
    'button[aria-pressed]'
  ].join(',');

  /**
   * The select skin a control sits in, if it is one: a container with the
   * library's class that wraps a <select> (Choices.js) or follows one
   * (select2, Chosen). A page's own box that only shares a class name
   * ("choices" round a pair of radios on the practice form) is not one.
   */
  function skinOf(el) {
    const skin = deepClosest(el, SELECT_SKIN);
    if (!skin) return null;
    return skin.querySelector('select') || skin.previousElementSibling?.tagName === 'SELECT' ||
      skin.parentElement?.querySelector(':scope > select') ? skin : null;
  }

  /** Widgets that replace a hidden native <select> and keep it in sync (the rules pack may change it). */
  const BUILTIN_SELECT_SKIN = '.select2-container, .select2, .chosen-container, .selectize-control, .choices';
  let SELECT_SKIN = BUILTIN_SELECT_SKIN;
  /** Error text in a box's own question (the rules pack may change it). */
  const BUILTIN_ERROR_TEXT = '[data-automation-id="inputAlert"], [role="alert"], [class*="error-message" i], [class*="errorMessage"]';
  let ERROR_TEXT = BUILTIN_ERROR_TEXT;
  /** An icon font's glyph; the page's complaint; a question's own label element (pack may change them). */
  const BUILTIN_ICON_GLYPH = /[\uE000-\uF8FF]/;
  let ICON_GLYPH = /[\uE000-\uF8FF]/g;
  const BUILTIN_PAGE_COMPLAINT = /\b(required|invalid)\b|^please (select|enter|choose)/i;
  let PAGE_COMPLAINT = BUILTIN_PAGE_COMPLAINT;
  const BUILTIN_QUESTION_TITLE = /question-title/i;
  let QUESTION_TITLE = BUILTIN_QUESTION_TITLE;

  /** "/source/flags" from the rules pack to a RegExp, or null. */
  function parsePackRegex(text) {
    const m = String(text || '').match(/^\/([\s\S]+)\/([a-z]*)$/);
    try { return m ? new RegExp(m[1], m[2].replace(/[^imsu]/g, '')) : null; } catch { return null; }
  }
  /** A selector from the rules pack the browser accepts, or ''. */
  function validSelector(text) {
    if (typeof text !== 'string' || !text.trim()) return '';
    try { document.createDocumentFragment().querySelector(text); return text; } catch { return ''; }
  }
  /** How long a box that names its list is watched for it (the rules pack may change it). */
  let NAMED_LIST_WAIT = 1000;

  /** What a dropdown shows before anything is chosen (the rules pack's copy wins when given). */
  const EMPTY_CHOICE = /^\s*(no selection|none selected|nothing selected|not selected|select( one| an option)?|choose( one| an option)?|please (select|choose)( one| an option)?|--+|—|-- ?select ?--)\s*(\.\.\.|…)?\s*$/i;

  const FORBIDDEN_TYPES = new Set(['password', 'hidden', 'file', 'image', 'submit', 'reset', 'button']);
  const FORBIDDEN_PATTERNS = [
    /pass(word|phrase)/i, /\bpin\b/i, /\bcvv\b|\bcvc\b|security[-_ ]?code/i,
    /card[-_ ]?number|cc[-_ ]?num|credit[-_ ]?card/i,
    /routing[-_ ]?number|account[-_ ]?number|iban|sort[-_ ]?code/i,
    /ssn|social[-_ ]?security|national[-_ ]?insurance/i, /passport[-_ ]?number/i,
    /date[-_ ]?of[-_ ]?birth|\bdob\b|birth[-_ ]?date/i,
    // "2fa" standing alone: Ashby names boxes by UUID, and "97fd04c2-2fa3-..."
    // hid Genesis's required "most significant accomplishments" question.
    /\botp\b|one[-_ ]?time[-_ ]?code|verification[-_ ]?code|(^|[^a-z0-9])2fa([^a-z0-9]|$)/i
  ];

  // Text slotted into a web component (SmartRecruiters' <spl-input> passes
  // its question through <slot name="label-content">) is not in the slot's
  // own textContent: it is read from the nodes assigned to the slot.
  const slottedText = node => {
    if (!node?.querySelectorAll) return '';
    const slots = node.tagName === 'SLOT' ? [node] : [...node.querySelectorAll('slot')];
    return slots.map(slot => (slot.assignedNodes?.({ flatten: true }) || []).map(n => n.textContent || '').join(' ')).join(' ');
  };
  const text = node => `${node?.textContent || ''} ${slottedText(node)}`.replace(/\s+/g, ' ').trim();

  /**
   * The text a person sees in a node: hidden parts (an error message waiting
   * to be shown, a loading spinner's label) and the text of controls inside
   * it are left out. Lever's whole question is a <label> that also holds
   * "No location found. Try entering a different location".
   */
  function seen(node) {
    if (!node) return '';
    const hidden = new Map();
    const isHidden = el => {
      if (hidden.has(el)) return hidden.get(el);
      let value = false;
      if (/^(INPUT|SELECT|TEXTAREA|BUTTON|SCRIPT|STYLE|SVG|svg|TEMPLATE|OPTION)$/.test(el.tagName)) value = true;
      else if (el.hidden || el.getAttribute('aria-hidden') === 'true') value = true;
      else {
        const style = getComputedStyle(el);
        value = style.display === 'none' || style.visibility === 'hidden';
      }
      hidden.set(el, value);
      return value;
    };
    const out = [];
    // Slots are read where they stand: the walk does not enter the nodes
    // assigned to them (SmartRecruiters' slotted questions).
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let t = node.tagName === 'SLOT' ? node : walker.nextNode(); t; t = walker.nextNode()) {
      const slot = t.nodeType === 1 && t.tagName === 'SLOT';
      if (t.nodeType === 1 && !slot) continue;
      let ok = true;
      for (let el = slot ? t : t.parentElement; el && ok; el = el === node ? null : el.parentElement) {
        if (isHidden(el)) ok = false;
      }
      if (!ok) continue;
      if (slot) out.push(...(t.assignedNodes?.({ flatten: true }) || []).map(n => (n.nodeType === 1 ? seen(n) : n.nodeValue || '')));
      else out.push(t.nodeValue);
      if (t === node) break;
    }
    return out.join(' ').replace(/\s+/g, ' ').trim();
  }

  // --- shadow DOM ---------------------------------------------------------
  // Sites built from web components (SmartRecruiters, Salesforce and others)
  // keep their inputs inside shadow roots, where document.querySelector does
  // not reach. Every lookup below therefore works from the element's own root,
  // and walking upward steps from a shadow root to the element hosting it.

  const rootOf = el => (el?.getRootNode ? el.getRootNode() : document);
  const hostOf = el => {
    const root = rootOf(el);
    return root && root !== document && root.host ? root.host : null;
  };
  /** The parent element, or the shadow host when leaving a shadow root. */
  const up = node => node?.parentElement || (node?.parentNode && node.parentNode.host) || null;
  const byId = (el, id) => rootOf(el).getElementById?.(id) || document.getElementById(id);
  function deepClosest(el, selector) {
    for (let n = el; n; n = up(n)) if (n.matches?.(selector)) return n;
    return null;
  }

  /** Matching elements in page order, including inside open shadow roots. */
  function deepAll(selector, root = document, out = []) {
    for (const el of root.querySelectorAll('*')) {
      if (el.matches(selector)) out.push(el);
      if (el.shadowRoot) deepAll(selector, el.shadowRoot, out);
    }
    return out;
  }

  /** Find an element by a selector from selectorFor, which may cross shadow roots. */
  function deepQuery(selector) {
    let node = null;
    let scope = document;
    for (const part of String(selector).split(' >>> ')) {
      try {
        node = scope?.querySelector(part) || null;
      } catch {
        return null;
      }
      scope = node?.shadowRoot || null;
    }
    return node;
  }

  function isForbidden(...parts) {
    const joined = parts.filter(Boolean).join(' ');
    return FORBIDDEN_PATTERNS.some(re => re.test(joined));
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (el.getClientRects().length > 0) return true;
    // Custom-styled radios and checkboxes are often visually hidden behind a
    // styled label. Treat the control as visible if its label is.
    const label = labelElementFor(el);
    return !!(label && label.getClientRects().length > 0);
  }

  /** A role=radio or role=checkbox wrapper whose own native input is hidden. */
  function clickedForHidden(el, role) {
    if (role !== 'radio' && role !== 'checkbox' && role !== 'switch') return false;
    const inner = el.querySelector('input[type="radio"], input[type="checkbox"]');
    // Workable hides it from assistive tech only (aria-hidden), not from view.
    return !!inner && !el.querySelector('select, textarea, input:not([type="radio"]):not([type="checkbox"])') &&
      (!isVisible(inner) || inner.getAttribute('aria-hidden') === 'true') && el.getClientRects().length > 0;
  }

  function labelElementFor(el) {
    if (el.id) {
      const escaped = cssEscape(el.id);
      const byFor = rootOf(el).querySelector(`label[for="${escaped}"]`);
      if (byFor) return byFor;
    }
    return el.closest('label');
  }

  function cssEscape(value) {
    if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(value);
    return String(value).replace(/([^\w-])/g, '\\$1');
  }

  /**
   * A question buried in a long preamble (Workday's export-control legends,
   * 500+ characters): the sentence that asks ("...?", "Please select yes if
   * you acknowledge."), else the last one. Short text is kept whole.
   */
  function askingPart(value) {
    if (!value || value.length < 400) return value;
    const sentences = value.match(/[^.?!]+[.?!]*/g)?.map(x => x.trim()).filter(Boolean) || [];
    const asking = sentences.filter(x => /\?$|\bplease (select|choose|indicate|confirm)\b|\b(do|are|will|have) you\b/i.test(x));
    return (asking[asking.length - 1] || sentences[sentences.length - 1] || '').slice(0, 399);
  }

  /** Label cascade, most trustworthy source first. */
  const BUILTIN_GENERIC_LABEL = /^(select|choose|pick|please (select|choose)|select (one|an option|\.\.\.)|select\.\.\.|choose\.\.\.|search)$/i;
  let GENERIC_LABEL = BUILTIN_GENERIC_LABEL;

  /**
   * The text just before the box a control sits in: the nearest earlier
   * sibling, a few levels up, that holds text and no other control.
   */
  function textAbove(el, maxDepth = 8) {
    let node = el;
    for (let depth = 0; node && depth < maxDepth; depth++, node = up(node)) {
      // Text before the form is its introduction, not this field's question
      // (YC's dialog: "Get in touch directly with the team.").
      if (node.matches?.('form')) break;
      // The page's complaint ("Required" in red) sits just above some boxes.
      let before = node.previousElementSibling;
      while (before && isComplaint(before)) before = before.previousElementSibling;
      if (!before) continue;
      if (before.matches?.(CONTROL_SELECTOR) || before.querySelector?.(CONTROL_SELECTOR)) return '';
      const value = seen(before);
      if (value && value.length < 400) return value;
    }
    return '';
  }

  /** A validation message, which names no question: "Required", "This field is required." */
  function isComplaint(node) {
    if (node.matches?.('[role="alert"], [aria-live], [class*="error" i], [class*="invalid" i]')) return true;
    const value = (node.textContent || '').replace(/\s+/g, ' ').trim();
    return /^(\*\s*)?(required|this (field|question) is required\.?|(this field is )?invalid.*|please (enter|select|choose|fill)\b.*)$/i.test(value) ||
      (/\b(text-red|danger)\b/.test(node.className || '') && value.length < 60);
  }

  /** "Required (0 / 200)" counters change as the box fills; they are not the question. */
  const withoutCounter = label => String(label || '').replace(/\s*\(?\b\d+\s*(\/|of)\s*\d+\)?(\s*(characters?|chars?|words?))?(\s*(max|maximum|remaining|left))?\s*$/i, '').trim();

  const UPLOAD_WORDS = /^\s*(enter manually|attach|upload( a)?( file)?|browse|choose( a)? file|drop (files? )?here)\s*$/i;

  function labelFor(el) {
    return withoutCounter(rawLabel(el));
  }

  function rawLabel(el) {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      // MUI names a dropdown by its label and itself, and itself is the
      // current value; only the label is the question.
      // A live region it points to is an announcement ("Date picker opened.
      // No date currently selected": Abbott), not its name.
      const parts = labelledBy.split(/\s+/)
        .map(id => byId(el, id))
        .filter(node => node && node !== el && !node.getAttribute('aria-live') && node.getAttribute('role') !== 'alert')
        .map(text)
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    }

    const explicit = labelElementFor(el);
    if (explicit) {
      // A wrapping label includes the control's own text, and sometimes hidden
      // messages; only what a person sees of it counts. A label that is only
      // the required mark ("*") names nothing; the lookup carries on.
      const value = seen(explicit);
      // Greenhouse labels its typed cover letter with its button's words,
      // "Enter manually": a button's words, not the question.
      if (value && /[A-Za-z0-9]/.test(value) && !UPLOAD_WORDS.test(value)) return value;
    }

    // "Select" names the control, not the question; the question is looked
    // for first, and this is kept as a last resort.
    const aria = el.getAttribute('aria-label');
    // Workday names its dropdown buttons " Select One Required", and once
    // answered "Yes Required": its own value. Neither is the question.
    const bare = (aria || '').replace(/\s*(\*|\brequired\b)\s*$/i, '').trim();
    const generic = aria && (GENERIC_LABEL.test(bare) || (!isNative(el) && bare && norm(bare) === norm(text(el))));
    if (aria && aria.trim() && !generic) return aria.trim();

    // The question is often tied to a wrapper rather than to the control:
    // Greenhouse's newer forms put <label for="q1"> on <div id="q1"
    // role="group">, with the button that opens the dropdown inside it.
    for (let node = up(el), depth = 0; node && node !== document.body && depth < 3; node = up(node), depth++) {
      if (node.id) {
        const named = rootOf(node).querySelector(`label[for="${cssEscape(node.id)}"]`);
        if (named && text(named)) return text(named);
      }
      if (/^(group|radiogroup|combobox)$/.test(node.getAttribute?.('role') || '')) {
        const ids = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
        const value = ids.map(id => byId(node, id)).filter(Boolean).map(text).join(' ');
        if (value) return value;
        const own = node.getAttribute('aria-label');
        if (own && own.trim()) return own.trim();
      }
    }

    // Workday, Lever and similar render the question as a sibling node.
    let node = up(el);
    for (let depth = 0; node && node !== document.body && depth < 4; depth++, node = up(node)) {
      const candidate = node.querySelector('legend, [class*="label" i], [class*="question" i], [data-automation-id*="label" i]');
      if (candidate && !candidate.contains(el)) {
        const value = askingPart(seen(candidate));
        if (value && value.length < 400) return value;
      }
      if (node.matches?.('form')) break; // another form's question is not this one's
    }

    // A web component often carries the label on its host: <spl-input label="City">.
    const host = hostOf(el);
    const hostLabel = host && (host.getAttribute('label') || host.getAttribute('aria-label') ||
      host.getAttribute('arialabel') || host.getAttribute('splarialabel'));
    if (hostLabel && hostLabel.trim()) return hostLabel.trim();
    // ...or as its own text, slotted in: <spl-checkbox>I currently work here</spl-checkbox>.
    const hostText = host ? text(host) : '';
    if (hostText && hostText.length < 160) return hostText;

    // The question as a paragraph just above the field's own box (Rippling's
    // custom questions: <p>Do you require sponsorship...</p> and then the
    // field), with nothing else to tie it to the control.
    // A placeholder that names the field ("First Name *") beats text found
    // far above the box, outside its own wrapper.
    const placeholderName = /^[A-Za-z][A-Za-z '&/()-]{1,40}\s*\*?$/.test((el.getAttribute('placeholder') || '').trim()) &&
      !/^(select|search|type|enter|e\.g|choose)\b/i.test((el.getAttribute('placeholder') || '').trim());
    const above = textAbove(el, placeholderName ? 2 : 8);
    if (above) return above;

    if (generic) return aria.trim();

    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();

    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();

    return '';
  }

  /**
   * Which repeat a field belongs to, for forms that ask for several employers.
   *
   * Applications express this in three ways: an index inside the control name
   * (`employment[1][company]`), a numbered heading ("Employer 2"), or an
   * ordinal word ("Previous employer"). The raw number is reported as written
   * and normalised later, because some forms count from zero and some from one.
   */
  const ORDINALS = [
    [/\b(first|1st|most recent|current|present)\b/i, 1],
    [/\b(previous|prior|second|2nd|last)\b/i, 2],
    [/\b(third|3rd)\b/i, 3],
    [/\b(fourth|4th)\b/i, 4],
    [/\b(fifth|5th)\b/i, 5]
  ];

  function repeatIndexFor(name, idAttr, section, label) {
    const attrs = `${name} ${idAttr}`;
    // An index written into the control name is the most reliable signal.
    const bracketed = attrs.match(/\[(\d{1,2})\]/);
    if (bracketed) return { raw: Number(bracketed[1]), from: 'name' };

    // "employer_2_city" is a second employer; "spl-form-element_12" is just a
    // generated id. A bare number only counts beside a word for a job or school.
    // Workday's "workExperience-15--jobTitle" counts every control on the
    // page, not jobs: the word before the number is the kind of block, and
    // the blocks are numbered in page order later (normaliseRepeats).
    const counted = attrs.match(/([a-z]*(?:employ|job|work|experience|position|compan|history|school|educat|institution|referen|referee)[a-z]*)-(\d{1,4})--/i);
    if (counted) return { raw: Number(counted[2]), from: 'counter', group: counted[1].toLowerCase() };
    const delimited = attrs.match(/(?:^|[_.-])(\d{1,2})(?:[_.-]|$)/);
    if (delimited && /employ|job|work|experience|position|compan|history|school|educat|institution|referen|referee/i.test(attrs)) {
      return { raw: Number(delimited[1]), from: 'name' };
    }
    // Greenhouse's "degree--1" says nothing of schools; its "Education" heading does.
    const dashed = attrs.match(/[a-z]--(\d{1,2})(?:\s|$)/i);
    if (dashed && /^(education|employment|work (experience|history)|experience|references?)\b/i.test(section)) {
      return { raw: Number(dashed[1]), from: 'name' };
    }

    // A numbered heading, such as "Employer 2" or "Position #3".
    const heading = `${section} ${label}`;
    const numbered = heading.match(/\b(?:employer|employment|position|job|experience|company|reference|referee)\s*#?\s*(\d{1,2})\b/i);
    if (numbered) return { raw: Number(numbered[1]), from: 'heading' };

    // Ordinals only mean a repeat inside a job or reference block, and only
    // in its headings: "Last name" is not the second reference, and "Current
    // address" is not the first employer.
    if (/employ|job|position|experience|company|work history|reference|referee/i.test(section)) {
      for (const [re, value] of ORDINALS) {
        if (re.test(section)) return { raw: value, from: 'ordinal' };
      }
    }
    return { raw: null, from: null };
  }

  /**
   * The headings a field sits under, nearest first, joined with " › ".
   *
   * One heading is not enough: in "Employer 2 > Address > City" the nearest
   * heading is "Address", and only the one above it says whose address. Each
   * step up keeps a heading only if it outranks the last one kept, so sibling
   * sub-headings of an earlier block are not mistaken for this one's parents.
   */
  const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6,[role="heading"]';

  /** Real headings, and the custom elements design systems use for them (<spl-typography-title>). */
  function isHeading(el) {
    return !!el?.matches?.(HEADING_SELECTOR) || /(^|-)(heading|title)$|typography-(title|heading)/i.test(el?.tagName || '');
  }

  /**
   * A block styled as a heading but built from plain tags: Greenhouse's
   * `<div class="education--header"><p>Education</p></div>`. Only a few
   * words, so a job's own header block is not taken for one.
   */
  function classHeading(el) {
    if (!/(?:^|[\s_-])(?:header|heading|title)(?=\s|$)/i.test(el.getAttribute?.('class') || '')) return false;
    const words = text(el).split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= 4 && !!el.getClientRects().length;
  }

  function headingLevel(el) {
    // Below every real heading, so the form's own headings above it still count.
    if (!isHeading(el)) return 6;
    const m = /^H([1-6])$/.exec(el.tagName);
    if (m) return Number(m[1]);
    return Number(el.getAttribute('aria-level')) || 2;
  }

  function sectionFor(el) {
    const trail = [];
    const add = value => {
      const v = (value || '').slice(0, 80);
      if (v && !trail.includes(v)) trail.push(v);
    };
    let lastLevel = 7;

    let node = el;
    while (node && node !== document.body && trail.length < 4) {
      if (node !== el && node.tagName === 'FIELDSET') {
        const legend = node.querySelector(':scope > legend');
        if (legend) add(text(legend));
      }
      const role = node.getAttribute?.('role');
      if (node !== el && (role === 'group' || role === 'region')) {
        const named = node.getAttribute('aria-label') ||
          (node.getAttribute('aria-labelledby') || '').split(/\s+/)
            .map(id => byId(node, id)).filter(Boolean).map(text).join(' ');
        if (named) add(named);
      }

      // Headings before this node at this level of the tree, nearest first. A
      // wrapper holding only a heading counts; an earlier block holding its own
      // fields does not, so its sub-headings are not mistaken for this one's.
      let sibling = node.previousElementSibling;
      while (sibling && lastLevel > 1) {
        let heading = null;
        if (isHeading(sibling)) heading = sibling;
        else if (!sibling.querySelector?.('input,select,textarea') && !isAside(sibling)) {
          const inner = Array.from(sibling.querySelectorAll?.('*') || []).filter(isHeading);
          // Several headings make a sidebar of facts or a page of text
          // (Ashby's job details: "Location", ..., "Compensation"), not
          // the heading of the block after it.
          if (inner.length && inner.length <= 2) heading = inner[inner.length - 1];
          else if (!inner.length && classHeading(sibling)) heading = sibling;
        }
        // "Step 6 of 6: Review and Submit" names a step in a menu, and a
        // hidden heading belongs to a step not shown.
        if (heading && (/^step \d+ of \d+/i.test(text(heading)) || !heading.getClientRects().length)) heading = null;
        if (heading) {
          const level = headingLevel(heading);
          if (level < lastLevel) {
            add(text(heading));
            lastLevel = level;
          }
        }
        sibling = sibling.previousElementSibling;
      }
      node = up(node);
    }
    return trail.join(' \u203a ');
  }

  /** Navigation, a step menu or a sidebar beside the form. */
  function isAside(node) {
    return !!(node.matches?.('nav, aside, [role="navigation"], [role="complementary"], [role="tablist"]') ||
      node.querySelector?.('nav, [role="navigation"], [aria-current], [role="tablist"]'));
  }

  /**
   * A selector that finds this element again, verified unique. Inside a shadow
   * root it is the host's selector, then " >>> ", then one within that root.
   */
  function selectorFor(el) {
    const host = hostOf(el);
    const inner = selectorWithin(el, rootOf(el));
    return host ? `${selectorFor(host)} >>> ${inner}` : inner;
  }

  function selectorWithin(el, root) {
    const unique = sel => {
      try {
        return root.querySelectorAll(sel).length === 1 ? sel : null;
      } catch {
        return null;
      }
    };

    // A role=radio wrapper around its own native input: by that input's name
    // and value, since Workable draws new random ids on every render.
    const role = el.getAttribute('role');
    const own = (role === 'radio' || role === 'checkbox') && el.querySelector('input[type="radio"][name][value], input[type="checkbox"][name][value]');
    if (own) {
      const hit = unique(`[role="${role}"]:has(input[name="${cssEscape(own.name)}"][value="${cssEscape(own.value)}"])`);
      if (hit) return hit;
    }

    if (el.id) {
      const hit = unique(`#${cssEscape(el.id)}`);
      if (hit) return hit;
    }

    const automation = el.getAttribute('data-automation-id');
    if (automation) {
      const hit = unique(`[data-automation-id="${cssEscape(automation)}"]`);
      if (hit) return hit;
    }

    for (const attr of ['data-testid', 'data-qa', 'data-test', 'name']) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const hit = unique(`${el.tagName.toLowerCase()}[${attr}="${cssEscape(value)}"]`);
      if (hit) return hit;
    }

    // A radio or tick box is its group's name plus its own value: Lever's
    // radios have no id, and their groups all share one structure.
    const name = el.getAttribute('name');
    const value = el.getAttribute('value');
    if (name && value !== null) {
      const hit = unique(`${el.tagName.toLowerCase()}[name="${cssEscape(name)}"][value="${cssEscape(value)}"]`);
      if (hit) return hit;
    }

    // Structural path as a last resort, grown until it matches this element
    // alone: a short path can match a look-alike elsewhere on the page.
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let part = node.tagName.toLowerCase();
      if (node.id && rootOf(node).querySelectorAll(`#${cssEscape(node.id)}`).length === 1) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (parts.length >= 3 && unique(parts.join(' > '))) break;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  // A native list is already in the page and cheap to read in full.
  const MAX_SELECT_OPTIONS = 2000;

  function optionsForSelect(el) {
    return Array.from(el.options || [])
      .filter(o => o.value !== '' || text(o))
      .slice(0, MAX_SELECT_OPTIONS)
      .map(o => ({ value: o.value, label: text(o) || o.value }));
  }

  function optionsForRadioGroup(radios) {
    return radios.slice(0, MAX_OPTIONS).map(r => ({
      value: r.value,
      // <spl-radio label="Yes" value="1"> keeps its words in its own label attribute.
      label: (!isNative(r) && r.getAttribute('label')) || labelFor(r) || r.value,
      selector: selectorFor(r)
    }));
  }

  /** "Research Assistant @ Generalist" or "Engineer at Globex | Careers": the company. */
  function companyFromTitle(title) {
    const hit = /\s(?:@|at)\s+([^|@]+?)\s*(?:[|–—]|$)/.exec(String(title || ''));
    return hit && hit[1].length <= 60 ? hit[1].trim() : '';
  }

  /** A hosted job board names the employer first in its path: jobs.ashbyhq.com/globex/... */
  function companyFromBoard() {
    if (!/(^|\.)(ashbyhq\.com|greenhouse\.io|lever\.co|workable\.com|smartrecruiters\.com|recruitee\.com|breezy\.hr)$/.test(location.hostname)) return '';
    const slug = new URLSearchParams(location.search).get('for') || location.pathname.split('/').filter(Boolean)[0] || '';
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug) || /^(embed|jobs?|apply|o)$/i.test(slug)) return '';
    return slug.replace(/-/g, ' ').replace(/\b[a-z]/g, c => c.toUpperCase());
  }

  /**
   * The schema.org JobPosting most boards publish for search engines (Ashby,
   * Greenhouse, Lever, Workday): the posting itself, even on an application
   * tab that shows only the form (Ashby's /application held no description,
   * so "Why Sesame?" was written blind).
   */
  function jobPosting() {
    const found = [];
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      const type = [].concat(node['@type'] || []);
      if (type.includes('JobPosting')) found.push(node);
      walk(node['@graph']);
    };
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { walk(JSON.parse(script.textContent || '')); } catch {}
    }
    const posting = found[0];
    if (!posting) return null;
    // The description is HTML: read it as text, a line per block. DOMParser runs no scripts.
    const html = String(posting.description || '').replace(/<\/(p|li|h\d|div)>|<br\s*\/?>/gi, '$&\n');
    const description = (new DOMParser().parseFromString(html, 'text/html').body?.textContent || '')
      .split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
    const org = posting.hiringOrganization;
    return { title: String(posting.title || '').trim(), company: String((org && (org.name || org)) || '').trim(), description };
  }

  /** Role, company and job description, used to ground written answers. */
  function pageContext() {
    const meta = name =>
      document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content?.trim() || '';

    const posting = jobPosting();
    const heading = text(document.querySelector('h1')) || '';
    const role = meta('og:title') || heading || posting?.title || document.title || '';
    const company =
      meta('og:site_name') ||
      document.querySelector('[class*="company" i]')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120) ||
      companyFromTitle(document.title) || companyFromBoard() || posting?.company ||
      location.hostname.replace(/^www\./, '');

    // The largest readable block on the page is, reliably, the job description.
    let description = '';
    const blocks = Array.from(
      document.querySelectorAll('main, article, [class*="description" i], [class*="job" i], [id*="content" i]')
    );
    for (const block of blocks) {
      const value = text(block);
      if (value.length > description.length) description = value;
    }
    if (!description) description = text(document.body);
    if (posting?.description?.length > 200) description = posting.description;

    return {
      url: location.href,
      title: document.title,
      role: role.slice(0, 200),
      company: String(company).slice(0, 120),
      jobDescription: description.slice(0, 8000),
      // Lines naming money, from the whole page: a pay range often sits past
      // the description's cut, or beside the form (Ashby's sidebar).
      payText: String(document.body?.innerText || '').split(/\n+/)
        .filter(line => /([$€£]|\b(usd|eur|gbp|cad|aud)\b)\s?\d/i.test(line)).join('\n').slice(0, 3000),
      // A "Next" or "Continue" button means this is one step of several, which
      // the popup surfaces so the user knows to run again on the next page.
      multiStep: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
        .some(b => /\b(next|continue|save and continue)\b/i.test(text(b) || b.value || ''))
    };
  }

  /** An option's own words: its accessible name, else its visible text. */
  function optionLabel(el) {
    // Workable labels each option by the question too ("...in Alameda, CA? YES"): only the option's own part.
    const group = el.closest('[role="radiogroup"], [role="group"], fieldset')?.getAttribute('aria-labelledby') || '';
    const groupIds = new Set(group.split(/\s+/).filter(Boolean));
    const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(id => !groupIds.has(id))
      .map(id => byId(el, id)).filter(n => n && n !== el).map(text).filter(Boolean).join(' ');
    return labelledBy || (el.getAttribute('aria-label') || '').trim() || text(el) ||
      el.getAttribute('data-value') || el.getAttribute('value') || '';
  }

  const isNative = el => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
  const ariaRole = el => (el.getAttribute('role') || '').toLowerCase() || (pressOption(el) ? 'radio' : '');

  /**
   * A toggle button that is one of two or more side by side (Ashby's Yes and
   * No): an option of one question, answered by pressing it. A lone toggle (an
   * editor's Bold button) is not.
   */
  function pressOption(el) {
    if (el.tagName !== 'BUTTON' || !el.hasAttribute('aria-pressed')) return false;
    return Array.from(el.parentElement?.children || []).filter(c => c.tagName === 'BUTTON' && c.hasAttribute('aria-pressed')).length > 1;
  }
  const isOn = el => el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';

  /**
   * The list a custom dropdown opens, if it is already in the page. Many
   * libraries only render it once opened; the filler reads it then.
   */
  function listboxFor(el) {
    for (const attr of ['aria-controls', 'aria-owns']) {
      for (const id of (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean)) {
        const node = byId(el, id);
        if (node && (ariaRole(node) === 'listbox' || node.querySelector('[role="option"]'))) return node;
      }
    }
    return null;
  }

  function optionsForListbox(el) {
    const box = listboxFor(el);
    if (!box) return [];
    return Array.from(box.querySelectorAll('[role="option"]'))
      .map(o => ({ value: o.getAttribute('data-value') || optionLabel(o), label: optionLabel(o) }))
      .filter(o => o.label)
      .slice(0, MAX_OPTIONS);
  }

  /** What a custom dropdown shows as chosen, or '' while it shows its prompt. */
  function listboxValue(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll?.('svg, title, desc').forEach(n => n.remove());
    const shown = text(clone).replace(/\u200b/g, '').trim();
    if (!shown || /^(select|choose|please|pick|--|—)|\.\.\.$|…$/i.test(shown)) return '';
    return shown.slice(0, 300);
  }

  /**
   * What a dropdown built around a text box shows as chosen. react-select
   * (Greenhouse, Lever) keeps the input empty and draws the choice beside it.
   */
  function shownNear(el) {
    const question = norm(labelFor(el));
    let node = el.parentElement;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      // Never into a wrapper holding another question's control or label.
      const others = Array.from(node.querySelectorAll('input:not([type="hidden"]), select, textarea, [role="combobox"], label'))
        .filter(n => n !== el && !(n.tagName === 'LABEL' && (n.htmlFor === el.id || n.contains(el))));
      if (others.length) break;
      const clone = node.cloneNode(true);
      // The question beside a box is not its answer, nor is an icon's
      // fallback text ("SVGs not supported by this browser").
      // Nor a style sheet the widget carries inside it (Saildrone's
      // react-select: ".remix-css-...{grid-area:...}" read as the country).
      clone.querySelectorAll('input, label, svg, title, desc, style, script, template, [class*="placeholder" i], [role="listbox"], [class*="menu" i], ' +
        '[role="alert"], [aria-live], [class*="error" i], [class*="invalid" i], [hidden], [aria-hidden="true"]')
        .forEach(n => n.remove());
      // An icon font's glyph (SuccessFactors draws the dropdown arrow as
      // U+E1EF) is not a value: every empty PG&E dropdown read as answered.
      const value = String(listboxValue(clone) || '').replace(ICON_GLYPH, '').trim();
      if (value && !/[\p{L}\p{N}]/u.test(value)) continue;
      // "This field is required." is the page's complaint, not an answer (SmartRecruiters).
      if (value && PAGE_COMPLAINT.test(value)) continue;
      if (value && norm(value) !== question && !question.startsWith(norm(value))) return value;
    }
    return '';
  }

  const norm = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

  // --- reading a dropdown's options --------------------------------------
  // Most design-system dropdowns render their options only while open. The
  // model can only choose well among options it can see, so during a fill
  // each such dropdown is opened, read and closed before anything is decided.

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

  const OPTION_LIKE = '[role="option"], [class*="__option" i], [class*="-option" i]';
  // A class only counts when it names the option itself ("select__option"),
  // not a piece inside one ("...-option-container-code": SmartRecruiters).
  const isOptionEl = o => o.getAttribute('role') === 'option' ||
    [...(o.classList || [])].some(c => /(__|-)option$/i.test(c));

  function visibleOptions() {
    return deepAll(OPTION_LIKE).filter(o => isOptionEl(o) && o.tagName !== 'OPTION' && o.getClientRects().length > 0 &&
      getComputedStyle(o).visibility !== 'hidden' && ![...o.querySelectorAll(OPTION_LIKE)].some(isOptionEl) &&
      !/notice|group-heading/i.test(o.className?.baseVal ?? o.className ?? '') &&
      text(o) && !/^(no (options|results|items|matches)|nothing found|loading)/i.test(text(o)));
  }

  function quietFocus(el) {
    el.focus({ preventScroll: true });
    if (document.hasFocus() && el.getRootNode().activeElement === el) return;
    el.dispatchEvent(new FocusEvent('focus', { composed: true }));
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
  }

  function quietBlur(el) {
    const real = document.hasFocus() && el.getRootNode().activeElement === el;
    el.blur();
    if (real) return;
    el.dispatchEvent(new FocusEvent('blur', { composed: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
  }

  /**
   * A whole key press, down and up. Widgets differ in which half they act
   * on: react-select opens on keydown, while Greenhouse's wrapper around it
   * opens only on keyup, and ignores keydown entirely.
   */
  const KEY_CODES = { ArrowDown: 40, Escape: 27, Enter: 13 };
  function press(el, key) {
    const init = { key, code: key, keyCode: KEY_CODES[key], which: KEY_CODES[key], bubbles: true, composed: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  /** A whole click, as a pointer makes it: down, up, click. */
  function tap(el) {
    const init = { bubbles: true, composed: true, cancelable: true, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', init));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    el.dispatchEvent(new PointerEvent('pointerup', init));
    el.dispatchEvent(new MouseEvent('mouseup', init));
    el.click();
  }

  /**
   * Open a dropdown the way its library listens (the keyboard first, which
   * selects nothing; then the pointer), read the options that appeared, and
   * close it again. Returns their texts, or [] when nothing opened, which is
   * the case for a search box that needs typing before it suggests anything.
   */
  /**
   * Only the entries of this control's own list: Workday marks each with its
   * search box's data-uxi-multiselect-id, other lists name themselves in
   * aria-controls. A list left open by another box (skills, read as a field
   * of study's options) is not this one's.
   */
  function ownOptions(el, options) {
    const id = el.getAttribute('data-uxi-multiselect-id');
    if (id) return options.filter(o => o.matches(`[data-uxi-multiselect-id="${id}"]`) || o.querySelector(`[data-uxi-multiselect-id="${id}"]`));
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

  async function readOptions(el) {
    const before = new Set(visibleOptions());
    const fresh = () => ownOptions(el, visibleOptions().filter(o => !before.has(o)));
    // A list that loads from a server shows a loading notice first; that
    // earns a longer wait, since the options are on their way.
    const loading = () => deepAll('[class*="loading" i], [aria-busy="true"]').some(n => n.getClientRects().length > 0 && !before.has(n));
    // A box that names its list is watched for longer: SuccessFactors'
    // lists take about 600 ms to open, and only that list is read.
    const named = /\S/.test(`${el.getAttribute('aria-controls') || ''}${el.getAttribute('aria-owns') || ''}`);
    const opened = async ms => {
      const found = await waitFor(() => { const f = fresh(); return f.length ? f : null; }, named ? Math.max(ms, NAMED_LIST_WAIT) : ms);
      if (found) return found;
      if (!loading()) return [];
      return (await waitFor(() => { const f = fresh(); return f.length ? f : null; }, 2000)) || [];
    };

    // Try first whatever opened the last dropdown on this page: a page's
    // dropdowns all come from one library. Remembered for the filler too.
    const order = globalThis.__applicatorOpenBy === 'pointer' ? ['pointer', 'keyboard'] : ['keyboard', 'pointer'];
    let how = 'none';
    let found = [];
    quietFocus(el);
    for (const way of order) {
      // Some lists toggle on a click, so a click is tried only once.
      if (way === 'keyboard') press(el, 'ArrowDown');
      else tap(el);
      found = await opened(way === 'keyboard' ? 300 : 400);
      if (found.length) {
        how = way;
        globalThis.__applicatorOpenBy = way;
        break;
      }
    }
    if (found.length) {
      // Workday adds options in stages ("Agency", "Employee Referral", then
      // four more): read until the count holds for 150 ms, at most 800 ms.
      const until = Date.now() + 800;
      let count = found.length;
      let still = Date.now();
      while (Date.now() < until && Date.now() - still < 150) {
        await new Promise(r => setTimeout(r, 50));
        const n = fresh().length;
        if (n !== count) { count = n; still = Date.now(); }
      }
      found = fresh();
    }
    const labels = [...new Set(found.map(text).filter(Boolean))].slice(0, MAX_OPTIONS);
    labels.how = how;

    press(el, 'Escape');
    quietBlur(el);
    if (!(await waitFor(() => !fresh().length, 200))) {
      // Still open: click away, the way a person closes a menu.
      tap(document.body);
      await waitFor(() => !fresh().length, 200);
    }
    return labels;
  }

  const MAX_PROBES = 60;
  /**
   * What a Workday prompt has chosen: the pills beside its search box, or
   * failing those, its spoken summary ("1 item selected, United States of
   * America (+1)").
   */
  function promptChoice(el) {
    const box = deepClosest(el, '[data-automation-id="multiSelectContainer"]') || el.parentElement;
    if (!box) return '';
    const pills = Array.from(box.querySelectorAll('[data-automation-id="selectedItemList"] [data-automation-id="promptOption"]'))
      .map(p => p.getAttribute('data-automation-label') || text(p)).filter(Boolean);
    if (pills.length) return pills.join('; ');
    const said = text(box.querySelector('[data-automation-id="promptAriaInstruction"]'));
    const m = said.match(/^\s*[1-9]\d* items? selected,\s*(.+)$/i);
    return m ? m[1].trim() : '';
  }

  const PROBE_BUDGET_MS = 12000;

  /** Read the options of every dropdown that has not rendered them yet. */
  async function probeDropdowns(fields, skip = []) {
    const skipped = new Set(skip);
    const started = Date.now();
    let probes = 0;
    for (const field of fields) {
      const wanted = (field.widget === 'listbox' && !field.options?.length) || (field.combobox && field.tag === 'input');
      if (!wanted || skipped.has(field.selector)) continue;
      // Out of time: the rest are read on the next pass, never decided unread
      // (Greenhouse's lists in a slow frame took ~2 s each).
      if (probes >= MAX_PROBES || Date.now() - started > PROBE_BUDGET_MS) {
        field.probePending = true;
        continue;
      }
      // A place box suggests only once something is typed; opening it shows nothing.
      if (field.combobox && field.tag === 'input' && !field.prompt &&
          /\b(location|city|town|address|where (do|are) you (live|based|located))\b/i.test(field.label || '')) continue;
      // A date box opens a calendar, not a list, and the keys that open a list
      // pick a day in it (Ashby's start date became today, its calendar left open).
      if (/\bdate\b|\b(start|end|from|to) (date|day)\b|\b(mm|dd)\s*\/\s*(dd|mm)\b/i.test(`${field.label || ''} ${field.placeholder || ''}`)) continue;
      const el = deepQuery(field.selector);
      if (!el) continue;
      probes++;
      const began = Date.now();
      const before = el.value;
      const labels = await readOptions(el);
      // Reading must not answer: a box the probe changed is put back.
      if (el.tagName === 'INPUT' && el.value !== before) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, before);
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        quietBlur(el);
      }
      // Kept on the descriptor for diagnostics: how it opened, and how long it took.
      field.probe = { how: labels.how, count: labels.length, ms: Date.now() - began };
      if (!labels.length) continue;
      // A fixed list: chosen from, not typed into. A searchable one keeps
      // the flag, so the filler can type to narrow a long list.
      field.options = labels.map(label => ({ value: label, label }));
      field.widget = 'listbox';
      field.searchable = el.tagName === 'INPUT';
      field.combobox = false;
    }
    return probes;
  }

  /**
   * A select2 or Chosen dropdown hides the real <select> and draws its own.
   * The hidden select is the one to fill: the skin listens to it.
   */
  function isSkinnedSelect(el) {
    if (el.tagName !== 'SELECT') return false;
    if (el.classList.contains('select2-hidden-accessible')) return true;
    const next = el.nextElementSibling;
    return !!(next && next.matches?.(SELECT_SKIN));
  }

  /**
   * The radios that answer the same question as this one. A shared name is the
   * browser's own grouping; React forms often leave radios unnamed, and then
   * the group is the nearest container holding more than one of them.
   */
  function radioGroupFor(el, controls, aria) {
    const isRadio = c => aria ? ariaRole(c) === 'radio' && !isNative(c)
      : c.tagName === 'INPUT' && (c.getAttribute('type') || '').toLowerCase() === 'radio';
    const name = aria ? '' : el.getAttribute('name') || '';
    if (name) {
      const root = rootOf(el);
      return controls.filter(c => isRadio(c) && c.getAttribute('name') === name && rootOf(c) === root);
    }
    const unnamed = c => isRadio(c) && (aria || !c.getAttribute('name'));
    const explicit = deepClosest(el, aria ? '[role="radiogroup"]' : 'fieldset, [role="radiogroup"]');
    if (explicit) {
      const inside = controls.filter(c => unnamed(c) && explicit.contains(c));
      if (inside.length) return inside;
    }
    for (let box = up(el), depth = 0; box && box !== document.body && depth < 6; box = up(box), depth++) {
      const inside = controls.filter(c => unnamed(c) && box.contains(c));
      if (inside.length > 1) return inside;
    }
    return [el];
  }

  /**
   * The tick boxes that answer one question together: those sharing a name
   * (Lever's "Which languages do you speak?", 33 boxes), or more than two in
   * one fieldset or group. Two boxes side by side are usually separate
   * consents, and stay separate.
   *
   * Boxes that share a name and a label are one per block, not the options
   * of one question: Workday's "I currently work here" in every job, Ashby's
   * "I don't wish to answer" under every survey question. Only those in this
   * box's own block, the widest container holding no repeated label, count.
   */
  function checkboxGroupFor(el, controls) {
    const isBox = c => (c.tagName === 'INPUT' && (c.getAttribute('type') || '').toLowerCase() === 'checkbox') ||
      (!isNative(c) && /^(checkbox|switch)$/.test(ariaRole(c)));
    const name = isNative(el) ? el.getAttribute('name') : '';
    if (name) {
      const same = controls.filter(c => isBox(c) && c.getAttribute('name') === name && rootOf(c) === rootOf(el));
      const repeats = boxes => {
        const seen = new Set();
        return boxes.some(b => {
          const text = (labelFor(b) || b.getAttribute('value') || '').trim().toLowerCase();
          if (!text) return false;
          if (seen.has(text)) return true;
          seen.add(text);
          return false;
        });
      };
      let mine = same;
      if (repeats(same)) {
        mine = [el];
        for (let box = up(el); box && box !== document.body && box.contains(el); box = up(box)) {
          const inside = same.filter(c => box.contains(c));
          if (repeats(inside)) break;
          mine = inside;
        }
      }
      if (mine.length > 1) return mine;
    }
    const group = deepClosest(el, 'fieldset, [role="group"]');
    if (group) {
      const inside = controls.filter(c => isBox(c) && group.contains(c));
      if (inside.length > 2) return inside;
    }
    return [el];
  }

  /**
   * The question over a group of tick boxes ("Which of these apply?"), so a
   * box labelled only "Asian" or "Weekends" carries what it is an answer to.
   */
  function checkboxQuestion(el, controls) {
    const group = deepClosest(el, 'fieldset, [role="group"]');
    if (!group) return '';
    const boxes = controls.filter(c => group.contains(c) &&
      ((c.tagName === 'INPUT' && c.type === 'checkbox') || (!isNative(c) && /^(checkbox|switch)$/.test(ariaRole(c)))));
    if (boxes.length < 2) return '';
    const own = labelFor(el);
    const question = radioQuestion(el, boxes, '');
    return question && question !== own ? question : '';
  }

  /**
   * Visible frames from another site that this frame cannot see into. The
   * background compares these with the frames that answered, and asks the
   * user for access to any form it could not reach.
   */
  const EMBED_NOISE = /recaptcha|hcaptcha|captcha|google\.com\/maps|youtube|vimeo|doubleclick|googletagmanager|facebook|twitter|linkedin\.com\/embed|stripe|paypal|intercom|drift|hubspot|zendesk|cookie|consent|onetrust|analytics|ads\./i;

  function embeddedFrames() {
    const out = [];
    for (const frame of deepAll('iframe')) {
      const src = frame.getAttribute('src') || '';
      if (!/^https?:/i.test(src) || EMBED_NOISE.test(src)) continue;
      const rect = frame.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 120) continue;
      try {
        const origin = new URL(src, location.href).origin;
        if (origin !== location.origin && !out.some(e => e.origin === origin)) out.push({ origin, src: src.slice(0, 300) });
      } catch { /* not a URL */ }
    }
    return out;
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.probe]  Open custom dropdowns to read their
   *   options. Only a fill asks for this; reading the page for the popup or
   *   for learning never touches the form.
   */
  /**
   * The markup around a control, for a developer reading a report: the
   * nearest ancestor that also holds its question, without styles or long
   * class lists, trimmed.
   */
  function contextOf(el) {
    let node = el;
    for (let depth = 0; depth < 4 && node; depth++) {
      const parent = up(node);
      if (!parent || parent === document.body) break;
      node = parent;
      if (text(node).length > 25) break;
    }
    const clone = node.cloneNode(true);
    for (const n of [clone, ...clone.querySelectorAll('*')]) {
      n.removeAttribute?.('style');
      if ((n.getAttribute?.('class') || '').length > 60) n.setAttribute('class', n.getAttribute('class').slice(0, 60) + '…');
      if (n.tagName === 'svg' || n.tagName === 'SVG') n.replaceChildren();
    }
    return clone.outerHTML.replace(/\s+/g, ' ').slice(0, 1500);
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.context]  Include each field's surrounding markup
   *   (development reports only).
   */
  async function extract({ probe = false, skip = [], context = false, structure = false, rules = {} } = {}) {
    // The rules pack's patterns and waits (background/rules.js), as plain
    // strings; the built-in ones stand where it gives none or a bad one.
    const emptyChoice = parsePackRegex(rules.emptyChoice) || EMPTY_CHOICE;
    NAMED_LIST_WAIT = Number(rules.namedListWaitMs) || 1000;
    GENERIC_LABEL = parsePackRegex(rules.genericLabel) || BUILTIN_GENERIC_LABEL;
    PAGE_COMPLAINT = parsePackRegex(rules.pageComplaint) || BUILTIN_PAGE_COMPLAINT;
    QUESTION_TITLE = parsePackRegex(rules.questionTitle) || BUILTIN_QUESTION_TITLE;
    const glyph = parsePackRegex(rules.iconGlyph) || BUILTIN_ICON_GLYPH;
    ICON_GLYPH = new RegExp(glyph.source, glyph.flags.replace('g', '') + 'g');
    SELECT_SKIN = validSelector(rules.selectors?.selectSkin) || BUILTIN_SELECT_SKIN;
    ERROR_TEXT = validSelector(rules.selectors?.errorText) || BUILTIN_ERROR_TEXT;
    // Which platforms' markers this page holds, for detectPlatform.
    const platformMarkers = (rules.markers || []).filter(m => {
      try { return !!document.querySelector(m.selector); } catch { return false; }
    }).map(m => m.id);
    const controls = deepAll(CONTROL_SELECTOR);

    const fields = [];
    const readEls = [];
    const claimed = new Set();
    let skippedSensitive = 0;
    let index = 0;

    for (const el of controls) {
      if (fields.length >= MAX_FIELDS) break;
      if (claimed.has(el)) continue;

      const tag = el.tagName.toLowerCase();
      const role = ariaRole(el);
      const native = isNative(el);

      // What kind of control this is, whatever it is built from.
      let kind;
      if (native) kind = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag;
      // A wrapper; its own control is found separately. Unless that control
      // is hidden and the wrapper is what a person clicks: Rippling's
      // div[role=radio] around a display:none radio.
      else if (el.querySelector('input, select, textarea') && !clickedForHidden(el, role)) continue;
      else if (role === 'radio') kind = 'aria-radio';
      else if (role === 'checkbox' || role === 'switch') kind = 'aria-checkbox';
      else if (role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') kind = 'listbox';
      else if (el.isContentEditable) {
        if (el.parentElement?.isContentEditable) continue; // inside a larger editor
        kind = 'richtext';
      } else continue;

      const type = kind === 'aria-radio' ? 'radio' : kind === 'aria-checkbox' ? 'checkbox'
        : kind === 'richtext' ? tag : kind;

      if (native && tag === 'input' && FORBIDDEN_TYPES.has(type)) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;
      // The part of a select2 or Chosen widget that is drawn over a real select.
      if (!native && skinOf(el)) continue;
      // The skin's own search box; a radio or tick box is never part of one.
      if (native && el.tagName === 'INPUT' && !/^(radio|checkbox)$/i.test(el.type) && skinOf(el)) continue;
      const skinned = isSkinnedSelect(el);
      if (!skinned && !isVisible(el)) continue;

      // A plain text box that draws its own list of suggestions (Lever's
      // location: a sibling "dropdown-results" div) is chosen from too.
      const suggests = native && tag === 'input' && /^(text|search)$/.test((el.getAttribute('type') || 'text').toLowerCase()) &&
        !!Array.from(el.parentElement?.children || []).find(c => c !== el &&
          /(dropdown|results|suggest|autocomplete|typeahead|predictions)/i.test(c.getAttribute?.('class') || '') &&
          !c.querySelector('input, select, textarea'));
      // Workday's prompt: a search box that opens a list, and keeps what is
      // chosen as pills beside it rather than as its value.
      const prompt = native && tag === 'input' && el.getAttribute('data-uxi-widget-type') === 'selectinput';
      const combobox = kind !== 'listbox' && (suggests || prompt || role === 'combobox' || el.getAttribute('aria-autocomplete') === 'list' ||
        /combobox/.test(hostOf(el)?.getAttribute('ariarole') || '') ||
        (hostOf(el)?.getAttribute('ariaautocomplete') || '') === 'list');
      const placeholder = el.getAttribute('placeholder') || '';
      const datePicker = type === 'date' || type === 'month' || /date|calendar/i.test(hostOf(el)?.tagName || '') ||
        /pick (a )?date|mm\/dd|dd\/mm|yyyy/i.test(placeholder) || !!deepClosest(el, '[class*="datepicker" i], [class*="date-picker" i]');
      // A read-only box that opens a picker is still answered, through the picker.
      if (el.readOnly && !(combobox || datePicker || el.getAttribute('aria-haspopup'))) continue;

      const name = el.getAttribute('name') || '';
      const idAttr = el.id || '';
      let label = labelFor(el);

      // The site's own menus (Workday's language and settings buttons) sit in
      // its header or navigation, outside any form.
      if (!native && deepClosest(el, 'header, nav, [role="banner"], [role="navigation"]') && !deepClosest(el, 'form')) continue;

      // The entries of an open list are choices, not questions: Workday draws
      // each as a radio inside a list item (31 unlabelled "questions").
      if (deepClosest(el, '[role="option"], [data-uxi-widget-type="multiselectlistitem"], [data-automation-id="activeListContainer"]')) continue;

      // A site's own search or help box is not part of the application.
      if (type === 'search' || deepClosest(el, '[role="search"]') ||
          /^(search|need help)/i.test(label || placeholder) || /search/i.test(deepClosest(el, 'form')?.id || '')) continue;

      if (isForbidden(name, idAttr, label, placeholder)) {
        skippedSensitive++;
        continue;
      }

      // Radios collapse into one logical field with a set of options.
      if (type === 'radio') {
        const aria = kind === 'aria-radio';
        const radios = radioGroupFor(el, controls, aria);
        radios.forEach(r => claimed.add(r));
        // The hidden box Ashby keeps in step with its Yes/No buttons is the
        // same question, not another one.
        if (pressOption(el)) el.parentElement.querySelectorAll('input').forEach(i => claimed.add(i));
        // A radio without a value attribute reports "on"; its label is the answer.
        const valueOf = r => {
          const own = aria ? '' : r.getAttribute('value');
          return own && own !== 'on' ? own : (aria ? optionLabel(r) : (labelFor(r) || own || ''));
        };
        const options = radios.slice(0, MAX_OPTIONS).map(r => ({
          value: valueOf(r),
          label: aria ? optionLabel(r) : (labelFor(r) || valueOf(r)),
          selector: selectorFor(r)
        }));
        const chosen = radios.find(r => (aria ? isOn(r) : r.checked));
        const question = radioQuestion(el, radios, aria ? '' : label);
        const section = sectionFor(el);
        const repeat = repeatIndexFor(name, idAttr, section, question);

        fields.push({
          id: `f${index++}`,
          tag: aria ? tag : 'input',
          type: 'radio',
          widget: aria ? 'aria' : undefined,
          selector: selectorFor(el),
          name,
          idAttr,
          groupName: name || question,
          label: question,
          ariaLabel: aria ? '' : el.getAttribute('aria-label') || '',
          section,
          required: isRequired(el) || /\*\s*$/.test(question),
          options,
          // What a person sees as the answer: the chosen option's label.
          currentValue: chosen ? (aria ? optionLabel(chosen) : (labelFor(chosen) || valueOf(chosen))) : '',
          multiline: false,
          repeatRaw: repeat.raw,
          repeatFrom: repeat.from,
          repeatGroup: repeat.group
        });
        continue;
      }

      if (type === 'checkbox') {
        const boxes = checkboxGroupFor(el, controls);
        if (boxes.length > 1) {
          // One question, answered by ticking among its boxes.
          const aria = kind === 'aria-checkbox';
          boxes.forEach(b => claimed.add(b));
          const isOn = b => (isNative(b) ? b.checked : b.getAttribute('aria-checked') === 'true');
          const optionOf = b => {
            const label = isNative(b) ? (labelFor(b) || b.getAttribute('value') || '') : optionLabel(b);
            return { value: label, label, selector: selectorFor(b) };
          };
          const question = radioQuestion(el, boxes, '') || checkboxQuestion(el, controls) || '';
          const section = sectionFor(el);
          fields.push({
            id: `f${index++}`,
            tag: aria ? tag : 'input',
            type: 'checkboxgroup',
            widget: aria ? 'aria' : undefined,
            selector: selectorFor(el),
            // What the boxes share, never the first box's own name: Ashby
            // names each box after its option, and a group called "LinkedIn"
            // matched the LinkedIn rule.
            name: sharedPart(boxes.map(b => b.getAttribute('name') || '')),
            idAttr: sharedPart(boxes.map(b => b.id || '')),
            label: question,
            ariaLabel: '',
            section,
            required: boxes.some(isRequired),
            options: boxes.slice(0, MAX_OPTIONS).map(optionOf),
            currentValue: boxes.filter(isOn).map(b => optionOf(b).label).join('; '),
            multiline: false
          });
          continue;
        }
        if (kind === 'aria-checkbox') label = optionLabel(el) || label;
        const question = checkboxQuestion(el, controls);
        if (question) label = `${question}: ${label}`;
      }

      const section = sectionFor(el);
      const repeat = repeatIndexFor(name, idAttr, section, label);

      const descriptor = {
        id: `f${index++}`,
        tag,
        type,
        // A read-only combobox is a dropdown that only opens; it is chosen from, not typed into.
        widget: kind === 'aria-checkbox' ? 'aria'
          : kind === 'listbox' || (combobox && el.readOnly) ? 'listbox' : undefined,
        selector: selectorFor(el),
        name,
        idAttr,
        // Web components put autocomplete on the host and "off" on the input.
        autocomplete: [el.getAttribute('autocomplete'), hostOf(el)?.getAttribute('autocomplete')]
          .find(v => v && v !== 'off') || '',
        placeholder,
        label,
        ariaLabel: el.getAttribute('aria-label') || '',
        dataAttr: el.getAttribute('data-automation-id') || el.getAttribute('data-testid') || '',
        section,
        required: isRequired(el),
        invalid: showsError(el) || undefined,
        maxLength: Number(el.getAttribute('maxlength')) || 0,
        currentValue: kind === 'aria-checkbox' ? (el.getAttribute('aria-checked') === 'true' ? 'checked' : '')
          : prompt ? promptChoice(el)
          : kind === 'listbox' ? listboxValue(el) || shownNear(el)
            // Only a widget draws its value beside itself; a plain text box
            // with suggestions holds its value, and nothing next to it counts.
            : combobox && !suggests && !el.value ? shownNear(el)
              : readValue(el, type),
        multiline: tag === 'textarea' || kind === 'richtext',
        // A date picker parses what is typed its own way; the value is written
        // in the format it reads.
        datePicker,
        dateFormat: datePicker ? (el.getAttribute('data-format') || el.getAttribute('data-date-format') || el.getAttribute('data-dateformat') || undefined) : undefined,
        // A box that offers suggestions as you type, where one has to be picked.
        combobox,
        suggests,
        prompt: prompt || undefined,
        repeatRaw: repeat.raw,
        repeatFrom: repeat.from,
        repeatGroup: repeat.group
      };

      if (tag === 'select') {
        descriptor.options = optionsForSelect(el);
        // A list longer than the options kept (every university, every
        // country) is matched in full when filled.
        if ((el.options?.length || 0) > descriptor.options.length + 1) descriptor.searchable = true;
        // A placeholder option ("Select month...") is no answer at all, and an
        // option the page preselected is its default rather than the user's.
        const chosen = el.selectedOptions?.[0];
        const chosenText = chosen ? text(chosen) : '';
        const placeholder = !chosen || chosen.value === '' || /^(select|choose|please|--)|\*$/i.test(chosenText);
        descriptor.currentText = placeholder ? '' : chosenText;
        descriptor.currentValue = placeholder ? '' : descriptor.currentValue;
        // With no option marked selected the browser shows the first: still
        // the page's default, not an answer (CalCareers' Phone Type on "Work").
        const unmarked = el.selectedIndex === 0 && ![...el.options].some(o => o.defaultSelected);
        descriptor.pageDefault = !placeholder && (!!chosen.defaultSelected || unmarked);
      } else if (descriptor.widget === 'listbox') {
        // Often empty until the list is opened; the filler reads it then.
        descriptor.options = optionsForListbox(el);
        descriptor.currentText = descriptor.currentValue;
      }
      // A dropdown showing its empty choice holds no answer: SuccessFactors'
      // "No Selection" made every PG&E yes/no question look answered.
      if ((descriptor.widget === 'listbox' || combobox || descriptor.type === 'radio') && emptyChoice.test(String(descriptor.currentValue || ''))) {
        descriptor.currentValue = '';
        descriptor.currentText = '';
      }

      fields.push(descriptor);
      readEls.push(el);
    }

    const probed = probe ? await probeDropdowns(fields, skip) : 0;
    if (context) {
      for (const field of fields) {
        const el = deepQuery(field.selector);
        if (el) field.context = contextOf(el);
      }
    }

    return {
      ok: true,
      fields,
      probed,
      platformMarkers,
      skippedSensitive,
      uploads: findUploads(),
      unread: unreadQuestions(readEls, claimed, fields),
      addButtons: addEntryButtons(),
      // Visible text, which never includes what is typed in a box: used to see
      // which jobs a one-at-a-time "Add employer" page has already listed.
      pageText: listedText(),
      // The page as lines, for TypeSafe to find each field's question (structure.js).
      structure: structure ? structureOf(fields) : undefined,
      context: pageContext(),
      origin: location.origin,
      top: window === window.top,
      embeds: embeddedFrames(),
      extractedAt: Date.now()
    };
  }

  /**
   * The page's visible text plus the labels of its buttons. A button's label
   * is its value, which innerText leaves out, and CalCareers lists the schools
   * and jobs already added as buttons ("Northfield University" opens that
   * entry): without them every school looks new and the first is added again.
   */
  /**
   * The page read as a person reads it: its visible text as numbered lines in
   * reading order (through shadow trees and slots), with where each field's
   * control and options sit among them. TypeSafe then picks, per field, which
   * nearby line is its question (background/structure.js), in place of the
   * label rules above, which can only cover the layouts written for.
   *
   * Returns the form's region only: { lines, fields: { [id]: { marker,
   * candidates, options: [{ index, label, candidates }] } } }, with line
   * numbers into `lines`.
   */
  function structureOf(fields) {
    const owner = new Map();
    for (const f of fields) {
      const head = deepQuery(f.selector);
      if (head) owner.set(head, { id: f.id });
      (f.options || []).forEach((o, i) => {
        const el = o.selector ? deepQuery(o.selector) : null;
        if (el && !owner.has(el)) owner.set(el, { id: f.id, option: i });
        else if (el && owner.get(el).id === f.id) owner.set(el, { id: f.id, option: i });
      });
    }
    const lines = [];
    const marks = [];
    let pending = '';
    const flush = () => {
      const t = pending.replace(/\s+/g, ' ').trim();
      pending = '';
      if (t && /[A-Za-z0-9?*]/.test(t)) lines.push(t.slice(0, 240));
    };
    const shown = el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'contents') return true;
      if (!el.getClientRects().length) return false;
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01;
    };
    const BLOCK = /^(block|flex|grid|list-item|table|table-row|table-cell|table-caption|flow-root)$/;
    const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|HEAD|IFRAME)$/;
    const childrenOf = node => {
      if (node.shadowRoot) return node.shadowRoot.childNodes;
      if (node.tagName === 'SLOT') {
        const assigned = node.assignedNodes({ flatten: true });
        return assigned.length ? assigned : node.childNodes;
      }
      return node.childNodes;
    };
    let visited = 0;
    const walk = node => {
      for (const child of childrenOf(node)) {
        if (++visited > 40000) return;
        if (child.nodeType === 3) { pending += ' ' + child.textContent; continue; }
        if (child.nodeType !== 1 || SKIP.test(child.tagName.toUpperCase())) continue;
        if (child.tagName === 'SLOT') { walk(child); continue; }
        const own = owner.get(child);
        if (own) {
          flush();
          marks.push({ ...own, at: lines.length, el: child });
          if (/^(SELECT|TEXTAREA|BUTTON)$/.test(child.tagName)) continue;
        }
        if (!own && !shown(child) && child.tagName !== 'LABEL') continue;
        const block = child.tagName === 'BR' || BLOCK.test(getComputedStyle(child).display);
        if (block) flush();
        walk(child);
        if (block) flush();
      }
    };
    walk(document.body);
    flush();

    const byField = new Map();
    for (const m of marks) {
      if (!byField.has(m.id)) byField.set(m.id, []);
      byField.get(m.id).push(m);
    }
    const starts = marks.map(m => m.at).sort((a, b) => a - b);
    const describe = el => {
      const type = el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text') : (el.getAttribute('role') || el.tagName.toLowerCase());
      const bits = [type];
      const add = (k, v) => { v = String(v || '').replace(/\s+/g, ' ').trim(); if (v) bits.push(`${k}="${v.slice(0, 60)}"`); };
      add('name', el.getAttribute('name'));
      // A short id often says what an unnamed box is (UC_..._AMPHI_CHK); long ones are noise.
      add('id', el.id && el.id.length < 50 ? el.id : '');
      add('placeholder', el.getAttribute('placeholder'));
      add('aria-label', el.getAttribute('aria-label'));
      if (el.tagName === 'BUTTON') add('text', el.textContent);
      if (el.required || el.getAttribute('aria-required') === 'true') bits.push('required');
      return bits.join(' ');
    };
    const out = {};
    let lo = Infinity;
    let hi = -1;
    for (const f of fields) {
      const ms = byField.get(f.id);
      if (!ms) continue;
      const first = Math.min(...ms.map(m => m.at));
      const last = Math.max(...ms.map(m => m.at));
      // The next control of another field closes the lines that follow.
      const next = starts.find(a => a > last) ?? lines.length;
      const before = [];
      for (let i = first - 1; i >= 0 && before.length < 8; i--) before.unshift(i);
      const inside = [];
      for (let i = first; i < last; i++) inside.push(i);
      const after = [];
      for (let i = last; i < Math.min(next, last + 3); i++) after.push(i);
      const candidates = [...before, ...inside, ...after].filter(i => i < lines.length);
      const head = (ms.find(m => m.option === undefined) || ms[0]).el;
      const options = (f.options || []).map((o, i) => {
        const m = ms.find(x => x.option === i);
        const near = m ? [m.at - 2, m.at - 1, m.at, m.at + 1].filter(x => x >= 0 && x < lines.length) : [];
        return { index: i, label: o.label || '', candidates: near };
      });
      out[f.id] = {
        // Where the control sits among the lines: TypeSafe reads it in place.
        at: first,
        marker: describe(head) + ((f.options || []).length > 1
          ? ` (first of ${f.options.length} options: ${f.options.slice(0, 8).map(o => (o.label || '?').slice(0, 30)).join(', ')})` : ''),
        candidates,
        options: options.filter(o => !/[A-Za-z0-9]/.test(o.label))
      };
      lo = Math.min(lo, first);
      hi = Math.max(hi, last);
    }
    if (hi < 0) return { offset: 0, lines: [], fields: {} };
    const from = Math.max(0, lo - 15);
    const to = Math.min(lines.length, hi + 6);
    return { offset: from, lines: lines.slice(from, to), fields: out };
  }

  function listedText() {
    const buttons = [...document.querySelectorAll('input[type=submit], input[type=button]')]
      .map(b => b.value).filter(Boolean).join('\n');
    return `${buttons}\n${document.body?.innerText || ''}`.slice(0, 60000);
  }

  /**
   * Buttons that add one entry to a list: "Add Employment Record"
   * (CalCareers), or Workday's plain "Add" and "Add Another", whose list is
   * named by the heading they sit under. The fill presses the safe ones
   * until the page shows a block for each saved entry; one that would send
   * or reload the page (an ASP.NET post-back, a submit input, a link to
   * another page) is only named in the popup for the user to click.
   */
  const ADD_WORDS = /^(\+\s*)?(add|add another|add more|add new|add one more|add an?|new|\+)(\s+(entry|item|row|record|one|more|another))?\s*\+?$/i;

  function addEntryButtons() {
    const out = [];
    const seen = new Set();
    for (const b of deepAll('button, input[type="submit"], input[type="button"], a, [role="button"]')) {
      if (out.length >= 8) break;
      if (!b.getClientRects().length || b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
      const own = String(b.value || b.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = String(b.getAttribute('aria-label') || b.title || '').replace(/\s+/g, ' ').trim();
      let list = entryListOf(own) || entryListOf(aria);
      if (!list && (ADD_WORDS.test(own) || ADD_WORDS.test(aria) || (!own && /^\+$/.test(aria)))) {
        // A plain "Add": the list is the heading it sits under.
        // The nearest heading first: "Education" under "My Experience".
        for (const heading of String(sectionFor(b) || '').split(' › ').slice(0, 2)) {
          list = entryListOf(`add ${heading}`.slice(0, 50));
          if (list) break;
        }
      }
      if (!list) continue;
      const selector = selectorFor(b);
      if (seen.has(selector)) continue;
      seen.add(selector);
      out.push({ text: (own || aria).slice(0, 60), list, selector, safe: safeToPress(b) });
    }
    return out;
  }

  /** Pressing it only changes this page: no post-back, no submit input, no link away. */
  function safeToPress(b) {
    const code = `${b.getAttribute('onclick') || ''} ${b.getAttribute('href') || ''}`;
    if (/__doPostBack|WebForm_DoPostBack|\.submit\(/i.test(code)) return false;
    if (b.tagName === 'INPUT' && /^(submit|image)$/i.test(b.type)) return false;
    if (b.tagName === 'A') {
      const href = (b.getAttribute('href') || '').trim();
      if (href && !/^(#|javascript:\s*(void\(0\)|;)?\s*;?$)/i.test(href)) return false;
    }
    return true;
  }

  /** The start the strings share ("q[3][0]", "q[3][1]" -> "q[3]"), or '' when it is too short to mean anything. */
  function sharedPart(values) {
    if (values.every(v => v === values[0])) return values[0];
    let n = 0;
    while (values.every(v => n < v.length && v[n] === values[0][n])) n++;
    const part = values[0].slice(0, n).replace(/[-_.[:\s]+$/, '');
    return part.length >= 3 ? part : '';
  }

  /** Which saved list an "Add ..." button's text adds to, if any. */
  function entryListOf(text) {
    if (text.length > 50 || !/^\+?\s*add\b/i.test(text)) return null;
    if (/employ|\bjob\b|work (experience|history)|\bexperience\b|\bposition\b|\bemployer\b/i.test(text)) return 'employment';
    if (/educat|\bschool\b|\bdegree\b|universit|college/i.test(text)) return 'education';
    if (/\breferences?\b|\breferee\b/i.test(text)) return 'references';
    return null;
  }

  /**
   * Questions on the form that no field was read for: the sign of a control
   * Applicator does not recognise yet (a widget drawn from plain divs, a new
   * design system). Only text inside the form's own area counts, so a job
   * description's "What will you do?" is not one, and only text that reads as
   * a question: ending in "?" or carrying a required marker. Free, no model:
   * it is what tells a fill that missed something from one that did not.
   */
  function unreadQuestions(readEls, claimed, fields) {
    const controls = [...readEls, ...claimed].filter(Boolean);
    const uploads = deepAll('input[type="file"]');
    if (!controls.length) return [];
    const area = commonArea(controls);
    if (!area) return [];
    const known = fields.map(f => normText(`${f.label || ''} ${f.section || ''}`)).join(' | ');
    // The question's own box: going up from it while a container holds
    // little more text than the question (the question and its control's
    // value), and no further. A control in that box answers it.
    const near = (node, own) => {
      for (let n = node, depth = 0; n && n !== area && depth < 5; n = up(n), depth++) {
        if (depth && (n.textContent || '').replace(/\s+/g, ' ').trim().length > own.length + 120) break;
        if (controls.some(c => n.contains(c)) || uploads.some(u => n.contains(u))) return true;
        if (shownControlIn(n) || attachedFileIn(n)) return true;
      }
      return false;
    };
    const out = [];
    for (const node of area.querySelectorAll('label, legend, p, span, div, h3, h4, h5, strong, b')) {
      if (out.length >= 10) break;
      // The node's own words, not its children's.
      const own = Array.from(node.childNodes).filter(c => c.nodeType === 3).map(c => c.textContent).join(' ').replace(/\s+/g, ' ').trim();
      if (own.length < 6 || own.length > 240) continue;
      // Cheap tests first; what is actually shown only for the few left.
      const whole = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (whole.length > 260 || !/(\?|[*✱])\s*[*✱]?$/.test(whole)) continue;
      if (!node.getClientRects().length || deepClosest(node, 'nav, header, footer, [role="navigation"], [role="banner"]')) continue;
      if (!/(\?|[*✱])\s*[*✱]?$/.test(seen(node))) continue;
      if (known.includes(normText(own))) continue;
      if (near(node, whole)) continue;
      // A heading followed by a paragraph explaining it ("How do you know if
      // you have a disability?" on the US disability form) is not a question.
      if (explained(node)) continue;
      out.push(own.slice(0, 160));
    }
    return out;
  }

  const normText = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  /**
   * A control a person can see inside `n`, read or not (a disabled box, a
   * password field). Buttons and zero-size inputs do not count: Ashby's
   * unread Yes/No buttons over a hidden checkbox once hid three required
   * questions from this check.
   */
  function shownControlIn(n) {
    const found = n.querySelectorAll?.('input:not([type="hidden"]), select, textarea, [role="combobox"], [role="radio"], [role="checkbox"], [role="listbox"], [contenteditable="true"]') || [];
    return Array.from(found).some(c => {
      const box = c.getBoundingClientRect();
      return box.width > 2 && box.height > 2;
    });
  }

  /**
   * A file already attached inside `n`: once a CV is in, Greenhouse replaces
   * its file input with the file's name and a "Remove file" button, and the
   * upload question looked missed.
   */
  /**
   * The page marks this box as wrong: aria-invalid, or an error shown in its
   * own question box (Workday's "Error: Invalid Date: 07/" beside a date that
   * shows 07/2023 but holds only the month). Such a box is not answered.
   */
  function showsError(el) {
    if (el.getAttribute('aria-invalid') === 'true') return true;
    const own = el.closest('[data-automation-id^="formField-"], fieldset, [class*="form-group" i], [class*="field-wrapper" i]');
    if (!own) return false;
    return [...own.querySelectorAll(ERROR_TEXT)]
      .some(n => n.getClientRects().length && /error|invalid|required|must/i.test(n.textContent || ''));
  }

  function attachedFileIn(n) {
    if (!n.querySelectorAll) return false;
    if (Array.from(n.querySelectorAll('button, [role="button"], a')).some(b =>
      /\b(remove|delete|replace|change)\b.*\b(file|attachment|resume|cv|document)\b/i.test(`${b.getAttribute('aria-label') || ''} ${b.title || ''} ${b.textContent || ''}`))) return true;
    return Array.from(n.querySelectorAll('p, span, a, div')).some(e => !e.children.length &&
      /^\S.{0,150}\.(pdf|docx?|rtf|txt|odt|pages)$/i.test((e.textContent || '').trim()));
  }

  function explained(node) {
    for (let n = node, depth = 0; n && depth < 3; n = n.parentElement, depth++) {
      const next = n.nextElementSibling;
      if (!next) continue;
      const prose = (next.textContent || '').replace(/\s+/g, ' ').trim();
      return prose.length > 120 && !next.querySelector('input, select, textarea, [role="combobox"], [role="radio"], [role="checkbox"]');
    }
    return false;
  }

  /** The smallest element holding every control read, or the form around them. */
  function commonArea(els) {
    const form = deepClosest(els[0], 'form');
    if (form && els.every(e => form.contains(e))) return form;
    let area = els[0].parentElement;
    while (area && !els.every(e => area.contains(e))) area = area.parentElement;
    return area && area !== document.documentElement ? area : document.body;
  }

  /**
   * File inputs that look like they want a CV.
   *
   * These are reported separately because a file input is never "filled" in the
   * ordinary sense, and Applicator only attaches a document the user stored
   * themselves, never anything read from the page or the disk.
   */
  function findUploads() {
    const out = [];
    const inputs = deepAll('input[type="file"]');

    for (const el of inputs) {
      if (el.disabled) continue;
      const label = labelFor(el) || '';
      const host = hostOf(el);
      const hostAttrs = host ? Array.from(host.attributes).map(a => a.value).join(' ') : '';
      // Rippling names the box only in its own data-testid ("input-resume")
      // and in the wrapping label's aria-labelledby ("Résumé"); its visible
      // words are "Drop or select".
      const wrap = el.closest('label');
      const named = [el.getAttribute('data-testid'), el.getAttribute('title'), wrap?.getAttribute('data-testid'),
        ...(wrap?.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => id && byId(el, id)).filter(Boolean).map(text)]
        .filter(Boolean).join(' ');
      const own = `${el.name || ''} ${el.id || ''} ${label} ${named} ${hostAttrs}`;
      const probe = `${own} ${sectionFor(el)}`;
      // "Autofill from resume" boxes make the site rewrite the form from the
      // file, undoing what was just filled. Only a plain resume field is used.
      if (/autofill|apply[-_ ]with[-_ ]resume|autocomplete your/i.test(probe)) continue;
      // The box's own words first, then its heading ("Resume and cover
      // letter" heads both boxes); cover letter first within each.
      const kindOf = t => /cover[\s_-]*letter/i.test(t) ? 'coverLetter'
        : /resume|r\u00e9sum\u00e9|\bcv\b|curriculum/i.test(t) ? 'resume' : null;
      const kind = kindOf(own) || kindOf(probe);
      if (!kind) continue;

      out.push({
        kind,
        selector: selectorFor(el),
        label: label.slice(0, 160),
        accept: el.getAttribute('accept') || '',
        multiple: el.multiple,
        alreadyHasFile: !!(el.files && el.files.length),
        // Greenhouse marks the group around its hidden input, not the input.
        required: isRequired(el),
        manualSelector: manualButton(el)
      });
    }
    return out;
  }

  /**
   * The button beside an upload that opens a box to type the document into
   * instead (Greenhouse's "Enter manually"), so a required cover letter with
   * no saved file can be written. Looked for in the upload's own block only.
   */
  function manualButton(el) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      if (node.querySelectorAll('input[type="file"]').length > 1) break;
      const b = Array.from(node.querySelectorAll('button, [role="button"]'))
        .find(x => /^(enter|type|paste)\s+(it\s+)?(manually|text|in)\b|^write (it|one)\b/i.test(text(x)));
      if (b) return selectorFor(b);
    }
    return '';
  }

  function isRequired(el) {
    return el.required || el.getAttribute('aria-required') === 'true' ||
           !!deepClosest(el, '[role="group"][aria-required="true"], [role="radiogroup"][aria-required="true"]') ||
           !!deepClosest(el, '[class*="required" i]') || requiredByLabel(el) ||
           // Workday: " Select One Required" on the button, and an
           // <abbr class="requiredAsterisk"> in the legend, not around it.
           /\brequired\s*$/i.test(el.getAttribute('aria-label') || '') || legendRequired(el) ||
           // CalCareers: "Institution Name: **".
           (!/^(radio|checkbox)$/.test(el.type) && /\*\s*$/.test(labelFor(el)));
  }

  function legendRequired(el) {
    const legend = deepClosest(el, 'fieldset')?.querySelector(':scope > legend');
    return !!legend && (!!legend.querySelector('[class*="required" i], abbr[title="required" i]') || /\*\s*$/.test(text(legend)));
  }

  // Ashby marks the question's label, a sibling of the box ("_required_" on
  // label.ashby-application-form-question-title), not anything around it.
  function requiredByLabel(el) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const label = Array.from(node.children).find(c => /^(LABEL|LEGEND)$/.test(c.tagName) || QUESTION_TITLE.test(c.className || ''));
      if (!label || label.contains(el)) continue;
      // A radio's own option label is not the question's.
      if (/^(radio|checkbox)$/.test(el.type) && el.id && label.htmlFor === el.id) continue;
      return /required/i.test(String(label.className || '')) || /\*\s*$/.test(label.textContent || '');
    }
    return false;
  }

  function readValue(el, type) {
    if (type === 'checkbox') return el.checked ? 'checked' : '';
    if (el.isContentEditable) return (el.textContent || '').trim().slice(0, 4000);
    return (el.value || '').slice(0, 4000);
  }

  /**
   * The question a radio group asks. Each radio's own label is only one answer
   * ("Yes", "He/Him"), so the group's legend, its accessible name, or the text
   * just above the smallest container holding every option comes first.
   */
  const ANSWER = 'input, [role="radio"], [role="checkbox"], [role="switch"]';
  const ANY_CONTROL = 'input, select, textarea, [role="radio"], [role="checkbox"], [role="combobox"], [role="switch"]';

  function radioQuestion(el, radios, ownLabel) {
    const fieldset = deepClosest(el, 'fieldset');
    const legend = fieldset?.querySelector(':scope > legend');
    if (legend && text(legend)) return text(legend);

    // ASP.NET's radio lists put the question's <label for> on the span or
    // table around the radios, and a short aria-label ("Graduate High
    // School") on the group: the label is the question the user sees.
    for (let n = up(el), depth = 0; n && n !== document.body && depth < 4; n = up(n), depth++) {
      if (!radios.every(r => n.contains(r))) continue;
      const pointing = n.id && (n.getRootNode?.() || document).querySelector?.(`label[for="${CSS.escape(n.id)}"]`);
      if (pointing && text(pointing)) return text(pointing);
    }

    const group = deepClosest(el, '[role="radiogroup"], [role="group"]');
    if (group) {
      const named = group.getAttribute('aria-label') ||
        (group.getAttribute('aria-labelledby') || '').split(/\s+/)
          .map(id => byId(group, id)).filter(Boolean).map(text).join(' ');
      if (named && named.trim()) return named.trim();
    }

    // Smallest ancestor holding every option; its question sits just before it.
    let box = up(el);
    while (box && box !== document.body && !radios.every(r => box.contains(r))) box = up(box);
    const optionText = new Set(radios.map(r => text(labelElementFor(r) || r)).filter(Boolean));
    // Text inside that container ahead of the first option, such as Ashby's
    // <fieldset><label>Preferred pronouns</label>...options...</fieldset>.
    if (box) {
      for (const child of box.children) {
        if (child.querySelector?.(ANSWER) || child.matches?.(ANSWER)) break;
        const value = text(child);
        if (value && value.length < 400 && !optionText.has(value)) return value;
      }
    }
    for (let node = box, depth = 0; node && node !== document.body && depth < 3; node = up(node), depth++) {
      // A label, or text that asks, beats the nearer description under it
      // (Ashby: question, then "Our address is ...", then the buttons).
      let first = '';
      let sibling = node.previousElementSibling;
      for (let hops = 0; sibling && hops < 2; hops++, sibling = sibling.previousElementSibling) {
        if (sibling.querySelector?.(ANY_CONTROL)) break;
        const value = text(sibling);
        if (!value || value.length >= 400 || optionText.has(value)) continue;
        if (sibling.matches('label, legend') || /\?\s*\**$/.test(value)) return value;
        first = first || value;
      }
      if (first) return first;
      if (node.previousElementSibling?.querySelector?.(ANY_CONTROL)) break;
    }
    return ownLabel || '';
  }

  globalThis.__applicatorExtract = extract;
  globalThis.__applicatorQuery = deepQuery;
})();
