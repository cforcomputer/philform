#!/usr/bin/env python3
"""Live integration test against the real DeepSeek API.

Not part of ./test.sh: it needs the network and it spends money. Run it after
changing a prompt, because a prompt that stops producing parseable JSON is
invisible to every offline check.

    python3 tools/test-live.py
    python3 tools/test-live.py --typesafe-only   # the field-matching benchmark alone

Uses the key from src/common/local-config.js.
"""
import json, pathlib, re, sys, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENDPOINT = 'https://api.deepseek.com/chat/completions'


def js_string(source, name):
    """Pull a backtick template literal out of a JavaScript module."""
    m = re.search(name + r"\s*=\s*`(.*?)`;", source, re.S)
    if not m:
        sys.exit(f'Could not find {name}')
    return m.group(1).replace('\\`', '`').replace('\\n', '\n').replace('\\$', '$')


key_src = (ROOT / 'src/common/local-config.js').read_text()
API_KEY = re.search(r"deepseekApiKey:\s*'([^']*)'", key_src).group(1)
TS_KEY = re.search(r"typesafeApiKey:\s*'([^']*)'", key_src).group(1)
if not API_KEY and '--typesafe-only' not in sys.argv:
    sys.exit('No deepseekApiKey in src/common/local-config.js')

settings = (ROOT / 'src/background/storage.js').read_text()
def setting(name):
    return re.search(name + r":\s*'([^']*)'", settings).group(1)

WRITER_MODEL = setting('deepseekWriterModel')
CLASSIFY_MODEL = setting('deepseekModel')
WRITER_EFFORT = setting('deepseekWriterEffort')
CLASSIFY_EFFORT = setting('deepseekClassifyEffort')

write_src = (ROOT / 'src/background/write.js').read_text()
WRITE_SYSTEM = js_string(write_src, 'const SYSTEM')
SHAPE = js_string(write_src, 'const SHAPE_INSTRUCTION')
classify_src = (ROOT / 'src/background/classify.js').read_text()
CLASSIFY_SYSTEM = js_string(classify_src, 'const SYSTEM')
responses_src = (ROOT / 'src/background/responses.js').read_text()
MATCH_SYSTEM = js_string(responses_src, 'const MATCH_SYSTEM')


def call(model, system, user, max_tokens, effort):
    body = json.dumps({
        'model': model,
        'messages': [{'role': 'system', 'content': system},
                     {'role': 'user', 'content': user}],
        'max_tokens': max_tokens,
        'reasoning_effort': effort,
        'response_format': {'type': 'json_object'}
    }).encode()
    req = urllib.request.Request(ENDPOINT, data=body, headers={
        'content-type': 'application/json',
        'authorization': f'Bearer {API_KEY}'
    })
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


failures = []
def check(name, ok, detail=''):
    print(('  ok   ' if ok else '  FAIL ') + name + ('' if ok else f': {detail}'))
    if not ok:
        failures.append(name)


