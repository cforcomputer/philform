"""Turn one fill's report into page.md, and score it against an answer key.

page.md is meant to be enough on its own to judge and debug a fill without
opening the page: every field with its question, control, options, block and
list entry; what TypeSafe chose and how sure it was, with the runners-up; the
decision and why; what the page shows afterwards; and, for anything that
looks wrong, the markup around the field.

Shared by tools/dev.py (each fill you make) and tools/corpus.py (the corpus).
"""
import json, re
from urllib.parse import urlparse

MAX_OPTIONS_SHOWN = 40


def norm(text):
    return re.sub(r'\s+', ' ', str(text or '')).strip().lower()


def same_value(planned, shown):
    """Whether the page shows what was meant, allowing for its formatting:
    "(415) 555-0134" is 4155550134, and "+1" is part of "United States +1"."""
    a, b = norm(planned), norm(shown)
    if a == b or (a and b and (a in b or b in a)):
        return True
    # A place picked from suggestions comes back in the site's own spelling:
    # "Portland, California" as "Portland, CA, USA".
    if ',' in a and ',' in b and a.split(',')[0].strip() == b.split(',')[0].strip() and len(a.split(',')[0].strip()) > 2:
        return True
    da, db = re.sub(r'\D', '', a), re.sub(r'\D', '', b)
    return len(da) >= 6 and len(db) >= 6 and (da.endswith(db) or db.endswith(da))


def cell(value, limit=60):
    text = re.sub(r'\s+', ' ', str(value if value is not None else '')).strip().replace('|', '\\|')
    return text[:limit] + ('…' if len(text) > limit else '')


def ats_of(url):
    host = urlparse(url or '').hostname or ''
    for name, pattern in [('Greenhouse', 'greenhouse'), ('Lever', 'lever.co'), ('Ashby', 'ashbyhq'),
                          ('Workday', 'myworkday'), ('SmartRecruiters', 'smartrecruiters'), ('Workable', 'workable'),
                          ('iCIMS', 'icims'), ('BambooHR', 'bamboohr'), ('Jobvite', 'jobvite'), ('Teamtailor', 'teamtailor'),
                          ('Recruitee', 'recruitee'), ('Breezy', 'breezy'), ('JazzHR', 'applytojob'), ('Rippling', 'rippling'),
                          ('Taleo', 'taleo'), ('SuccessFactors', 'successfactors')]:
        if pattern in host:
            return name
    return host or 'unknown'


def keyed(items, key):
    """Index items by normalised label, numbering repeats: "name", "name#2"."""
    out, seen = {}, {}
    for item in items:
        label = norm(item.get(key))
        seen[label] = seen.get(label, 0) + 1
        out[label if seen[label] == 1 else f'{label}#{seen[label]}'] = item
    return out


def typesafe_reads(events):
    """TypeSafe's answer per question label: choice, confidence, runners-up."""
    reads = {}
    for e in events:
        if e['kind'] != 'typesafe':
            continue
        for qid, q in (e.get('questions') or {}).items():
            ins = q.get('instructions')
            label = ins.get('form_field', {}).get('label') if isinstance(ins, dict) else None
            if not label:
                continue
            a = (e.get('answers') or {}).get(qid) or {}
            probs = sorted((a.get('probabilities') or {}).items(), key=lambda kv: -kv[1])
            kind = 'option' if isinstance(ins, dict) and str(ins.get('question', '')).startswith('Which option') else 'key'
            reads.setdefault(norm(label)[:100], []).append({
                'kind': kind, 'choice': a.get('choice'), 'confidence': a.get('confidence'),
                'top': [(k, round(v, 3)) for k, v in probs[:3]], 'offered': len(q.get('criteria') or {})})
    return reads


def handle_of(f):
    """The box itself, as the orchestrator identifies it: id and name (and
    which of the boxes sharing them), else its selector. Labels repeat and
    change as a box fills, so rows are joined on this, not on the label."""
    if f.get('idAttr') or f.get('name'):
        nth = f"@{f['handleIndex']}" if f.get('handleIndex') else ''
        return f"{f.get('frameId', 0)}|{f.get('idAttr') or ''}#{f.get('name') or ''}{nth}"
    if f.get('selector'):
        return f"{f.get('frameId', 0)}|sel:{f['selector']}"
    return None


