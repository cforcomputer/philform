/**
 * A record of one run, kept only in development.
 *
 * The development loop (tools/dev.py) wants to see everything a fill did: what
 * was read from the page, what TypeSafe was asked and answered, what was
 * decided and what the page accepted. Each step reports here with `trace`,
 * which does nothing at all unless a run was started with `beginTrace`, and
 * only a development build ever starts one.
 */

let current = null;

export function beginTrace() {
  current = { startedAt: Date.now(), events: [] };
  return current;
}

export function tracing() {
  return current !== null;
}

/** Note one event. Free when no trace is running. */
export function trace(kind, data = {}) {
  if (!current) return;
  current.events.push({ at: Date.now() - current.startedAt, kind, ...data });
}

/** Stop and hand back what was recorded. */
export function endTrace() {
  const done = current;
  current = null;
  return done;
}

/** A field descriptor cut down to what a reviewer needs. */
export function compactField(f) {
  return {
    id: f.id,
    frameId: f.frameId || 0,
    label: f.label || f.ariaLabel || f.placeholder || '',
    name: f.name || '',
    idAttr: f.idAttr || '',
    // With id and name, what tells one box from another across passes (page.md joins on it).
    handleIndex: f.handleIndex || undefined,
    selector: f.idAttr || f.name ? undefined : String(f.selector || '').slice(0, 200),
    extractedLabel: f.extractedLabel || undefined,
    pageQuestion: f.pageQuestion || undefined,
    tag: f.tag,
    type: f.type,
    widget: f.widget || '',
    combobox: !!f.combobox,
    searchable: !!f.searchable,
    section: f.section || '',
    scope: f.scope || '',
    repeatIndex: f.repeatIndex ?? null,
    required: !!f.required,
    ...(f.invalid ? { invalid: true } : {}),
    options: (f.options || []).length,
    // Enough to judge a choice without opening the page.
    optionSample: (f.options || []).slice(0, 40).map(o => o.label),
    // A dropdown's text, not its internal value ("United States", not "US").
    current: String(f.currentText || f.currentValue || '').slice(0, 200),
    probe: f.probe || null
  };
}