def deepseek_checks():
    """Classification, writing, response matching and tailoring on DeepSeek."""
    print(f'Classification  model={CLASSIFY_MODEL} effort={CLASSIFY_EFFORT}')
    payload = {
        "fields": [
            {"id": "f1", "label": "Are you legally authorized to work in the United States?",
             "control": "select", "options": ["Yes", "No"]},
            {"id": "f2", "label": "Will you now or in the future require sponsorship for an employment visa?",
             "control": "select", "options": ["Yes", "No"]},
            {"id": "f3", "label": "Date of Birth", "control": "text"},
            {"id": "f4", "label": "Why are you interested in this role?", "control": "textarea"},
            {"id": "f5", "label": "How did you hear about us?", "control": "select",
             "options": ["LinkedIn", "Referral", "Job board", "Other"]}
        ],
        "profile": {
            "authorization.authorizedToWork": {"label": "Authorized to work", "value": "yes"},
            "authorization.requiresSponsorship": {"label": "Requires sponsorship", "value": "no"},
            "preferences.howHeard": {"label": "How you heard about the role", "value": "LinkedIn"}
        },
        "context": {"company": "Acme", "role": "Backend Engineer"}
    }
    res = call(CLASSIFY_MODEL, CLASSIFY_SYSTEM, json.dumps(payload),
               min(8000, 1500 + len(payload['fields']) * 120), CLASSIFY_EFFORT)
    text = res['choices'][0]['message']['content']
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        check('classification returns JSON', False, str(e)); parsed = {'assignments': []}
    else:
        check('classification returns JSON', True)

    by_id = {a['id']: a for a in parsed.get('assignments', [])}
    check('authorized-to-work answered Yes', by_id.get('f1', {}).get('value') == 'Yes', by_id.get('f1'))
    check('sponsorship answered No', by_id.get('f2', {}).get('value') == 'No', by_id.get('f2'))
    check('date of birth refused', not by_id.get('f3', {}).get('value'), by_id.get('f3'))
    check('essay handed to the writer',
          by_id.get('f4', {}).get('needsWriting') is True or not by_id.get('f4', {}).get('value'),
          by_id.get('f4'))
    check('option copied exactly', by_id.get('f5', {}).get('value') == 'LinkedIn', by_id.get('f5'))
    print(f'  usage: {res["usage"]["prompt_tokens"]} in, {res["usage"]["completion_tokens"]} out')

    print(f'\nWriting         model={WRITER_MODEL} effort={WRITER_EFFORT}')
    questions = {
        "questions": [
            {"id": "q1", "question": "Why do you want to work at Acme?", "targetWords": 90},
            {"id": "q2", "question": "Describe a technical challenge you solved.",
             "characterLimit": 400, "targetWords": 60}
        ],
        "role": {"company": "Acme", "title": "Backend Engineer",
                 "description": "Build and scale payment processing services."},
        "candidate": {
            "name": "Pat Brien", "currentTitle": "Senior Backend Engineer",
            "currentCompany": "Globex", "yearsExperience": "8",
            "summary": "Backend engineer focused on payments infrastructure.",
            "achievements": "Cut payment settlement latency by 40 percent.\nLed the migration off a monolith to three services.",
            "resume": "Globex, Senior Backend Engineer, 2019 to present. Python and Go. Payments."
        }
    }
    budget = min(16000, 3000 + len(questions['questions']) * 1500)
    res2 = call(WRITER_MODEL, WRITE_SYSTEM + '\n\n' + SHAPE, 
                'Draft an answer for each question below.\n\n' + json.dumps(questions, indent=2),
                budget, WRITER_EFFORT)
    text2 = res2['choices'][0]['message']['content']
    check('writer returned content', bool(text2.strip()), 'empty response')
    try:
        parsed2 = json.loads(text2)
    except json.JSONDecodeError as e:
        check('writer returns JSON', False, str(e)); parsed2 = {'answers': []}
    else:
        check('writer returns JSON', True)

    answers = {a['id']: a for a in parsed2.get('answers', [])}
    check('answered both questions', set(answers) == {'q1', 'q2'}, list(answers))
    check('q1 is substantial', len(answers.get('q1', {}).get('answer', '')) > 100)
    # The model is asked to stay under the limit; fitToLimit enforces it afterwards,
    # so a modest overshoot here is a prompt-quality signal rather than a failure.
    q2_len = len(answers.get('q2', {}).get('answer', ''))
    check('q2 is near the character limit', q2_len <= 400 * 1.3, f'{q2_len} chars against a 400 limit')
    check('no markdown headings', not any(a.get('answer', '').lstrip().startswith('#') for a in answers.values()))
    check('no em-dashes', not any('—' in a.get('answer', '') for a in answers.values()))
    check('thin flag present', all('thin' in a for a in answers.values()))
    print(f'  usage: {res2["usage"]["prompt_tokens"]} in, {res2["usage"]["completion_tokens"]} out '
          f'(reasoning {(res2["usage"].get("completion_tokens_details") or {}).get("reasoning_tokens", 0)})')
    print(f'\n  q1: {answers.get("q1", {}).get("answer", "")[:200]}')

    print(f'\nSaved responses  model={CLASSIFY_MODEL} effort={CLASSIFY_EFFORT}')
    # The point of model matching is paraphrase. Every question below is worded
    # differently from the saved answer's listed phrasings.
    saved = [
        {"id": "r1", "name": "Five year plan",
         "phrasings": ["where do you see yourself in 5 years"],
         "answer": "In five years I want to be leading the design of payment systems rather than only building them, with a small team I have helped grow."},
        {"id": "r2", "name": "Why this company",
         "phrasings": ["why do you want to work"],
         "answer": "I have followed {{company}} for a while and the {{role}} role lines up with the payments work I have been doing."},
        {"id": "r3", "name": "Greatest weakness",
         "phrasings": ["greatest weakness"],
         "answer": "I hold onto a piece of work longer than I should before showing it. I counter that by putting rough drafts in front of people earlier."}
    ]
    paraphrases = [
        ("m1", "What are your long-term career goals?", "r1"),
        ("m2", "Describe your career aspirations over the next few years.", "r1"),
        ("m3", "What draws you to this organisation?", "r2"),
        ("m4", "Tell us about an area where you are still developing.", "r3"),
        ("m5", "What is your expected salary?", None),
        ("m6", "Please list your three most recent employers.", None)
    ]
    res3 = call(CLASSIFY_MODEL, MATCH_SYSTEM,
                json.dumps({"savedAnswers": saved,
                            "questions": [{"id": i, "question": q} for i, q, _ in paraphrases]}),
                min(4000, 800 + len(paraphrases) * 80), CLASSIFY_EFFORT)
    try:
        got = {m['id']: m for m in json.loads(res3['choices'][0]['message']['content'])['matches']}
    except (json.JSONDecodeError, KeyError) as e:
        check('response matching returns JSON', False, str(e)); got = {}
    else:
        check('response matching returns JSON', True)

    for qid, question, want in paraphrases:
        m = got.get(qid, {})
        picked = m.get('responseId')
        conf = m.get('confidence', 0)
        # A match below the acceptance floor is discarded by reconcileMatches, so
        # judge what would actually be used rather than the raw choice.
        used = picked if (picked and conf >= 0.55) else None
        check(f'{"matches" if want else "declines"}: {question}', used == want,
              f'chose {used or "nothing"}, wanted {want or "nothing"}')
    print(f'  usage: {res3["usage"]["prompt_tokens"]} in, {res3["usage"]["completion_tokens"]} out')

    print(f'\nTailoring       model={WRITER_MODEL} effort={WRITER_EFFORT}')
    basis = "I have followed Globex for a while and the Platform Engineer role lines up with the payments work I have been doing. I want to work somewhere the infrastructure is the product."
    res4 = call(WRITER_MODEL, WRITE_SYSTEM + '\n\n' + SHAPE,
                'Draft an answer for each question below.\n\n' + json.dumps({
                    "questions": [{"id": "t1", "question": "Why do you want to work at Acme?",
                                   "targetWords": 70, "basis": basis}],
                    "role": {"company": "Acme", "title": "Backend Engineer"},
                    "candidate": {"name": "Pat Brien", "currentCompany": "Globex"}
                }, indent=2), 6000, WRITER_EFFORT)
    try:
        tailored = json.loads(res4['choices'][0]['message']['content'])['answers'][0]['answer']
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        check('tailoring returns JSON', False, str(e)); tailored = ''
    else:
        check('tailoring returns JSON', True)

    check('swapped in the new company', 'Acme' in tailored, tailored[:160])
    check('dropped the stale company', 'Globex' not in tailored, tailored[:160])
    check('kept the candidate voice', 'infrastructure is the product' in tailored, tailored[:160])
    check('did not balloon the answer', len(tailored) < len(basis) * 1.8, f'{len(tailored)} vs basis {len(basis)}')
    print(f'  tailored: {tailored[:190]}')


