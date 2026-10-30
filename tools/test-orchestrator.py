#!/usr/bin/env python3
"""Test the orchestrator's value coercion and essay detection.

These decide whether a stored "yes" lands on the option a form actually offers,
and whether a question is routed to the cheap model or the writing model. Both
are easy to get subtly wrong and invisible when they are.
"""
import json, pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

FILES = [
    'src/common/util.js',
    'src/common/messages.js',
    'src/common/schema.js',
    'src/common/rules-default.js',
    'src/common/rulespack.js',
    'src/background/storage.js',
    'src/background/llm/relay.js',
    'src/background/llm/typesafe.js',
    'src/background/shortlist.js',
    'src/background/responses.js',
    'src/background/skills/matcher.js',
    'src/background/skills/store.js',
    'src/background/heuristics.js',
    'src/background/scope.js',
    'src/background/llm/deepseek.js',
    'src/background/classify.js',
    'src/background/write.js',
    'src/background/quota.js',
    'src/background/frames.js',
    'src/background/cost.js',
    'src/common/wallet.js',
    'src/background/timesaved.js',
    'src/background/trace.js',
    'src/background/structure.js',
    'src/background/dev.js',
    'src/background/orchestrator.js',
    'src/background/learn.js',
]

TOP_CONST = re.compile(r'^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)', re.M)


def strip_modules(src):
    src = re.sub(r'^\s*import\s*\{[^}]*\}\s*from\s*[^;]+;?\s*$', '', src, flags=re.M | re.S)
    src = re.sub(r'^\s*import\s[^;]*;?\s*$', '', src, flags=re.M)
    src = re.sub(r'^\s*export\s*\{[^}]*\};?\s*$', '', src, flags=re.M)
    return re.sub(r'^\s*export\s+(default\s+)?', '', src, flags=re.M)


def build():
    """Concatenate the modules, renaming top-level constants that collide.

    Each real module has its own scope, so two files may both declare `SYSTEM`.
    Flattening them into one script does not, so duplicates are given a
    per-module suffix before they are joined.
    """
    sources = {f: strip_modules((ROOT / f).read_text()) for f in FILES}

    seen, duplicates = set(), set()
    for src in sources.values():
        for name in set(TOP_CONST.findall(src)):
            if name in seen:
                duplicates.add(name)
            seen.add(name)

    parts = []
    for path, src in sources.items():
        suffix = '_' + re.sub(r'\W', '_', pathlib.Path(path).stem)
        for name in duplicates:
            src = re.sub(r'\b%s\b' % re.escape(name), name + suffix, src)
        parts.append('// ---- %s\n%s' % (path, src))
    return parts


# chrome.* is touched only inside functions these tests never call.
bundle = 'var chrome = { storage: { local: {} }, scripting: {}, runtime: {} };\n'
bundle += '\n'.join(build())