def field_rows(report):
    """One row per field: the descriptor from the last pass that saw it, with
    the decision, the fill result, TypeSafe's read and what the page shows."""
    events = (report.get('trace') or {}).get('events', [])
    fields = {}       # handle (or label key when there is none) -> descriptor
    in_pass = {}      # (pass, field id) -> that handle
    for e in events:
        if e['kind'] == 'extraction':
            labelled = keyed(e['fields'], 'label')
            nth = {}
            for label, f in labelled.items():
                h = handle_of(f) or f'label:{label}'
                # Reports from before handleIndex: number repeats the same way.
                nth[h] = nth.get(h, 0) + 1
                if nth[h] > 1 and not f.get('handleIndex'):
                    h = f'{h}@{nth[h] - 1}'
                in_pass[(e.get('pass'), f.get('id'))] = h
                prior = fields.get(h)
                # Later passes do not reopen dropdowns; keep what the first
                # pass learned about the control and its options.
                if prior and prior.get('options') and not f.get('options'):
                    f = {**f, 'widget': prior.get('widget'), 'options': prior['options'],
                         'optionSample': prior.get('optionSample'), 'probe': prior.get('probe'),
                         'searchable': prior.get('searchable')}
                if prior and not f.get('_labelKey'):
                    f = {**f, '_labelKey': prior.get('_labelKey')}
                fields[h] = {**f, '_labelKey': f.get('_labelKey') or label}
    # A plan, result or reason belongs to the field of its own pass; one whose
    # pass is unknown (an older report) falls back to its label.
    by_label = {f['_labelKey']: h for h, f in fields.items()}
    def owner(e, item, label):
        return in_pass.get((e.get('pass'), item.get('id'))) or by_label.get(label)
    decided, why, filled = {}, {}, {}
    for e in events:
        if e['kind'] == 'decided':
            for label, p in keyed(e['plan'], 'label').items():
                decided[owner(e, p, label)] = p
            for label, u in keyed(e['unfilled'], 'label').items():
                why.setdefault(owner(e, u, label), u.get('reason', ''))
        elif e['kind'] == 'filled':
            for label, r in keyed(e['results'], 'label').items():
                filled[owner(e, r, label)] = r
    readback = keyed([f for f in report.get('readback') or [] if 'label' in f], 'label')
    by_handle = {}
    nth = {}
    for f in report.get('readback') or []:
        h = handle_of(f)
        if not h:
            continue
        nth[h] = nth.get(h, 0) + 1
        if nth[h] > 1 and not f.get('handleIndex'):
            h = f'{h}@{nth[h] - 1}'
        by_handle.setdefault(h, f)
    reads = typesafe_reads(events)

    rows = []
    for h, f in fields.items():
        label = f['_labelKey']
        plan, result = decided.get(h), filled.get(h)
        back = (by_handle.get(h) if not h.startswith('label:') else None) or readback.get(label) or {}
        base = label.split('#')[0]
        row = {
            'key': label, 'label': f.get('label') or '(no label)', 'frame': f.get('frameId', 0),
            'extractedLabel': f.get('extractedLabel') or '',
            'kind': f.get('widget') or f.get('type') or f.get('tag'), 'type': f.get('type'),
            'required': bool(f.get('required')), 'scope': f.get('scope') or '', 'section': f.get('section') or '',
            'entry': f.get('repeatIndex'), 'name': f.get('name') or '',
            'options': f.get('options', 0), 'optionSample': f.get('optionSample') or [],
            'probe': f.get('probe'),
            'decision': plan.get('profileKey') if plan else None, 'via': plan.get('via') if plan else None,
            'planned': plan.get('value') if plan else None,
            'ok': (result or {}).get('ok'), 'result': (result or {}).get('reason', '') if result else '',
            'altered': (result or {}).get('altered'),
            'reason': why.get(h, ''), 'shown': back.get('current', ''), 'context': back.get('context', ''),
            # Long questions are cut short in the request; match on the start.
            'typesafe': reads.get(norm(base)[:100], [])
        }
        row['flag'] = flag_for(row)
        rows.append(row)
    # The same label on several boxes, numbered in page order as answer keys expect.
    count = {}
    for row in rows:
        # Only a counter is cut: a label can hold '#' ("Primary Phone #").
        base = re.sub(r'#\d+$', '', row['key'])
        count[base] = count.get(base, 0) + 1
        row['key'] = base if count[base] == 1 else f'{base}#{count[base]}'
    # Uploads are not fields, but a required CV that did not go through is the
    # first thing to see.
    for u in (report.get('summary') or {}).get('uploadsUnsure') or []:
        rows.append({'key': f"upload:{u.get('kind')}", 'label': f"Upload ({u.get('kind')})", 'frame': 0, 'extractedLabel': '',
                     'kind': 'file', 'type': 'file', 'required': False, 'scope': '', 'section': '', 'entry': None, 'name': '',
                     'options': 0, 'optionSample': [], 'probe': None, 'decision': None, 'via': 'upload', 'planned': None,
                     'ok': not u.get('failed'), 'result': 'refused by the page' if u.get('failed') else 'still uploading',
                     'altered': None, 'reason': '', 'shown': '', 'context': '', 'typesafe': [],
                     'flag': 'upload refused' if u.get('failed') else 'upload not confirmed'})
    return rows


