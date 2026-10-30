#!/usr/bin/env python3
"""Run the pure-logic tests through JavaScriptCore.

Only modules with no DOM or chrome.* dependency are testable this way:
util, schema and heuristics. The extraction and fill scripts need a real page.
"""
import json, pathlib, re, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

def load(rel):
    src = (ROOT / rel).read_text()
    src = re.sub(r'^\s*import\s*\{[^}]*\}\s*from\s*[^;]+;?\s*$', '', src, flags=re.M | re.S)
    src = re.sub(r'^\s*import\s[^;]*;?\s*$', '', src, flags=re.M)
    src = re.sub(r'^\s*export\s*\{[^}]*\};?\s*$', '', src, flags=re.M)
    src = re.sub(r'^\s*export\s+(default\s+)?', '', src, flags=re.M)
    return src

bundle = '\n'.join(load(f) for f in [
    'src/common/util.js',
    'src/common/schema.js',
    'src/common/rules-default.js',
    'src/common/rulespack.js',
    'src/background/heuristics.js',
])

TESTS = r'''
var failures = [];
function check(name, actual, expected) {
  if (actual !== expected) failures.push(name + ": expected " + expected + ", got " + actual);
}
// --- the rules pack (common/rulespack.js) ----------------------------------
var pack = compilePack(DEFAULT_RULES_PACK);
check("regex strings compile", parseRegex("/^a+$/i").test("AAA"), true);
check("a bad regex is dropped", parseRegex("/(/i"), null);
check("the pack names Workday by hostname", detectPlatform(pack, {hostname: "acme.wd5.myworkdayjobs.com"}).id, "workday");
check("and SuccessFactors by its markers", detectPlatform(pack, {hostname: "career4.successfactors.com"}).id, "successfactors");
check("a marker found on a page names the platform when the host does not", detectPlatform(pack, {hostname: "careers.example.com", markers: ["#careerform"]}).id, "successfactors");
check("an unknown site is null", detectPlatform(pack, {hostname: "jobs.example.com"}), null);
var merged = compilePack(mergeRaw(DEFAULT_RULES_PACK, {version: "test", rules: [{key: "work.school", label: "/^alma mater$/i"}, {key: "bad", label: "/(/"}],
  patterns: {rowName: {education: "/\\bacademy\\b/i"}}, overrides: {successfactors: {dropdowns: {namedListWaitMs: 1500}}}}));
check("a fetched pack's version wins", merged.version, "test");
check("its rules come first and a bad one is dropped", merged.rules.length === 1 && merged.rules[0].key, "work.school");
check("a nested pattern merges one level deep", merged.patterns.rowName.employment instanceof RegExp && merged.patterns.rowName.education.test("Naval Academy"), true);
var sf = platformRules(merged, "successfactors");
check("a platform's override applies to it", sf.dropdowns.namedListWaitMs, 1500);
check("and not elsewhere", platformRules(merged, "workday").dropdowns.namedListWaitMs, 1000);
check("a full platform reads as working well", supportLevel(pack.platforms[0], null).level, "full");
check("a site learned before is seen", supportLevel(null, {fields: {a: 1, b: 2}}).text, "Seen before: 2 answers learned on this site");
check("a stranger is new", supportLevel(null, null).level, "new");
setExtraRules(sf.rules.concat([{key: "work.school", label: /^alma mater$/i}]));
check("an extra rule is tried before the built-in ones", matchField({label: "Alma mater", tag: "input", type: "text"}).key, "work.school");
setExtraRules([]);
var content = contentRules(pack, platformRules(pack, null));
check("content rules carry the pattern as a string", typeof content.emptyChoice === "string" && content.emptyChoice.indexOf("/^") === 0, true);
check("content rules carry the page reader's selectors", content.selectors.selectSkin.indexOf(".choices") >= 0 && content.selectors.errorText.indexOf("inputAlert") >= 0, true);
check("and its patterns", parseRegex(content.genericLabel).test("Select") && parseRegex(content.iconGlyph).test("\uE1EF") && parseRegex(content.pageComplaint).test("This field is required.") && parseRegex(content.questionTitle).test("ashby-application-form-question-title"), true);
var skinFix = compilePack(mergeRaw(DEFAULT_RULES_PACK, {selectors: {selectSkin: ".select2-container"}, overrides: {workday: {selectors: {errorText: "[data-automation-id=errorMessage]"}}}}));
check("a fetched selector replaces the built-in one", contentRules(skinFix, platformRules(skinFix, null)).selectors.selectSkin, ".select2-container");
check("and keeps the others", contentRules(skinFix, platformRules(skinFix, null)).selectors.errorText.indexOf("inputAlert") >= 0, true);
check("a platform's selector applies to it only", platformRules(skinFix, "workday").selectors.errorText, "[data-automation-id=errorMessage]");
check("an empty selector is dropped", compilePack({selectors: {selectSkin: "  ", errorText: 3}}).selectors.selectSkin, undefined);


// --- heuristic field matching -------------------------------------------
var cases = [
  // [description, field, expected profile key]
  ["Greenhouse first name", {name:"job_application[first_name]", label:"First Name", tag:"input", type:"text"}, "identity.firstName"],
  ["Greenhouse last name", {name:"job_application[last_name]", label:"Last Name", tag:"input", type:"text"}, "identity.lastName"],
  ["autocomplete email", {name:"q1", autocomplete:"email", label:"Contact", tag:"input", type:"text"}, "contact.email"],
  ["plain email label", {name:"applicant_email", label:"Email Address", tag:"input", type:"email"}, "contact.email"],
  ["phone", {name:"phone_number", label:"Phone", tag:"input", type:"tel"}, "contact.phone"],
  ["LinkedIn", {name:"urls[LinkedIn]", label:"LinkedIn Profile", tag:"input", type:"url"}, "links.linkedin"],
  ["GitHub", {name:"urls[GitHub]", label:"GitHub URL", tag:"input", type:"url"}, "links.github"],
  ["Workday city", {name:"", dataAttr:"addressSection_city", label:"City", tag:"input", type:"text"}, "address.city"],
  ["postal code", {name:"postalCode", label:"Zip / Postal Code", tag:"input", type:"text"}, "address.postalCode"],
  ["sponsorship question", {name:"q_sponsor", label:"Will you now or in the future require sponsorship for employment visa status?", tag:"select", type:"select"}, "authorization.requiresSponsorship"],
  ["work authorization", {name:"q_auth", label:"Are you legally authorized to work in the United States?", tag:"select", type:"select"}, "authorization.authorizedToWork"],
  ["relocation", {name:"willing_to_relocate", label:"Are you willing to relocate?", tag:"select", type:"select"}, "preferences.willingToRelocate"],
  ["how heard", {name:"source", label:"How did you hear about this role?", tag:"select", type:"select"}, "preferences.howHeard"],
  ["desired salary", {name:"salary_expectation", label:"Desired Salary", tag:"input", type:"text"}, "compensation.desired"],
  ["gender EEO", {name:"gender", label:"Gender", tag:"select", type:"select"}, "demographics.gender"],
  ["veteran", {name:"veteran_status", label:"Protected Veteran Status", tag:"select", type:"select"}, "demographics.veteranStatus"],
  ["current employer", {name:"current_company", label:"Current Company", tag:"input", type:"text"}, "work.currentCompany"],
  ["years experience", {name:"yoe", label:"Years of relevant experience", tag:"input", type:"number"}, "work.yearsExperience"],
  ["school", {name:"education[0][school]", label:"School", tag:"input", type:"text"}, "work.school"]
];

for (var i = 0; i < cases.length; i++) {
  var c = cases[i];
  var m = matchField(c[1]);
  check("match " + c[0], m ? m.key : null, c[2]);
  if (m && m.confidence < HEURISTIC_ACCEPT) {
    failures.push("confidence too low for " + c[0] + ": " + m.confidence);
  }
}

// --- fields that must never match ---------------------------------------
var forbidden = [
  ["password", {name:"password", label:"Password", tag:"input", type:"text"}],
  ["SSN", {name:"ssn", label:"Social Security Number", tag:"input", type:"text"}],
  ["date of birth", {name:"dob", label:"Date of Birth", tag:"input", type:"text"}],
  ["card number", {name:"cc_number", label:"Card Number", tag:"input", type:"text"}],
  ["verification code", {name:"otp", label:"Verification Code", tag:"input", type:"text"}]
];
for (var j = 0; j < forbidden.length; j++) {
  check("refuse " + forbidden[j][0], matchField(forbidden[j][1]), null);
}

// --- partitioning --------------------------------------------------------
var part = partitionFields([
  {id:"a", name:"first_name", label:"First Name", tag:"input", type:"text"},
  {id:"b", name:"mystery_q", label:"What excites you about this role?", tag:"textarea", type:"textarea"},
  {id:"c", name:"ssn", label:"Social Security Number", tag:"input", type:"text"}
]);
check("partition resolved", part.resolved.length, 1);
check("partition unresolved", part.unresolved.length, 2);

// --- util ----------------------------------------------------------------
check("an embed's site is its registrable domain", siteOf("https://job-boards.greenhouse.io"), "greenhouse.io");
check("a two-part country suffix keeps three labels", siteOf("https://careers.acme.co.uk"), "acme.co.uk");
check("access is asked for the embed's whole site", sitePattern("https://boards.greenhouse.io"), "https://*.greenhouse.io/*");
check("a local address is asked for as it is", sitePattern("http://127.0.0.1"), "http://127.0.0.1/*");
check("siteKey strips www", siteKey("https://www.boards.greenhouse.io/acme/jobs/1"), "boards.greenhouse.io");
check("hash is stable", hash("abc"), hash("abc"));
check("hash differs", hash("abc") === hash("abd"), false);
check("cleanLabel strips marker", cleanLabel("First Name *"), "First Name");
check("cleanLabel strips required", cleanLabel("Email (required)"), "Email");

var fenced = parseLooseJson("Here you go:\n```json\n{\"assignments\":[{\"id\":\"f1\"}]}\n```\nDone.");
check("parseLooseJson unwraps fence", fenced.assignments[0].id, "f1");
var bare = parseLooseJson('{"a":1}');
check("parseLooseJson plain", bare.a, 1);
var prose = parseLooseJson('Sure thing. {"answers":[]} Hope that helps.');
check("parseLooseJson from prose", Array.isArray(prose.answers), true);

// --- profile helpers -----------------------------------------------------
var profile = {"identity.firstName":"Pat","identity.lastName":"Brien","contact.email":"p@x.com"};
check("derived full name", profileValue(profile, "identity.fullName"), "Pat Brien");
check("direct value", profileValue(profile, "contact.email"), "p@x.com");
check("missing value", profileValue(profile, "links.github"), "");
check("filledKeys counts", filledKeys(profile).length, 4); // three set plus derived fullName

check("isForbiddenName catches ssn", isForbiddenName("applicant_ssn"), true);
check("isForbiddenName allows name", isForbiddenName("first_name"), false);

JSON.stringify(failures);
'''

script = bundle + '\n' + TESTS
result = subprocess.run(['osascript', '-l', 'JavaScript', '-e', script],
                        capture_output=True, text=True)
out = (result.stdout or '').strip()
if not out:
    print('Test harness error:', result.stderr.strip()[:2000])
    sys.exit(1)
try:
    failures = json.loads(out)
except json.JSONDecodeError:
    print('Unexpected harness output:', out[:2000])
    print(result.stderr.strip()[:2000])
    sys.exit(1)

if failures:
    print(f'{len(failures)} failure(s):')
    for f in failures:
        print('  -', f)
    sys.exit(1)
print('All logic tests passed.')