TESTS = r'''
var failures = [];
function check(name, actual, expected) {
  if (actual !== expected) failures.push(name + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

var profile = {
  "identity.firstName": "Pat",
  "identity.lastName": "Brien",
  "contact.email": "p@example.com",
  "authorization.authorizedToWork": "yes",
  "authorization.requiresSponsorship": "no",
  "preferences.willingToRelocate": "yes",
  "work.yearsExperience": "8",
  "demographics.gender": "Prefer not to say"
};

// --- plain text ----------------------------------------------------------
check("plain text value",
  resolveValue({tag:"input", type:"text"}, "identity.firstName", profile), "Pat");
check("missing value returns null",
  resolveValue({tag:"input", type:"text"}, "links.github", profile), null);
check("respects maxLength",
  resolveValue({tag:"input", type:"text", maxLength:2}, "identity.firstName", profile), "Pa");

// --- yes/no onto a real dropdown ----------------------------------------
var yesNo = {tag:"select", type:"select", options:[{label:"Yes"},{label:"No"}]};
check("yes maps to Yes", resolveValue(yesNo, "authorization.authorizedToWork", profile), "Yes");
check("no maps to No", resolveValue(yesNo, "authorization.requiresSponsorship", profile), "No");

// A form that words its options differently still has to land correctly.
var worded = {tag:"select", type:"select", options:[{label:"I am authorized to work"},{label:"I am not authorized to work"}]};
check("yes maps to affirmative phrasing",
  resolveValue(worded, "authorization.authorizedToWork", profile), "I am authorized to work");
check("no maps to negative phrasing",
  resolveValue(worded, "authorization.requiresSponsorship", profile), "I am not authorized to work");

// An option set with no yes/no answer must refuse rather than pick at random.
var unrelated = {tag:"select", type:"select", options:[{label:"Red"},{label:"Blue"}]};
check("no plausible option returns null",
  resolveValue(unrelated, "authorization.authorizedToWork", profile), null);

// --- exact and partial option matching ----------------------------------
var gender = {tag:"select", type:"select", options:[{label:"Male"},{label:"Female"},{label:"Prefer not to say"}]};
check("exact option match", resolveValue(gender, "demographics.gender", profile), "Prefer not to say");

// --- checkboxes ----------------------------------------------------------
check("checkbox from yes", resolveValue({tag:"input", type:"checkbox"}, "preferences.willingToRelocate", profile), "true");
check("checkbox from no", resolveValue({tag:"input", type:"checkbox"}, "authorization.requiresSponsorship", profile), null);

// --- essay routing -------------------------------------------------------
check("textarea is an essay", looksLikeEssay({multiline:true, label:"Notes"}), true);
check("a GitHub URL asked in a text area is not an essay", isDefinitelyEssay({multiline:true, tag:"textarea", label:"Github profile *"}), false);
check("a LinkedIn URL asked in a text area is not an essay", isDefinitelyEssay({multiline:true, tag:"textarea", label:"Linkedin *"}), false);
check("a cover letter text area is still an essay", isDefinitelyEssay({multiline:true, tag:"textarea", label:"Cover letter"}), true);
check("an optional 'Additional Information' is a catch-all", isOptionalCatchAll({label:"Additional Information"}), true);
check("a required one is not", isOptionalCatchAll({label:"Additional Information", required:true}), false);
check("a real question is not a catch-all", isOptionalCatchAll({label:"Why do you want to work here?"}), false);
check("why-us is an essay", looksLikeEssay({label:"Why do you want to work here?", tag:"input", type:"text"}), true);
check("cover letter is an essay", looksLikeEssay({label:"Cover letter", tag:"input", type:"text"}), true);
check("a long limit on a text area is an essay", looksLikeEssay({label:"Summary", tag:"textarea", maxLength:2000}), true);
check("a one-line box is never an essay for its limit", looksLikeEssay({label:"Please specify", tag:"input", type:"text", maxLength:255}), false);
check("short text is not an essay", looksLikeEssay({label:"First Name", tag:"input", type:"text", maxLength:60}), false);
check("select is not an essay", looksLikeEssay({label:"Country", tag:"select", type:"select"}), false);
check("skill can force long", looksLikeEssay({label:"Anything", forceLong:true}), true);

// A cover letter box must never be taken by the heuristics: filling it from the
// profile would paste the raw template with its placeholders still in it.
check("cover letter bypasses heuristics", isDefinitelyEssay({label:"Cover Letter", tag:"textarea", multiline:true}), true);
check("why-us bypasses heuristics", isDefinitelyEssay({label:"Why do you want to join us?", tag:"input", type:"text"}), true);
check("long address field stays cheap", isDefinitelyEssay({label:"Street Address", tag:"input", type:"text", maxLength:255}), false);
check("a long address box is not an essay either", looksLikeEssay({label:"Street Address", tag:"input", type:"text", maxLength:255}), false);
check("'Please specify' waits on an Other answer", followUpCondition({label:"Please specify"}).test("Other"), true);
check("'If (f) Other, please explain' waits on Other", followUpCondition({label:"If (f) Other, please explain:"}).test("(f) Other (please explain)"), true);
check("'If yes, which?' waits on Yes", followUpCondition({label:"If yes, which company?"}).test("Yes"), true);
check("'If you are not located near San Francisco, ...' waits on a No (Pilot)",
  followUpCondition({label:"If you are not located near San Francisco, CA, are you open to relocating?"}).test("No") && !followUpCondition({label:"If you are not located near San Francisco, CA, are you open to relocating?"}).test("Yes"), true);
check("and names what it follows", followUpTopic({label:"If you are not located near San Francisco, CA, are you open to relocating?"}), "locate");
check("years testing APIs is one skill, not the whole career (Wonderschool)", (matchField({label:"How many years of experience do you have testing APIs and backend services?", type:"text"}) || {}).key !== "work.yearsExperience", true)
check("but plain years of experience still is", (matchField({label:"Years of experience", type:"text"}) || {}).key, "work.yearsExperience")
check("a graduate major is not the field of study (Wonderschool)", (matchField({label:"What was your graduate major?", type:"text"}) || {}).key !== "work.fieldOfStudy", true)
check("an undergraduate major is", (matchField({label:"What was your undergraduate major?", type:"text"}) || {}).key, "work.fieldOfStudy")
check("'Work hours — anything else to add?' is an optional comment box", isOptionalCatchAll({label:"Work hours — anything else to add?"}), true)
check("a story question is not the job's duties (Solcoa)", (matchField({label:"Describe an equipment or process problem you diagnosed. What did you do, and what was the result?", type:"textarea"}) || {}).key !== "employment.description", true)
check("but 'What did you do?' in a job block still is", (matchField({label:"What did you do?", type:"textarea"}) || {}).key, "employment.description")
check("'Do you require work authorization ...?' is the sponsorship question (Gimlet)", (matchField({label:"Do you require work authorization to work in the country of origin for this position?", type:"text"}) || {}).key, "authorization.requiresSponsorship")
check("a request for a video is the user's to record (Wispr Flow)", ASKS_FOR_VIDEO.test("Please provide a 1-2 minute video (janky talking head is great, no editing) on why Wispr Flow"), true)
check("but a question about video work is not", ASKS_FOR_VIDEO.test("Describe your experience with video encoding"), false)
check("a GitHub Username box gets the handle (Mapbox)", resolveValue({label:"GitHub Username", type:"text"}, "links.github", {"links.github":"https://github.com/patbrien"}), "patbrien")
check("a GitHub URL box keeps the link", resolveValue({label:"GitHub URL", type:"text"}, "links.github", {"links.github":"https://github.com/patbrien"}), "https://github.com/patbrien")
check("'located in the New York or SF area?' is Yes from Oakland (Middesk)", locatedInAnswer({label:"Are you located in the New York or SF area?", type:"radio", options:[{label:"Yes"},{label:"No"}]}, {"address.city":"Oakland"}), "Yes")
check("a saved question with no answer yet is not offered to the model", customFields({custom:[{id:"a1", question:"What is the smallest team size you have been on?", answer:""}, {id:"b2", question:"Shoe size?", answer:"44"}]}).map(f => f.key).join(), "custom.b2")
check("an ordinary question is no follow-up", followUpCondition({label:"Phone"}), null);
check("a quoted 'If you answered yes' waits on Yes",
  followUpCondition({label:'If you answered "yes" to the above question, please provide additional details'}).test("Yes"), true);
check("a full 'Please elaborate on…' question is no follow-up",
  followUpCondition({label:"Please elaborate on your experience building software in AWS (with Terraform)"}), null);
var sponsorFollow = {label:"If you will require sponsorship, please specify the type of assistance you would need (e.g., 'I currently hold an H-1B and require a transfer' or 'I am on F-1 OPT and will need future sponsorship')"};
check("a long 'If you will require sponsorship, please specify' waits on Yes (Greenhouse)", followUpCondition(sponsorFollow).test("Yes"), true);
check("and follows the question about sponsorship", followUpTopic(sponsorFollow), "sponso");
check("'If you will require relocation, what is your timeline' names relocation",
  followUpTopic({label:"If you will require relocation, what is your expected timeline?"}), "reloca");
check("'If yes, which company?' names no subject", followUpTopic({label:"If yes, which company?"}), null);
check("a decoding puzzle is a challenge", isChallenge({label:"Here's some text encoded in a common format. Figure out the correct secret"}), true);
check("a normal question is not", isChallenge({label:"Why do you want to work here?"}), false);
check("a long question in a one-line box is written",
  looksLikeEssay({tag:"input", type:"text", label:"We believe exceptional performance in one area is a good indication of performance in other areas. Do you have any examples?"}), true);
check("a long label mentioning GitHub is still an essay",
  isDefinitelyEssay({multiline:true, tag:"textarea", label:"Share 2-3 of your open-source contributions with links (GitHub)"}), true);
check("short name field is neither", isDefinitelyEssay({label:"First Name", tag:"input", type:"text", maxLength:60}), false);

// --- reconcile drops invented options ------------------------------------
var fields = [
  {id:"f1", tag:"select", type:"select", options:[{label:"Yes"},{label:"No"}], selector:"#a"},
  {id:"f2", tag:"input", type:"text", selector:"#b"},
  {id:"f3", tag:"textarea", type:"textarea", selector:"#c"}
];
var r = reconcile([
  {id:"f1", value:"Maybe", profileKey:"authorization.authorizedToWork"},
  {id:"f2", value:"hello", profileKey:"identity.firstName"},
  {id:"f3", needsWriting:true},
  {id:"f9", value:"ghost"},
  {id:"f2", value:""}
], fields);
check("invented option dropped", r.accepted.filter(function(a){return a.id==="f1";}).length, 0);
check("valid value kept", r.accepted.filter(function(a){return a.id==="f2";}).length, 1);
check("unknown id dropped", r.accepted.filter(function(a){return a.id==="f9";}).length, 0);
check("essay handed back", r.needsWriting.length, 1);

var r2 = reconcile([{id:"f1", value:"yes"}], fields);
check("case-insensitive option match", r2.accepted[0] && r2.accepted[0].value, "Yes");

// --- a draft about the material is not filled -----------------------------
check("a draft saying it lacks information is dropped",
  attachAnswers([{id:"q", answer:"I don't have enough information about Channable's values to answer this well."}], [{id:"q"}]).length, 0);
var trimmedMeta = attachAnswers([{id:"q", answer:"I don't have information about Acme's values in the provided materials. I value ownership, because at my last job I saw projects through from the first sketch to the release."}], [{id:"q"}]);
check("a draft that opens with talk about the material loses only that sentence",
  trimmedMeta.length === 1 && /^I value ownership/.test(trimmedMeta[0].value) && trimmedMeta[0].thin, true);
check("a draft saying there is nothing to share is dropped",
  attachAnswers([{id:"q", answer:"I do not have open-source contributions to share at this time."}], [{id:"q"}]).length, 0);
check("a real draft is kept",
  attachAnswers([{id:"q", answer:"I value ownership because I like seeing work through."}], [{id:"q"}]).length, 1);

// --- attachAnswers respects the page limit -------------------------------
var attached = attachAnswers(
  [{id:"f3", answer:"x".repeat(50), thin:false}],
  [{id:"f3", maxLength:10, selector:"#c"}]
);
check("answer truncated to page limit", attached[0].value.length <= 10, true);
check("truncation is reported", attached[0].trimmed, true);

// Overrunning a limit must not leave a sentence hanging.
var two = "I build payment systems and enjoy it. I also mentor engineers on the team.";
check("cuts at a sentence end", fitToLimit(two, 45), "I build payment systems and enjoy it.");
check("falls back to a word boundary", fitToLimit("alpha beta gamma delta epsilon", 20), "alpha beta gamma");
check("leaves short text alone", fitToLimit("short answer", 400), "short answer");
check("no limit means no change", fitToLimit("anything at all", 0), "anything at all");
check("never exceeds the limit", fitToLimit("supercalifragilistic expialidocious", 12).length <= 12, true);
check("keeps at least half the allowance",
  fitToLimit("One extremely long opening clause that runs on. Short.", 50).length >= 25, true);

// --- skills field identity ----------------------------------------------
var f = {name:"job_application[first_name]", label:"First Name", tag:"input", type:"text"};
check("fieldKey stable", fieldKey(f), fieldKey(JSON.parse(JSON.stringify(f))));
check("fieldKey differs by label", fieldKey(f) === fieldKey({name:f.name, label:"Last Name", tag:"input", type:"text"}), false);

// --- applySkill routes correctly -----------------------------------------
var skill = {fields:{}};
skill.fields[fieldKey(f)] = {kind:"profile", profileKey:"identity.firstName", locked:true};
var applied = applySkill(skill, [f, {name:"other", label:"Other", tag:"input", type:"text"}]);
check("skill hit", applied.known.length, 1);
check("skill miss", applied.unknown.length, 1);
check("skill supplies profile key", applied.known[0].profileKey, "identity.firstName");

var skipSkill = {fields:{}};
skipSkill.fields[fieldKey(f)] = {kind:"skip", note:"Never fill this"};
check("skill can skip", applySkill(skipSkill, [f]).skipped.length, 1);
var story = {name:"q1", label:"Describe an equipment or process problem you diagnosed. What did you do, and what was the result?", tag:"textarea", type:"textarea"};
var staleSkill = {fields:{}};
staleSkill.fields[fieldKey(story)] = {kind:"profile", profileKey:"employment.description", via:"label"};
check("a mapping a fixed rule no longer makes is not reused (Solcoa)", applySkill(staleSkill, [story]).known.length, 0);
staleSkill.fields[fieldKey(story)].via = "model";
check("but one a model made still is", applySkill(staleSkill, [story]).known.length, 1);
check("reusing a mapping keeps where it came from",
  learnFromRun({fields:{a:{kind:"profile", profileKey:"x", via:"label"}}}, [{fieldKey:"a", kind:"profile", profileKey:"x", via:"skill", ok:true}]).fields.a.via, "label");

// --- TypeSafe: reading a typed choice ------------------------------------
check("accepts a confident choice",
  readChoice({type:"choice", choice:"contact.email", confidence:0.9}, {minConfidence:0.6}).accepted, true);
check("marks a weak choice as not accepted",
  readChoice({type:"choice", choice:"contact.email", confidence:0.3}, {minConfidence:0.6}).accepted, false);
check("still reports the weak choice",
  readChoice({type:"choice", choice:"contact.email", confidence:0.3}, {minConfidence:0.6}).choice, "contact.email");
check("ignores a missing answer", readChoice(undefined, {}), null);
check("ignores an answer of the wrong type",
  readChoice({type:"noul", noul:0.9}, {}), null);
check("treats a missing confidence as zero",
  readChoice({type:"choice", choice:"x"}, {minConfidence:0.5}).accepted, false);
check("no floor accepts anything",
  readChoice({type:"choice", choice:"x", confidence:0}, {}).accepted, true);

// --- shortlisting --------------------------------------------------------
var AVAILABLE = ["identity.firstName","identity.lastName","contact.email","contact.phone",
  "address.line1","address.line2","address.city","address.state","address.postalCode",
  "address.country","links.linkedin","links.github","links.portfolio","work.currentCompany",
  "work.currentTitle","work.yearsExperience","work.school","work.highestDegree",
  "authorization.authorizedToWork","authorization.requiresSponsorship","preferences.howHeard",
  "preferences.willingToRelocate","compensation.desired","demographics.gender"];

function list(field) {
  return shortlistFor(field, {availableKeys: AVAILABLE, allowSensitive: false});
}
function has(field, key) { return list(field).indexOf(key) >= 0; }

check("shortlist is capped", list({label:"First Name"}).length <= SHORTLIST_SIZE, true);
check("shortlist finds the obvious key", has({label:"Email Address"}, "contact.email"), true);
check("shortlist keeps the heuristic guess",
  has({label:"Are you legally authorized to work in the United States?", name:"q_auth"},
      "authorization.authorizedToWork"), true);
check("shortlist keeps a sponsorship question's key",
  has({label:"Will you now or in the future require sponsorship?", name:"q_sponsor"},
      "authorization.requiresSponsorship"), true);
check("shortlist keeps an oddly worded key",
  has({label:"Apartment, suite, etc.", name:"address_line_2"}, "address.line2"), true);

// Only keys the profile can actually answer are offered.
check("an unset key is never offered",
  shortlistFor({label:"GitHub"}, {availableKeys:["contact.email"]}).indexOf("links.github"), -1);
// A heuristic guess must not smuggle a withheld key back into the list.
check("demographics are withheld by default",
  list({label:"Gender", name:"gender"}).indexOf("demographics.gender"), -1);
check("a withheld key is absent even as a direct hint",
  shortlistFor({label:"Gender", hint:"demographics.gender"},
    {availableKeys:AVAILABLE, allowSensitive:false}).indexOf("demographics.gender"), -1);
check("the hint never overflows the shortlist",
  shortlistFor({label:"Apartment, suite, etc.", hint:"address.line2"},
    {availableKeys:AVAILABLE, allowSensitive:false}).length <= SHORTLIST_SIZE, true);
check("demographics are offered when enabled",
  shortlistFor({label:"Gender"}, {availableKeys:AVAILABLE, allowSensitive:true})
    .indexOf("demographics.gender") >= 0, true);

// --- criteria ------------------------------------------------------------
var crit = criteriaFor(["contact.email","links.github","authorization.authorizedToWork"], {"contact.email":"pat@example.com"});
// The state holds each key's label and value; an option repeats neither.
check("a plain key needs no description", crit["links.github"], null);
check("an option does not repeat the saved value", JSON.stringify(crit).indexOf("pat@example.com"), -1);
check("criteria marks the boundary of a confusable key",
  /sponsorship/.test(crit["authorization.authorizedToWork"].not_for), true);
check("criteria offers a written escape", typeof crit[WRITTEN], "string");
check("criteria offers a none escape", typeof crit[NONE], "string");
check("criteria names the sensitive refusals", crit[NONE].indexOf("date of birth") >= 0, true);
check("criteria stays within the option ceiling",
  Object.keys(criteriaFor(AVAILABLE, {})).length <= MAX_OPTIONS, true);

// --- a dropdown is asked about its own options ------------------------------
var oc = optionCriteria({options:[{label:"Select..."},{label:"Yes"},{label:"No"},{label:"Yes"}]});
check("the page's options are the choices", Object.keys(oc).filter(function(k){ return k !== NONE; }).join("|"), "Yes|No");
check("a placeholder option is not a choice", "Select..." in oc, false);
check("there is a way out", typeof oc[NONE], "string");

// --- settling a dropdown -----------------------------------------------------
check("agreement keeps the rule's option",
  settleOption("Yes", {choice:"Yes", label:"Yes", confidence:0.9}, 0.6).value, "Yes");
check("a confident model option wins over the rule",
  settleOption("Yes", {choice:"No", label:"No", confidence:0.95}, 0.6).value, "No");
check("a confident 'none' leaves it empty",
  settleOption(null, {choice:NONE, confidence:0.9}, 0.6).value, null);
check("an unsure model keeps the rule",
  settleOption("Mobile", {choice:"Home", label:"Home", confidence:0.65}, 0.6).value, "Mobile");
check("with no rule, a model answer above the gate is used",
  settleOption(null, {choice:"LinkedIn", label:"LinkedIn", confidence:0.65}, 0.6).value, "LinkedIn");
check("with no rule, a model answer below the gate is a best guess",
  settleOption(null, {choice:"LinkedIn", label:"LinkedIn", confidence:0.4}, 0.6).via, "guess");
check("an answer too unsure even to guess is left empty",
  settleOption(null, {choice:"LinkedIn", label:"LinkedIn", confidence:0.2}, 0.6).value, null);
check("a question that depends on another answer is not guessed",
  settleOption(null, {choice:"No", label:"No", confidence:0.45}, 0.6, {label:"After the OPT, are you eligible for a 24-month extension?"}).value, null);
check("a question about who someone is is never guessed",
  settleOption(null, {choice:"No", label:"No", confidence:0.5}, 0.6, {label:"Do you identify as transgender?"}).value, null);
check("'nothing applies' is never a guess",
  settleOption(null, {choice:"__none__", label:null, confidence:0.5}, 0.6).value, null);

// --- every saved key is offered -------------------------------------------
// Everything saved, less the demographic one (gender): desired pay is offered,
// since salary questions are not what the demographics switch turns off.
check("the whole available list is offered, not a top fifteen",
  list({label:"Middle initial"}).length, AVAILABLE.length - 1);
check("desired pay is offered with demographics off",
  list({label:"Expected salary"}).indexOf("compensation.desired") >= 0, true);

// --- packing questions into requests ----------------------------------------
var bigQ = {};
for (var qi = 0; qi < 120; qi++) {
  bigQ["q" + qi] = {type:"choice", instructions:describeForTypeSafe({label:"Question " + qi}),
    criteria: criteriaFor(AVAILABLE, {"contact.email":"pat@example.com"})};
}
var packs = packQuestions(bigQ, {candidate_profile:{a:"b"}});
check("a large form is split across requests", packs.length > 1, true);
check("no question is lost in packing",
  packs.reduce(function(n, b){ return n + Object.keys(b).length; }, 0), 120);
check("every request fits the token budget",
  packs.every(function(b){ return estimateTokens(b) + estimateTokens({candidate_profile:{a:"b"}}) <= TOKEN_BUDGET_PER_CALL; }), true);
check("a small form is one request", packQuestions({a:{type:"choice"}}, "s").length, 1);
// A request builder the batcher calls must exist: a run that loses it falls
// back to local rules without any error, which is how it went unnoticed once.
check("the batcher's request function exists", typeof askTypeSafe, "function");

// --- what TypeSafe is told about a field -------------------------------------
var described = describeForTypeSafe({label:"Company size", name:"company_size", tag:"select",
  options:[{label:"1-10"},{label:"11-50"}], section:"About you", scope:"employment", required:true});
check("the field is a structured object", described.form_field.label, "Company size");
check("its name attribute is included", described.form_field.html_name, "company_size");
check("its options are included", described.form_field.options_offered.join("|"), "1-10|11-50");
check("a dropdown is called a dropdown", described.form_field.control, "dropdown");
check("the question points at the field", /`form_field`/.test(described.question), true);
check("a generated name is left out",
  describeForTypeSafe({label:"City", name:"spl-form-element_1234"}).form_field.html_name, undefined);

// --- settling a local rule against TypeSafe ---------------------------------
check("agreement keeps the rule's key",
  settle("address.state", {choice:"address.state", confidence:0.95}, 0.6).key, "address.state");
check("a confident different answer overrules the rule",
  settle("work.currentCompany", {choice:"custom.size", confidence:0.9}, 0.6).key, "custom.size");
check("a confident 'nothing fits' leaves the field empty",
  settle("address.state", {choice:NONE, confidence:0.92}, 0.6).key, null);
check("an unsure answer keeps the rule",
  settle("address.state", {choice:NONE, confidence:0.5}, 0.6).key, "address.state");
check("no answer keeps the rule", settle("address.state", undefined, 0.6).key, "address.state");
check("a written-answer verdict does not erase a stored match",
  settle("employment.description", {choice:WRITTEN, confidence:0.95}, 0.6).key, "employment.description");
check("a rule key with nothing saved is not replaced by a neighbour",
  settle("identity.middleName", {choice:"identity.firstName", confidence:0.9}, 0.6, {offered:false}).key, "identity.middleName");

// --- merging frames ---------------------------------------------------------
var merged = mergeExtractions([
  {frameId:0, result:{ok:true, origin:"https://acme.com", fields:[], uploads:[], context:{role:"Engineer", company:"Acme"},
    embeds:[{origin:"https://boards.greenhouse.io"}, {origin:"https://jobs.ashbyhq.com"}]}},
  {frameId:7, result:{ok:true, origin:"https://boards.greenhouse.io", fields:[{id:"f0", label:"First name"}],
    uploads:[{kind:"resume", selector:"#r"}], context:{role:"Apply for Backend Engineer", multiStep:true}, embeds:[]}}
]);
check("fields from a frame keep their frame", merged.fields[0].frameId, 7);
check("field ids are unique across frames", merged.fields[0].id, "7:f0");
check("uploads keep their frame", merged.uploads[0].frameId, 7);
check("the top page names the company", merged.context.company, "Acme");
check("a multi-step embed marks the form multi-step", merged.context.multiStep, true);
check("an embed that answered is not blocked", merged.blocked.indexOf("https://boards.greenhouse.io"), -1);
check("an embed that did not answer is reported", merged.blocked.join(","), "https://jobs.ashbyhq.com");
check("frames group by id", byFrame([{frameId:0},{frameId:3},{}]).get(0).length, 2);
var redirected = mergeExtractions([
  {frameId:0, result:{ok:true, origin:"https://www.zipline.com", fields:[], uploads:[], context:{},
    embeds:[{origin:"https://boards.greenhouse.io"}]}},
  {frameId:4, result:{ok:true, origin:"https://job-boards.greenhouse.io", fields:[{id:"f0", label:"First name"}], uploads:[], context:{}, embeds:[]}}
]);
check("an embed that redirected within its site is not blocked", redirected.blocked.length, 0);

// --- country codes against richer options ----------------------------------
check("US matches 'United States +1'",
  resolveValue({options:[{label:"Afghanistan +93"},{label:"United States +1"}]}, "address.country", {"address.country":"US"}), "United States +1");
check("US matches 'United States of America'",
  resolveValue({options:[{label:"United Kingdom"},{label:"United States of America"}]}, "address.country", {"address.country":"US"}), "United States of America");

// --- ambiguous starts ----------------------------------------------------------
check("a start several options share is no answer",
  resolveValue({options:[{label:"Northfield University - Bothell"},{label:"Northfield University - Seattle"}]},
    "work.school", {education:[{school:"Northfield University", endYear:"2020"}]}), null);
check("a start only one option has is",
  resolveValue({options:[{label:"Stanford University"},{label:"Northfield University - Seattle"}]},
    "work.school", {education:[{school:"Northfield University", endYear:"2020"}]}), "Northfield University - Seattle");
var bigList = []; for (var bi = 0; bi < 600; bi++) bigList.push({label:"College " + bi});
bigList.push({label:"Northfield University - Seattle"});
check("a long list sends the matching options first",
  Object.keys(optionCriteria({options:bigList, savedValue:"Northfield University"}))[0], "Northfield University - Seattle");

// --- "Immediately" in a date picker ------------------------------------------
check("a date picker gets today's date for 'Immediately'",
  /^\d{2}\/\d{2}\/\d{4}$/.test(resolveValue({datePicker:true, placeholder:"Pick date..."}, "preferences.availableStartDate", {"preferences.availableStartDate":"Immediately"})), true);
check("a native date input gets ISO",
  /^\d{4}-\d{2}-\d{2}$/.test(resolveValue({datePicker:true, type:"date"}, "preferences.availableStartDate", {"preferences.availableStartDate":"Immediately"})), true);
check("a text box keeps the word",
  resolveValue({}, "preferences.availableStartDate", {"preferences.availableStartDate":"Immediately"}), "Immediately");
check("the place hint spells the state both ways",
  /CA/.test(suggestionHint({profileKey:"address.location"}, {"address.state":"California","address.country":"US"})), true);

// --- a phone box that starts with a dial code ------------------------------
check("a phone box starting with another country's code gets the number with its own",
  resolveValue({tag:"input", type:"tel", currentValue:"+31"}, "contact.phone", {"contact.phone":"(415) 555-0134", "address.country":"United States"}), "+1 4155550134");
check("a saved code is used and not doubled",
  resolveValue({tag:"input", type:"tel", currentValue:"+31"}, "contact.phone", {"contact.phone":"14155550134", "contact.phoneCountryCode":"+1"}), "+1 4155550134");
check("an empty phone box keeps the number as saved",
  resolveValue({tag:"input", type:"tel", currentValue:""}, "contact.phone", {"contact.phone":"(415) 555-0134"}), "(415) 555-0134");

// --- Workday ids name their section first --------------------------------
check("a Workday id's section is not the field (Employee ID on the disability page)",
  (matchField({label:"Employee ID (if applicable)", name:"employeeId", idAttr:"selfIdentifiedDisabilityData--employeeId"}) || {}).key !== "demographics.disabilityStatus", true);
check("the form's language picker is not the disability question",
  (matchField({label:"Language", name:"disabilityForm", idAttr:"selfIdentifiedDisabilityData--disabilityForm", options:[{label:"English"}]}) || {}).key !== "demographics.disabilityStatus", true);
var unavailableQ = {label:"Other than time off for reasons related to your religion, a disability, or a medical condition, are there any days or times when you are unavailable to work?", idAttr:"question_19103559004", type:"text"};
check("an aside naming a disability is not the disability question (Kairos Power)",
  (matchField(unavailableQ) || {}).key !== "demographics.disabilityStatus" && !isIdentityQuestion(unavailableQ), true);
var signQ = {label:"I certify that all of the information I have provided is correct and complete. By signing this Electronic Signature Acknowledgment Online Form, I agree that my electronic signature is the legally binding equivalent to my handwritten signature. Please sign by typing your Full Legal First, Middle Initial, and Last Name.*", idAttr:"question_1", type:"text"};
check("a typed signature is the whole name, not the middle name (Block)", (matchField(signQ) || {}).key, "identity.fullName");
check("with the middle initial it asks for", resolveValue(signQ, "identity.fullName", {"identity.firstName":"Pat", "identity.middleName":"Quinn", "identity.lastName":"Brien", "identity.fullName":"Pat Quinn Brien"}), "Pat Q. Brien");
check("preferred gender pronouns are pronouns, not an identity question (Brex)", isIdentityQuestion({label:"What are your preferred gender pronouns? (She/Her/Hers; He/Him/His; They/Them/Theirs, etc.)", type:"text"}), false);
check("a follow-up naming the employer it asks about follows that question (Brex)",
  followUpTopic({label:"If you currently work, or have previously worked, at Capital One or a company acquired by Capital One, please provide your Employee ID (EID). This information is required for former/current employees."}), "capita");
check("a long 'If you answered Yes' box is still a follow-up (Block)",
  String(followUpCondition({label:'If you answered "Yes" to the question above, please enter your dates of employment. Note that your performance history may be reviewed as part of the application process.'})), "/^(yes|y)\\b/i");
check("an offer of interview accommodations is not the disability question (Astera)",
  (matchField({label:"We are happy to provide accommodations for individuals with disabilities. Please let us know if you require any support during the interview process.", type:"text"}) || {}).key !== "demographics.disabilityStatus", true);
check("aligned with working from the office 3 times a week is accepting on-site work (insitro)",
  (matchField({label:"Are you aligned with the role's work from office expectation of 3 times a week at our South San Francisco headquarters?", type:"radio", options:[{label:"Yes"},{label:"No"}]}) || {}).key, "preferences.acceptOnsite");
check("a box asking for the GitHub profile is not a list of links (Astera)",
  severalLinks({label:"If you have any projects on GitHub, please provide a link to your GH profile.", type:"url"}, {"links.github":"https://github.com/patbrien", "links.portfolio":"https://patbrien.example"}), null);
check("a numbered 'a. If NO' box is a follow-up after a No (Apptronik)",
  String(followUpCondition({label:'a. If NO, please indicate your country of citizenship and, if different, the country in which you have most recently obtained citizenship or permanent residency status. (Enter in "N/A" if marked Yes above) *'})), "/^(no|n)\\b/i");
check("eligible for a clearance is answered from US citizenship, not the saved clearance (HavocAI)",
  resolveValue({label:"Are you eligible for a US security clearance?", type:"radio", options:[{label:"Yes"},{label:"No"}]}, "screening.securityClearance", {"screening.securityClearance":"No", "authorization.citizenship":"U.S. citizen"}), "yes");
check("holding one is still the saved answer",
  resolveValue({label:"Do you have an active security clearance?", type:"text"}, "screening.securityClearance", {"screening.securityClearance":"No", "authorization.citizenship":"U.S. citizen"}), "No");
check("a gender list saying Man takes Man for a saved Male (Samsara)",
  resolveValue({label:"How do you identify? (gender identity)*", options:["Agender","Cis-man","Cis-woman","Man","Woman"].map(label => ({label}))}, "demographics.gender", {"demographics.gender":"Male"}), "Man");
check("preferred name and pronouns in one box get both (Samsara)",
  resolveValue({label:"Feel free to share your preferred name and pronouns (she/her, they/them, he/him, ze/zir etc.).", type:"text"}, "identity.preferredName", {"identity.preferredName":"Pat", "identity.firstName":"Patrice", "identity.pronouns":"He/Him"}), "Pat (He/Him)");
check("accepting the listed salary range is yes (Samsara)", acceptsPayRange({label:"Do you accept the listed salary range for this position?*", options:[{label:"Yes"},{label:"No"}]}), "Yes");
check("an interviewer AI policy is acknowledged (Samsara)", (matchField({label:"AI Policy for Interviewers*", options:[{label:"Yes"},{label:"No"}]}) || {}).key, "preferences.agreeToTerms");
check("the disability question still is",
  matchField({label:"Please check one of the boxes below:", idAttr:"selfIdentifiedDisabilityData--disabilityStatus", type:"checkboxgroup"}).key, "demographics.disabilityStatus");
check("a signature date's month box is today's date",
  matchField({label:"Month", idAttr:"selfIdentifiedDisabilityData--dateSignedOn-dateSectionMonth-input"}).key, "preferences.todaysDate");
var todayIso = profileValue({}, "preferences.todaysDate");
check("its month is this month",
  resolveValue({label:"Month"}, "preferences.todaysDate", {}), todayIso.slice(5, 7));
check("its day is today",
  resolveValue({label:"Day"}, "preferences.todaysDate", {}), todayIso.slice(8, 10));
check("its year is this year",
  resolveValue({label:"Year"}, "preferences.todaysDate", {}), todayIso.slice(0, 4));

check("Workday's preferred name tick box is not a referral",
  matchField({label:"I have a preferred name", type:"checkbox", idAttr:"name--preferredCheck"}).key, "identity.preferredName");
check("it is ticked when a preferred name is saved, short form or not",
  resolveValue({type:"checkbox"}, "identity.preferredName", {"identity.firstName":"Patricia","identity.preferredName":"Pat"}), "true");
check("Workday's revealed preferred first-name box is the preferred name",
  matchField({label:"First Name", idAttr:"name--preferredName--firstName", name:"preferredName--firstName"}).key, "identity.preferredName");
check("and its last-name box the last name",
  matchField({label:"Last Name", idAttr:"name--preferredName--lastName", name:"preferredName--lastName"}).key, "identity.lastName");
check("the legal first-name box is still the first name",
  matchField({label:"First Name", idAttr:"name--legalName--firstName", name:"legalName--firstName"}).key, "identity.firstName");
check("and left alone when it is the first name",
  resolveValue({type:"checkbox"}, "identity.preferredName", {"identity.firstName":"Pat","identity.preferredName":"Pat"}), null);

// --- places and schools ----------------------------------------------------
check("'Where do you plan on working from?' wants a location",
  matchField({label:"Where do you plan on working from (for payroll tax purposes)?"}).key, "address.location");
check("'Current location' wants a location", matchField({label:"Current location ✱"}).key, "address.location");
check("the location is city and state",
  profileValue({"address.city":"Portland","address.state":"California"}, "address.location"), "Portland, California");
check("a GPA question mentioning school is not a school box",
  (matchField({label:"If you're less than 3 years out of school, what is your undergraduate GPA?"}) || {}).key === "work.school", false);
check("'School' is still a school box", matchField({label:"School*"}).key, "work.school");
check("'Which university did you attend?' is a school box",
  matchField({label:"Which university are you currently attending or did you last attend?"}).key, "work.school");

// --- how did you hear ------------------------------------------------------
check("'Tell us how you heard about Acme' is how-heard",
  matchField({label:"Tell us how you heard about Acme and this job!"}).key, "preferences.howHeard");
check("'How did you connect with us?' is how-heard",
  matchField({label:"How did you connect with us?*", name:"question_4012"}).key, "preferences.howHeard");
check("'How did you hear about Globex?' is still how-heard",
  matchField({label:"How did you hear about Globex?"}).key, "preferences.howHeard");
check("Workday's source--source box is still how-heard",
  matchField({label:"How Did You Hear About Us?", idAttr:"source--source"}).key, "preferences.howHeard");
check("a SUBSOURCE detail box is not how-heard",
  (matchField({label:"Specific Referral Source", idAttr:"HRS_AL_SRCE_I_HRS_SUBSOURCE_DESC", name:"HRS_AL_SRCE_I_HRS_SUBSOURCE_DESC"}) || {}).key === "preferences.howHeard", false);
check("a referralSource box is still how-heard",
  matchField({label:"Referral source", name:"referralSource"}).key, "preferences.howHeard");
check("a 'resource' box is not how-heard",
  (matchField({label:"Resources", name:"resources"}) || {}).key === "preferences.howHeard", false);

// --- consent is not a marketing opt-in -------------------------------------
check("an opt-in to future contact is not a terms box",
  (matchField({type:"checkbox", label:"Spotify has my consent to contact me about future job opportunities"}) || {}).key === "preferences.agreeToTerms", false);
check("a privacy policy box still is",
  matchField({type:"checkbox", label:"I agree to the privacy policy"}).key, "preferences.agreeToTerms");

// --- cost ------------------------------------------------------------------------
check("TypeSafe bills input only: a million tokens is 4.2 cents",
  Math.round(callCents("typesafe", "jev-latest", {input_tokens: 1000000, output_tokens: 999}) * 1000) / 1000, 4.2);
var peakTime = new Date(Date.UTC(2026, 9, 14, 8, 0));   // Wednesday 08:00 UTC
var offTime = new Date(Date.UTC(2026, 9, 17, 8, 0));    // Saturday
check("DeepSeek peak hours are recognised", deepseekPeak(peakTime), true);
check("weekends are off-peak", deepseekPeak(offTime), false);
check("off-peak DeepSeek costs half",
  callCents("deepseek", "deepseek-v4-pro", {prompt_cache_miss_tokens: 1000000}, offTime) * 2,
  callCents("deepseek", "deepseek-v4-pro", {prompt_cache_miss_tokens: 1000000}, peakTime));
check("cache hits are billed at the hit rate",
  callCents("deepseek", "deepseek-v4-pro", {prompt_cache_hit_tokens: 1000000}, peakTime) < 0.01 * 1000, true);
var budget = affordableOutput("deepseek", "deepseek-v4-pro", 6000, 10, peakTime);
check("the writer's output is cut to fit the cap",
  worstCaseCents("deepseek", "deepseek-v4-pro", 6000, budget, peakTime) <= 10, true);
var meter = new Meter(10);
meter.add("typesafe", "jev-latest", {input_tokens: 20000}, "plan");
check("a meter totals its calls", meter.summary().cents, 0.084);
check("the price is three times the cost", meter.summary().priceCents, 0.252);
check("a call over the cap is refused", meter.allows(10), false);
check("and the fill is marked capped", meter.summary().capped, true);
var split = new Meter(10);
split.add("typesafe", "jev-latest", {input_tokens: 10000}, "plan");
split.add("deepseek", "deepseek-v4-pro", {prompt_cache_miss_tokens: 2000, prompt_tokens: 2000, completion_tokens: 500}, "writer");
var parts = split.summary().byProvider;
check("the cost is split by provider",
  [parts.typesafe.inputTokens, parts.typesafe.calls, parts.deepseek.inputTokens, parts.deepseek.outputTokens].join(","), "10000,1,2000,500");
check("the parts add up to the total",
  Math.abs(parts.typesafe.cents + parts.deepseek.cents - split.summary().cents) < 0.001, true);

// --- time saved -----------------------------------------------------------------
// Keystroke-level timings, net of checking each field: a realistic form.
function opts(n) { var o = []; for (var i = 0; i < n; i++) o.push({label:"Option " + i}); return o; }
var essay = new Array(200).fill("word").join(" ");
var form = [
  {label:"First Name", value:"Pat"}, {label:"Last Name", value:"Brien"}, {label:"Preferred First Name", value:"Pat"},
  {label:"Email", type:"email", value:"pat.brien@example.com"},
  {label:"Country", widget:"listbox", options:opts(244), value:"United States +1"},
  {label:"Phone", type:"tel", value:"(415) 555-0134"},
  {label:"Location (City)", combobox:true, value:"Portland, Oregon, United States"},
  {label:"LinkedIn Profile", value:"https://www.linkedin.com/in/pat-brien-12345/"},
  {label:"How did you hear about this job?", widget:"listbox", options:opts(16), value:"LinkedIn"},
  {label:"Why do you want to work at Acme?", via:"written", multiline:true, value:essay},
  {label:"Are you legally authorized to work in the United States for our company?", widget:"listbox", options:opts(3), value:"Yes"},
  {label:"Are you currently located in the US?", widget:"listbox", options:opts(2), value:"Yes"},
  {label:"Are you willing to relocate to the Bay Area for this role?", widget:"listbox", options:opts(2), value:"Yes"},
  {label:"Gender", widget:"listbox", options:opts(3), value:"Male"},
  {label:"Race and ethnicity", widget:"listbox", options:opts(8), value:"White"},
  {label:"Veteran status", widget:"listbox", options:opts(3), value:"I am not a protected veteran"},
  {label:"Disability status", widget:"listbox", options:opts(3), value:"No"},
  {label:"Gender identity (optional)", widget:"listbox", options:opts(6), value:"Man"},
  {label:"Race or ethnicity (optional)", widget:"listbox", options:opts(8), value:"White"},
  {label:"Are you Hispanic/Latino?", widget:"listbox", options:opts(3), value:"No"},
  {label:"Please identify your race", widget:"listbox", options:opts(7), value:"White"}
];
var formMinutes = estimateSeconds(form, 1) / 60;
check("a 21-field form with one 200-word essay saves about seventeen minutes (" + formMinutes.toFixed(1) + ")",
  formMinutes > 15 && formMinutes < 19, true);
check("the same form without the essay is a few minutes", (function () {
  var m = estimateSeconds(form.filter(function (f) { return f.via !== "written"; }), 0) / 60; return m > 1.5 && m < 4; })(), true);
check("a short name is a few seconds, net of checking it",
  estimateSeconds([{label:"First Name", value:"Pat"}]) >= 0 && estimateSeconds([{label:"First Name", value:"Pat"}]) <= 5, true);
check("a long value counts as copied, not typed letter by letter",
  estimateSeconds([{label:"Portfolio", value:new Array(200).join("x")}]) < 20, true);
check("a long list takes longer than a short one",
  estimateSeconds([{label:"Country", widget:"listbox", options:opts(244)}]) > estimateSeconds([{label:"Country", widget:"listbox", options:opts(3)}]), true);
function five(extra) { var out = []; for (var i = 0; i < 5; i++) out.push(Object.assign({label:"Which shift would you prefer to work?", widget:"listbox", options:opts(3)}, extra)); return out; }
check("a best guess earns half", estimateSeconds(five({via:"guess"})) < estimateSeconds(five({})), true);
check("a 200-word draft is twenty minutes of writing, less five of editing it",
  Math.round(estimateSeconds([{label:"Why us?", via:"written", multiline:true, value:essay}]) / 60), 15);
check("nothing filled saves nothing", estimateSeconds([]), 0);
// --- yes/no facts asked in a text area (Ashby) --------------------------------
var sponsorBox = {tag:"textarea", multiline:true, label:"Will you now or in the future require sponsorship for employment visa status (e.g. H-1B visa status)?"};
check("a yes/no fact in a text area is not an essay", looksLikeEssay(sponsorBox), false);
check("it is answered from the profile, as a word",
  resolveValue(sponsorBox, "authorization.requiresSponsorship", {"authorization.requiresSponsorship":"no"}), "No");
check("a yes/no question that asks for more is still written",
  looksLikeEssay({tag:"textarea", multiline:true, label:"Will you require sponsorship? If so, please explain your visa situation in detail."}), true);

// --- a reference's employer (PeopleSoft) -------------------------------------
check("an EMPLOYER id under a reference heading is the reference's",
  scopeOf({name:"HRS_REFF_SS_VW_EMPLOYER$0", idAttr:"HRS_REFF_SS_VW_EMPLOYER$0", label:"Employer", section:"Reference Information › Add Reference"}).scope, "reference");
check("an employer id under a job heading is still the job's",
  scopeOf({name:"employer_name", label:"Employer", section:"Employment History › Experience"}).scope, "employment");
check("PeopleSoft's REFF prefix is a reference", scopeOf({name:"HRS_REFF_NAME", label:"Name", section:""}).scope, "reference");

// --- rows of saved jobs shown as filled-in boxes (workatastartup) -------------
var rowsProfile = {employment: [{company:"Acme", title:"Analyst"}, {company:"Globex", title:"Engineer"}, {company:"Initech", title:"Intern"}]};
function jobRow(id, company) {
  return [{id:id+"c", label:"Company", scope:"employment", currentValue: company || ""},
          {id:id+"t", label:"Title", scope:"employment", currentValue: company ? "Someone" : ""}];
}
var rows = [].concat(jobRow("a"), jobRow("b", "Acme"), jobRow("c", "Globex"));
check("a blank job row above saved ones gets the first job not already shown",
  pickListEntries(rows, "Work History", rowsProfile).map(function(f){ return f.repeatIndex; }).join(","), "2,2,0,0,1,1");
check("a single job dialog with a repeated Month label stays one job",
  pickListEntries([{id:"m1", label:"Company", scope:"employment"}, {id:"m2", label:"Month", scope:"employment"}, {id:"m3", label:"Month", scope:"employment"}],
    "Employment History Acme", rowsProfile).map(function(f){ return f.repeatIndex; }).join(","), "1,1,1");

// --- the page's structure, read by TypeSafe (structure.js) ----------------------
var st = {offset: 10, lines: ["Apply to Acme", "This role is in Portland. Are you in Portland or willing to move? *", "Yes", "No", "Email *", "Row 1"],
  fields: {
    f0: {marker: "checkbox", candidates: [10, 11, 12, 13], options: []},
    f1: {marker: "checkbox", candidates: [11, 12, 13], options: []},
    f2: {marker: 'email placeholder="Email *"', candidates: [13, 14], options: []},
    f3: {marker: "text", candidates: [14, 15], options: []},
    f4: {marker: "radio (first of 2 options: ?, ?)", candidates: [10, 11], options: [{index: 0, label: "", candidates: [12]}, {index: 1, label: "", candidates: [13]}]}
  }};
var stFields = [{id:"f0", type:"checkbox", label:"Yes"}, {id:"f1", type:"checkbox", label:"No"},
  {id:"f2", type:"email", label:"Required", placeholder:"Email *"}, {id:"f3", type:"text", label:"Row 1"},
  {id:"f4", type:"radio", label:"", options:[{label:"", value:"1"}, {label:"", value:"0"}]}];
var req = structureQuestions(st, stFields);
check("the structure request offers each field its nearby lines",
  Object.values(req.questions.q_f0.criteria).slice(0, 2).join(" / "), "Apply to Acme / This role is in Portland. Are you in Portland or willing to move? *");
check("and reads the instructions once, in the state", /question or label/.test(req.state.task) && /\| This role/.test(req.state.page), true);
check("each control is a numbered line of its own", /(^|\n)L\d+ \| \[q_f0: checkbox\]/.test(req.state.page), true);
check("an option with no words is asked for the line beside it", !!req.questions.o_f4_0, true);
// The numbered page's id for a text line, as the request shows it.
var idOf = numberedPage(st, stFields).idOf;
var applied = applyStructure(st, stFields, {
  q_f0: {choice: idOf(11), confidence: 0.98}, q_f1: {choice: idOf(11), confidence: 0.97}, q_f2: {choice: "__self__", confidence: 0.9},
  q_f3: {choice: "__none__", confidence: 0.85}, q_f4: {choice: idOf(11), confidence: 0.6},
  o_f4_0: {choice: idOf(12), confidence: 0.9}, o_f4_1: {choice: idOf(13), confidence: 0.9}}).fields;
check("a line that is another field's own label is not this field's question",
  applyStructure(st, stFields, {q_f2: {choice: idOf(12), confidence: 0.9}}).fields[2].label, "Required");
check("a field gets the question TypeSafe found", applied[0].label, "This role is in Portland. Are you in Portland or willing to move? *");
check("its own words are kept for the tick box", applied[0].optionText + "/" + applied[1].optionText, "Yes/No");
check("and the extractor's reading is kept", applied[0].extractedLabel, "Yes");
check("named by its own placeholder", applied[2].label, "Email *");
check("\"Excellence\" is not a cell phone (Promise)", (matchField({label:"Show Off Your Excellence", type:"textarea", name:"45f0c39f"}) || {}).key !== "contact.phone", true)
check("but \"Cell\" is", (matchField({label:"Cell", type:"tel", name:"x"}) || {}).key, "contact.phone")
check("a worded label far above its box is not swapped for \"Type here...\" (Promise)",
  applyStructure(st, [{id:"f2", type:"textarea", label:"Show Off Your Excellence", placeholder:"Type here...", required:true}], {q_f2: {choice: "__self__", confidence: 0.9}}).fields[0].label, "Show Off Your Excellence");
check("site furniture is set aside", applied[3].notPart, true);
check("blank options get the words beside them", applied[4].options.map(function(o){return o.label;}).join("/"), "Yes/No");
check("a required field is never set aside",
  applyStructure(st, [{id:"f3", type:"text", label:"Row 1", required:true}], {q_f3: {choice: "__none__", confidence: 0.95}}).fields[0].notPart, undefined);
check("an unsure answer keeps the extractor's reading",
  applyStructure(st, [stFields[2]], {q_f2: {choice: idOf(14), confidence: 0.2}}).fields[0].label, "Required");
check("the Yes box under a question is ticked for yes",
  resolveValue(applied[0], "preferences.willingToRelocate", {"preferences.willingToRelocate":"yes"}), "true");
check("and the No box is not", resolveValue(applied[1], "preferences.willingToRelocate", {"preferences.willingToRelocate":"yes"}), null);
check("a field's identity stays with the extractor's reading",
  fieldIdentity(applied[0]) === fieldIdentity(stFields[0]), true);

// --- in-office requirements --------------------------------------------------
var onsiteQ = {label:"This role requires working in person five days per week at Acme's downtown Portland office. Are you willing to meet this requirement?", type:"radio", options:[{label:"Yes"},{label:"No"}]};
check("an in-office requirement question is the on-site preference", matchField(onsiteQ).key, "preferences.acceptOnsite");
check("saying yes to it answers Yes", resolveValue(onsiteQ, "preferences.acceptOnsite", {"preferences.acceptOnsite":"yes"}), "Yes");
check("an office-days question in other words too",
  matchField({label:"Are you able to work from our Portland HQ 3 days per week?", type:"radio", options:[{label:"Yes"},{label:"No"}]}).key, "preferences.acceptOnsite");
check("an office-days question asked as excitement (Ashby)",
  matchField({label:"Are you excited to work in-office five days a week?", type:"radio", options:[{label:"Yes"},{label:"No"}]}).key, "preferences.acceptOnsite");
officeQ = {"label":"Which location are you applying for?", "type":"radio", "options":[{"label":"New York"},{"label":"San Francisco"},{"label":"Stockholm"}]}
check("choosing an office is a location question (Modal)", matchField(officeQ).key, "address.location")
swedenQ = {"label":"If you are applying for our Stockholm office, are you legally authorized to work in Sweden?", "type":"radio", "options":[{"label":"Yes"},{"label":"No"}]}
usOnly = {"authorization.authorizedToWork":"yes","authorization.requiresSponsorship":"no","authorization.countriesAuthorized":"United States"}
check("authorized in another named country is answered from the countries list (Modal)", resolveValue(swedenQ, "authorization.authorizedToWork", usOnly), "No")
check("sponsorship in another named country is needed", resolveValue({"label":"Will you require sponsorship to work in the UK?", "type":"radio", "options":[{"label":"Yes"},{"label":"No"}]}, "authorization.requiresSponsorship", usOnly), "Yes")
check("a question about a listed country keeps the saved answer", resolveValue({"label":"Are you legally authorized to work in the U.S.?", "type":"radio", "options":[{"label":"Yes"},{"label":"No"}]}, "authorization.authorizedToWork", usOnly), "Yes")
check("\"us\" is not the United States", resolveValue({"label":"Are you legally authorized to work for us?", "type":"radio", "options":[{"label":"Yes"},{"label":"No"}]}, "authorization.authorizedToWork", {"authorization.authorizedToWork":"yes","authorization.countriesAuthorized":"Canada"}), "Yes")
check("an EU citizen is authorized in Sweden", resolveValue(swedenQ, "authorization.authorizedToWork", {"authorization.authorizedToWork":"yes","authorization.countriesAuthorized":"United States, European Union"}), "Yes")
check("a question naming no country keeps the saved answer", resolveValue({"label":"Are you legally authorized to work in the country where this role is located?", "type":"radio", "options":[{"label":"Yes"},{"label":"No"}]}, "authorization.authorizedToWork", usOnly), "Yes")
officesQ = {"label":"Which office location(s) are you interested in?", "type":"checkboxgroup", "options":[{"label":"London, UK"},{"label":"San Mateo, CA"},{"label":"Singapore"}]}
check("an office question with (s) is a location question (Fireworks)", matchField(officesQ).key, "address.location")
check("\"From where do you intend to work?\" is a place, by rule (Greenhouse)",
  matchField({label:"From where do you intend to work?", type:"text"}).key, "address.location");
check("\"Do you intend to work from our office?\" is not",
  (matchField({label:"Do you intend to work from our office?", type:"radio", options:[{label:"Yes"},{label:"No"}]}) || {}).key !== "address.location", true);
var sfQ = {label:"Are you able to work from San Francisco, CA?", type:"radio", options:[{label:"Yes, and I currently live in the SF Bay Area."},{label:"Yes, and while I do not currently live in the SF Bay Area, I am open to relocation."},{label:"No or Other. Please add more details below."}]};
check("Oakland lives in the SF Bay Area option (Sierra)", livesInOption(sfQ, {"address.city":"Oakland"}), "Yes, and I currently live in the SF Bay Area.")
check("Denver takes the not-living-there one", livesInOption(sfQ, {"address.city":"Denver"}), "Yes, and while I do not currently live in the SF Bay Area, I am open to relocation.")
check("an unknown city decides nothing", livesInOption(sfQ, {"address.city":"Tulsa"}), null)
var localQ = {label:"Are you currently located in the San Francisco Bay Area or open to relocating for this role?", type:"checkboxgroup", options:[{label:"I\u2019m local to the San Francisco Bay Area"},{label:"I\u2019m not local but open to relocating"},{label:"I\u2019m not local and not open to relocating"}]};
check("Berkeley is local to the SF Bay Area (Gridware, Lever)", livesInOption(localQ, {"address.city":"Berkeley"}), "I\u2019m local to the San Francisco Bay Area")
check("Denver is not local: left to the model", livesInOption(localQ, {"address.city":"Denver"}), null)
var prefQ = {label:"Preferred First & Last Name", type:"text"};
check("a preferred first and last name box is the preferred name (Sierra)", matchField(prefQ).key, "identity.preferredName")
check("and gets it with the last name", resolveValue(prefQ, "identity.preferredName", {"identity.firstName":"Patricia","identity.preferredName":"Pat","identity.lastName":"Brien"}), "Pat Brien")
check("or the first name when none is saved", resolveValue(prefQ, "identity.preferredName", {"identity.firstName":"Patricia","identity.lastName":"Brien"}), "Patricia Brien")
check("a plain preferred name box is still the first name alone", resolveValue({label:"Preferred Name", type:"text"}, "identity.preferredName", {"identity.preferredName":"Pat","identity.lastName":"Brien"}), "Pat")
var metaQ = {label:"We use Metaview, an AI notetaking tool, to streamline interviews by recording and summarizing discussions. Can Metaview transcribe all your interviews?", type:"radio", options:[{label:"Yes"},{label:"No"}]};
check("consent to interview transcription follows the agreement setting (Sierra)", matchField(metaQ).key, "preferences.agreeToTerms")
check("and reads as something to agree to", AGREEMENT.test(metaQ.label), true)
check("and agreeing says Yes", resolveValue(metaQ, "preferences.agreeToTerms", {"preferences.agreeToTerms":"yes"}), "Yes")
check("how did you hear in a big box is the saved source, not an essay (Clay)", isDefinitelyEssay({label:"How did you hear about us?", tag:"textarea", type:"textarea", multiline:true}), false)
check("a long question in a big box is still an essay", isDefinitelyEssay({label:"How did you hear about this role, and what drew you to apply?", tag:"textarea", type:"textarea", multiline:true}), true)
var commQ = {label:"Which of the following communities do you belong to? Please select all that apply.", type:"checkboxgroup", options:[{label:"Person with disability"},{label:"Neurodiverse"},{label:"Veteran"},{label:"Parent"},{label:"Refugee or immigrant"},{label:"None of the above"},{label:"I prefer not to answer"}]};
check("a communities list is an identity question (Clay)", isIdentityQuestion(commQ), true)
check("neurodiverse has its own key", matchField({label:"Do you identify as neurodiverse?", type:"radio", options:[{label:"Yes"},{label:"No"}]}).key, "demographics.neurodiverse")
check("a start month box is the start date (Coinbase)", matchField({label:"Start date month*", idAttr:"start-date-month-0", type:"text", combobox:true}).key, "employment.startDate")
check("a start year box too", matchField({label:"Start date year", idAttr:"start-date-year-0", type:"text"}).key, "employment.startDate")
check("an end year box is the end date, not the start (Coinbase)", matchField({label:"End date year", idAttr:"end-date-year-0", type:"text"}).key, "employment.endDate")
check("an end month box too", matchField({label:"End date month*", idAttr:"end-date-month-0", type:"text", combobox:true}).key, "employment.endDate")
check("a month list read without options is searched by the month's name (Coinbase)", resolveValue({label:"End date month*", combobox:true, type:"text"}, "employment.endDate", {employment:[{company:"Globex", endDate:"2026-07"}]}), "July")
check("a plain month box still gets digits", resolveValue({label:"End date month", type:"text"}, "employment.endDate", {employment:[{company:"Globex", endDate:"2026-07"}]}), "07")
var receiptQ = {label:"Please confirm receipt of the above linked Global Data Privacy Notice and US Arbitration Agreement.*", widget:"listbox", type:"text", options:[{label:"Confirmed"}]};
check("confirming receipt of a privacy notice follows the agreement setting (Coinbase)", matchField(receiptQ).key, "preferences.agreeToTerms")
check("and agreeing picks Confirmed", resolveValue(receiptQ, "preferences.agreeToTerms", {"preferences.agreeToTerms":"yes"}), "Confirmed")
check("a narrow none-of-these lead gives way to a real runner-up, as a guess (backlog: option-question-prompt-abstains)",
  JSON.stringify(settleOption(null, {choice:"__none__", confidence:0.5, label:null, runnerUp:{label:"Yes", confidence:0.42}}, 0.6, {label:"Did you graduate from high school?"})), JSON.stringify({value:"Yes", via:"guess"}))
check("a sure none stays empty", settleOption(null, {choice:"__none__", confidence:0.8, label:null, runnerUp:{label:"Yes", confidence:0.2}}, 0.6, {label:"Did you graduate from high school?"}).value, null)
check("a weak runner-up stays empty", settleOption(null, {choice:"__none__", confidence:0.6, label:null, runnerUp:{label:"Yes", confidence:0.2}}, 0.6, {label:"Office?"}).value, null)
check("never for a conditional question", settleOption(null, {choice:"__none__", confidence:0.5, label:null, runnerUp:{label:"Yes", confidence:0.45}}, 0.6, {label:"If so, were you a manager?"}).value, null)
check("a conditional question is not answered from a saved job (PG&E agency box)",
  conditionalRowValue({label:"If you served as an agency worker or consultant, please indicate your actual employer"}, "employment.company"), true);
check("but the company box is", conditionalRowValue({label:"Company Name"}, "employment.company"), false);
check("nor does it stop a conditional profile answer", conditionalRowValue({label:"If yes, what type of visa?"}, "authorization.visaType"), false);
check("a clear lead over the other options is a guess, though unsure it applies (Vitalize travel)",
  settleOption(null, Object.assign(readChoice({type:"choice", choice:"Yes", confidence:0.27, probabilities:{"Yes":0.51, "No":0.05, "__none__":0.44}}), {label:"Yes"}), 0.6, {label:"Are you able to meet this travel requirement?"}).via, "guess")
check("but not when the options are close", settleOption(null, Object.assign(readChoice({type:"choice", choice:"Yes", confidence:0.27, probabilities:{"Yes":0.4, "No":0.3, "__none__":0.3}}), {label:"Yes"}), 0.6, {label:"Office?"}).value, null)
check("the runner-up is read from the probabilities", JSON.stringify(readChoice({type:"choice", choice:"__none__", confidence:0.5, probabilities:{"__none__":0.5, "Yes":0.4, "No":0.1}}).runnerUp), JSON.stringify({choice:"Yes", confidence:0.4}))
check("a two-letter state box gets the abbreviation, not a cut name (backlog: CalCareers)", resolveValue({label:"State", type:"text", maxLength:2}, "address.state", {"address.state":"California"}), "CA")
check("a short box shortens at a word", resolveValue({label:"Current employer", type:"text", maxLength:12}, "work.currentCompany", {"work.currentCompany":"Globex Industrial Holdings"}).length <= 12, true)
check("a picker declaring MM/dd/yyyy gets that, with the saved day (backlog: CalCareers)", formatDate({datePicker:true, dateFormat:"{0:MM/dd/yyyy}"}, "2024/03/12"), "03/12/2024")
check("and the first of the month when no day is saved", formatDate({datePicker:true, dateFormat:"MM/dd/yyyy"}, "2023-07"), "07/01/2023")
check("a picker with no declared format is unchanged", formatDate({datePicker:true}, "2023-07"), "2023-07")
check("\"pronounce\" is not a pronoun question (Runway)", SENSITIVE_QUESTION.test("So we can pronounce it correctly, what is the phonetic spelling of your name?"), false)
check("pronouns still are", SENSITIVE_QUESTION.test("What are your preferred pronouns?"), true)
check("a country code is searched by its name in a suggestion list (ElevenLabs)", resolveValue({label:"Location", combobox:true, type:"text"}, "address.country", {"address.country":"US"}), "United States")
check("sexual orientation has its own key (Reddit)", matchField({label:"What sexual orientation do you most closely identify with? *", type:"radio", options:[{label:"Straight"},{label:"I prefer not to answer"}]}).key, "demographics.sexualOrientation")
check("transgender experience is not the gender question (Reddit)", matchField({label:"Are you a person of transgender experience? *", type:"radio", options:[{label:"Yes"},{label:"No"}]}).key, "demographics.transgender")
check("gender is still gender", matchField({label:"What gender identity do you most closely identify with?", type:"radio", options:[{label:"Male"},{label:"Female"}]}).key, "demographics.gender")
check("the option that declines is found", declineOption({options:[{label:"Gay"},{label:"Straight"},{label:"I prefer not to answer"}]}), "I prefer not to answer")
check("and in other words", declineOption({options:[{label:"Yes"},{label:"No"},{label:"I don't wish to answer"}]}), "I don't wish to answer")
check("a choice with no such option has none", declineOption({options:[{label:"Yes"},{label:"No"}]}), null)
check("an office named after its city is in that metro (Mercor)", metroOf("San Francisco HQ - 181 Fremont Street"), "bay area")
check("and New York City is New York", metroOf("New York City - 1 World Trade"), "new york")
var officeBoxes = [
  {id:"f8", type:"checkbox", label:"Which office are you applying to? (Select both if appropriate): San Francisco HQ - 181 Fremont Street", required:true},
  {id:"f9", type:"checkbox", label:"Which office are you applying to? (Select both if appropriate): New York City - 1 World Trade", required:true},
  {id:"f10", type:"checkbox", label:"I agree to the privacy policy"}];
var tg = tickGroups(officeBoxes);
check("two tick boxes under one question are one choice (Mercor)", tg.length + ":" + tg[0].options.map(function(o){return o.label}).join("|"), "1:San Francisco HQ - 181 Fremont Street|New York City - 1 World Trade")
check("the group asks the question", tg[0].label, "Which office are you applying to? (Select both if appropriate)")
check("a lone box is not a group", tg[0].tickBoxes.map(function(b){return b.field.id}).join(","), "f8,f9")
check("the office near home is chosen locally", nearestOffice(tg[0], {"address.city":"Oakland", "address.location":"Oakland, California"}), "San Francisco HQ - 181 Fremont Street")
check("no office near home is left to the model", nearestOffice(tg[0], {"address.city":"Denver"}), null)
check("boxes whose question asks nothing are not grouped", tickGroups([{id:"a", type:"checkbox", label:"Marketing emails: Weekly"}, {id:"b", type:"checkbox", label:"Marketing emails: Monthly"}]).length, 0)
recQ = {"label":"Interview Recording Consent", "type":"radio", "options":[{"label":"Yes, I consent to be recorded"},{"label":"Opt out of recording"}]}
check("a consent question asked as a choice follows the agreement setting", matchField(recQ).key, "preferences.agreeToTerms")
check("and agreeing picks the consenting option", resolveValue(recQ, "preferences.agreeToTerms", {"preferences.agreeToTerms":"yes"}), "Yes, I consent to be recorded")
check("and not agreeing leaves it to the user", resolveValue(recQ, "preferences.agreeToTerms", {"preferences.agreeToTerms":"no"}), null)
sentryQ = {"label":"I understand the information I submit will be used in accordance to Sentry's Applicant Privacy Policy.", "type":"radio", "options":[{"label":"I have read and acknowledge Sentry's Applicant Privacy Policy. "}]}
check("years of relevant work experience is the saved years (Rocket Lab)", (matchField({"label": "How many years of relevant work experience do you have (excluding internships)?*", "type": "text", "combobox": true}) || {}).key, "work.yearsExperience")
check("an empty portfolio is the personal website", profileValue({"links.website": "https://patbrien.example"}, "links.portfolio"), "https://patbrien.example")
check("currently interviewing at the employer is answered from phil's record, not guessed (MaintainX)", (appliedBeforeAnswer({"label": "Are you currently interviewing or actively being considered for a role at Autodesk?", "type": "radio", "options": [{"label": "Yes"}, {"label": "No"}]}, [], "MaintainX") || {}).value, "No")
check("how-heard with no match takes the company site, else Other (Whatnot)", [heardOption(["LinkedIn", "Company Website", "Other"]), heardOption(["BuiltIn", "Glassdoor", "LinkedIn", "Other"])].join("|"), "Company Website|Other")
check("how did you first hear is a how-heard question, answered by the careers page (Infinitus)", [HOW_HEARD.test("How did you first hear about this opportunity?"), heardOption(["Employee referral", "Infinitus careers page", "LinkedIn job post", "Other job board (Indeed, Glassdoor, etc.)", "Other"])].join("|"), "true|Infinitus careers page")
check("a posting's role section goes before a long company pitch (Nimble)", [roleFirst("About Nimble\n" + "robots ".repeat(120) + "\nThe Role\nAs a QA Engineer, you will test").indexOf("The Role"), roleFirst("The Role\nShort").indexOf("The Role")].join("|"), "0|0")
check("a box asking for GitHub or portfolio links gets both (1X)", [severalLinks({"label": "Please share links to GitHub, portfolio, publications, or hardware projects (if applicable).", "tag": "input", "type": "text"}, {"links.github": "https://github.com/patbrien", "links.website": "https://patbrien.example"}), severalLinks({"label": "GitHub", "tag": "input"}, {"links.github": "https://github.com/patbrien", "links.website": "https://patbrien.example"}), severalLinks({"label": "Links to GitHub, portfolio or hardware projects", "tag": "input", "type": "url"}, {"links.github": "https://github.com/patbrien", "links.website": "https://patbrien.example"})].join("|"), "https://github.com/patbrien, https://patbrien.example||https://patbrien.example")
check("a newsletter sign-up box beside the form is not the application (Saildrone)", [scopeKey({"label": "Enter your email", "type": "email", "section": "Stay informed with the latest research findings and updates."}, "contact.email").key, scopeKey({"label": "Email", "type": "text", "section": "Apply for this job"}, "contact.email").key].join("|"), "|contact.email")
check("a name beside a signature date is kept, the applicant signing (Velo3D)", dedupeAcrossSections([{id:"a", profileKey:"identity.fullName", section:"Submit your application", value:"Pat Brien"}, {id:"b", profileKey:"identity.fullName", section:"Disability status", value:"Pat Brien"}, {id:"c", profileKey:"preferences.todaysDate", section:"Disability status", value:"2026-10-25"}]).kept.length, 3)
var yn = [{"label": "Yes"}, {"label": "No"}];
check("travel up to 25% is yes at 25 and no at 10 (Tulip)", [travelAnswer({"label": "Are you able to travel up to 25%?*", "type": "radio", "options": yn}, {"preferences.maxTravelPercent": "25"}), travelAnswer({"label": "Are you able to travel up to 25%?*", "type": "radio", "options": yn}, {"preferences.maxTravelPercent": "10"})].join("|"), "Yes|No")
check("a travel range list gets the range holding the saved figure", travelAnswer({"label": "How much are you willing to travel?", "type": "select", "options": [{"label": "None"}, {"label": "0-25%"}, {"label": "25-50%"}, {"label": "50%+"}]}, {"preferences.maxTravelPercent": "30"}), "25-50%")
check("what percentage can you travel gets the number", travelAnswer({"label": "What percentage of the time can you travel?", "type": "text"}, {"preferences.maxTravelPercent": "25"}), "25%")
check("nothing saved, or a commute question, is not answered", [travelAnswer({"label": "Are you able to travel up to 25%?", "type": "radio", "options": yn}, {}), travelAnswer({"label": "How long is your travel time to the office?", "type": "text"}, {"preferences.maxTravelPercent": "25"})].join("|"), "|")
check("every country tick box the user may work in, from saved countries and citizenship (MATS)", authorizedCountriesAnswer({"label": "Please share all countries for which you have valid work authorization. *", "type": "checkboxgroup", "options": [{"label": "US"}, {"label": "UK"}, {"label": "EU"}, {"label": "Other"}]}, {"authorization.countriesAuthorized": "United States", "authorization.citizenship": "U.S. citizen and EU citizen"}), "US\nEU")
var part810 = {"label": "Are you a citizen of any country that is NOT included in the following list: Argentina, Australia, Austria, Belgium, Brazil, Bulgaria, Canada, Croatia, Cyprus, Czech Republic, Denmark, Estonia, Finland, France, Germany, Greece, Hungary, Indonesia, Ireland, Italy, Japan, Kazakhstan, the Republic of Korea, Latvia, Lithuania, Luxembourg, Malta, Mexico, Morocco, Netherlands, Norway, Poland, Portugal, Romania, Slovakia, Slovenia, South Africa, Spain, Sweden, Switzerland, Taiwan, Turkey, Ukraine, United Arab Emirates, United Kingdom, or Vietnam? *", "options": [{"label": "Yes, I am a citizen of a country that is NOT on the above list."}, {"label": "No, all of my countries of citizenship are on the above list."}, {"label": "U.S. Citizen only"}]};
check("a US and EU citizen's other citizenship is on an export-control list (Kairos Power)", citizenshipListAnswer(part810, {"authorization.citizenship": "U.S. citizen and EU citizen"}), "No, all of my countries of citizenship are on the above list.")
check("a US citizen only takes the US-only option", citizenshipListAnswer(part810, {"authorization.citizenship": "U.S. citizen"}), "U.S. Citizen only")
check("a citizenship off the list says so", citizenshipListAnswer(part810, {"authorization.citizenship": "United States, India"}), "Yes, I am a citizen of a country that is NOT on the above list.")
check("a country list on another question is not answered as work authorization", authorizedCountriesAnswer({"label": "Which country do you live in?", "type": "select", "options": [{"label": "US"}, {"label": "UK"}]}, {"authorization.countriesAuthorized": "United States"}), null)
check("a dropdown reading back its option value for the label written is not cleared (MATS phone country)", wasCleared({"type": "select", "currentValue": "US", "options": [{"value": "US", "label": "United States"}, {"value": "GB", "label": "United Kingdom"}]}, {"value": "United States"}), false)
check("a dropdown showing another option was cleared", wasCleared({"type": "select", "currentValue": "GB", "options": [{"value": "US", "label": "United States"}, {"value": "GB", "label": "United Kingdom"}]}, {"value": "United States"}), true)
check("a tick-box group holding every box written is not cleared (MATS countries)", [wasCleared({"type": "checkboxgroup", "currentValue": "US; EU", "options": [{"label": "US"}, {"label": "EU"}]}, {"value": "US\nEU"}), wasCleared({"type": "checkboxgroup", "currentValue": "US", "options": [{"label": "US"}, {"label": "EU"}]}, {"value": "US\nEU"})].join("|"), "false|true")
check("a one-line major box gets the major without the user's note (Workable)", resolveValue({"label": "Field of study", "tag": "input", "type": "text"}, "education.major", {"education": [{"school": "Lakeside College", "major": "Graphic Design (did not finish, 90 of 120 credits)"}]}), "Graphic Design")
check("a location box the page filled from the visitor's IP is not the user's answer", [JSON.stringify(guessedLocation({"label": "Address", "tag": "input", "currentValue": "San Francisco, United States of America"}, {"address.city": "Portland"})), JSON.stringify(guessedLocation({"label": "Address", "tag": "input", "currentValue": "Portland, OR, USA"}, {"address.city": "Portland"})), JSON.stringify(guessedLocation({"label": "Street address", "tag": "input", "currentValue": "12 Oak St, Apt 4"}, {"address.city": "Portland"}))].join("|"), '{"currentValue":""}|{}|{}')
var addrP = {"address.line1": "12 Elm St", "address.city": "Portland", "address.state": "Oregon", "address.postalCode": "97201"};
var addrQ = {"id": "a", "label": "What is your address?", "type": "text"};
check("an address box alone on the form gets the whole address (Voyager)", onlyAddressBox(addrQ, [addrQ, {"id": "b", "label": "Are you Hispanic/Latino?", "name": "hispanic_ethnicity"}]) ? oneLineAddress(addrP) : "", "12 Elm St, Portland, OR 97201")
check("one beside a city box keeps the street", onlyAddressBox(addrQ, [addrQ, {"id": "c", "label": "City"}]), false)
check("and a street box always does", onlyAddressBox({"id": "s", "label": "Street address"}, []), false)
var empP = {"employment": [{"company": "Globex"}, {"company": "Initech"}]};
check("worked for us before with no saved job there is No (Voyager)", workedHereAnswer({"label": "Have you previously worked for Acme or one of its subsidiaries? If so, when, which subsidiary, what position?", "type": "textarea"}, empP, "Acme Technologies, Inc."), "No")
check("as a choice it is the form's No", workedHereAnswer({"label": "Have you ever been employed by us?", "type": "radio", "options": yn}, empP, "Acme"), "No")
check("a saved job at the company is left to the model", workedHereAnswer({"label": "Have you previously worked for Globex?", "type": "textarea"}, empP, "Globex"), null)
check("worked with a tool is another question", workedHereAnswer({"label": "Have you worked with Salesforce?", "type": "radio", "options": yn}, empP, "Acme"), null)
var bgQ = matchField({"label": "Any offer of employment with Globex is contingent on a successful criminal background check and successful reference checks. Please indicate below if you can meet these hiring requirements*", "type": "text", "combobox": true})
check("a background check question is the saved background-check answer (Rocket Lab)", bgQ && bgQ.key, "screening.backgroundCheck")
var convQ = matchField({"label": "Have you been convicted of a felony? A conviction will not automatically bar you; a background check is required.", "type": "text"})
check("a conviction question is not", !!(convQ && convQ.key === "screening.backgroundCheck"), false)
var clearanceQ = {"label":"Active Security Clearance(s) *", "type":"checkboxgroup", "options":[{"label":"Top Secret"},{"label":"Secret"},{"label":"Other"},{"label":"Expired Clearance"},{"label":"Not Applicable"}]}
check("a saved No picks the option meaning none (Rocket Lab)", resolveValue(clearanceQ, "screening.securityClearance", {"screening.securityClearance":"No"}), "Not Applicable")
check("a plain No option is still No", resolveValue({"label":"Clearance?","type":"radio","options":[{"label":"Yes"},{"label":"No"},{"label":"Not Applicable"}]}, "screening.securityClearance", {"screening.securityClearance":"No"}), "No")
check("a one-option acknowledgement is chosen when agreeing (Sentry)", resolveValue(sentryQ, "preferences.agreeToTerms", {"preferences.agreeToTerms":"yes"}), "I have read and acknowledge Sentry's Applicant Privacy Policy. ")
check("a have-you-used question names its product (Sentry)", usedProduct({"label":"Have you ever used Sentry before?", "type":"radio", "options":[{"label":"Yes"},{"label":"No"}]}), "Sentry")
check("our product is the company's", usedProduct({"label":"Have you used our product?", "type":"radio", "options":[{"label":"Yes"},{"label":"No"}]}, {"company":"Globex"}), "Globex")
var tsQ = {"label":"We're always curious - have you used Tailscale before?*", "type":"text", "options":[{"label":"Yes, on my personal devices."},{"label":"Yes, at work."},{"label":"I haven\u2019t used it, but I\u2019m excited to learn more!"}]};
check("a lead-in before the question is skipped, and a worded no counts (Tailscale)", usedProduct(tsQ) + "|" + answerNo(tsQ), "Tailscale|I haven\u2019t used it, but I\u2019m excited to learn more!")
check("a typed-name attestation is the applicant signing (Cyberhaven)", dedupeAcrossSections([{id:"a", profileKey:"identity.fullName", section:"Name", value:"Pat Brien"}, {id:"b", profileKey:"identity.fullName", section:"Attestation", label:"By typing my name below, I confirm that the information provided is true", value:"Pat Brien"}]).kept.length, 2)
check("a phone's dial-code picker does not push the address Country out (Tailscale)", dedupeAcrossSections([{id:"p", profileKey:"address.country", value:"United States +1", section:"Phone"}, {id:"c", profileKey:"address.country", value:"US", section:"Address"}]).kept.length, 2)
check("a written question is not a yes/no one", usedProduct({"label":"Have you used Sentry before?", "type":"textarea"}), "")
check("a used product the resume names is found", mentions("Built dashboards with Sentry and Datadog at Globex", "Sentry"), true)
check("and one it does not name is not", mentions("Built dashboards with Datadog", "Sentry"), false)
check("not used is answered with the form's No", answerNo({"type":"radio", "options":[{"label":"Yes"},{"label":"No"}]}), "No")
check("a kind of work is not a named product: left to TypeSafe (Deepgram demos)", usedProduct({"label":"Have you built customer-facing demos or proof-of-concepts in previous roles?", "type":"radio", "options":[{"label":"Yes"},{"label":"No"}]}), "")
check("a named tool still is", usedProduct({"label":"Have you worked with Salesforce?", "type":"radio", "options":[{"label":"Yes"},{"label":"No"}]}), "Salesforce")
check("which the resume does not mention", mentions("Built dashboards for stakeholders", "customer-facing demos or proof-of-concepts in previous roles"), false)
check("filler words do not hide a mention", mentions("Ran Python services in production", "Python in a professional setting"), true)
check("a project counts as a mention", mentions(experienceText({"documents.resumeText":"Built dashboards at Globex", "projects":[{"name":"Pager bot", "description":"A Slack bot that reads Sentry alerts"}]}), "Sentry"), true)
var cvT = "Experience\n\u2022 Built a React web app for Acme's parts catalog, making lookups 63% faster\n\u2022 Developed a scheduling service for weekly pricing reports, cutting manual time by 42%\n\u2022 Led the move to Git by writing guides and training staff\nSkills\n";
check("resume bullets are read", resumeBullets(cvT).length, 3)
var leads = assignExamples([{id:"a", question:"Which programming languages, and what was the most complex application you built?"}, {id:"b", question:"Tell us about pricing work you automated"}, {id:"c", question:"How have you trained others?"}], cvT);
check("each written question gets its own lead example", new Set([leads.get("a"), leads.get("b"), leads.get("c")]).size, 3)
check("the best fitting one", /pricing/.test(leads.get("b")) && /Git/.test(leads.get("c")), true)
var fq = [{id:"a", question:"What's the most impactful thing you've built? What was your specific contribution?"}, {id:"b", question:"How did you know it worked? What did success actually look like?"}, {id:"c", question:"Why do you want to work here?"}];
var fl = assignExamples(fq, cvT);
check("a follow-up question shares the lead example of the question it follows (ElevenLabs)", fl.get("b") === fl.get("a") && !!fl.get("a"), true)
check("and the others still get their own", fl.get("c") !== fl.get("a"), true)
var rq = [{id:"a", question:"Describe the most impactful project you led in the last 6 months."}, {id:"b", question:"How do you use coding tools day to day?"}];
check("a question about the last 6 months leads with this year's project (WorkOS)", /Globex/.test(assignExamples(rq, cvT, ["Globex tracker (2026): built a parts tracker"], {year: 2026}).get("a")), true)
var fr = repeatedSentences([
  {id:"a", answer:"I built a web app that made lookups 63% faster. It also lifted orders 250%. I wrote the backend."},
  {id:"b", answer:"Lookups got 63% faster within a month. Buyers stopped asking for manual reports. Orders rose 250%."}],
  [{id:"a", question:"What's the most impactful thing you've built?", leadExample:"Web app making lookups 63% faster and orders 250% higher"}, {id:"b", question:"How did you know it worked?", leadExample:"Web app making lookups 63% faster and orders 250% higher"}]);
check("a follow-up may tell the figures of the answer it continues (ElevenLabs)", fr.has("b"), false)
check("pointing back is recognised", continuesPrevious("How did you know it worked?") && !continuesPrevious("What drew you to this role?"), true)
check("intensifiers are taken out", plainer("The product is an API developers actually build on. Actually, I like it. It works, truly."), "The product is an API developers build on. I like it. It works.")
check("machine-writing tells are found", aiTells("Speech is a messy problem, and that is the kind of challenge I want. I like turning complexity into something a customer can use on day one. I built a pricing tool in Python.").map(function(x){return x.tell}).join("|"), '"the kind of"|"day one"|stock phrase|invented preference or colour')
check("a colon and a list of three phrases are tells (user, ElevenLabs)", aiTells("The role feels close to what Forward Deployed Engineers do: sitting between a product and a customer's real workflows, making integration work, and turning manual steps into reliable systems.").map(function(x){return x.tell}).join("|"), "colon|list of three phrases")
check("a short list of tools is not", aiTells("I used Python, SQL, and Tableau at Globex.").length, 0)
check("three short clauses in a row are a tell (Tailscale)", aiTells("Find the bottleneck, build the tool, remove the manual step.").map(function(x){return x.tell}).join("|"), "three-beat fragment")
check("a before a vowel becomes an, but not before a one or a user", plainer("It is a infrastructure problem, a one-off, a user tool, a Ashby form."), "It is an infrastructure problem, a one-off, a user tool, an Ashby form.")
check("a capital A mid-sentence is left alone", plainer("I got grade A in maths. A ERP sync ran daily."), "I got grade A in maths. An ERP sync ran daily.")
check("what draws me is the drawn-to phrase again (TypeSafe)", aiTells("The aim of making models dependable is what draws me to Globex.").map(function(x){return x.tell}).join("|"), "stock phrase")
check("WhatsApp consent is text-message consent, not terms (Ramp)", (matchField({"label": "Check Yes or No to indicate your agreement to receive text message updates via SMS and/or WhatsApp", "name": "whatsAppConsent", "type": "radio"}) || {}).key, "contact.textConsent")
check("a claimed hardship and an I'd-bring closer are tells (Parafin)", aiTells("I know how hard it is for small businesses to get fair financial tools. I'd bring the ability to automate.").map(function(x){return x.tell}).join("|"), "claimed first-hand knowledge|closer about what I would bring")
check("but a sentence listing tools is not", aiTells("Python, SQL and Airflow, mostly.").length, 0)
check("a time is not a colon tell", aiTells("The report ran at 9:30 every morning.").length, 0)
check("\"real\" as emphasis is taken out, fixed phrases stay (user)", plainer("I built tools for real customers in real time. Real problems need real estate data."), "I built tools for customers in real time. Problems need real estate data.")
check("plain sentences have none", aiTells("I built a pricing tool in Python. It cut manual work by 42%.").length, 0)
check("restating the ad, a judging closer and running down a past job are tells (Sesame)", aiTells("The role asks for someone to stand up automated testing. That's concrete and measurable. I'd rather own the testbed than maintain dashboards for Globex.").map(function(x){return x.tell}).join("|"), 'restating the ad|closer that names the point|contrast ("not just X", "X rather than Y")|invented preference or colour')
check('"exactly the kind of hardware I like" is a tell (Sesame)', aiTells("That's exactly the kind of hardware I like to work on.").map(function(x){return x.tell}).join("|"), '"the kind of"|closer that names the point')
check("a staged contrast and an invented preference are tells (Relativity)", aiTells("That's a different problem from bolting tools onto an existing factory. I'd rather help shape the systems while the factory is still taking form.").map(function(x){return x.tell}).join("|"), 'contrast ("not just X", "X rather than Y")|invented preference or colour')
check('"is why X appeals to me" and "the ownership I like" are tells (Relativity, Sesame)', aiTells("The chance to automate workflows is why Globex appeals to me. This role has the ownership I like.").map(function(x){return x.tell}).join("|"), 'closer that names the point|invented preference or colour')
check("why-us questions are found", ["Why Sesame?", "What excites you about Deepgram?", "Tell us about your interest in working at SafelyYou.", "Why do you want to join Globex?", "Tell us a bit about why you're applying to work here. What excited you about this role?"].map(isWhyUs).join(","), "true,true,true,true,true")
check("other why questions are not", ["Why did you leave your last job?", "Describe a hardware automation system you built.", "Why is there a gap in your employment?"].map(isWhyUs).join(","), "false,false,false")
check("a role sentence that is not a retelling is not", aiTells("The role is in Portland, where I live.").length, 0)
var relDraft = "I want to work on systems that support building something tangible, and Globex is building a rocket factory. At Acme I built tools that made sourcing 97% faster. I've spent years automating manual work and integrating systems, which is the core of this role.";
check("an edit that trims the draft is its own words", fromDraft("I want to work on systems that support building something tangible.", relDraft), true)
check("an edit that adds a sentence is not (Relativity)", fromDraft("Working alongside the people who run production, on systems they depend on every day, is the part of this role I keep coming back to.", relDraft), false)
check("nor one that grows a sentence with new facts", fromDraft("I've spent years automating manual work and integrating systems, including wiring a finance tool directly into the Exact ERP with the ERP vendor and finance team.", relDraft), false)
check("a sentence left with a tell is cut", withoutTells("I built a pricing tool. It cut manual work by 42%. That's a hard problem to solve well."), "I built a pricing tool. It cut manual work by 42%.")
var dd = repeatedSentences([
  {id:"why", answer:"I built a web app that made lookups 63% faster. Voice data is a messy problem. I want to work on it."},
  {id:"lang", answer:"I used Python and SQL to cut manual time by 42%. The most complex app made lookups 63% faster and lifted orders 250%."}],
  [{id:"why", question:"Why us?", leadExample:"Scheduling service cutting manual time by 42%"}, {id:"lang", question:"Languages?", leadExample:"Web app making lookups 63% faster and orders 250% higher"}]);
check("a figure is told once, by the answer it was given to", JSON.stringify(dd.get("why")), JSON.stringify(["I built a web app that made lookups 63% faster."]))
check("an answer's own figures stay, even one lent to another question it never used", dd.has("lang"), false)
bayQ = {"label":"Are you located in the San Francisco Bay Area?", "type":"radio", "options":[{"label":"Yes"},{"label":"No"}]}
check("Oakland is in the Bay Area (Deepgram)", locatedInAnswer(bayQ, {"address.city":"Oakland"}), "Yes")
check("Denver is not", locatedInAnswer(bayQ, {"address.city":"Denver"}), "No")
check("a metro the table does not know is left to the model", locatedInAnswer({"label":"Are you located in Tulsa?", "type":"radio", "options":[{"label":"Yes"},{"label":"No"}]}, {"address.city":"Oakland"}), null)
check("greater ... area is the metro", locatedInAnswer({"label":"Are you based in the greater Seattle area?", "type":"radio", "options":[{"label":"Yes"},{"label":"No"}]}, {"address.city":"Seattle"}), "Yes")
check("compensation expectations is a salary question, not a demographic one (Fireworks)", matchField({"type":"number", "label":"Do you have any initial compensation expectations?"}).key, "compensation.desired")
check("pay: the bottom of a posted range", lowestPay("Compensation $180K \u2013 $240K \u2022 Offers Equity"), "180,000")
check("pay: a range with one unit", lowestPay("$180 - 240k"), "180,000")
check("pay: a bonus or stipend is not salary", lowestPay("We offer a $20,000 relocation package and a $120,000-$160,000 base. Plus a $15,000 signing bonus"), "120,000")
check("pay: funding is not salary", lowestPay("We raised $50,000,000 in funding. Salary: $140,000"), "140,000")
check("pay: none posted", lowestPay("We have $30,000 of customers and pay $45/hour"), "")
check("a number box gets digits only", resolveValue({"type":"number", "label":"Expected salary"}, "compensation.desired", {"compensation.desired":"$180,000"}), "180000")
check("a text box keeps the figure", resolveValue({"type":"text", "label":"Expected salary"}, "compensation.desired", {"compensation.desired":"180,000"}), "180,000")
var oct18 = new Date(2026, 9, 18);
check("a picker showing today shows its own default (Ashby)", showsToday("10/18/2026", oct18), true)
check("in any order", showsToday("2026-10-18", oct18) && showsToday("18/10/2026", oct18) && showsToday("Oct 18, 2026", oct18), true)
check("another date is an answer", showsToday("11/02/2026", oct18), false)
check("the start-date rule reads a hyphen (Fireworks)", matchField({"type":"text", "label":"If offered a position, what is your ideal start-date?"}).key, "preferences.availableStartDate")
check("an office in the user's metro is chosen", resolveValue(officesQ, "address.location", {"address.city":"Oakland","address.state":"California"}), "San Mateo, CA")
check("and none when no office is near", resolveValue(officesQ, "address.location", {"address.city":"Denver","address.state":"Colorado"}), null)
check("relocation is still relocation", matchField({label:"Are you willing to relocate to Portland?"}).key, "preferences.willingToRelocate");
check("a pronoun question relabelled by its description is still pronouns",
  matchField({label:"Let us know how you'd like to be addressed.", extractedLabel:"Preferred Pronouns", type:"radio"}).key, "identity.pronouns");

// --- identity questions -------------------------------------------------------
check("a race box labelled only by its option, under a race heading, is an identity question",
  isIdentityQuestion({type:"checkbox", label:"European", section:"Ethnicity and Race Identification › Step 6 of 6"}), true);
check("an unlabelled dropdown of genders is one",
  isIdentityQuestion({tag:"select", label:"", options:[{label:"Man"},{label:"Woman"},{label:"Non-binary"}]}), true);
check("so is an Age group on an EEO page", isIdentityQuestion({type:"radio", label:"Age", options:[{label:"21 - 39"}]}), true);
check("and a Sexual Orientation text box", isIdentityQuestion({type:"text", label:"Sexual Orientation"}), true);
check("but not 'at least 18 years of age'", isIdentityQuestion({type:"radio", label:"Are you at least 18 years of age?", options:[{label:"Yes"},{label:"No"}]}), false);
check("nor the terms box on a self-identification page",
  isIdentityQuestion({type:"checkbox", label:"I agree to the terms and conditions", section:"Voluntary Self-Identification"}), false);
check("nor the Name box on a self-identification page", isIdentityQuestion({type:"text", label:"Name", section:"Self-Identification of Disability"}), false);
check("a saved custom answer about identity is sensitive",
  customFields({custom:[{id:"a", question:"Yes, I identify as LGBTQ+.", answer:"yes"}]})[0].sensitive, true);
check("an ordinary saved answer is not",
  customFields({custom:[{id:"b", question:"Do you have a driving licence?", answer:"yes"}]})[0].sensitive, undefined);

// --- the wallet -------------------------------------------------------------
var w = newWallet();
for (var i = 0; i < 10; i++) w = settleFill(w, {appKey: "acme.example/jobs/" + i, costCents: 0.3, filled: 4}).wallet;
check("ten applications are free", [w.freeLeft, w.balanceCents].join(","), "0,0");
check("then nothing can start with no money", canStart(w, "acme.example/jobs/new").allowed, false);
check("except a later page of a free application", canStart(w, "acme.example/jobs/3").allowed, true);
w = reload(w, 500);
var paid = settleFill(w, {appKey: "acme.example/jobs/new", costCents: 0.27, filled: 6});
check("after them a fill costs three times what it used", [paid.charge.free, paid.charge.cents, paid.wallet.balanceCents].join(","), "false,0.81,499.19");
check("never more than the cap", priceOf(500), PRICE_CAP_CENTS);
check("a fill that filled nothing costs nothing", settleFill(w, {appKey: "x", costCents: 2, filled: 0}).charge.cents, 0);
var small = (function () { try { reload(w, 300); return "allowed"; } catch (e) { return "refused"; } })();
check("a reload under $5 is refused", small, "refused");

check("a fill the next day adds a day to the streak",
  JSON.stringify(nextStreak({days:2, last:"2026-02-28"}, "2026-03-01")), JSON.stringify({days:3, last:"2026-03-01"}));
check("a second fill the same day does not",
  nextStreak({days:2, last:"2026-03-01"}, "2026-03-01").days, 2);
check("a day missed starts the streak again",
  nextStreak({days:9, last:"2026-03-01"}, "2026-03-03").days, 1);
check("a streak is still alive the day after its last fill, and gone the day after that",
  [currentStreak({days:4, last:"2026-03-01"}, "2026-03-02"), currentStreak({days:4, last:"2026-03-01"}, "2026-03-03")].join(","), "4,0");

var wdJob = "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Portland-OR/Data-Engineer_R0147";
check("every page of a Workday application is one application",
  applicationKey(wdJob + "/apply/autofillWithResume?source=LinkedIn") === applicationKey(wdJob + "/apply/applyManually"), true);
check("two jobs on one Workday site are two applications",
  applicationKey(wdJob + "/apply") === applicationKey(wdJob.replace("R0147", "R0200") + "/apply"), false);
check("a Lever job and its apply page are one application",
  applicationKey("https://jobs.lever.co/globex/1a2b-3c4d") === applicationKey("https://jobs.lever.co/globex/1a2b-3c4d/apply?lever-source=x"), true);
check("a job named in the query stays apart from another",
  applicationKey("https://globex.taleo.net/careersection/jobapply.ftl?job=101&step=2") ===
  applicationKey("https://globex.taleo.net/careersection/jobapply.ftl?job=102&step=2"), false);
check("and its steps stay together",
  applicationKey("https://globex.taleo.net/careersection/jobapply.ftl?job=101&step=2") ===
  applicationKey("https://globex.taleo.net/careersection/jobapply.ftl?step=3&job=101"), true);

// --- references ---------------------------------------------------------------
var refProfile = {"identity.fullName": "Pat Brien", "contact.phone": "555-0000",
  references: [
    {fullName: "Alice Ng", relationship: "Former manager", company: "Acme", phone: "415-555-0101", email: "alice@acme.test"},
    {fullName: "Bob Diaz", relationship: "Colleague", phone: "415-555-0102"},
    {fullName: "Cara Li Wong", relationship: "Professor", phone: "415-555-0103"}
  ]};
function refField(label, extra) { var f = {label: label, section: "References", scope: "reference"}; for (var k in (extra||{})) f[k] = extra[k]; return f; }
check("a reference's Name is the reference's name, not yours",
  scopeKey(refField("Name"), "identity.fullName").key, "references.fullName");
check("a reference's Phone is the reference's phone",
  scopeKey(refField("Phone"), "contact.phone").key, "references.phone");
check("a reference's Company is the reference's company",
  scopeKey(refField("Company"), "work.currentCompany").key, "references.company");
check("your address never goes in a references block",
  scopeKey(refField("City"), "address.city").key, null);
check("an emergency contact's Relationship is not a reference's",
  scopeKey({label:"Relationship", section:"Emergency contact", scope:"emergency"}, "references.relationship").key, null);
check("a reference key outside a references block is refused",
  scopeKey({label:"Relationship", scope:"unknown"}, "references.relationship").key, null);
check("Relationship matches its rule", matchField({label:"Relationship to you"}).key, "references.relationship");
check("How long known matches its rule", matchField({label:"How long have you known this person?"}).key, "references.yearsKnown");
check("the second reference's first name comes from its full name",
  profileValue(refProfile, "references.firstName", {repeatIndex: 1}), "Bob");
check("a last name keeps every word after the first",
  profileValue(refProfile, "references.lastName", {repeatIndex: 2}), "Li Wong");
check("references keep the order they were typed", listEntries(refProfile, "references")[2].fullName, "Cara Li Wong");

function refIdx(fields, used, text) {
  return pickListEntries(fields, text || "", refProfile, used || {}).map(function(f){ return f.repeatIndex; }).join(",");
}
var oneBlock = [refField("Name", {id:"a"}), refField("Phone", {id:"b"})];
check("a single reference block starts with the first reference", refIdx(oneBlock), ",");
check("once the first was given on this site, the next form gets the second",
  refIdx(oneBlock, {references:[0]}), "1,1");
check("and the one after that gets the third", refIdx(oneBlock, {references:[0,1]}), "2,2");
check("a reference whose name is already on the page is passed over",
  refIdx(oneBlock, {}, "References added: Alice Ng"), "1,1");
check("with every reference given, it starts again at the first",
  refIdx(oneBlock, {references:[0,1,2]}), ",");
var threeBlocks = [refField("Name",{id:"a"}), refField("Phone",{id:"b"}), refField("Name",{id:"c"}), refField("Phone",{id:"d"}),
  refField("Name",{id:"e"}), refField("Phone",{id:"f"})];
check("three unnumbered reference blocks take three references", refIdx(threeBlocks), "0,0,1,1,2,2");
check("three blocks after one given take the next ones, then run out",
  refIdx(threeBlocks, {references:[0]}), "1,1,2,2,3,3");
var numbered = [refField("Name",{id:"a", repeatRaw:1}), refField("Name",{id:"b", repeatRaw:2})];
check("numbered reference blocks keep their numbering",
  pickListEntries(normaliseRepeats(numbered), "", refProfile, {references:[0]}).map(function(f){ return f.repeatIndex; }).join(","), "0,1");
check("the rest of the form is untouched by reference choice",
  pickListEntries([{id:"x", label:"Email", scope:"personal"}].concat(oneBlock), "", refProfile, {references:[0]})[0].repeatIndex, undefined);

// --- identity across passes -------------------------------------------------
check("a field keeps its identity when renumbered",
  fieldIdentity({id:"f2", idAttr:"email", label:"Email"}), fieldIdentity({id:"f9", idAttr:"email", label:"Email"}));
check("frames separate identical fields",
  fieldIdentity({idAttr:"email", label:"Email"}) === fieldIdentity({idAttr:"email", label:"Email", frameId:4}), false);

// --- defaults ------------------------------------------------------------
check("typesafe is the default engine", DEFAULT_SETTINGS.classifier, "typesafe");
check("confidence gate has a default", DEFAULT_SETTINGS.classifierConfidence, 0.6);
check("typesafe model is the stable alias", DEFAULT_SETTINGS.typesafeModel, "jev-latest");
check("every offered typesafe model is real",
  TYPESAFE_MODELS.every(function(m){ return m.id === "jev-latest" || m.id === "jev-preview"; }), true);
check("batching stays under the context limit", TOKEN_BUDGET_PER_CALL <= 50000, true);

// --- inferred fields -----------------------------------------------------
var nameProfile = {"identity.firstName":"Pat","identity.middleName":"J","identity.lastName":"Brien"};
check("full name is inferred", profileValue(nameProfile, "identity.fullName"), "Pat J Brien");
check("inferred value is offered to the UI", inferredValue(nameProfile, "identity.fullName"), "Pat J Brien");
check("a typed value wins over the inferred one",
  profileValue({"identity.firstName":"Pat","identity.lastName":"Brien","identity.fullName":"P. Brien"}, "identity.fullName"),
  "P. Brien");
check("a typed value hides the placeholder",
  inferredValue({"identity.firstName":"Pat","identity.lastName":"Brien","identity.fullName":"P. Brien"}, "identity.fullName"), "");
check("no name means nothing inferred", inferredValue({}, "identity.fullName"), "");

// --- conditional fields ---------------------------------------------------
check("non-compete industry is hidden by default",
  isFieldActive({}, "preferences.nonCompeteIndustry"), false);
check("non-compete industry appears on yes",
  isFieldActive({"preferences.nonCompete":"yes"}, "preferences.nonCompeteIndustry"), true);
check("non-compete industry stays hidden on no",
  isFieldActive({"preferences.nonCompete":"no"}, "preferences.nonCompeteIndustry"), false);
check("an ordinary field is always active", isFieldActive({}, "contact.email"), true);
check("an inactive field is not offered as available",
  filledKeys({"preferences.nonCompeteIndustry":"Finance"}).indexOf("preferences.nonCompeteIndustry"), -1);

// --- employment history ---------------------------------------------------
var empProfile = {employment:[
  {company:"Globex", title:"Senior Engineer", startDate:"2019"},
  {company:"Initech", title:"Engineer", startDate:"2016"},
  {company:"Umbrella", title:"Junior", startDate:"2014"}
]};
check("current employer reads the most recent job",
  profileValue(empProfile, "work.currentCompany"), "Globex");
check("repeating key defaults to the first entry",
  profileValue(empProfile, "employment.company"), "Globex");
check("repeating key follows the repeat index",
  profileValue(empProfile, "employment.company", {repeatIndex:1}), "Initech");
check("third entry resolves",
  profileValue(empProfile, "employment.title", {repeatIndex:2}), "Junior");
check("a missing entry yields nothing",
  profileValue(empProfile, "employment.company", {repeatIndex:9}), "");
check("empty entries are not counted", employmentEntries({employment:[{company:"A"},{},{company:""}]}).length, 1);
check("unemployed still has a most recent employer",
  profileValue({"work.employmentStatus":"Not currently employed", employment:[{company:"Globex"}]}, "work.currentCompany"),
  "Globex");

// --- repeat index normalisation -------------------------------------------
function idx(fields) { return normaliseRepeats(fields).map(function(f){ return f.repeatIndex; }); }
check("zero-based form stays as written",
  JSON.stringify(idx([{repeatRaw:0},{repeatRaw:1},{repeatRaw:2}])), "[0,1,2]");
check("one-based form is shifted down",
  JSON.stringify(idx([{repeatRaw:1},{repeatRaw:2},{repeatRaw:3}])), "[0,1,2]");
check("ordinal words normalise the same way",
  JSON.stringify(idx([{repeatRaw:1},{repeatRaw:2}])), "[0,1]");
check("Workday's id counters number each kind of block in page order (Accenture)",
  JSON.stringify(idx([{repeatRaw:4,repeatGroup:"workexperience"},{repeatRaw:15,repeatGroup:"workexperience"},{repeatRaw:66,repeatGroup:"workexperience"},
    {repeatRaw:91,repeatGroup:"education"},{repeatRaw:92,repeatGroup:"education"},{repeatRaw:1}])), "[0,1,2,0,1,0]");
check("a Workday 'Month' under 'To' is the job's end date",
  scopeKey({label:"Month", section:"To* › Work Experience 1", scope:"employment", idAttr:"workExperience-4--endDate-dateSectionMonth-input"}, "employment.startDate").key, "employment.endDate");
check("and one under 'From' its start date",
  scopeKey({label:"Month", section:"From* › Work Experience 1", scope:"employment", idAttr:"workExperience-4--startDate-dateSectionMonth-input"}, "employment.startDate").key, "employment.startDate");
check("blocks a form does not number are counted by a repeated question",
  blockCounts([{label:"Employer", section:"Employment History"},{label:"Job title", section:"Employment History"},
    {label:"Employer", section:"Employment History"},{label:"Job title", section:"Employment History"}]).employment, 2);
check("and a list with no boxes on the page has none",
  blockCounts([{label:"Email"}]).education, 0);
check("a major the list lacks gets its closest option",
  closestLabel(["Accounting", "Computer Science and Information Technology", "Computer Science", "Design"], "Computer Science & Game Design"), "Computer Science");
check("and nothing when no option shares half its words",
  closestLabel(["Accounting", "Biology"], "Computer Science & Game Design"), null);
check("a shared \"University\" alone is not a match (Lyft: Aalborg University for University of Portland)",
  closestLabel(["Aalborg University", "Aalto University", "Aarhus University"], "University of Portland"), null);
check("a long list of majors holding a few identity-sounding studies is not an identity question (Lyft)",
  isIdentityQuestion({label:"Discipline*", options:["Accounting","African Studies","Asian Studies","Biology","Computer Science","Design","Economics","English","General Studies","History","Mathematics","Physics"].map(l=>({label:l}))}), false);
check("a short gender list given away by its options still is",
  isIdentityQuestion({label:"", options:[{label:"Male"},{label:"Female"},{label:"Decline To Self Identify"}]}), true);
check("an experience question asking what you solved is not a test (Xaira)",
  isChallenge({label:"Please describe the most complex robotics or automation system you have personally built, integrated, or debugged. What hardware and software were involved, and what problems did you solve?"}), false);
check("a puzzle asking to solve this still is", isChallenge({label:"Solve the following: what is the output of the code below?"}), true);
check("an option the saved major names in full is the saved answer (Lyft: General Studies, not Computer Science)",
  namedOption(["Computer Science", "General Studies", "Information Systems"], "General Studies (Associate of Arts, Direct Transfer Agreement)"), "General Studies");
check("and the most specific one when several are named",
  namedOption(["Computer Science", "Computer Science and Game Design", "Design"], "Computer Science and Game Design"), "Computer Science and Game Design");
var czQ = {label:"Have you applied to or interviewed with any organization(s) within the Chan Zuckerberg Science ecosystem in the past?*", options:[{label:"Yes"},{label:"No"}]};
check("applied before: no fill for this company is No, outlined (CZI)", JSON.stringify(appliedBeforeAnswer(czQ, [{company:"Globex", url:"https://x/1"}], "Chan Zuckerberg Initiative", "https://y/2")), JSON.stringify({value:"No", thin:true}));
check("and an earlier fill for it is Yes", appliedBeforeAnswer(czQ, [{company:"Chan Zuckerberg Initiative", url:"https://x/1"}], "Chan Zuckerberg Initiative", "https://y/2").value, "Yes");
check("but not this same page filled again", appliedBeforeAnswer(czQ, [{company:"Chan Zuckerberg Initiative", url:"https://y/2"}], "Chan Zuckerberg Initiative", "https://y/2").value, "No");
check("other questions are left alone", appliedBeforeAnswer({label:"Have you worked here before?", options:[{label:"Yes"},{label:"No"}]}, [], "Acme"), null);
check("the major named first wins when two are named",
  namedOption(["Art History", "Graphic Design"], "Graphic Design (Art History coursework)"), "Graphic Design");
check("a shared word alone names nothing",
  namedOption(["Graphic Design", "Interaction Design"], "Interactive Media Design"), null);
check("a school left without a degree goes after the one that gave a degree (single Degree block, Lyft)",
  listEntries({education:[{school:"Portland State University", degree:"", endYear:"2020"}, {school:"Riverbend College", degree:"Associates Degree", endYear:"2016"}]}, "education")[0].school, "Riverbend College");
check("the school's own name still finds its longer entry",
  closestLabel(["Lakeview College", "Lakeside Community College"], "Lakeside College"), "Lakeside Community College");
check("fields with no index default to the first entry",
  JSON.stringify(idx([{},{repeatRaw:null}])), "[0,0]");

// --- lenient import -------------------------------------------------------
function imported(payload, current) {
  return prepareImport(payload, {currentProfile: current || {}, currentSettings: {}});
}
var partial = imported({version:2, data:{profile:{
  "contact.email":"pat@example.com", "address.city":"San Francisco", "links.github":"https://gh/pat"}}});
check("a partial profile imports", partial.report.matched, 3);
check("only the profile is touched", partial.imported.length, 1);

// Fields this version does not know are reported, not silently dropped.
var mixed = imported({version:2, data:{profile:{
  "contact.email":"pat@example.com", "legacy.favouriteColour":"blue", "another.unknown":"x"}}});
check("known fields still land", mixed.incoming.profile["contact.email"], "pat@example.com");
check("unknown fields are reported", mixed.report.unknown.length, 2);
check("unknown fields are not written", mixed.incoming.profile["legacy.favouriteColour"], undefined);

// A file holding only an address must not wipe the rest of the profile.
var kept = imported({version:2, data:{profile:{"address.city":"Leeds"}}},
                    {"contact.email":"pat@example.com","identity.firstName":"Pat"});
check("import merges rather than replaces", kept.incoming.profile["contact.email"], "pat@example.com");
check("import applies the new value", kept.incoming.profile["address.city"], "Leeds");

// A bare profile with no wrapper is still accepted.
var bare = imported({"contact.email":"pat@example.com","identity.firstName":"Pat"});
check("a bare profile file imports", bare.report.matched, 2);

var emp = imported({version:2, data:{profile:{employment:[{company:"Globex", title:"Eng", junk:"x"}]}}});
check("employment history imports", emp.incoming.profile.employment[0].company, "Globex");
check("unknown entry keys are dropped", emp.incoming.profile.employment[0].junk, undefined);

function rejectsImport(name, payload) {
  var threw = false;
  try { imported(payload); } catch (e) { threw = true; }
  check(name, threw, true);
}
rejectsImport("rejects a file with nothing recognisable", {version:2, data:{}});
rejectsImport("rejects a non-object", null);
rejectsImport("rejects a future format", {version:99, data:{profile:{}}});

// --- site skills record everything ---------------------------------------
var observed = learnFromRun({fields:{}}, [
  {fieldKey:"a", label:"First Name", kind:"profile", profileKey:"identity.firstName", ok:true},
  {fieldKey:"b", label:"Veteran status", kind:"unresolved", ok:false, reason:"No confident match"},
  {fieldKey:"c", label:"Cover letter", kind:"long", ok:true}
]);
check("every field is recorded, not just the filled ones",
  Object.keys(observed.fields).length, 3);
check("an unfilled field is recorded as unresolved", observed.fields["b"].kind, "unresolved");
check("the reason is kept for the editor", observed.fields["b"].lastReason, "No confident match");
check("a filled field counts a confirmation", observed.fields["a"].confirms, 1);
check("an unfilled field counts a miss", observed.fields["b"].misses, 1);
check("an unfilled field earns no confirmation", observed.fields["b"].confirms, 0);

var lockedSkill = {fields:{a:{kind:"profile", profileKey:"identity.lastName", locked:true, confirms:3}}};
var relearned = learnFromRun(lockedSkill, [
  {fieldKey:"a", label:"First Name", kind:"profile", profileKey:"identity.firstName", ok:true}]);
check("a correction survives a later run", relearned.fields["a"].profileKey, "identity.lastName");
check("the outcome still updates", relearned.fields["a"].lastOutcome, "filled");

// --- sharing a skill ------------------------------------------------------
var shareable = exportSkill({site:"boards.greenhouse.io", notes:"n", fields:{
  a:{kind:"profile", profileKey:"identity.firstName", label:"First Name", confirms:9},
  b:{kind:"unresolved", label:"Mystery"}
}});
check("a shared skill carries its mappings", Object.keys(shareable.fields).length, 1);
check("unresolved fields are not shared", shareable.fields["b"], undefined);
check("a shared skill names its site", shareable.site, "boards.greenhouse.io");
check("a shared skill carries no timings", shareable.stats, undefined);

var adopted = importSkill({site:"x", fields:{a:{kind:"profile", profileKey:"identity.lastName", locked:true}}}, shareable);
check("a shared skill does not overwrite a local correction",
  adopted.skill.fields["a"].profileKey, "identity.lastName");
check("the kept correction is counted", adopted.kept, 1);

var fresh = importSkill(null, shareable);
check("a shared skill installs on a new site", fresh.added, 1);
check("an adopted mapping is marked shared", fresh.skill.fields["a"].shared, true);

var badShare = false;
try { importSkill(null, {kind:"not-a-skill"}); } catch (e) { badShare = true; }
check("a file that is not a skill is rejected", badShare, true);

// --- settings defaults ----------------------------------------------------
check("demographics are answered by default", DEFAULT_SETTINGS.fillDemographics, true);
check("employment history fills every block by default", DEFAULT_SETTINGS.fillEmploymentHistory, "all");
check("documents attach by default", DEFAULT_SETTINGS.attachDocuments, true);

// --- saved responses, local pass -----------------------------------------
var lib = [
  {id:"r1", name:"Why this company", enabled:true,
   triggers:"why do you want to work\nwhy are you interested",
   text:"I admire {{company}} and the {{role}} role fits what I do."},
  {id:"r2", name:"Anything else", enabled:true, triggers:"anything else", text:"Nothing further."},
  {id:"r3", name:"Disabled one", enabled:false, triggers:"why do you want to work", text:"Should never be used."},
  {id:"r4", name:"Empty one", enabled:true, triggers:"salary history", text:"   "}
];
function matched(label) {
  var hit = matchResponseLocally({label: label}, lib);
  return hit ? hit.response.id : null;
}
check("matches a listed phrase", matched("Why do you want to work at Acme?"), "r1");
check("matches the second response", matched("Is there anything else we should know?"), "r2");
check("unrelated question matches nothing", matched("What is your postal code?"), null);
check("empty label matches nothing", matched(""), null);
check("paraphrase is left to the model", matched("What draws you to this organisation?"), null);
check("word overlap alone does not decide",
  matchResponseLocally({label:"Why do you think anything matters?"}, lib), null);
check("a short listed phrase clears the bar",
  scoreResponse(lib[1], "Is there anything else we should know?") >= LOCAL_ACCEPT, true);
check("disabled response is skipped",
  matchResponseLocally({label:"Why do you want to work here?"}, [lib[2]]), null);
check("empty response is skipped",
  matchResponseLocally({label:"What is your salary history?"}, [lib[3]]), null);

// --- what the model is shown ---------------------------------------------
var described = describeForModel(lib);
check("only usable answers are offered", described.length, 2);
check("the answer text is included", described[0].answer.length > 0, true);
check("a disabled answer is withheld",
  described.filter(function(d){ return d.id === "r3"; }).length, 0);
check("an empty answer is withheld",
  described.filter(function(d){ return d.id === "r4"; }).length, 0);

// --- reconciling the model's choices -------------------------------------
var qFields = [{id:"q1", label:"What draws you to this organisation?"},
               {id:"q2", label:"What is your notice period?"}];
function recon(matches) { return reconcileMatches(matches, qFields, lib); }
check("a confident match is accepted", recon([{id:"q1", responseId:"r1", confidence:0.85}]).length, 1);
check("a low-confidence match is rejected", recon([{id:"q1", responseId:"r1", confidence:0.2}]).length, 0);
check("an invented response id is dropped", recon([{id:"q1", responseId:"ghost", confidence:0.9}]).length, 0);
check("an invented question id is dropped", recon([{id:"q9", responseId:"r1", confidence:0.9}]).length, 0);
check("a disabled response cannot be chosen", recon([{id:"q1", responseId:"r3", confidence:0.99}]).length, 0);
check("a missing confidence means no confidence", recon([{id:"q1", responseId:"r1"}]).length, 0);

// --- placeholder rendering ------------------------------------------------
var prof = {"identity.firstName":"Pat","identity.lastName":"Brien","contact.email":"p@example.com"};
var ctx = {company:"Acme", role:"Backend Engineer"};
check("fills company and role",
  renderResponse("I admire {{company}} and the {{role}} role fits what I do.", {profile:prof, context:ctx}),
  "I admire Acme and the Backend Engineer role fits what I do.");
check("fills a derived profile field",
  renderResponse("Regards, {{name}}", {profile:prof, context:ctx}), "Regards, Pat Brien");
check("fills a dotted profile key",
  renderResponse("Reach me at {{contact.email}}", {profile:prof, context:ctx}), "Reach me at p@example.com");
check("drops an unknown placeholder",
  renderResponse("Hello {{nonsense}} there", {profile:prof, context:ctx}), "Hello there");
check("tolerates spaces in the braces",
  renderResponse("At {{ company }}.", {profile:prof, context:ctx}), "At Acme.");
check("missing context yields no crash", renderResponse("At {{company}}.", {}), "At .");

// --- long text mode -------------------------------------------------------
check("default mode writes", DEFAULT_SETTINGS.longTextMode, "write");
check("legacy off flag becomes skip", effectiveLongTextMode({writeLongAnswers:false}), "skip");
check("legacy on flag becomes write", effectiveLongTextMode({writeLongAnswers:true}), "write");
check("explicit mode wins", effectiveLongTextMode({longTextMode:"canned", writeLongAnswers:false}), "canned");

// --- building an export ---------------------------------------------------
var SNAPSHOT = {
  profile: {"identity.firstName":"Pat"},
  settings: {deepseekApiKey:"sk-secret", typesafeApiKey:"apikey-secret", proxyToken:"tok", longTextMode:"canned"},
  responses: [{id:"r1", name:"Why", text:"Because."}],
  skills: {"boards.greenhouse.io":{site:"boards.greenhouse.io", fields:{}}},
  runs: [{site:"x"}],
  usage: {completions:7}
};
var full = buildExport(SNAPSHOT, {});
check("export is identified", full.application, "applicator");
check("export carries the profile", full.data.profile["identity.firstName"], "Pat");
check("export strips the deepseek key", full.data.settings.deepseekApiKey, "");
check("export strips the typesafe key", full.data.settings.typesafeApiKey, "");
check("export keeps non-secret settings", full.data.settings.longTextMode, "canned");
check("export flags itself as keyless", full.containsCredentials, false);
check("stripping does not mutate the source", SNAPSHOT.settings.deepseekApiKey, "sk-secret");

var withKeys = buildExport(SNAPSHOT, {includeKeys:true});
check("opt-in export carries the key", withKeys.data.settings.deepseekApiKey, "sk-secret");
check("opt-in export warns", withKeys.containsCredentials, true);

var subset = buildExport(SNAPSHOT, {parts:["profile","responses"]});
check("subset includes what was asked", subset.includes.length, 2);
check("subset omits site skills", subset.data.skills === undefined, true);
check("absent data is not exported", buildExport({}, {}).includes.length, 0);

// A keyless export must not erase a key already configured on this machine.
var here = {deepseekApiKey:"sk-local", typesafeApiKey:"", proxyToken:""};
var back = prepareImport(full, {currentSettings: here, currentProfile: {}});
check("a keyless file keeps the local key", back.incoming.settings.deepseekApiKey, "sk-local");
check("a keyed file overwrites it",
  prepareImport(withKeys, {currentSettings: here}).incoming.settings.deepseekApiKey, "sk-secret");
check("import forces autoSubmit off", back.incoming.settings.autoSubmit, false);
check("import fills in new defaults", back.incoming.settings.classifier, "typesafe");


// --- whose details a field wants ------------------------------------------
var SEP = " › ";
var jobProfile = {
  "address.line1": "1 Home St", "address.city": "Oakland", "address.state": "CA",
  "contact.phone": "555-0100", "identity.firstName": "Pat", "identity.lastName": "Brien",
  "preferences.availableStartDate": "2026-11-01",
  employment: [
    {company: "Acme", title: "Engineer", startDate: "2022-01", endDate: "", location: "Austin, TX, USA"},
    {company: "Initech", title: "Analyst", startDate: "2019-03", endDate: "2021-12", location: "Boston, MA"}
  ]
};
function place(field, key) {
  var f = Object.assign({}, field, {profileKey: key});
  f.scope = scopeOf(f).scope;
  var placed = placeInScope(f);
  return placed.profileKey ? resolveValue(placed, placed.profileKey, jobProfile) : null;
}

check("scope: employer heading above an address sub-heading",
  scopeOf({label:"City", section:"Address" + SEP + "Work Experience 2"}).scope, "employment");
check("scope: nearest heading wins", scopeOf({label:"City", section:"Home address" + SEP + "Application"}).scope, "personal");
check("scope: field name places it", scopeOf({label:"City", name:"workExperience[1][city]"}).scope, "employment");
check("scope: label places it", scopeOf({label:"Employer city"}).scope, "employment");
check("scope: references block", scopeOf({label:"Phone", section:"References"}).scope, "reference");
check("scope: a job reference code is not a referee", scopeOf({label:"Code", section:"Job reference number"}).scope, "unknown");
check("scope: equal employment opportunity is not a job", scopeOf({label:"Name", section:"Equal Employment Opportunity"}).scope, "unknown");
check("scope: education block", scopeOf({label:"City", section:"Education"}).scope, "education");
check("scope: plain field is unknown", scopeOf({label:"City", section:""}).scope, "unknown");

check("home city stays home in personal block", place({label:"City", section:"Your address"}, "address.city"), "Oakland");
check("employer city is the job's city", place({label:"City", section:"Employer 1", repeatIndex:0}, "address.city"), "Austin");
check("employer state is the job's state", place({label:"State", section:"Employer 1", repeatIndex:0}, "address.state"), "TX");
check("second employer city", place({label:"City", section:"Employer 2", repeatIndex:1}, "address.city"), "Boston");
check("employer country needs a country in the location",
  place({label:"Country", section:"Employer 2", repeatIndex:1}, "address.country"), null);
check("employer street is never the home street", place({label:"Street", section:"Work history"}, "address.line1"), null);
check("employer phone is never the applicant's", place({label:"Phone", section:"Work history"}, "contact.phone"), null);
check("start date in a job block is the job's start",
  place({label:"Start date", section:"Employer 2", repeatIndex:1}, "preferences.availableStartDate"), "2019-03");
check("end date in a job block is the job's end",
  place({label:"To", section:"Employer 2", repeatIndex:1}, "preferences.availableStartDate"), "2021-12");
check("company in a later job block is that job's company",
  place({label:"Company", section:"Employer 2", repeatIndex:1}, "work.currentCompany"), "Initech");
check("start date outside any job block is availability",
  place({label:"Start date", section:"Availability"}, "preferences.availableStartDate"), "2026-11-01");
check("a referee's name is not the applicant's", place({label:"First name", section:"References"}, "identity.firstName"), null);
check("a supervisor's phone is blocked", place({label:"Supervisor phone", section:"Employer 1"}, "contact.phone"), null);
check("an education city is blocked", place({label:"City", section:"Education"}, "address.city"), null);
check("a locked skill row is trusted",
  placeInScope({label:"City", section:"Employer 1", scope:"employment", profileKey:"address.city", locked:true}).profileKey, "address.city");
check("location parts", [locationPart("Austin, TX", "city"), locationPart("Austin", "state"), locationPart("", "city")].join("|"), "Austin||");

// The backstop: the same personal answer in two unrecognised sections.
var dd = dedupeAcrossSections([
  {id:"a", profileKey:"address.city", section:"Applicant"},
  {id:"b", profileKey:"address.city", section:"Block B"},
  {id:"c", profileKey:"contact.email", section:"Applicant"},
  {id:"d", profileKey:"contact.email", section:"Applicant"},
  {id:"e", profileKey:"authorization.over18", section:"Block B"}
]);
check("dedupe keeps the applicant's section", dd.kept.map(function(f){return f.id;}).join(","), "a,c,d,e");
check("dedupe drops the repeat elsewhere", dd.dropped.map(function(f){return f.id;}).join(","), "b");
var dd2 = dedupeAcrossSections([
  {id:"x", profileKey:"address.city", section:"Block A"},
  {id:"y", profileKey:"address.city", section:"Your details"}
]);
check("dedupe prefers a personal heading over page order", dd2.kept.map(function(f){return f.id;}).join(","), "y");


// --- newest job by date, whatever order it was typed in -------------------
var typedOldestFirst = { employment: [
  {company: "OldCo", title: "Intern", startDate: "2015-06", endDate: "2016-08"},
  {company: "MidCo", title: "Analyst", startDate: "Mar 2017", endDate: "Dec 2020"},
  {company: "NowCo", title: "Lead", startDate: "01/2021", endDate: ""}
]};
check("newest job is the ongoing one", profileValue(typedOldestFirst, "work.currentCompany"), "NowCo");
check("current title from the newest job", profileValue(typedOldestFirst, "work.currentTitle"), "Lead");
check("employer block 2 is the next newest", profileValue(typedOldestFirst, "employment.company", {repeatIndex:1}), "MidCo");
check("newest index points into the typed list", newestEmploymentIndex(typedOldestFirst), 2);
var allEnded = { employment: [
  {company: "A", startDate: "2018", endDate: "2019"},
  {company: "B", startDate: "2019-02", endDate: "2023-05"},
  {company: "C", startDate: "2016", endDate: "Present"}
]};
check("'Present' counts as current", profileValue(allEnded, "work.currentCompany"), "C");
check("then the latest end date", profileValue(allEnded, "employment.company", {repeatIndex:1}), "B");
check("a stale typed current employer loses to the history",
  profileValue(Object.assign({"work.currentCompany": "Stale"}, typedOldestFirst), "work.currentCompany"), "NowCo");
check("with no history a typed current employer still answers",
  profileValue({"work.currentCompany": "Typed"}, "work.currentCompany"), "Typed");
check("dates order month-aware", dateRank("2020-11") > dateRank("Mar 2020"), true);
check("unreadable dates are null", dateRank("soon"), null);

// --- name pronunciation -----------------------------------------------------
check("pronunciation label matches its own key", matchField({label:"Name Pronunciation"}).key, "identity.namePronunciation");
check("full name is never put in a pronunciation box",
  placeInScope({label:"Name Pronunciation", profileKey:"identity.fullName"}).profileKey, null);
check("a blank pronunciation leaves the box empty",
  resolveValue({label:"Name Pronunciation"}, "identity.namePronunciation", {"identity.firstName":"Pat","identity.lastName":"Brien"}), null);
check("a saved pronunciation fills it",
  resolveValue({label:"Name Pronunciation"}, "identity.namePronunciation", {"identity.namePronunciation":"PAT BRY-en"}), "PAT BRY-en");


// --- CaselleHire-shaped forms ----------------------------------------------
var PP = {
  "contact.phone": "5105550100", "contact.phoneType": "Cell", "contact.preferredMethod": "Email", "contact.textConsent": "no",
  "preferences.agreeToTerms": "yes", "address.line1": "1 Home St", "address.country": "United States",
  "address.state": "CA",
  employment: [
    {company: "Acme Corp", title: "Office Manager", positionType: "Full-time", startDate: "2021-03", endDate: "",
     address: "500 Main St", city: "Oakland", state: "CA", postalCode: "94704", phone: "5105551234",
     supervisor: "Jo Smith", mayContact: "yes", description: "Ran the office.", reasonForLeaving: "Growth"},
    {company: "Initech", title: "Admin Assistant", startDate: "Jun 2018", endDate: "02/2021", city: "Austin", state: "TX"}
  ],
  education: [{school: "UC Oakland", degree: "BA", major: "History", startYear: "2014", endYear: "2018", city: "Oakland"}]
};
function decide(f, profile) {
  f = Object.assign({}, f); f.scope = scopeOf(f).scope;
  var m = matchField(f); if (!m || m.confidence < HEURISTIC_ACCEPT) return "no match";
  var placed = placeInScope(Object.assign({}, f, {profileKey: m.key}));
  return placed.profileKey ? resolveValue(placed, placed.profileKey, profile || PP) : null;
}
var yesNo = [{label:"Yes"},{label:"No"}];
var MONTHS12 = ["01 / Jan","02 / Feb","03 / Mar","04 / Apr","05 / May","06 / Jun","07 / Jul","08 / Aug","09 / Sep","10 / Oct","11 / Nov","12 / Dec"].map(function(l){return {label:l};});
var YEARS = ["2026","2025","2024","2023","2022","2021","2020","2019","2018"].map(function(l){return {label:l};});
var JOB = "Company Information › Add Employer › Employment History";

check("preferred communication picks email",
  decide({tag:"select", label:"What is your preferred method of communication?", name:"text_approval", options:[{label:"Email"},{label:"Text Message"}]}), "Email");
check("text consent maps onto the long option",
  decide({tag:"select", label:"Please indicate if you agree to CaselleHire's Applicant Communication Policy.", name:"applicant_consent_approval",
    options:[{label:"Yes, I agree to be contacted by text messages"},{label:"No, I do not agree to receive text messages"}]}),
  "No, I do not agree to receive text messages");
check("terms checkbox is ticked", decide({type:"checkbox", label:"I agree to CaselleHire's Privacy Policy and Terms of Service.*", name:"info_use_consent"}), "true");
check("a certification is never ticked",
  decide({type:"checkbox", label:"I certify that the information I have provided is true and complete"}) === "true", false);
check("agreement off leaves the box alone",
  decide({type:"checkbox", label:"I agree to the Terms of Service"}, {"preferences.agreeToTerms":"no"}), null);
check("phone type", decide({tag:"select", label:"Number Type", name:"contact_number_type", options:[{label:"Home"},{label:"Cell"},{label:"Work"}]}), "Cell");
check("company phone is the job's phone", decide({label:"Company Phone Number*", name:"phone", section:JOB}), "5105551234");
check("company address is the job's street", decide({label:"Company Address*", name:"address", section:JOB}), "500 Main St");
check("company zip", decide({label:"Company Zip*", name:"zip", section:JOB}), "94704");
check("company state select expands CA",
  decide({tag:"select", label:"Company State/Province*", name:"state_id", section:JOB, options:[{label:"Arizona"},{label:"California"}]}), "California");
check("company country falls back to your country",
  decide({tag:"select", label:"Company Country*", name:"country_id", section:JOB, options:[{label:"Canada"},{label:"United States"}]}), "United States");
check("supervisor's name", decide({label:"Supervisor's Name*", name:"supervisor_name", section:"Supervisor Info › Add Employer"}), "Jo Smith");
check("position type select", decide({tag:"select", label:"Position Type*", name:"position_id", section:"About Your Role › Add Employer",
  options:[{label:"Full-Time"},{label:"Part-Time"}]}), "Full-Time");
check("about your role is a job block", scopeOf({label:"Your Job Title*", section:"About Your Role › Add Employer"}).scope, "employment");
check("current employer checkbox", decide({type:"checkbox", label:"This is my current Employer", name:"is_current_employer", section:JOB}), "true");
check("start month select", decide({tag:"select", label:"Dates Employed Start Month*", name:"dates_employed_start_month", section:JOB, options:MONTHS12}), "03 / Mar");
check("start year select", decide({tag:"select", label:"Dates Employed Year Start Date*", name:"dates_employed_start_year", section:JOB, options:YEARS}), "2021");
check("end month of an older job",
  decide({tag:"select", label:"Dates Employed Month End Date*", name:"dates_employed_end_month", section:"Employer 2", repeatIndex:1, options:MONTHS12}), "02 / Feb");
check("month from a written month name",
  decide({tag:"select", label:"Start Month", name:"start_month", section:"Employer 2", repeatIndex:1, options:MONTHS12}), "06 / Jun");
check("reason for leaving", decide({label:"Reason For Leaving*", name:"reason_for_leaving", section:JOB}), "Growth");
check("may we contact", decide({type:"radio", label:"May We Contact?", name:"may_we_contact", section:"May We Contact? › Add Employer", options:yesNo}), "Yes");
check("stored duties go in a duties box", storedAnswer({label:"Explain Your Duties*", name:"duties", multiline:true, section:JOB, scope:"employment"}, PP), true);
check("an essay is not a stored answer", storedAnswer({label:"Why do you want to work here?", multiline:true}, PP), false);

var EDU = "Add Educational Experience › Education";
check("institution name is the school", decide({label:"Institution Name", name:"name", section:EDU}), "UC Oakland");
check("school city", decide({label:"City", name:"city", section:EDU}), "Oakland");
check("years attended from", decide({label:"Years Attended From (in years)", name:"years_attended_from", section:EDU}), "2014");
check("years attended to", decide({label:"Years Attended To (in years)", name:"years_attended_to", section:EDU}), "2018");
check("degree obtained", decide({label:"Degree/Certificate Obtained", name:"degree", section:EDU}), "BA");
check("major", decide({label:"Major/Course of Study", name:"major", section:EDU}), "History");

check("address line 2 never gets line 1", decide({label:"Address Line 2", name:"address2"}, {"address.line1":"1 Home St"}), null);
check("a street_2 box is line 2", placeInScope({label:"Street", name:"street_2", profileKey:"address.line1"}).profileKey, "address.line2");

// A one-at-a-time "Add employer" dialog picks the next job not yet listed.
var modal = [{id:"a", label:"Company Name", scope:"employment", repeatRaw:null}, {id:"b", label:"Supervisor", scope:"supervisor", repeatRaw:null}];
check("first dialog is the newest job", pickListEntries(modal, "Employment History", PP)[0].repeatIndex, undefined);
check("next dialog skips a listed job", pickListEntries(modal, "Employment History Acme Corp Office Manager", PP)[1].repeatIndex, 1);
check("all listed leaves nothing to fill", pickListEntries(modal, "Acme Corp ... Initech", PP)[0].repeatIndex, 2);
check("numbered blocks keep their numbering",
  pickListEntries([{scope:"employment", repeatRaw:1, repeatIndex:0}], "Acme Corp", PP)[0].repeatIndex, 0);

// --- screening questions ------------------------------------------------------
var SQ = {"screening.everDischarged":"no","screening.relatedToEmployee":"no","screening.essentialFunctions":"yes",
          "screening.licenses":"None","screening.equipment":"Office equipment, forklift","preferences.previouslyEmployed":"no",
          "authorization.authorizedToWork":"yes"};
check("discharged", decide({type:"radio", label:"Have you ever been discharged from any employment or resigned in lieu of discharge?*", options:yesNo}, SQ), "No");
check("related to an employee", decide({type:"radio", label:"Are you related to an employee of the City?*", options:yesNo}, SQ), "No");
check("worked for the city", decide({type:"radio", label:"Have you ever worked for the City?*", options:yesNo}, SQ), "No");
check("essential functions", decide({type:"radio", label:"Please review the job description for the job for which you are applying. Can you perform the essential functions of the job, with or without accommodation?*", options:yesNo}, SQ), "Yes");
check("licenses", decide({label:"Professional licenses/certificates required for the job you are applying for:*", multiline:true}, SQ), "None");
check("equipment", decide({label:"Machines or equipment you can operate relevant to the job you are applying for:*"}, SQ), "Office equipment, forklift");
check("authorized to work", decide({type:"radio", label:"Are you a United States citizen or legally authorized to work in the United States?", options:yesNo}, SQ), "Yes");
check("proof-of-permission notice is acknowledged",
  decide({type:"checkbox", label:"If hired, you will be required to submit proof of permission to work pursuant to Federal Law.*"}, {"preferences.agreeToTerms":"yes"}), "true");

// --- learned answers ------------------------------------------------------------
var withCustom = {custom:[{id:"k1", question:"Do you have a valid California driver's license?", answer:"Yes"}]};
check("a learned answer is a profile value", profileValue(withCustom, "custom.k1"), "Yes");
check("a learned answer is offered to the classifier",
  shortlistFor({label:"Do you hold a valid CA drivers license?"}, {availableKeys: filledKeys(withCustom), profile: withCustom}).indexOf("custom.k1") >= 0, true);
check("its criterion quotes the question",
  /driver's license/.test(criteriaFor(["custom.k1"], withCustom)["custom.k1"].what), true);
check("a learned yes answers a yes/no radio", resolveValue({type:"radio", options:yesNo}, "custom.k1", withCustom), "Yes");

// Learning from a form the user filled in themselves.
var filled = [
  {id:"f0", tag:"select", label:"What is your preferred method of communication?", name:"text_approval",
   options:[{label:"Email"},{label:"Text Message"}], currentValue:"0", currentText:"Email"},
  {id:"f1", tag:"input", type:"text", label:"Company Name*", name:"company", section:JOB, currentValue:"Globex"},
  {id:"f2", tag:"input", type:"text", label:"Company Phone Number*", name:"phone", section:JOB, currentValue:"5105559999"},
  {id:"f3", tag:"select", label:"Dates Employed Start Month*", name:"dates_employed_start_month", section:JOB, options:MONTHS12, currentValue:"4", currentText:"04 / Apr"},
  {id:"f4", tag:"select", label:"Dates Employed Year Start Date*", name:"dates_employed_start_year", section:JOB, options:YEARS, currentValue:"2019", currentText:"2019"},
  {id:"f5", tag:"select", label:"Position Type*", name:"position_id", section:"About Your Role › Add Employer", options:[{label:"Full-Time"}], currentValue:"1", currentText:"Full-Time"},
  {id:"f6", tag:"input", type:"radio", label:"Do you have a valid California driver's license?", name:"dl", options:[{label:"Yes", value:"y"},{label:"No", value:"n"}], currentValue:"y"},
  {id:"f7", tag:"input", type:"text", label:"Search the FAQ here", currentValue:"benefits"},
  {id:"f8", tag:"textarea", type:"textarea", label:"Why do you want to work for the City?", multiline:true, currentValue:"Because..."},
  {id:"f9", tag:"input", type:"text", label:"Email", name:"email", currentValue:"new@example.com"}
];
var proposals = proposeLearning({fields: filled, profile: {"contact.email":"old@example.com", employment:[]}, site:"piedmont.casellehire.com"});
function find(type, pred) { return proposals.filter(function(p){ return p.type === type && pred(p); })[0]; }
check("learns the preferred contact method", (find("field", function(p){return p.key==="contact.preferredMethod";})||{}).value, "Email");
function jobItem(prop) { return find("entry", function(p){ return p.list === "employment" && prop in p.values && Object.keys(p.values).length <= 2; }) || {values:{}}; }
check("each detail of a job is its own item, named for the job", jobItem("phone").name, "Globex");
check("learns the company phone", jobItem("phone").values.phone, "5105559999");
check("an item says where it will be saved", /Globex/.test(jobItem("phone").saveTo), true);
check("an item keeps the page's own question", jobItem("phone").question, "Company Phone Number*");
check("month and year become one date", jobItem("startDate").values.startDate, "2019-04");
check("position type uses the profile's spelling", jobItem("positionType").values.positionType, "Full-time");
check("an unknown question becomes a saved answer",
  (find("custom", function(p){ return /driver's license/.test(p.question); })||{}).answer, "Yes");
check("search boxes are not learned", !!find("custom", function(p){ return /search/i.test(p.question); }), false);
check("employer-specific essays are not learned", !!find("custom", function(p){ return /why do you want/i.test(p.question); }), false);
var corrected = find("field", function(p){ return p.key === "contact.email"; }) || {};
check("a page value that differs from the saved one is offered as a replacement", corrected.replaces, "old@example.com");

var base = {"contact.email":"old@example.com", employment:[{company:"Globex", title:"Clerk"}], custom:[]};
var after = applyLearning(base, proposals).profile;
check("saving all adds details to the matching job", after.employment[0].phone, "5105559999");
check("without replacing what the job already had", after.employment[0].title, "Clerk");
check("and does not duplicate it", after.employment.length, 1);
check("the saved answer is kept", after.custom.length, 1);
check("a saved value is not replaced unless asked", after["contact.email"], "old@example.com");
check("Replace replaces it", applyLearning(base, [Object.assign({}, corrected, {replace:true})]).profile["contact.email"], "new@example.com");
check("one item can be saved on its own",
  applyLearning(base, [jobItem("phone")]).profile.employment[0].phone, "5105559999");
check("applying twice does not duplicate saved answers", applyLearning(after, proposals).profile.custom.length, 1);
var nothingNew = proposeLearning({fields:[{id:"e", tag:"input", type:"email", label:"Email", name:"email", currentValue:"old@example.com"}],
  profile:{"contact.email":"old@example.com"}, site:"x"});
check("an answer already saved is not offered again", nothingNew.length, 0);

// --- older profiles ---------------------------------------------------------
var old = normaliseProfile({"work.school":"MIT", "work.graduationYear":"2012", employment:[{company:"A", location:"Austin, TX"}]});
check("flat education becomes the first entry", old.education[0].school, "MIT");
check("a job's location is split", old.employment[0].city + "|" + old.employment[0].state, "Austin|TX");
check("school still answers the flat question", profileValue(old, "work.school"), "MIT");


// --- dates into date pickers, and generated ids ---------------------------------
check("a picker gets ISO year-month", formatDate({datePicker:true, placeholder:"Pick a date"}, "Jun 2018"), "2018-06");
check("a type=date box gets a full ISO date", formatDate({type:"date"}, "03/2021"), "2021-03-01");
check("an MM/YYYY placeholder is followed", formatDate({placeholder:"MM/YYYY"}, "2021-03"), "03/2021");
check("an MM/DD/YYYY placeholder is followed", formatDate({placeholder:"MM/DD/YYYY"}, "Mar 2021"), "03/01/2021");
check("a plain box keeps the date as written", formatDate({label:"Start date"}, "Mar 2021"), "Mar 2021");
check("a signature date keeps its day in an MM/DD/YYYY box (Velo3D)", [formatDate({placeholder:"MM/DD/YYYY"}, "2026-10-25"), formatDate({type:"date"}, "2026-10-25")].join("|"), "10/25/2026|2026-10-25");
check("a starred label still matches", matchField({label:"Title*"}).key, "work.currentTitle");
check("bare From in a job block is the start date",
  decide({label:"From", datePicker:true, placeholder:"Pick a date", section:"Experience *"}), "2021-03");
check("office location in a job block is the job's city", decide({label:"Office location", section:"Experience *"}), "Oakland");
check("a job description box uses saved duties",
  storedAnswer({label:"Description", multiline:true, section:"Experience *", scope:"employment"}, PP), true);

// --- the applicant's own status inside an education block --------------------
var HS = {tag:"input", type:"radio", label:"Did you graduate from High School?", name:"ctl00$cphMainContent$ucEducation$rblGraduateHighSchool",
  section:"Education", options:yesNo};
check("a did-you question in an education block is about the applicant", scopeOf(HS).scope, "personal");
check("a school's own city stays in the block", scopeOf({label:"City", section:"Education"}).scope, "education");
check("high school graduation follows from a college entry",
  decide(HS, {education:[{school:"Lakeside College", degree:"Associate"}]}), "Yes");
check("a high school with no end year says nothing",
  decide(HS, {education:[{school:"Lincoln High School"}]}), null);

// --- ticked boxes are saved under their question ------------------------------
var tickProps = proposeLearning({fields:[
  {id:"t1", tag:"input", type:"checkbox", label:"Which shifts can you work?: Weekends", currentValue:"on"},
  {id:"t2", tag:"input", type:"checkbox", label:"Which shifts can you work?: Nights", currentValue:""},
  {id:"t3", tag:"input", type:"checkbox", label:"Which shifts can you work?: Days", currentValue:"on"},
  {id:"t4", tag:"input", type:"checkbox", label:"Yes, I have a forklift licence.", currentValue:"on"}], profile:{custom:[]}, site:"x"});
check("ticked boxes are saved as their question, answered with the options ticked",
  tickProps.map(function(p){ return p.question + " = " + p.answer; }).join(" | "), "Which shifts can you work? = Weekends; Days");

// --- a "please specify who" box is not a yes/no --------------------------------
check("\"current/former employee, please specify who\" is not the previously-employed question",
  decide({tag:"input", type:"text", label:"If you were contacted by a recruiter or are a current/former employee, please specify who."}), "no match");
check("\"Have you previously worked for Acme?\" still is",
  matchField({tag:"select", label:"Have you previously worked for Acme?", options:yesNo}).key, "preferences.previouslyEmployed");
check("a conditional question the model says nothing fits is left empty, whatever the keyword",
  settle("preferences.previouslyEmployed", {choice:"__none__", confidence:0.61}, 0.6, {label:"If so, who referred you?"}).key, null);
check("an ordinary one keeps the rule when the model is unsure",
  settle("contact.phone", {choice:"__none__", confidence:0.61}, 0.6, {label:"Phone"}).key, "contact.phone");

// --- identity by element; a job's Summary box --------------------------------
check("a box whose label changes as it fills is the same field",
  fieldIdentity({idAttr:"major", label:"Major 0 / 200"}), fieldIdentity({idAttr:"major", label:"Major 37 / 200"}));
check("boxes sharing a name are told apart by their place",
  fieldIdentity({name:"summary", label:"Summary"}) === fieldIdentity({name:"summary", label:"Summary", handleIndex:1}), false);
check("a Summary box in a job block is that job's saved duties",
  placeInScope({label:"Summary", name:"summary", multiline:true, scope:"employment", profileKey:"documents.summary"}).profileKey, "employment.description");

// --- a supervisor's phone is the job's ------------------------------------------
check("Supervisor Phone takes the job's saved phone",
  placeInScope({label:"Supervisor Phone", section:"Supervisor Information", scope:"supervisor", profileKey:"contact.phone"}).profileKey, "employment.phone");
check("a saved answer is never learned under a question of only \"*\"",
  proposeLearning({fields:[{id:"s", tag:"input", type:"text", label:"*", currentValue:"3 years"}], profile:{custom:[]}, site:"x"}).length, 0);

// --- a CV for each kind of job ------------------------------------------------
var oldDocs = normaliseDocuments({resume:{filename:"cv.pdf", data:"JVBE"}, coverLetter:{filename:"letter.pdf", data:"JVBE"}});
check("one CV stored before is read as a list of one",
  [oldDocs.resumes.length, oldDocs.resumes[0].filename, oldDocs.resumes[0].category, !!oldDocs.resumes[0].id, "resume" in oldDocs, oldDocs.coverLetter.filename].join(" "),
  "1 cv.pdf  true false letter.pdf");
check("no CV is an empty list", normaliseDocuments({}).resumes.length, 0);
var cvs = [{id:"a", filename:"pat-brien.pdf", category:"Retail, customer service"},
           {id:"b", filename:"pat-brien-eng.pdf", category:"Software engineering"},
           {id:"c", filename:"pat-brien-data.pdf", category:"Data analysis"}];
check("without TypeSafe, the CV whose stated jobs the role names is chosen",
  resumeByWords(cvs, "Backend Software Engineer at Globex").id, "b");
check("a posting about data analysis picks that CV",
  resumeByWords(cvs, "Analyst. You will run data analysis for the sales team.").id, "c");
check("a job none of them names picks none (the main one is sent)", resumeByWords(cvs, "Forklift operator"), null);

// A key of the user's own goes straight to DeepSeek even in a paid run; TypeSafe stays on the relay.
useRelay({ url: "https://api.philform.test/", token: "tok", runId: "run1" });
check("in a paid run TypeSafe goes through the relay",
  route("typesafe", "https://typesafe.test/v1", "relay").url, "https://api.philform.test/v1/relay/typesafe");
check("and so does DeepSeek without a key of the user's own",
  route("deepseek", "https://api.deepseek.com/chat/completions", "relay").headers["x-philform-run"], "run1");
check("with the user's own key DeepSeek is called directly, on that key",
  [route("deepseek", "https://api.deepseek.com/chat/completions", "sk-own").url,
   route("deepseek", "https://api.deepseek.com/chat/completions", "sk-own").headers.authorization].join(" "),
  "https://api.deepseek.com/chat/completions Bearer sk-own");
useRelay(null);

JSON.stringify(failures);
'''

result = subprocess.run(['osascript', '-l', 'JavaScript', '-e', bundle + '\n' + TESTS],
                        capture_output=True, text=True)
out = (result.stdout or '').strip()
if not out:
    print('Harness error:', result.stderr.strip()[:3000]); sys.exit(1)
try:
    failures = json.loads(out)
except json.JSONDecodeError:
    print('Unexpected output:', out[:3000]); print(result.stderr.strip()[:2000]); sys.exit(1)

if failures:
    print(f'{len(failures)} failure(s):')
    for f in failures: print('  -', f)
    sys.exit(1)
print('All orchestrator tests passed.')