def flag_for(row):
    planned, ok, shown = row['planned'], row['ok'], row['shown'] or ''
    if planned is not None and ok and not shown.strip() and row['type'] not in ('checkbox',):
        return 'reported filled, page shows nothing'
    if planned is not None and ok and shown and row['type'] not in ('checkbox', 'radio') and not same_value(planned, shown):
        return 'page shows something else'
    if planned is not None and not ok:
        return 'fill failed'
    if planned is None and row['required'] and not shown.strip():
        return 'required, left empty'
    return ''


def score(rows, expected):
    """Compare what the page shows with the answer key.

    expected: {"fields": {"<label>[#n]": value}} where value is the text the
    field should show, "" when it must stay empty, or null for "any".
    """
    by_key = {r['key']: r for r in rows}
    # Keys are the extractor's labels; a field TypeSafe relabelled carries it as extractedLabel.
    by_extracted = {}
    for r in rows:
        if r.get('extractedLabel'):
            by_extracted.setdefault(norm(r['extractedLabel']), []).append(r)
    results = []
    for key, want in (expected.get('fields') or {}).items():
        k = norm(key)
        row = by_key.get(k)
        if row is None:
            base, _, nth = k.partition('#')
            same = by_extracted.get(base) or []
            i = int(nth) - 1 if nth.isdigit() else 0
            row = same[i] if 0 <= i < len(same) else None
        shown = (row or {}).get('shown', '')
        if want is None:
            continue
        if row is None:
            verdict = 'missing field'
        elif want == '*':
            # Any answer: a date that changes daily, a draft.
            verdict = 'ok' if str(shown).strip() else 'left empty'
        elif want == '':
            verdict = 'ok' if not str(shown).strip() else 'should be empty'
        elif not str(shown).strip():
            verdict = 'left empty'
        elif same_value(want, shown) or (row['type'] in ('checkbox',) and norm(want) == norm(shown)):
            verdict = 'ok'
        else:
            verdict = 'wrong'
        results.append({'key': key, 'want': want, 'shown': shown, 'verdict': verdict, 'row': row})
    return results