if '--typesafe-only' not in sys.argv:
    deepseek_checks()

# --- TypeSafe field classification ------------------------------------------
# The benchmark behind the default engine. It sends what the extension sends:
# every saved key as an option, each described with its saved value and, for
# keys that are easy to confuse, what it is not for; and each field as a
# structured object. Re-run it whenever the questions or the options change.
if TS_KEY:
    TS_MODEL = setting('typesafeModel')
    print(f'\nField matching   engine=typesafe model={TS_MODEL}')

    schema = (ROOT / 'src/common/schema.js').read_text()
    key_labels = {k: lab for k, lab, _t, sec in
                  re.findall(r"\{ key: '([\w.]+)', label: '([^']+)', type: '(\w+)', section: '(\w+)'", schema)
                  if sec != 'documents'}
    shortlist_src = (ROOT / 'src/background/shortlist.js').read_text()
    not_for = dict(re.findall(r"'([\w.]+)': '([^']+)'", shortlist_src[shortlist_src.index('const NOT_FOR'):
                                                                      shortlist_src.index('};', shortlist_src.index('const NOT_FOR'))]))

    bench_profile = {
        "identity.firstName": "Pat", "identity.lastName": "Brien",
        "contact.email": "pat@example.com", "contact.phone": "+1 415 555 0134",
        "address.line1": "18 Mission St", "address.line2": "Apt 4",
        "address.city": "San Francisco", "address.state": "California",
        "address.postalCode": "94105", "address.country": "United States",
        "links.linkedin": "https://linkedin.com/in/patbrien",
        "links.portfolio": "https://patbrien.dev",
        "work.currentCompany": "Globex", "work.yearsExperience": "8",
        "work.highestDegree": "BSc",
        "authorization.authorizedToWork": "yes",
        "authorization.requiresSponsorship": "no",
        "authorization.over18": "yes", "authorization.countriesAuthorized": "United States",
        "preferences.willingToRelocate": "yes", "preferences.howHeard": "LinkedIn",
        "compensation.desired": "$180,000", "identity.pronouns": "they/them"
    }
    # (label, extra form_field properties, wanted key)
    bench = [
        ("First Name", {}, "identity.firstName"), ("Email Address", {}, "contact.email"),
        ("Are you legally authorized to work in the United States?", {"control": "one choice from a set of options", "options_offered": ["Yes", "No"]}, "authorization.authorizedToWork"),
        ("Will you now or in the future require sponsorship for an employment visa?", {"control": "one choice from a set of options", "options_offered": ["Yes", "No"]}, "authorization.requiresSponsorship"),
        ("Current Employer", {}, "work.currentCompany"), ("LinkedIn Profile", {}, "links.linkedin"),
        ("Zip / Postal Code", {}, "address.postalCode"), ("How did you hear about this role?", {}, "preferences.howHeard"),
        ("Desired Salary", {}, "compensation.desired"), ("Date of Birth", {}, "__none__"),
        ("Why do you want to work here?", {"control": "multi-line text box"}, "__written__"),
        ("Years of relevant experience", {}, "work.yearsExperience"),
        ("Are you willing to relocate?", {}, "preferences.willingToRelocate"),
        ("Apartment, suite, etc.", {}, "address.line2"),
        ("Are you at least 18 years of age?", {}, "authorization.over18"),
        ("Social Security Number", {}, "__none__"),
        # Traps: a keyword rule gets each of these wrong.
        ("Company size", {"control": "dropdown", "html_name": "company_size", "options_offered": ["1-10", "11-50", "51-200", "200+"]}, "__none__"),
        ("Phone", {"headings_above": "References › Reference 1", "whose_details": "It asks about a reference, another person, so none of the applicant's own details belong here"}, "__none__"),
        ("Name of the employee who referred you", {}, "__none__"),
        ("City", {"headings_above": "Where do you live?"}, "address.city"),
    ]

    # As shortlist.js sends them: the key alone, unless it is easy to confuse.
    criteria = {k: ({"not_for": not_for[k]} if k in not_for else None) for k in bench_profile if k in key_labels}
    criteria["__written__"] = 'An open-ended question that needs a written paragraph, not a stored value'
    criteria["__none__"] = ('No saved value answers this field, the field asks for a password, payment detail, '
                            'government identifier, passport number or date of birth, or it is about another person')

    def question(label, extra):
        field = {"label": label, "control": "text box", **extra}
        return {"type": "choice", "criteria": criteria, "instructions": {
            "form_field": field,
            "question": "On this job application, which of the candidate's saved values belongs in `form_field`?"}}

    # Dropdowns are asked about their own options, as planWithTypeSafe does.
    # These are SpaceX's, word for word.
    option_bench = [
        ("Are you legally authorized to work in the United States?*",
         ["I am authorized to work in the United States for any employer",
          "I am authorized to work in the United States for my present employer only",
          "I require sponsorship to work in the United States",
          "I am not authorized to work in the United States",
          "My status to work in the United States is unknown"],
         "I am authorized to work in the United States for any employer"),
        ("Active Security Clearance(s)*",
         ["Top Secret SCI with Polygraph", "Top Secret SCI/SAP", "Top Secret", "DOE Level Q", "Secret", "Expired Clearance"],
         "__none__"),
        ("Will you now or in the future require visa sponsorship?", ["Yes", "No"], "No"),
        # Recruitee, for a job in the Netherlands: authorized in the US only.
        ("Do you have EU citizenship or a valid work permit for the Netherlands? Or do you need sponsorship from us?",
         ["EU citizenship", "Valid work permit", "I need sponsorship"], "I need sponsorship"),
    ]

    def option_question(label, options):
        crit = {o: None for o in options}
        crit["__none__"] = "The candidate's saved details do not say which of these applies"
        return {"type": "choice", "criteria": crit, "instructions": {
            "form_field": {"label": label, "control": "dropdown", "required": True},
            # As classify.js asks it.
            "question": "Which option would the candidate choose for `form_field`, going by what their saved details say? "
                        "When the question does not apply to them, given those details (a graduate GPA or graduate test score "
                        "when they hold no graduate degree), choose the option saying it does not apply, if there is one. "
                        "If their details do not say, choose __none__."}}

    body = json.dumps({
        "model": TS_MODEL,
        "state": {"candidate_profile": {k: {"label": key_labels.get(k, k), "value": v} for k, v in bench_profile.items()},
                  "application": {"company": "Acme", "role": "Backend Engineer"}},
        "questions": {**{f"b{i}": question(label, extra) for i, (label, extra, _) in enumerate(bench)},
                      **{f"o{i}": option_question(label, opts) for i, (label, opts, _) in enumerate(option_bench)}}
    }).encode()
    req = urllib.request.Request("https://api.typesafe.ai/v1/systemone", data=body, headers={
        "content-type": "application/json", "authorization": f"Bearer {TS_KEY}"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=120) as r:
        ts = json.load(r)
    ts_secs = time.time() - t0

    floor = float(re.search(r"classifierConfidence:\s*([\d.]+)", settings).group(1))
    correct = 0
    for i, (label, _extra, want) in enumerate(bench):
        a = ts['answers'].get(f'b{i}', {})
        got = a.get('choice')
        conf = a.get('confidence', 0)
        # Below the configured floor the field is left blank, which is only the
        # right outcome when nothing should have been filled.
        effective = got if conf >= floor else '__none__'
        hit = effective == want
        correct += hit
        print(f"  {'ok  ' if hit else 'MISS'} {conf:.2f} {label[:58]:<58} -> {got}")
        if not hit:
            check(f'field: {label}', False, f'chose {got} at confidence {conf}, wanted {want}')
    for i, (label, _opts, want) in enumerate(option_bench):
        a = ts['answers'].get(f'o{i}', {})
        got, conf = a.get('choice'), a.get('confidence', 0)
        effective = got if conf >= floor else '__none__'
        hit = effective == want
        correct += hit
        print(f"  {'ok  ' if hit else 'MISS'} {conf:.2f} {label[:58]:<58} -> {str(got)[:50]}")
        if not hit:
            check(f'dropdown: {label}', False, f'chose {got} at confidence {conf}, wanted {want}')
    total = len(bench) + len(option_bench)
    check(f'typesafe placed every benchmark field ({correct}/{total})', correct == total)
    tokens = ts['usage']['input_tokens']
    print(f'  {correct}/{total} correct, {ts_secs:.2f}s, {tokens} input tokens, '
          f'${tokens * 0.042 / 1e6:.6f} (output is free)')
    print(f'  confidence floor in settings: {floor}')
else:
    print('\nField matching   skipped, no typesafeApiKey in local-config.js')

print()
if failures:
    print(f'{len(failures)} live check(s) failed.')
    sys.exit(1)
print('All live checks passed.')