def write_page(folder, report, expected=None, screenshot=None):
    """Write page.md for one fill. Returns (flagged count, score results)."""
    s = report.get('summary') or {}
    events = (report.get('trace') or {}).get('events', [])
    rows = field_rows(report)
    flagged = [r for r in rows if r['flag']]
    scored = score(rows, expected) if expected else []

    out = [f"# {cell((report.get('page') or {}).get('title') or report.get('url', ''), 120)}", '']
    out.append(f"- URL: {report.get('url', '')}")
    out.append(f"- System: {ats_of(report.get('url'))}")
    build = report.get('build') or {}
    out.append(f"- Build {build.get('number', '?')} ({build.get('at', '')}), reported {report.get('reportedAt', '')}")
    if report.get('error'):
        out.append(f"- **Run failed:** {report['error'].get('message')}")
    if s:
        plan_usage = (s.get('usage') or {}).get('plan') or {}
        out.append(f"- Filled {s.get('filled')} of {s.get('fieldsFound')} fields in {s.get('durationMs')} ms; "
                   f"{s.get('passes')} passes; {s.get('modelCalls')} model rounds, {s.get('modelRequests', '?')} TypeSafe requests"
                   + (f", {plan_usage.get('input_tokens')} input tokens" if plan_usage.get('input_tokens') else ''))
        cost = s.get('cost') or {}
        if cost:
            out.append(f"- Cost {cost.get('cents', 0):.3f}¢ (price {cost.get('priceCents', 0):.3f}¢, cap {cost.get('capCents')}¢)"
                       + (' — **reached the cap**' if cost.get('capped') else '') + ': ' +
                       ', '.join(f"{c.get('label') or c.get('provider')} {c.get('cents', 0):.3f}¢" for c in cost.get('calls', [])))
        if s.get('blockedFrames'):
            out.append(f"- Blocked frames: {', '.join(s['blockedFrames'])}")
    out.append(f"- {len(flagged)} field(s) flagged")
    if screenshot:
        out.append(f"- Screenshot: {screenshot}")

    if scored:
        right = sum(1 for r in scored if r['verdict'] == 'ok')
        out += ['', f'## Score: {right} of {len(scored)} as expected', '']
        bad = [r for r in scored if r['verdict'] != 'ok']
        if bad:
            out += ['| Field | Verdict | Expected | Page shows |', '|---|---|---|---|']
            for r in bad:
                out.append(f"| {cell(r['key'], 50)} | {r['verdict']} | {cell(r['want'], 40)} | {cell(r['shown'], 40)} |")
        else:
            out.append('Every field in the answer key is right.')

    missed = (report.get('summary') or {}).get('possiblyMissed') or []
    if missed:
        out += ['', '## Possibly missed', '', 'Question text on the form with no field read for it:', '']
        out += [f'- {cell(q, 160)}' for q in missed]

    if flagged:
        out += ['', '## Flagged', '']
        for r in flagged:
            detail = (f"planned {cell(r['planned'])!r}, page shows {cell(r['shown'])!r}"
                      if r['planned'] is not None else (r['reason'] or 'nothing was planned'))
            out.append(f"- **{cell(r['label'], 80)}**: {r['flag']}; {detail}" + (f"; {r['result']}" if r['result'] else ''))

    out += ['', '## Fields', '', '| # | Field | Control | Block | Decision | Page shows | Note |', '|---|---|---|---|---|---|---|']
    for i, r in enumerate(rows, 1):
        control = r['kind'] + (f" ({r['options']})" if r['options'] else '')
        block = r['scope'] + (f"[{r['entry']}]" if r['entry'] not in (None, 0) else '')
        decision = (r['decision'] or ('option' if r['via'] == 'model-option' else '')) + (f" · {r['via']}" if r['via'] else '')
        star = ' *' if r['required'] and not r['label'].rstrip().endswith('*') else ''
        note = r['flag'] or r['result'] or r['reason']
        out.append(f"| {i} | {cell(r['label'], 50)}{star} | {cell(control, 24)} | {cell(block, 14)} | "
                   f"{cell(decision, 40)} | {cell(r['shown'], 45)} | {cell(note, 70)} |")

    out += ['', '## Field details', '']
    for i, r in enumerate(rows, 1):
        out.append(f"### {i}. {cell(r['label'], 100)}" + (' (required)' if r['required'] else '') + (f" — **{r['flag']}**" if r['flag'] else ''))
        out.append(f"- Control: {r['kind']}" + (f", name `{r['name']}`" if r['name'] else '') +
                   (f", frame {r['frame']}" if r['frame'] else '') + (f"; probed: {r['probe']}" if r['probe'] else ''))
        if r['section'] or r['scope']:
            out.append(f"- Under: {cell(r['section'], 120)}; block: {r['scope'] or '-'}" +
                       (f"; entry {r['entry']}" if r['entry'] not in (None,) else ''))
        if r['optionSample']:
            shown_opts = r['optionSample'][:MAX_OPTIONS_SHOWN]
            more = r['options'] - len(shown_opts)
            out.append(f"- Options ({r['options']}): " + '; '.join(cell(o, 50) for o in shown_opts) + (f"; … {more} more" if more > 0 else ''))
        for t in r['typesafe']:
            top = ', '.join(f"{cell(k, 45)} {v}" for k, v in t['top'])
            out.append(f"- TypeSafe ({t['kind']} question, {t['offered']} choices): chose {cell(t['choice'], 60)!r} "
                       f"at {t['confidence']}; top: {top}")
        if r['planned'] is not None:
            out.append(f"- Decided: {r['decision'] or '(option)'} via {r['via']} → {cell(r['planned'], 200)!r}")
            out.append(f"- Write: {'ok' if r['ok'] else 'FAILED'}" + (', altered by the page' if r['altered'] else '') +
                       (f" ({r['result']})" if r['result'] else ''))
        elif r['reason']:
            out.append(f"- Not filled: {r['reason']}")
        out.append(f"- Page shows: {cell(r['shown'], 200)!r}")
        if (r['flag'] or (r['planned'] is None and r['required'])) and r['context']:
            out += ['', '```html', r['context'], '```']
        out.append('')

    # The questions TypeSafe read from the page (src/background/structure.js).
    structure = [c for e in events if e['kind'] == 'structure' for c in e.get('changes', [])]
    if structure:
        out += ['## Page structure (TypeSafe)', '',
                'Which line of the page each field asks, as TypeSafe read it, against the extractor\'s own label.', '']
        for c in structure:
            if c.get('error'):
                out.append(f"- Failed: {c['error']}; the extractor's labels were used")
            elif c.get('before') != c.get('after'):
                out.append(f"- {cell(c.get('before') or '(no label)', 80)!r} → {cell(c.get('after'), 120)!r} @{c.get('confidence')}")
        unchanged = sum(1 for c in structure if not c.get('error') and c.get('before') == c.get('after'))
        out += [f'- {unchanged} other field(s) kept the extractor\'s label', '']

    out += ['## Timeline', '']
    for e in events:
        if e['kind'] == 'typesafe':
            out.append(f"- {e['at']} ms: TypeSafe request, {len(e.get('questions', {}))} questions, {e.get('ms')} ms, "
                       f"{(e.get('usage') or {}).get('input_tokens', '?')} input tokens")
        elif e['kind'] == 'extraction':
            out.append(f"- {e['at']} ms: read the page (pass {e.get('pass')}): {len(e['fields'])} fields, {len(e.get('fresh', []))} new")
        elif e['kind'] == 'decided':
            out.append(f"- {e['at']} ms: decided (pass {e.get('pass')}): {len(e['plan'])} to fill, {len(e['unfilled'])} left")
        elif e['kind'] == 'filled':
            out.append(f"- {e['at']} ms: wrote (pass {e.get('pass')}): {sum(1 for r in e['results'] if r.get('ok'))} of {len(e['results'])} kept")
        elif e['kind'] == 'written':
            out.append(f"- {e['at']} ms: writer drafted {len(e.get('answers', []))}")
    if report.get('error'):
        out += ['', '## Error', '', '```', str(report['error'].get('stack') or report['error'].get('message')), '```']

    (folder / 'page.md').write_text('\n'.join(out) + '\n')
    return len(flagged), scored
