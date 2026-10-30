#!/usr/bin/env python3
"""Load the built extension in a real headless Firefox and check that it works.

Every other check in this repository inspects the source. None of them loads the
extension, which is how a stray `export` in the background script shipped: the
parse check had stripped the keyword before looking, and the extension was
broken in every browser while every test passed.

This test is the ground truth. It installs the Firefox build as a temporary
add-on, opens the options page, and asserts that the background script actually
evaluated, that a message reaches it, and that saving settings round-trips. It
also fails on any JavaScript error Firefox reports from the extension.

    python3 tools/test-firefox.py

Needs Firefox installed. Exits 0 with a note if it is not.
"""
import functools, http.server, json, os, pathlib, re, shutil, signal, socket, subprocess, sys, tempfile, threading, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
from marionette import Marionette  # noqa: E402
FIREFOX = pathlib.Path('/Applications/Firefox.app/Contents/MacOS/firefox')
ADDON_ID = 'applicator@local.test'
def free_port():
    # Another test run (or one that died and left its Firefox) may hold a
    # fixed port: Firefox then "closes the connection" at start.
    import socket
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


PORT = free_port()

if not FIREFOX.exists():
    found = shutil.which('firefox')
    if not found:
        print('Firefox is not installed; skipping the browser test.')
        sys.exit(0)
    FIREFOX = pathlib.Path(found)


failures = []


def check(name, ok, detail=''):
    print(('  ok   ' if ok else '  FAIL ') + name + ('' if ok else f': {detail}'))
    if not ok:
        failures.append(name)



# --- CV files, for reading their text on upload --------------------------------
# Made here rather than checked in: a PDF from macOS and one from Firefox
# differ in exactly the ways these do (simple fonts placed by Td; Type0 fonts
# with a ToUnicode table, kept in object streams, placed by cm).
import base64, io, zipfile, zlib  # noqa: E402

def cv_pdf_file(objects, packed=()):
    """A PDF from {num: body}; numbers in `packed` go inside one object stream."""
    out = io.BytesIO()
    out.write(b'%PDF-1.5\n%\xe2\xe3\xcf\xd3\n')
    inner = [n for n in objects if n in packed]
    loose = {n: b for n, b in objects.items() if n not in packed}
    if inner:
        head, body = b'', b''
        for n in inner:
            head += b'%d %d ' % (n, len(body))
            body += objects[n] + b'\n'
        data = zlib.compress(head + body)
        num = max(objects) + 1
        loose[num] = (b'<< /Type /ObjStm /N %d /First %d /Filter /FlateDecode /Length %d >>\nstream\n'
                      % (len(inner), len(head), len(data))) + data + b'\nendstream'
    for n, body in sorted(loose.items()):
        out.write(b'%d 0 obj\n' % n + body + b'\nendobj\n')
    out.write(b'trailer\n<< /Root 1 0 R >>\n%%EOF\n')
    return out.getvalue()


def cv_stream(content, compress=True):
    data = zlib.compress(content) if compress else content
    return (b'<< /Length %d%s >>\nstream\n' % (len(data), b' /Filter /FlateDecode' if compress else b'')) + data + b'\nendstream'


def cv_simple_pdf():
    """Helvetica in WinAnsi, lines by Td, a kerned word and a word gap made by TJ."""
    content = (b'BT /F1 12 Tf 72 720 Td (Pat Brien) Tj 0 -16 Td (Portland, OR \\267 415-555-0134) Tj '
               b'0 -16 Td [(Sof) 30 (tware) -400 (Engineer) ] TJ 0 -16 Td (\\223Typed\\224 APIs \\227 Globex) Tj ET')
    return cv_pdf_file({
        1: b'<< /Type /Catalog /Pages 2 0 R >>',
        2: b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        3: b'<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /MediaBox [0 0 612 792] >>',
        4: b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
        5: cv_stream(content, compress=False),
    })


def cv_packed_pdf():
    """Two pages; Type0 fonts with a ToUnicode table, every dictionary in an object
    stream, lines placed by moving the drawing (cm) as macOS does."""
    cmap = (b'/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n'
            b'1 begincodespacerange <0000> <FFFF> endcodespacerange\n'
            b'2 beginbfchar <0001> <0041> <0002> <00E9> endbfchar\n'
            b'1 beginbfrange <0010> <0029> <0061> endbfrange\n'
            b'1 beginbfrange <0003> <0004> [<0020> <2014>] endbfrange\n'
            b'endcmap CMapName currentdict /CMap defineresource pop end end')

    def codes(text):
        table = {'A': 1, 'é': 2, ' ': 3, '—': 4}
        return b''.join((table[c] if c in table else 0x10 + ord(c) - ord('a')).to_bytes(2, 'big') for c in text)

    def line(y, text):
        return b'q 1 0 0 1 72 %d cm BT 0 0 Td /F1 11 Tf <%s> Tj ET Q ' % (y, codes(text).hex().encode())

    page1 = line(700, 'acme résumé') + line(684, 'A b — c')
    page2 = line(700, 'second page')
    return cv_pdf_file({
        1: b'<< /Type /Catalog /Pages 2 0 R >>',
        2: b'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /Resources << /Font << /F1 5 0 R >> >> >>',
        3: b'<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>',
        4: b'<< /Type /Page /Parent 2 0 R /Contents [8 0 R] >>',
        5: b'<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Font /Encoding /Identity-H /DescendantFonts [9 0 R] /ToUnicode 6 0 R >>',
        6: cv_stream(cmap),
        7: cv_stream(page1),
        8: cv_stream(page2),
        9: b'<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Font /DW 500 /W [3 [250]] >>',
    }, packed={1, 2, 3, 4, 5, 9})


def cv_docx_file():
    xml = ('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           '<w:body><w:p><w:r><w:t>Pat Brien</w:t></w:r></w:p>'
           '<w:p><w:r><w:t xml:space="preserve">Engineer, </w:t></w:r><w:r><w:t>Globex &amp; Acme</w:t></w:r></w:p>'
           '<w:p><w:r><w:t>Cut costs</w:t><w:tab/><w:t>40%</w:t></w:r></w:p></w:body></w:document>')
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<Types/>')
        z.writestr('word/document.xml', xml)
    return out.getvalue()


print('Building the Firefox package')
# In a folder of its own, so a running dev.py cannot rebuild it underneath.
built = pathlib.Path(tempfile.mkdtemp(prefix='applicator-dist-'))
subprocess.run(['./build.sh', 'firefox'], cwd=ROOT, check=True,
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**os.environ, 'DIST': str(built)})

profile = tempfile.mkdtemp(prefix='applicator-ff-')
(pathlib.Path(profile) / 'user.js').write_text('\n'.join([
    'user_pref("browser.dom.window.dump.enabled", true);',
    'user_pref("devtools.console.stdout.chrome", true);',
    'user_pref("devtools.console.stdout.content", true);',
    'user_pref("xpinstall.signatures.required", false);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
    f'user_pref("marionette.port", {PORT});',
    # Fixture tabs fill while the extension page that started them is in
    # front; Firefox would run their timers once a second, turning every short
    # wait in a fill into a second or more. Users fill a tab in front.
    'user_pref("dom.min_background_timeout_value", 4);',
    'user_pref("dom.min_background_timeout_value_without_budget_throttling", 4);',
    'user_pref("dom.timeout.enable_budget_timer_throttling", false);',
]))

# A probe page, added to the build copy only, that exercises the real paths.
build = pathlib.Path(tempfile.mkdtemp(prefix='applicator-build-')) / 'firefox'
shutil.copytree(built / 'firefox', build)

(build / 'probe.js').write_text('''
// Results go on the page, where Marionette reads them. Firefox no longer
// sends dump() to stdout, which is what this probe relied on before.
window.__probeSave = 'pending';
window.__probeBackground = 'pending';
(async () => {
  try {
    const store = await import('./src/background/storage.js');
    await store.saveSettings({ typesafeApiKey: 'browser-test-key' });
    const back = await store.getSettings();
    window.__probeSave = back.typesafeApiKey === 'browser-test-key' ? 'ok' : 'wrong value: ' + back.typesafeApiKey;
  } catch (e) { window.__probeSave = 'threw ' + e.message; }

  try {
    const res = await chrome.runtime.sendMessage({ type: 'get-status' });
    window.__probeBackground = res && res.ok ? 'ok' : 'bad reply ' + JSON.stringify(res);
  } catch (e) { window.__probeBackground = 'threw ' + e.message; }
})();
''')

options = build / 'src' / 'options' / 'options.html'
options.write_text(options.read_text().replace(
    '<script type="module" src="options.js"></script>',
    '<script type="module" src="options.js"></script>\n'
    '  <script type="module" src="../../probe.js"></script>\n'
    '  <script type="module" src="../../e2e.js"></script>'))

# The test copy may reach the local fixture server on two of its three
# origins, standing in for the site a user granted. The third, [::1], stays
# ungranted so the blocked-frame report can be checked.
manifest_path = build / 'manifest.json'
test_manifest = json.loads(manifest_path.read_text())
test_manifest['host_permissions'] += ['http://127.0.0.1/*', 'http://localhost/*']
manifest_path.write_text(json.dumps(test_manifest, indent=2))


# A form shaped like the ones that went wrong: the same "City" and "Start date"
# labels under the applicant's details, two employer blocks with their own
# sub-headings, and a references block.
(build / 'form.html').write_text('''<!doctype html><meta charset="utf-8"><body>
<h1>Apply</h1>
<h2>My information</h2>
<label for="home-city">City</label><input id="home-city" name="city">
<label for="avail">Start date</label><input id="avail" name="available">
<section>
  <div class="hdr"><h2>Work Experience 1</h2></div>
  <label for="c1">Company</label><input id="c1" name="companyA">
  <div><h3>Address</h3><label for="w1">City</label><input id="w1" name="jobCityA"></div>
  <label for="s1">Start date</label><input id="s1" name="fromA">
  <label for="spl-form-element_12">Title</label><input id="spl-form-element_12">
</section>
<section>
  <div class="hdr"><h2>Work Experience 2</h2></div>
  <div><h3>Location</h3><div><label for="w2">City</label><input id="w2" name="jobCityB"></div></div>
</section>
<fieldset id="wd-ack"><legend><div><p>This position may involve access to technology and software that is subject to United States export controls under the Export Administration Regulations and the International Traffic in Arms Regulations. This position may involve access to technology and software that is subject to United States export controls under the Export Administration Regulations and the International Traffic in Arms Regulations. Please select "yes" if you acknowledge.</p></div></legend>
  <div><div><button type="button" id="wd1" aria-haspopup="listbox" aria-label=" Select One Required">Select One</button></div></div>
</fieldset>
<fieldset id="pron-group"><label>Preferred Pronouns</label>
  <div><input type="radio" id="pr1" name="pron"><label for="pr1">He/Him</label></div>
  <div><input type="radio" id="pr2" name="pron"><label for="pr2">She/Her</label></div>
</fieldset>
<h2>References</h2>
<label for="rp">Phone</label><input id="rp" name="refPhone">
<h2>Easy apply</h2>
<x-field id="sd-first" label="First name" autocomplete="given-name"></x-field>
<x-city id="sd-city"></x-city>
<x-slotted><span slot="label-content">What is your highest degree?</span></x-slotted>
<div><div class="side"><h2>Location</h2><p>Remote</p><h2>Department</h2><p>Data</p><h2>Compensation</h2><p>$100K</p></div>
  <div><label for="sb1">Phone number</label><input id="sb1"></div></div>
<p>Get in touch directly with the team.</p>
<form><div><div class="text-xs text-red-700">Required</div><input id="yc-first" placeholder="First Name *"></div></form>
<label for="ct">What is your major? <span>0 / 200</span></label><textarea id="ct"></textarea>
<fieldset><legend>How did you hear about us?</legend><label><input type="checkbox" id="hear-0" name="LinkedIn">LinkedIn</label>
  <label><input type="checkbox" id="hear-1" name="Job board">Job board</label>
  <label><input type="checkbox" id="hear-2" name="Friend">Friend</label></fieldset>
<label for="rs-in">Country</label><div class="rs__control" id="rs-ctl" style="width:300px;height:30px"><div class="rs__value-container"><input id="rs-in" style="width:2px"></div></div>
<div role="group" aria-labelledby="up-cl" aria-required="true"><div id="up-cl">Cover Letter<span class="required">*</span></div>
  <div><button type="button">Attach</button><label class="visually-hidden" for="cl-file">Attach</label><input id="cl-file" type="file" style="width:1px;height:1px"></div>
  <div><button type="button" data-testid="cl-text">Enter manually</button></div>
  <label class="visually-hidden" for="cl-typed">Enter manually</label><textarea id="cl-typed"></textarea></div>
<div data-testid="field"><div><span id="rp-resume-label">R\u00e9sum\u00e9</span><span>*</span></div><div id="rp-resume-tip">Total 0 file selected</div>
  <label data-testid="resume" aria-labelledby="rp-resume-tip rp-resume-label"><input accept=".pdf" data-testid="input-resume" type="File" style="width:1px;height:1px"><button type="button">Drop or select (.pdf)</button></label></div>
<div data-testid="field"><div><span id="rp-cover_letter-label">Cover letter</span><span>*</span></div><div id="rp-cover_letter-tip">Total 0 file selected</div>
  <label data-testid="cover_letter" aria-labelledby="rp-cover_letter-tip rp-cover_letter-label"><input accept=".pdf" data-testid="input-cover_letter" type="File" style="width:1px;height:1px"><button type="button">Drop or select (.pdf)</button></label></div>
<div data-testid="field"><span id="sms-q">May we text you about your application?</span>
  <div data-testid="sms_opt_in" id="sms-group" role="radiogroup" aria-labelledby="sms-q">
  <div data-testid="radio-label-sms_opt_in" data-value="true" role="radio" tabindex="0" aria-checked="false"><input data-testid="radio-sms_opt_in" aria-labelledby="sms-yes" type="radio" value="true" name="sms_opt_in" style="display:none"><div id="sms-yes"><p>Yes - I consent to receiving text messages</p></div></div>
  <div data-testid="radio-label-sms_opt_in" data-value="false" role="radio" tabindex="-1" aria-checked="false"><input data-testid="radio-sms_opt_in" aria-labelledby="sms-no" type="radio" value="false" name="sms_opt_in" style="display:none"><div id="sms-no"><p>No - I do not consent</p></div></div>
  </div></div>
<div class="education--container">
<div class="education--form"><hr><div class="education--header"><p class="body">Education</p></div>
  <div class="select"><label id="degree--0-label" for="degree--0">Degree</label><input id="degree--0"></div>
  <div><label for="end-year--0">End date year</label><input id="end-year--0" type="number"></div></div>
<div class="education--form"><hr><div class="education--header"><p class="body">Education</p></div>
  <div class="select"><label id="degree--1-label" for="degree--1">Degree</label><input id="degree--1"></div>
  <div><label for="end-year--1">End date year</label><input id="end-year--1" type="number"></div></div>
</div>
<script src="shadow-fixture.js"></script>
<script src="src/content/extract.js"></script>
<script src="src/content/fill.js"></script>
<script type="module" src="form-probe.js"></script>
</body>''')
# Web components with open shadow roots, shaped like SmartRecruiters' Spark
# inputs: the <input> and its <label> live inside the shadow root, and the
# city box offers suggestions as custom elements that must be clicked.
(build / 'shadow-fixture.js').write_text('''
customElements.define('x-field', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<label for="${this.id}">${this.getAttribute('label')}*</label><input id="${this.id}">`;
  }
});
// SmartRecruiters passes the question in through a slot: the label inside
// the shadow root holds only <slot> and the required mark.
customElements.define('x-slotted', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<label for="sd-degree"><slot name="label-content"></slot><span>*</span></label><input id="sd-degree">';
  }
});
customElements.define('x-option', class extends HTMLElement {});
customElements.define('x-city', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<label for="c">City*</label><input id="c" role="combobox" aria-autocomplete="list"><div id="menu"></div>';
    const input = root.getElementById('c');
    input.addEventListener('input', () => {
      root.getElementById('menu').innerHTML = input.value
        ? ['Oakland, NJ, US', 'Oakland, CA, US'].map(t => `<x-option>${t}</x-option>`).join('') : '';
      root.querySelectorAll('x-option').forEach(o => o.addEventListener('click', () => {
        this.dataset.chosen = o.textContent; input.value = o.textContent; root.getElementById('menu').innerHTML = '';
      }));
    });
  }
});
''')
(build / 'form-probe.js').write_text('''
import { scopeOf } from './src/background/scope.js';
const { fields, uploads } = await globalThis.__applicatorExtract();
window.__uploads = uploads;
window.__sms = fields.filter(f => /text you/.test(f.label || '')).map(f => ({ label: f.label, type: f.type, widget: f.widget, options: (f.options || []).map(o => o.label) }));
const first = fields.find(f => f.idAttr === 'sd-first');
const city = fields.find(f => f.label === 'City*' && f.combobox);
await globalThis.__applicatorFill({ items: [{ ...first, value: 'Pat' }, { ...city, value: 'Oakland' }], highlight: true });
const picked = await globalThis.__applicatorPickSuggestions({ items: [{ id: city.id, selector: city.selector, value: 'Oakland', hint: 'CA, United States' }] });
window.__shadow = {
  found: !!first && !!city,
  autocomplete: first && first.autocomplete,
  filled: document.getElementById('sd-first').shadowRoot.querySelector('input').value,
  chosen: document.getElementById('sd-city').dataset.chosen || '',
  picked: picked.results[0].ok
};
const rs = fields.find(f => f.idAttr === 'rs-in');
if (rs) await globalThis.__applicatorFill({ items: [{ ...rs, value: 'Canada' }], highlight: true });
window.__outlined = document.getElementById('rs-ctl').className;
window.__probe = Object.fromEntries(fields.map(f => [f.idAttr, { section: f.section, scope: scopeOf(f).scope, repeat: f.repeatRaw, label: f.label, name: f.name }]));
''')


# --- an application shaped like the ones that went wrong ---------------------
# Served over HTTP on three origins so frames are real cross-origin frames:
# the page on 127.0.0.1, an embedded form on localhost (granted), and a second
# embed on [::1] (not granted).
site = pathlib.Path(tempfile.mkdtemp(prefix='applicator-site-'))
(site / 'app.html').write_text('''<!doctype html><meta charset="utf-8"><title>Backend Engineer at Acme</title>
<body><h1>Backend Engineer</h1><form id="application" onsubmit="return false">
<h2>Your details</h2>
<label for="fn">First name</label><input id="fn" autocomplete="given-name">
<label for="ln">Last name</label><input id="ln" name="last_name">
<label for="em">Email</label><input id="em" name="email" type="email">
<label for="ph">Mobile phone</label><input id="ph" name="mobile" type="tel" placeholder="(555) 555-5555">
<label for="csz">Company size (employees)</label><input id="csz" name="company_headcount">
<label for="size">Company size</label>
<select id="size" name="company_size"><option value="">Select</option><option>1-10</option><option>11-50</option><option>51-200</option></select>

<div class="question"><div class="question-text">Are you legally authorized to work in the United States?</div>
  <label><input type="radio" value="yes"> Yes</label><label><input type="radio" value="no"> No</label></div>
<div class="question"><div class="question-text">Will you now or in the future require sponsorship for employment visa status?</div>
  <label><input type="radio" value="yes"> Yes</label><label><input type="radio" value="no"> No</label></div>

<div role="radiogroup" aria-label="Are you willing to relocate?" id="relocate">
  <div role="radio" aria-checked="false" tabindex="0">Yes</div><div role="radio" aria-checked="false" tabindex="0">No</div></div>

<span id="hh-label">How did you hear about us?</span>
<div role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="hh-label hh" id="hh" tabindex="0">Select...</div>
<span id="pt-label">Phone type</span>
<div role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="pt-label pt" id="pt" tabindex="0">Select...</div>

<label for="nc">Are you bound by a non-compete agreement?</label>
<select id="nc" name="noncompete"><option value="">Select</option><option>Yes</option><option>No</option></select>
<div id="nc-more"></div>

<section><h2>References</h2>
  <label for="r-name">Name</label><input id="r-name" name="ref_name">
  <label for="r-first">First name</label><input id="r-first" name="ref_first">
  <label for="r-phone">Phone</label><input id="r-phone" name="ref_phone" type="tel">
  <label for="r-rel">Relationship</label><input id="r-rel" name="ref_relationship">
</section>
<div role="checkbox" aria-checked="false" tabindex="0" id="agree">I agree to the privacy policy</div>
<iframe src="http://localhost:8765/embed.html" width="600" height="220" id="granted"></iframe>
<iframe src="http://[::1]:8765/embed.html" width="600" height="220" id="ungranted"></iframe>
<button type="button">Next</button>
</form>
<script src="app.js"></script></body>''')
(site / 'app.js').write_text('''
// A phone box that only keeps ten digits, formatted, like common input masks.
const ph = document.getElementById("ph");
ph.addEventListener("input", () => {
  const d = ph.value.replace(/\\D/g, "").slice(0, 10);
  ph.value = d.length > 6 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : d.length > 3 ? `(${d.slice(0,3)}) ${d.slice(3)}` : d;
});
// Styled radios: clicking one checks it and clears the rest of its group.
for (const radio of document.querySelectorAll("#relocate [role=radio]")) {
  radio.addEventListener("click", () => {
    for (const r of radio.parentElement.children) r.setAttribute("aria-checked", String(r === radio));
  });
}
const agree = document.getElementById("agree");
agree.addEventListener("click", () => agree.setAttribute("aria-checked", String(agree.getAttribute("aria-checked") !== "true")));
// Dropdowns drawn as a portal list, opened on mousedown (MUI) or on click.
function dropdown(id, options, openOn) {
  const trigger = document.getElementById(id);
  trigger.addEventListener(openOn, () => {
    if (document.getElementById(id + "-list")) return;
    const list = document.createElement("ul");
    list.id = id + "-list"; list.setAttribute("role", "listbox");
    for (const text of options) {
      const li = document.createElement("li");
      li.setAttribute("role", "option"); li.textContent = text;
      li.addEventListener("click", () => { trigger.textContent = text; trigger.setAttribute("aria-expanded", "false"); list.remove(); });
      list.appendChild(li);
    }
    document.body.appendChild(list);
    trigger.setAttribute("aria-controls", list.id); trigger.setAttribute("aria-expanded", "true");
  });
}
// Like real libraries, an open list closes on Escape or a press elsewhere.
document.addEventListener("keydown", e => {
  if (e.key === "Escape") document.querySelectorAll("[role=listbox]").forEach(l => l.remove());
});
document.addEventListener("mousedown", e => {
  for (const l of document.querySelectorAll("[role=listbox]")) {
    const trigger = document.querySelector(`[aria-controls="${l.id}"]`);
    if (!l.contains(e.target) && !(trigger && trigger.contains(e.target))) l.remove();
  }
});
dropdown("hh", ["LinkedIn", "Indeed", "Referral", "Other"], "mousedown");
dropdown("pt", ["Mobile", "Home", "Work"], "click");
// Answering yes reveals the next question.
document.getElementById("nc").addEventListener("change", e => {
  document.getElementById("nc-more").innerHTML = e.target.value === "Yes"
    ? '<label for="nci">Which industry or companies does it cover?</label><input id="nci" name="nc_scope">' : "";
});
''')
(site / 'step2.html').write_text('''<!doctype html><meta charset="utf-8"><title>Step 2</title><body>
<h1>Step 2 of 3</h1><h2>Professional reference</h2>
<label for="r-name">Name</label><input id="r-name" name="ref_name">
<label for="r-phone">Phone</label><input id="r-phone" name="ref_phone" type="tel">
<label for="r-rel">Relationship</label><input id="r-rel" name="ref_relationship">
</body>''')
# CalCareers adds one school at a time, and lists the schools already added
# above the form as buttons: the school's name is a button's value, not text.
(site / 'calcareers.html').write_text('''<!doctype html><meta charset="utf-8"><title>CalCareers</title><body>
<h2>Education</h2>
<table id="cphMainContent_ucEducation_gvCollegeEducation"><caption>College Education Grid</caption>
<thead><tr><th>Institution Name and Location</th><th>Course of Study</th><th>Delete?</th></tr></thead>
<tbody><tr><td><input type="submit" name="ctl00$gvCollegeEducation$ctl02$btnEditEducation" value="Portland State University"
  onclick="return false"><br>Portland</td><td>Economics</td><td><input type="submit" value="Delete" onclick="return false"></td></tr></tbody></table>
<h3>University/College</h3>
<label for="edu-name">Institution Name: **</label><input id="edu-name" name="ctl00$ucEducation$txtNameEducationRecord">
</body>''')
# PeopleSoft: changing a select posts the page back, and 300 ms later the
# server's answer redraws the form from the values it was sent, so a box
# written in between is put back.
(site / 'postback.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body>
<form name="win0"><input type="hidden" name="ICStateNum" value="126">
<label for="pb-type">Phone Type</label>
<select id="pb-type" name="PHONE_TYPE" onchange="addchg_win0(this);submitAction_win0(this.form,this.name);"><option value="W">Work</option><option value="M">Mobile</option></select>
<div id="pb-c"><label for="pb-country">Country</label><select id="pb-country" name="COUNTRY"><option>Canada</option><option>United States</option></select></div>
</form>
<script>
function addchg_win0() {}
function submitAction_win0(form) {
  const sent = document.getElementById('pb-country').value;
  setTimeout(() => {
    document.getElementById('pb-c').innerHTML = '<label for="pb-country">Country</label><select id="pb-country" name="COUNTRY">' +
      ['Canada', 'United States'].map(c => `<option${c === sent ? ' selected' : ''}>${c}</option>`).join('') + '</select>';
    form.ICStateNum.value = String(Number(form.ICStateNum.value) + 1);
  }, 300);
}
</script></body>''')
# An upload the page refuses after it starts: the box says so a moment later,
# while its instructions already mention "too large".
(site / 'upload.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body>
<label for="u-email">Email</label><input id="u-email" name="email" type="email">
<div><label for="u-cv">Resume/CV</label><p>PDF only; files that are too large are refused.</p>
  <input id="u-cv" type="file" name="resume"><button type="button">Upload</button><span id="u-state"></span></div>
<script>
document.getElementById('u-cv').addEventListener('change', () => {
  document.getElementById('u-state').textContent = 'Uploading...';
  setTimeout(() => { document.getElementById('u-state').textContent = 'Upload failed. Please try again.'; }, 300);
});
</script></body>''')
# Greenhouse's follow-ups that name their own condition (Taskrabbit): a long
# required "If you will require sponsorship, please specify ..." after the
# sponsorship question answered No, and "If you will require relocation, what
# is your timeline?" under an unrelated in-office question.
(site / 'sponsor.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body><form onsubmit="return false">
<label for="s-email">Email *</label><input id="s-email" name="97fd04c2-2fa3-48d9-97e6-c6f2f7e8e878" type="email">
<label for="s-office">Our team works in the office three days a week. Are you able to do so?</label>
<select id="s-office" name="office"><option value="">Select...</option><option>Yes</option><option>No</option></select>
<label for="s-reloc">If you will require relocation, what is your expected timeline? *</label><input id="s-reloc" name="reloc" required>
<label for="s-spon">Will you now, or in the future, require sponsorship for an immigration-related employment benefit? *</label>
<select id="s-spon" name="spon" required><option value="">Select...</option><option>Yes</option><option>No</option></select>
<label for="s-type">If you will require sponsorship, please specify the type of assistance you would need (e.g., 'I currently hold an H-1B and require a transfer' or 'I am on F-1 OPT and will need future sponsorship') *</label>
<input id="s-type" name="type" required maxlength="255">
<label for="s-heard">How did you hear about this opportunity? *</label>
<select id="s-heard" name="heard" required><option value="">Select...</option><option>Company Website</option><option>LinkedIn</option><option>Other</option></select>
<label for="s-spec">Please specify *</label><input id="s-spec" name="spec" required>
</form></body>''')
# The practice form's radios: a page's own box called "choices" (the class
# Choices.js gives its select skin) once hid every radio and tick box in it.
(site / 'choices.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body><form onsubmit="return false">
<p>Will you now or in the future require visa sponsorship? *</p>
<div class="choices" role="radiogroup" aria-label="Will you now or in the future require visa sponsorship?">
<label><input type="radio" name="sponsorship" value="Yes" required> Yes</label><label><input type="radio" name="sponsorship" value="No"> No</label></div>
</form></body>''')
# A required question nothing saved answers: marked on the page for the user
# (its dropdown carries a style sheet, as Saildrone's react-select does: not an answer)
# to answer there and tick, and saved for next time.
(site / 'ask.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body><form onsubmit="return false">
<label for="a-email">Email *</label><input id="a-email" name="email" type="email">
<label for="a-shirt">Which T-shirt size should we send you? *</label><input id="a-shirt" name="shirt" required>
<div style="width:420px">
<label id="a-pol-l" for="a-pol">Which badge colour do you want? *</label>
<div class="select__control" id="a-polc" style="border:1px solid #999;height:36px;position:relative">
  <div class="select__value-container" id="a-polv"><style>.remix-css-1jqq78o{grid-area:1/1/2/3;margin-left:2px}</style><input id="a-pol" role="combobox" aria-required="true" aria-labelledby="a-pol-l" aria-expanded="false" style="width:2px;border:0"></div>
</div>
<div class="select__menu" id="a-polm" role="listbox" hidden style="position:absolute;width:420px;background:#eee;z-index:5">
  <div role="option" class="select__option">Blue</div><div role="option" class="select__option">Green</div></div>
</div>
<script>
const ctl = document.getElementById('a-polc'), menu = document.getElementById('a-polm');
ctl.addEventListener('mousedown', () => { menu.hidden = false; document.getElementById('a-pol').setAttribute('aria-expanded', 'true'); });
menu.addEventListener('click', e => {
  if (e.target.getAttribute('role') !== 'option') return;
  menu.hidden = true;
  document.getElementById('a-pol').setAttribute('aria-expanded', 'false');
  document.getElementById('a-polv').insertAdjacentHTML('afterbegin', '<div class="select__single-value">' + e.target.textContent + '</div>');
});
</script>
</form></body>''')
# Workday's My Experience: job blocks whose ids count every control on the
# page (workExperience-4, -15), and From/To dates as "Month" and "Year" boxes
# under a "From" or "To" heading (Accenture: jobs 2-5 left empty, the first
# job's To given its start date).
def wd_job(n, c):
    p = f'workExperience-{c}--'
    date = lambda which, word: (f'<fieldset><legend>{word}*</legend>'
        f'<input role="spinbutton" aria-label="Month" id="{p}{which}-dateSectionMonth-input">'
        f'<input role="spinbutton" aria-label="Year" id="{p}{which}-dateSectionYear-input"></fieldset>')
    return (f'<div role="group" aria-labelledby="h{c}"><h4 id="h{c}">Work Experience {n}</h4>'
            f'<label for="{p}jobTitle">Job Title*</label><input id="{p}jobTitle" name="jobTitle" aria-required="true">'
            f'<label for="{p}companyName">Company*</label><input id="{p}companyName" name="companyName" aria-required="true">'
            + date('startDate', 'From') + date('endDate', 'To') + '</div>')
(site / 'wdjobs.html').write_text('<!doctype html><meta charset="utf-8"><title>My Experience</title><body><main><h2>My Experience</h2><h3>Work Experience</h3>'
    + wd_job(1, 4) + wd_job(2, 15) + '</main></body>')
# Each Workday job block has its own "I currently work here" box, and all of
# them are named "currentlyWorkHere" (Accenture: five read as one question).
wd_current = lambda c: (f'<div><label for="workExperience-{c}--currentlyWorkHere">I currently work here</label>'
    f'<input id="workExperience-{c}--currentlyWorkHere" type="checkbox" name="currentlyWorkHere" aria-checked="false"></div>')
(site / 'wdcurrent.html').write_text('<!doctype html><meta charset="utf-8"><title>My Experience</title><body><main><h2>My Experience</h2><h3>Work Experience</h3>'
    + ''.join(wd_job(n, c).replace('<fieldset>', wd_current(c) + '<fieldset>', 1) for n, c in ((1, 4), (2, 15), (3, 28))) + '</main></body>')
# Workday's My Experience as it opens: one empty job block with "Add
# Another" under Work Experience, and Education with only an "Add" button.
# Each press adds a block whose ids carry the page's next counter.
(site / 'wdadd.html').write_text('''<!doctype html><meta charset="utf-8"><title>My Experience</title><body><main><h2>My Experience</h2>
<div role="group" aria-labelledby="we"><h3 id="we">Work Experience</h3><div id="jobs">''' + wd_job(1, 4) + '''</div>
<button data-automation-id="add-button" id="add-job">Add Another</button></div>
<div role="group" aria-labelledby="ed"><h3 id="ed">Education</h3><div id="schools"></div>
<button data-automation-id="add-button" id="add-school">Add</button></div>
<script>
let counter = 20, jobs = 1, schools = 0;
document.getElementById('add-job').addEventListener('click', () => {
  jobs++; const c = counter += 11, p = 'workExperience-' + c + '--';
  const date = (w, word) => '<fieldset><legend>' + word + '*</legend><input role="spinbutton" aria-label="Month" id="' + p + w + '-dateSectionMonth-input"><input role="spinbutton" aria-label="Year" id="' + p + w + '-dateSectionYear-input"></fieldset>';
  setTimeout(() => document.getElementById('jobs').insertAdjacentHTML('beforeend',
    '<div role="group" aria-labelledby="h' + c + '"><h4 id="h' + c + '">Work Experience ' + jobs + '</h4>' +
    '<label for="' + p + 'jobTitle">Job Title*</label><input id="' + p + 'jobTitle" name="jobTitle" aria-required="true">' +
    '<label for="' + p + 'companyName">Company*</label><input id="' + p + 'companyName" name="companyName" aria-required="true">' +
    date('startDate', 'From') + date('endDate', 'To') + '</div>'), 150);
});
document.getElementById('add-school').addEventListener('click', () => {
  schools++; const c = counter += 7, p = 'education-' + c + '--';
  setTimeout(() => document.getElementById('schools').insertAdjacentHTML('beforeend',
    '<div role="group" aria-labelledby="e' + c + '"><h4 id="e' + c + '">Education ' + schools + '</h4>' +
    '<label for="' + p + 'school">School or University*</label><input id="' + p + 'school" name="school" aria-required="true"></div>'), 150);
});
</script></main></body>''')
# A form that does not number its blocks: "+ Add another" under Employment
# History copies the block. A link that leaves the page is never pressed.
(site / 'plainadd.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body><form onsubmit="return false">
<h2>Employment History</h2><div id="emp"><div class="job">
<label>Employer <input name="employer"></label><label>Job title <input name="title"></label></div></div>
<button id="more">+ Add another</button>
<h2>References</h2><a href="/elsewhere.html" id="ref-link">Add reference</a>
<script>
document.getElementById('more').addEventListener('click', () => {
  const div = document.createElement('div'); div.className = 'job';
  div.innerHTML = '<label>Employer <input name="employer"></label><label>Job title <input name="title"></label>';
  document.getElementById('emp').append(div);
});
</script></form></body>''')
# Workday's School or University: a search box that lists nothing while you
# type, searches on Enter, and takes only a school clicked in the results.
# "Lakeside College" is listed as "Lakeside Community College"; "Nowhere Tech"
# is not listed at all, and gets "Other".
def wd_school(c):
    return (f'<div role="group" aria-labelledby="e{c}"><h4 id="e{c}">Education</h4>'
            f'<label for="education-{c}--school">School or University<abbr>*</abbr></label>'
            f'<div data-automation-id="multiSelectContainer" id="ms-{c}">'
            f'<input data-uxi-widget-type="selectinput" placeholder="Search" autocomplete="off" aria-required="true" id="education-{c}--school" value="">'
            f'<ul role="listbox" data-automation-id="selectedItemList"></ul>'
            f'<div data-automation-id="promptAriaInstruction" aria-hidden="true">0 items selected</div></div></div>')
(site / 'wdschool.html').write_text('<!doctype html><meta charset="utf-8"><title>My Experience</title><body><main><h2>My Experience</h2>'
    + wd_school(31) + wd_school(38) + '''</main>
<script>
const SCHOOLS = ["Lakeside Community College", "Portland State University", "Reed College", "Other"];
let popup = null;
function close() { if (popup) { popup.remove(); popup = null; } }
for (const input of document.querySelectorAll('input[data-uxi-widget-type=selectinput]')) {
  const box = input.closest('[data-automation-id=multiSelectContainer]');
  input.addEventListener('input', close);
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = SCHOOLS.filter(n => words.every(w => n.toLowerCase().includes(w)));
    setTimeout(() => {
      close();
      popup = document.createElement('div');
      popup.setAttribute('role', 'listbox');
      popup.setAttribute('data-automation-id', 'activeListContainer');
      for (const n of hits.length ? hits : ['No Items.']) {
        const o = document.createElement('div');
        o.setAttribute('role', 'option');
        o.setAttribute('data-automation-id', 'promptOption');
        o.textContent = n;
        if (hits.length) o.onclick = () => {
          box.querySelector('[data-automation-id=selectedItemList]').innerHTML =
            '<li><div role="option" data-automation-id="selectedItem"><p data-automation-id="promptOption">' + n + '</p></div></li>';
          box.querySelector('[data-automation-id=promptAriaInstruction]').textContent = '1 item selected, ' + n;
          input.value = '';
          close();
        };
        popup.append(o);
      }
      document.body.append(popup);
    }, 250);
  });
}
</script></body>''')
# A school search that never lists anything: without Cancel, phil would
# search on for many seconds.
(site / 'cancel.html').write_text((site / 'wdschool.html').read_text().replace(
    'const SCHOOLS = ["Lakeside Community College", "Portland State University", "Reed College", "Other"];', 'const SCHOOLS = [];'))
# Workday's My Experience as the Accenture review found it:
#  - search prompts (school, field of study, skills) that list nothing until
#    Enter, ignore a click while their list is still drawing, and keep only a
#    clicked entry, as a pill (the typed search alone once counted as kept);
#  - a job's dates showing 07 / 2023 whose year Workday never took, marked
#    "Error: Invalid Date", which take only key presses and commit on leaving;
#  - the CV already attached beside a drop zone that takes several files.
def wd_prompt(pid, label, req=False):
    return (f'<div data-automation-id="formField-{pid}"><label for="{pid}">{label}{"<abbr>*</abbr>" if req else ""}</label>'
            f'<div data-automation-id="multiSelectContainer"><input data-uxi-widget-type="selectinput" placeholder="Search" autocomplete="off" id="{pid}" value="">'
            f'<ul role="listbox" data-automation-id="selectedItemList"></ul>'
            f'<div data-automation-id="promptAriaInstruction" aria-hidden="true">0 items selected</div></div></div>')
def wd_spin(pid, which, word, month, year):
    return (f'<div data-automation-id="formField-{which}"><fieldset><legend><label>{word}<abbr>*</abbr></label></legend>'
            f'<div role="group" data-automation-id="dateInputWrapper">'
            f'<input role="spinbutton" aria-label="Month" id="{pid}{which}-dateSectionMonth-input" value="{month}" data-held="{month}">'
            f'<input role="spinbutton" aria-label="Year" id="{pid}{which}-dateSectionYear-input" value="{year}" data-held="">'
            f'</div><p data-automation-id="inputAlert"><span>Error: </span>Invalid Date: {month}/</p></fieldset></div>')
(site / 'wdmore.html').write_text('<!doctype html><meta charset="utf-8"><title>My Experience</title><body><main><h2>My Experience</h2>'
    + '<div role="group" aria-labelledby="wx"><h3 id="wx">Work Experience</h3><div role="group" aria-labelledby="h4"><h4 id="h4">Work Experience 1</h4>'
    + '<label for="workExperience-4--jobTitle">Job Title*</label><input id="workExperience-4--jobTitle" name="jobTitle" value="Engineer">'
    + '<label for="workExperience-4--companyName">Company*</label><input id="workExperience-4--companyName" name="companyName" value="Globex">'
    + wd_spin('workExperience-4--', 'startDate', 'From', '3', '2021') + wd_spin('workExperience-4--', 'endDate', 'To', '6', '2023') + '</div></div>'
    + '<div role="group" aria-labelledby="ed"><h3 id="ed">Education</h3>'
    + '<div role="group" aria-labelledby="e1"><h4 id="e1">Education 1</h4>' + wd_prompt('education-11--school', 'School or University', True)
    + wd_prompt('education-11--fieldOfStudy', 'Field of Study') + '<label for="education-11--gradeAverage">Overall Result (GPA)</label><input id="education-11--gradeAverage" name="gradeAverage"></div>'
    + '<div role="group" aria-labelledby="e2"><h4 id="e2">Education 2</h4>' + wd_prompt('education-18--school', 'School or University', True)
    + wd_prompt('education-18--fieldOfStudy', 'Field of Study') + '</div></div>'
    + '<div role="group" aria-labelledby="sk"><h3 id="sk">Skills</h3>' + wd_prompt('skills--skills', 'Type to Add Skills') + '</div>'
    + '<div role="group" aria-labelledby="rs"><h3 id="rs">Resume/CV</h3><div data-automation-id="attachments-FileUpload">'
    + '<div data-automation-id="file-upload-drop-zone"><button type="button" data-automation-id="select-files">Select files</button></div>'
    + '<input data-automation-id="file-upload-input-ref" type="file" multiple id="cvfiles"></div>'
    + '<div><div data-automation-id="file-upload-item"><span data-automation-id="file-upload-item-name">cv.pdf</span></div></div></div>'
    + """</main><script>
const LISTS = {
  school: ["Northfield University", "Northfield University Eastside", "Lakeside Community College", "Other"],
  fieldOfStudy: ["Accounting", "Computer Science", "Computer Science and Information Technology", "Liberal Arts", "Other"],
  skills: ["Python (Programming Language)", "SQL", "SQL Data Mining", "Airflow Management", "Airflow_Do Not Use", "Tableau (Software)", "Other"]
};
// As live: the field of study opens its whole list when typed into and is
// searched only by Enter; results arrive in stages; and only the node
// inside an entry takes the click (a click does not travel down to it).
let popup = null, shownAt = 0;
function close() { if (popup) { popup.remove(); popup = null; } }
const words = t => t.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
for (const input of document.querySelectorAll('input[data-uxi-widget-type=selectinput]')) {
  const box = input.closest('[data-automation-id=multiSelectContainer]');
  const list = LISTS[input.id.split('--')[1]];
  const multi = input.id.startsWith('skills');
  const whole = input.id.endsWith('fieldOfStudy');
  input.addEventListener('input', () => { if (whole && !popup) show(list); else if (!whole) close(); });
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const want = words(input.value);
    const hits = list.filter(n => want.every(w => words(n).some(x => x.startsWith(w))));
    setTimeout(() => { show(hits.slice(0, 1)); if (hits.length > 1) setTimeout(() => show(hits), 300); }, 150);
  });
  function show(hits) {
      close();
      popup = document.createElement('div');
      popup.setAttribute('role', 'listbox');
      popup.setAttribute('data-automation-id', 'activeListContainer');
      shownAt = Date.now();
      for (const n of hits.length ? hits : ['No Items.']) {
        const o = document.createElement('div');
        o.setAttribute('role', 'option');
        o.innerHTML = '<div data-automation-id="promptLeafNode">' + n + '</div>';
        if (hits.length) o.firstChild.onclick = () => {
          if (Date.now() - shownAt < 300) return;  // still drawing: the click is lost
          const ul = box.querySelector('[data-automation-id=selectedItemList]');
          const pill = '<li><div role="option" data-automation-id="selectedItem"><p data-automation-id="promptOption">' + n + '</p></div></li>';
          ul.innerHTML = multi ? ul.innerHTML + pill : pill;
          box.querySelector('[data-automation-id=promptAriaInstruction]').textContent = ul.children.length + ' items selected, ' + n;
          input.value = '';
          close();
        };
        popup.append(o);
      }
      document.body.append(popup);
  }
}
// Spin buttons: only key presses count, and they are taken when the box is left.
for (const sp of document.querySelectorAll('input[role=spinbutton]')) {
  let typed = '';
  sp.addEventListener('focusin', () => { typed = ''; });
  sp.addEventListener('keydown', e => { if (/^\d$/.test(e.key)) typed += e.key; });
  sp.addEventListener('focusout', () => {
    if (!typed) return;
    sp.dataset.held = String(Number(typed));
    sp.setAttribute('aria-valuenow', sp.dataset.held);
    sp.value = sp.dataset.held;
    const fs = sp.closest('fieldset');
    const ok = [...fs.querySelectorAll('input[role=spinbutton]')].every(i => i.dataset.held);
    fs.querySelector('[data-automation-id=inputAlert]').hidden = ok;
  });
}
</script></body>""")
# A CV for each kind of job: the one made for this job is attached, not the main one.
(site / 'cvpick.html').write_text('''<!doctype html><meta charset="utf-8"><title>Backend Software Engineer</title><body>
<h1>Backend Software Engineer</h1><main><p>Build payment services in Go and Python at Globex.</p></main><form>
<label for="c-email">Email</label><input id="c-email" name="email" type="email">
<label for="c-cv">Resume/CV</label><input id="c-cv" type="file" name="resume"></form></body>''')
# Ashby's application tab shows only the form: the posting is in the page's
# schema.org JobPosting, which phil reads for the role and the CV choice (Sesame).
(site / 'cvpick-ld.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title>
<script type="application/ld+json">{"@context": "https://schema.org", "@type": "JobPosting", "title": "Backend Software Engineer",
"hiringOrganization": {"@type": "Organization", "name": "Globex"},
"description": "<p><strong>About the role</strong></p><p>Join the software engineering team building payment services in Go and Python. You will design APIs, run them in production and keep them fast.</p><ul><li>Five years of backend engineering</li></ul>"}</script>
<body><form>
<label for="c-email">Email</label><input id="c-email" name="email" type="email">
<label for="c-cv">Resume/CV</label><input id="c-cv" type="file" name="resume"></form></body>''')
# Greenhouse's upload: once a file is in, the file input is replaced by the
# file's name and a "Remove file" button. The question is answered, not missed.
(site / 'ghupload.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body><form>
<label for="g-email">Email *</label><input id="g-email" name="email" type="email">
<div role="group" aria-labelledby="g-label" class="file-upload"><div id="g-label" class="label">Resume/CV<span>*</span></div>
  <div id="g-wrap"><input id="g-cv" type="file" name="resume"></div></div>
<script>
document.getElementById('g-cv').addEventListener('change', e => {
  const name = e.target.files[0].name;
  setTimeout(() => { document.getElementById('g-wrap').innerHTML = '<p>' + name + '</p><button type="button" aria-label="Remove file">x</button>'; }, 100);
});
</script></form></body>''')
# CalCareers' first education page: one ASP.NET radio list, whose question is a
# <label for> on the span around the radios (the group's aria-label is a short
# name), and jobs behind an "Add Employment Record" button that posts back.
(site / 'calcareers-add.html').write_text('''<!doctype html><meta charset="utf-8"><title>CalCareers</title><body>
<form onsubmit="return false"><h2>Education</h2>
<label for="rblHS">Did you graduate from High School?</label>
<span id="rblHS" class="rdoTable" role="group" aria-label="Graduate High School">
  <input id="hs0" type="radio" name="ctl00$cphMainContent$ucEducation$rblGraduateHighSchool" value="Y"><label for="hs0">Yes</label>
  <input id="hs1" type="radio" name="ctl00$cphMainContent$ucEducation$rblGraduateHighSchool" value="N"><label for="hs1">No</label></span>
<label for="edu-desc">Description</label><textarea id="edu-desc" name="txtEduDescription"></textarea>
<h2>Account</h2><label for="user">Username: **</label><input id="user" name="txtUserName">
<fieldset><legend>Which team would you join?<abbr class="requiredAsterisk" title="required"></abbr></legend>
  <select id="team" name="team"><option value="">Select One</option><option>Alpha</option><option>Beta</option></select></fieldset>
<h2>Employment History</h2><p>No job history data provided.</p>
<input type="submit" name="ctl00$btnAddEmployment" value="Add Employment Record">
</form></body>''')
# Identity questions as reviews found them answered with demographics off: an
# unlabelled SmartRecruiters gender dropdown, CalCareers' EEO "Age" radios, UC's
# race boxes labelled only by the option under a race heading, and a "Sexual
# Orientation" box that a saved custom answer ("Yes, I identify as LGBTQ+.")
# was typed into. One ordinary question shows the page is still filled.
(site / 'identity.html').write_text('''<!doctype html><meta charset="utf-8"><title>Self-identification</title><body>
<h2>Equal Employment Opportunity (EEO)</h2>
<fieldset><legend>Age</legend>
  <label><input type="radio" name="age" value="1">Under 21</label>
  <label><input type="radio" name="age" value="2">21 - 39</label>
  <label><input type="radio" name="age" value="3">40 or over</label></fieldset>
<div><select name="q_7f3a"><option value="">Select</option><option>Man</option><option>Woman</option><option>Non-binary</option></select></div>
<h3>Ethnicity and Race Identification</h3>
<div><input type="checkbox" id="eth-eu" name="UC_ETH_EUROPE_CHK"><label for="eth-eu">European</label></div>
<div><input type="checkbox" id="eth-af" name="UC_ETH_AMBLACK_CHK"><label for="eth-af">Black or African American</label></div>
<label for="orient">Sexual Orientation</label><input id="orient" name="GEND_ORNT_P_VW_DESCR">
<h2>Contact</h2>
<label for="em">Email</label><input id="em" name="email">
</body>''')
# Ashby's Yes/No questions: two buttons with aria-pressed over a hidden,
# unlabelled checkbox, and a description between the question and the
# buttons. The buttons are in a form and default to submit: pressing one must
# not send the form (this one does not stop the submit itself).
(site / 'ashby.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body>
<form action="/submitted.html">
<div class="ashby-application-form-field-entry">
  <label class="ashby-application-form-question-title" for="q-auth">Are you authorized to work in the country where the job is located?</label>
  <div class="ashby-application-form-question-description"><p>Our address is 100 Main St, Portland, OR</p></div>
  <div class="ashby-application-form-input-yesno" id="yn-auth">
    <button class="ashby-application-form-input-yesno-option" aria-pressed="false" data-option="yes">Yes</button>
    <button class="ashby-application-form-input-yesno-option" aria-pressed="false" data-option="no">No</button>
    <input type="checkbox" tabindex="-1" name="q-auth" style="position:absolute;width:0;height:0;opacity:0"></div>
</div>
<div class="ashby-application-form-field-entry">
  <label class="ashby-application-form-question-title" for="q-spon">Will you now or in the future require sponsorship for employment visa status?</label>
  <div class="ashby-application-form-input-yesno" id="yn-spon">
    <button class="ashby-application-form-input-yesno-option" aria-pressed="false" data-option="yes">Yes</button>
    <button class="ashby-application-form-input-yesno-option" aria-pressed="false" data-option="no">No</button>
    <input type="checkbox" tabindex="-1" name="q-spon" style="position:absolute;width:0;height:0;opacity:0"></div>
</div>
</form>
<script>
for (const group of document.querySelectorAll('.ashby-application-form-input-yesno')) {
  for (const b of group.querySelectorAll('button')) b.addEventListener('click', () => {
    for (const o of group.querySelectorAll('button')) o.setAttribute('aria-pressed', String(o === b));
    group.querySelector('input').checked = b.dataset.option === 'yes';
  });
}
</script>
</body>''')
(site / 'submitted.html').write_text('<!doctype html><title>Submitted</title><p>The form was submitted.</p>')
# UC's PeopleSoft status boxes: each <label> is a blank space and the words
# are in the next span, so nothing tells the boxes apart.
(site / 'uc-status.html').write_text('''<!doctype html><meta charset="utf-8"><title>Self-Identify - UC Affiliation</title><body>
<h2>UC Affiliation</h2><p>Select one or more of the following categories to describe yourself</p>
<div><input type="checkbox" id="UC_RM_CHK" name="UC_RM_CHK"><label for="UC_RM_CHK">&nbsp;</label><span class="ps-text">Retired from UC receiving monthly payment</span></div>
<div><input type="checkbox" id="UC_RP_CHK" name="UC_RP_CHK"><label for="UC_RP_CHK">&nbsp;</label><span class="ps-text">A UC career employee in a layoff with rehire privileges</span></div>
<label for="em2">Email</label><input id="em2" name="email">
</body>''')
# Greenhouse, as a review saw it: once one box is settled (there, the city), the page puts back
# an older copy of the form a moment later, clearing boxes already typed.
(site / 'reset.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body>
<label for="city">Phone</label><input id="city" name="phone" type="tel">
<label for="li">LinkedIn Profile</label><input id="li" name="linkedin">
<script>
let once = false;
document.getElementById('city').addEventListener('change', () => {
  if (once) return;
  once = true;
  // After the current task, as React's re-render is; not a timer, which a
  // background tab runs only once a second.
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { document.getElementById('li').value = ''; };
  ch.port2.postMessage(0);
});
</script>
</body>''')
# A form that keeps its own state, as Ashby's does on Modal: each change is
# saved a moment later on top of a copy of the state taken when it happened.
# Writes a person would make seconds apart, made in one task, overwrite each
# other, and the form says boxes that show an answer are missing.
# Workable: YES/NO wrappers around aria-hidden radios that answer only a
# click on that radio and draw new random ids on every render, and an
# Education editor that keeps its entry only once its Update is pressed.
(site / 'workable.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body>
<form id="application-form">
<label><span id="fn_label">First name</span><input id="firstname" name="firstname" aria-labelledby="fn_label" required></label>
<div data-ui="contact"><p>Contact</p><ul><li><div data-ui="editor" id="ed-phone">
  <label><span id="phone_label">Phone number</span><input id="phone" name="phone" type="tel" aria-labelledby="phone_label" required></label>
  <div><button data-ui="save-section" type="button">Update</button><button data-ui="cancel-section" type="button">Cancel</button></div>
</div></li></ul></div>
<div data-ui="other"><p>Other</p><ul><li><div data-ui="editor" id="ed-color">
  <label><span id="color_label">Favourite colour of your first bicycle</span><input id="color" name="color" aria-labelledby="color_label"></label>
  <div><button data-ui="save-section" type="button">Update</button><button data-ui="cancel-section" type="button">Cancel</button></div>
</div></li></ul></div>
<div id="q"></div>
<button type="submit">Submit application</button>
</form>
<script>
const state = { auth: '', saved: '' };
const rid = () => Math.random().toString(36).slice(2, 12);
function render() {
  const q = rid();
  document.getElementById('q').innerHTML = `<span id="${q}_label">Are you legally authorized to work in the United States?</span>
  <fieldset role="radiogroup" data-ui="QA_1" aria-labelledby="${q}_label">` + ['true', 'false'].map(v => { const o = rid(); return `
    <div data-ui="option" role="radio" id="wrapper_${o}" aria-labelledby="${q}_label radio_label_${o}" aria-checked="${state.auth === v}" tabindex="0">
      <label><input id="${o}" tabindex="-1" aria-hidden="true" type="radio" name="QA_1" value="${v}" style="position:absolute;opacity:0;width:1px;height:1px"><span id="radio_label_${o}">${v === 'true' ? 'YES' : 'NO'}</span></label></div>`; }).join('') + '</fieldset>';
  for (const input of document.querySelectorAll('#q input')) input.addEventListener('click', e => { state.auth = e.target.value; setTimeout(render, 30); });
}
render();
document.getElementById('firstname').addEventListener('input', () => setTimeout(render, 10));
for (const ed of document.querySelectorAll('[data-ui=editor]')) ed.querySelector('[data-ui=save-section]').addEventListener('click', () => {
  const box = ed.querySelector('input');
  state[box.id] = 'saved:' + box.value;
  ed.outerHTML = `<div data-ui="entry">${box.value}</div>`;
});
setInterval(() => { document.body.dataset.state = JSON.stringify(state); }, 50);
</script></body>''')

(site / 'stale.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body>
<form>
<label for="s-name">Name</label><input id="s-name" name="name">
<label for="s-email">Email</label><input id="s-email" name="email" type="email">
<label for="s-phone">Phone</label><input id="s-phone" name="phone" type="tel">
<fieldset><legend>Are you legally authorized to work in the United States?</legend>
  <label><input type="radio" name="auth" value="Yes">Yes</label><label><input type="radio" name="auth" value="No">No</label></fieldset>
<div class="upload"><label for="s-cv">Resume</label><input id="s-cv" name="resume" type="file"><button type="button" id="s-replace">Replace</button></div>
</form>
<script>
let state = {};
// The upload, as Ashby's: saved when it finishes, over the form as the upload
// box last saw it (it does not re-render for other answers, so: as the page
// loaded); its button is disabled meanwhile.
const seenByUpload = { ...state };
document.getElementById('s-cv').addEventListener('change', e => {
  const copy = { ...seenByUpload }, btn = document.getElementById('s-replace');
  btn.disabled = true;
  setTimeout(() => {
    state = { ...copy, resume: e.target.files[0]?.name || '' };
    document.body.dataset.state = JSON.stringify(state);
    btn.disabled = false;
  }, 1500);
});
const save = (k, v) => {
  const copy = { ...state };
  const ch = new MessageChannel();
  ch.port1.onmessage = () => { state = { ...copy, [k]: v }; document.body.dataset.state = JSON.stringify(state); };
  ch.port2.postMessage(0);
};
for (const el of document.querySelectorAll('input:not([type=file])')) {
  el.addEventListener(el.type === 'radio' ? 'change' : 'input', () => save(el.name, el.value));
}
</script>
</body>''')
# Ashby's "missing entry" list is kept from focus-out, not from typing. Here
# blur() does nothing for every other box, as when the browser window loses
# focus to another app mid-fill: those boxes show text the form never took.
(site / 'blur.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body>
<label for="b-name">Name</label><input id="b-name" name="name">
<label for="b-email">Email</label><input id="b-email" name="email" type="email">
<label for="b-phone">Phone</label><input id="b-phone" name="phone" type="tel">
<label for="b-li">LinkedIn Profile</label><input id="b-li" name="linkedin">
<script>
const taken = {};
let n = 0;
const blur = HTMLElement.prototype.blur;
HTMLElement.prototype.blur = function () { if (n++ % 2) blur.call(this); };
document.addEventListener('focusout', e => {
  if (e.target.name) { taken[e.target.name] = e.target.value; document.body.dataset.taken = JSON.stringify(taken); }
});
</script>
</body>''')
# SmartRecruiters' country list: each option holds two pieces whose class
# names also contain "-option" ("...-option-container-country", "...-code").
# Only the option itself is one; its pieces read as alternating names and codes.
(site / 'srlist.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body>
<label for="s-email">Email</label><input id="s-email" name="email" type="email">
<label id="s-lab">Country</label>
<button type="button" id="s-country" role="combobox" aria-haspopup="listbox" aria-labelledby="s-lab" aria-expanded="false" aria-controls="s-list">Select</button>
<div id="s-list" role="listbox" hidden></div>
<script>
const btn = document.getElementById('s-country'), list = document.getElementById('s-list');
const items = [['Afghanistan', '+93'], ['American Samoa', '+1'], ['Canada', '+1'], ['United States', '+1']];
list.innerHTML = items.map(([c, code]) => `<div class="spl-select-option"><span class="spl-select-option-container-country">${c}</span><span class="spl-select-option-container-code">${code}</span></div>`).join('');
const open = () => { list.hidden = false; btn.setAttribute('aria-expanded', 'true'); };
btn.addEventListener('click', open);
btn.addEventListener('keydown', e => { if (e.key === 'ArrowDown') open(); });
list.querySelectorAll('.spl-select-option').forEach(o => o.addEventListener('click', () => {
  btn.textContent = o.querySelector('.spl-select-option-container-country').textContent; list.hidden = true; btn.setAttribute('aria-expanded', 'false');
}));
</script>
</body>''')
# Runway's Location (Ashby) searches countries only: a city finds "No
# results", the country finds itself.
(site / 'country.html').write_text('''<!doctype html><meta charset="utf-8"><title>Data Analyst @ Globex</title><body>
<label for="c-email">Email</label><input id="c-email" name="email" type="email">
<label for="c-loc">Location</label>
<input id="c-loc" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" aria-controls="c-list" placeholder="Start typing...">
<div id="c-list" role="listbox"></div>
<script>
const COUNTRIES = ['United Kingdom', 'United States', 'United Arab Emirates', 'Canada', 'Bermuda', 'Brazil'];
const loc = document.getElementById('c-loc'), list = document.getElementById('c-list');
loc.addEventListener('input', () => {
  list.innerHTML = '';
  if (!loc.value) return;
  const hits = COUNTRIES.filter(c => c.toLowerCase().startsWith(loc.value.toLowerCase()));
  if (!hits.length) list.innerHTML = '<div class="empty"><p>No results</p></div>';
  for (const c of hits) {
    const o = document.createElement('div'); o.setAttribute('role', 'option'); o.textContent = c;
    o.addEventListener('click', () => { loc.value = c; list.innerHTML = ''; loc.setAttribute('aria-expanded', 'false'); });
    list.appendChild(o);
  }
  loc.setAttribute('aria-expanded', 'true');
});
</script>
</body>''')
# CalCareers' phone box is a MaskedEdit template, "(___) ___-____": a number
# written in all at once lands one slot off and loses its first digit; typed
# digits fill the slots in order.
(site / 'mask.html').write_text('''<!doctype html><meta charset="utf-8"><title>Contact</title><body>
<label for="m-email">Email</label><input id="m-email" name="email" type="email">
<label for="m-phone">Primary Phone</label><input id="m-phone" name="txtPhoneNumber" value="(___) ___-____">
<label for="m-type">Phone Type</label><select id="m-type" name="ddlPhoneType"><option value="W">Work</option><option value="M">Mobile</option></select>
<script>
const box = document.getElementById('m-phone');
const fit = d => { let i = 0; return '(___) ___-____'.replace(/_/g, () => d[i++] || '_'); };
box.addEventListener('input', e => {
  let d = box.value.replace(/\D/g, '');
  if (!(e.inputType === 'insertText' && (e.data || '').length === 1) && e.inputType !== 'deleteContentBackward') d = d.slice(1);
  box.value = fit(d.slice(0, 10));
});
</script>
</body>''')
# Abbott's work history (react-datepicker): a month picker with a year
# dropdown and a year picker paged by decade. Typed text is dropped when the
# box is left; only a date chosen in the calendar stays. Each box is labelled
# by a live region that announces the calendar, not by its question.
(site / 'datepickers.html').write_text('''<!doctype html><meta charset="utf-8"><title>Work and education</title><body>
<fieldset id="experienceData[0]"><legend>Work Experience</legend>
<label for="experienceData[0].companyName">Company Name</label><input id="experienceData[0].companyName" type="text">
<label for="experienceData[0].fromTo.startDate">From</label>
<div class="react-datepicker-wrapper"><div class="react-datepicker__input-container"><input type="text" id="experienceData[0].fromTo.startDate" data-kind="month" aria-labelledby="live-s"></div></div>
<div class="sr-only" aria-live="polite" id="live-s"></div>
<label for="experienceData[0].fromTo.endDate">To</label>
<div class="react-datepicker-wrapper"><div class="react-datepicker__input-container"><input type="text" id="experienceData[0].fromTo.endDate" data-kind="month" aria-labelledby="live-e"></div></div>
<div class="sr-only" aria-live="polite" id="live-e"></div>
</fieldset>
<fieldset id="educationData[0]"><legend>Education</legend>
<label for="educationData[0].schoolName">School or University</label><input id="educationData[0].schoolName" type="text">
<label for="educationData[0].fromTo.startDate">From</label>
<div class="react-datepicker-wrapper"><div class="react-datepicker__input-container"><input type="text" id="educationData[0].fromTo.startDate" data-kind="year" aria-labelledby="live-y"></div></div>
<div class="sr-only" aria-live="polite" id="live-y"></div>
</fieldset>
<script>
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const chosen = new Map();
let open = null;
function close() { if (open) { open.pop.remove(); document.getElementById(open.input.getAttribute('aria-labelledby')).textContent = ''; open = null; } }
function show(input) {
  if (open && open.input === input) return;
  close();
  const pop = document.createElement('div'); pop.className = 'react-datepicker';
  input.closest('.react-datepicker-wrapper').after(pop);
  open = { input, pop, year: 2026, decade: 2020 };
  document.getElementById(input.getAttribute('aria-labelledby')).textContent = 'Date picker opened. No date currently selected.';
  draw();
}
function draw() {
  const { input, pop } = open; pop.innerHTML = '';
  const pick = (label, value) => { const c = document.createElement('div'); c.setAttribute('role', 'option'); c.setAttribute('aria-label', 'Choose ' + label);
    c.className = input.dataset.kind === 'year' ? 'react-datepicker__year-text' : 'react-datepicker__month-text'; c.textContent = label.split(' ')[0].slice(0, 4);
    c.addEventListener('click', () => { chosen.set(input, value); input.value = value; close(); }); pop.appendChild(c); };
  if (input.dataset.kind === 'month') {
    const sel = document.createElement('select'); sel.className = 'range-select';
    for (let y = 1990; y <= 2026; y++) sel.add(new Option(String(y), String(y), false, y === open.year));
    sel.addEventListener('change', () => { open.year = Number(sel.value); draw(); });
    pop.appendChild(sel);
    MONTHS.forEach((m, i) => pick(m + ' ' + open.year, String(i + 1).padStart(2, '0') + '/' + open.year));
  } else {
    const nav = (cls, d) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'react-datepicker__navigation ' + cls;
      b.setAttribute('aria-label', d < 0 ? 'Previous Year' : 'Next Year'); b.addEventListener('click', () => { open.decade += d; draw(); }); pop.appendChild(b); };
    nav('react-datepicker__navigation--previous', -12); nav('react-datepicker__navigation--next', 12);
    for (let y = open.decade - 9; y <= open.decade + 2; y++) pick(String(y), String(y));
  }
}
for (const input of document.querySelectorAll('[data-kind]')) {
  input.addEventListener('click', () => show(input));
  input.addEventListener('focus', () => show(input));
  // Typed text it cannot read is dropped as soon as the box is left.
  input.addEventListener('blur', () => setTimeout(() => { if (input.value !== (chosen.get(input) || '')) input.value = chosen.get(input) || ''; }, 0));
}
document.addEventListener('mousedown', e => { if (open && !open.pop.contains(e.target) && e.target !== open.input) close(); });
</script>
</body>''')
# An identity question nothing saved answers, on a form that requires it
# (Reddit's sexual orientation): its own "prefer not to answer", never a guess.
(site / 'orient.html').write_text('''<!doctype html><meta charset="utf-8"><title>Voluntary survey</title><body>
<label for="q-email">Email</label><input id="q-email" name="email" type="email">
<fieldset><legend>Are you a person of transgender experience? *</legend>
<label><input type="radio" name="trans" value="Yes"> Yes</label>
<label><input type="radio" name="trans" value="No"> No</label>
<label><input type="radio" name="trans" value="Prefer not"> I prefer not to answer</label></fieldset>
<label for="q-vet">Are you a veteran? *</label>
<select id="q-vet" name="vet" required><option value="">Select...</option><option>I am a protected veteran</option><option>I am not a protected veteran</option><option>I decline to self-identify</option></select>
</body>''')
# Ashby's location box searches a server as you type; live, its first search
# once showed nothing (Mercor). Here the first round of typing gets no
# suggestions. Below it, two tick boxes are the options of one office question.
(site / 'place.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body>
<label for="p-email">Email</label><input id="p-email" name="email" type="email">
<label for="p-loc">Where are you currently located?</label>
<input id="p-loc" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" aria-controls="p-list" placeholder="Start typing...">
<ul id="p-list" role="listbox"></ul>
<fieldset><legend>Which office are you applying to? (Select both if appropriate)</legend>
<label><input type="checkbox" id="o-sf" name="San Francisco HQ - 1 Market Street"> San Francisco HQ - 1 Market Street</label>
<label><input type="checkbox" id="o-ny" name="New York City - 1 Broadway"> New York City - 1 Broadway</label>
</fieldset>
<script>
const loc = document.getElementById('p-loc'), list = document.getElementById('p-list');
let rounds = 0;
loc.addEventListener('input', e => {
  if (e.inputType === 'deleteContentBackward' && !loc.value) rounds++;
  list.innerHTML = '';
  if (rounds < 2 || loc.value.length < 3) return;
  for (const place of ['Oakland, California, United States', 'Oakland Springs, West Virginia, United States']) {
    if (!place.toLowerCase().startsWith(loc.value.toLowerCase())) continue;
    const li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = place;
    li.addEventListener('click', () => { loc.value = place; list.innerHTML = ''; loc.setAttribute('aria-expanded', 'false'); });
    list.appendChild(li);
  }
  loc.setAttribute('aria-expanded', String(!!list.children.length));
});
</script>
</body>''')
# Ashby's start date: a box that announces a pop-up like a dropdown, and
# picks a day when opened with keys. Reading the page must not pick one.
(site / 'datepick.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body>
<label for="d-email">Email</label><input id="d-email" name="email" type="email">
<label for="d-start">If offered a position, what is your ideal start-date?</label>
<input id="d-start" role="combobox" aria-haspopup="dialog" aria-expanded="false" placeholder="MM/DD/YYYY">
<script>
const d = document.getElementById('d-start');
const pick = () => { if (!d.value) d.value = 'PICKED-BY-OPENING'; };
d.addEventListener('keydown', pick); d.addEventListener('click', pick);
</script>
</body>''')
# Ashby saves every answer to its server as it changes (ApiSetFormValue) and
# submits the server's copy; saves sent before its form session exists are
# lost. On a slow line, answers that show on screen are "missing" on Submit.
(site / 'savefields.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body>
<label for="v-name">Name</label><input id="v-name" name="name">
<label for="v-email">Email</label><input id="v-email" name="email" type="email">
<label for="v-phone">Phone</label><input id="v-phone" name="phone" type="tel">
<script>
const saved = {};
let session = null;
fetch('/slow-session').then(r => r.json()).then(j => { session = j.session; });
for (const el of document.querySelectorAll('input')) {
  el.addEventListener('input', () => {
    if (!session) return; // no form session yet: the save goes nowhere
    fetch('/slow-save', { method: 'POST', body: JSON.stringify({ k: el.name, v: el.value }) })
      .then(r => r.json()).then(j => { saved[j.k] = j.v; document.body.dataset.saved = JSON.stringify(saved); });
  });
}
</script>
</body>''')
# Ashby's choices (Sentry): each click saves the whole form as the page holds
# it, and the slow reply replaces the page's copy. A click made while a save
# is out is undone when that reply lands: the box shows it, the server has not.
# Greenhouse's dropdowns in a slow embedded frame (Instacart): each shows
# "Loading..." for ~2 s before its options, so the first read runs out of
# time and the last lists are never opened. Filled blind, "LinkedIn" matched
# nothing among them; what the list showed when filled decides it again.
def slow_list(n, label, options):
    opts = ''.join(f'<div role="option" class="select__option">{o}</div>' for o in options)
    return (f'<div style="width:420px;margin:8px 0"><label id="sl{n}-l" for="sl{n}">{label}</label>'
            f'<div class="select__control" id="sl{n}c" style="border:1px solid #999;height:36px;position:relative">'
            f'<div class="select__value-container" id="sl{n}v"><input id="sl{n}" role="combobox" aria-labelledby="sl{n}-l" aria-expanded="false" style="width:2px;border:0"></div></div>'
            f'<div class="select__loading" id="sl{n}w" hidden>Loading...</div>'
            f'<div class="select__menu" id="sl{n}m" role="listbox" hidden style="position:absolute;width:420px;background:#eee;z-index:5">{opts}</div></div>')
(site / 'slowlists.html').write_text('<!doctype html><meta charset="utf-8"><title>Apply</title><body><form onsubmit="return false">'
    + ''.join(slow_list(n, f'Which project team interests you most ({n})?', ['Team A', 'Team B']) for n in range(1, 8))
    + slow_list(8, 'How did you hear about us?', ['Job Board', 'Referral', 'Other']) + '''
<script>
for (const input of document.querySelectorAll('input[role=combobox]')) {
  const id = input.id, menu = document.getElementById(id + 'm'), wait = document.getElementById(id + 'w');
  const open = () => {
    if (!menu.hidden || !wait.hidden) return;
    wait.hidden = false;
    setTimeout(() => { wait.hidden = true; menu.hidden = false; input.setAttribute('aria-expanded', 'true'); }, 1800);
  };
  input.addEventListener('keydown', e => { if (e.key === 'ArrowDown') open(); });
  document.getElementById(id + 'c').addEventListener('mousedown', open);
  // Like react-select: typed text is only a filter, cleared when the box is left.
  input.addEventListener('blur', () => setTimeout(() => { menu.hidden = true; wait.hidden = true; input.value = ''; input.setAttribute('aria-expanded', 'false'); }, 150));
  menu.addEventListener('mousedown', e => e.preventDefault());
  menu.addEventListener('click', e => {
    if (e.target.getAttribute('role') !== 'option') return;
    menu.hidden = true; input.setAttribute('aria-expanded', 'false');
    const v = document.getElementById(id + 'v');
    v.querySelector('.select__single-value')?.remove();
    v.insertAdjacentHTML('afterbegin', '<div class="select__single-value">' + e.target.textContent + '</div>');
  });
}
</script></form></body>''')
# A careers page embedding its form as a lazy iframe far below the fold
# (Lyft's Greenhouse embed): it holds no document until loaded, which read
# as a frame phil had no access to.
(site / 'lazyform.html').write_text('''<!doctype html><meta charset="utf-8"><title>Form</title><body><form onsubmit="return false">
<label for="lz-email">Email *</label><input id="lz-email" type="email" required></form></body>''')
(site / 'lazyframe.html').write_text('''<!doctype html><meta charset="utf-8"><title>Careers</title><body>
<h1>Business Systems Engineer</h1><div style="height:3000px">About the job.</div>
<iframe id="lz" loading="lazy" src="lazyform.html" width="640" height="150"></iframe></body>''')
(site / 'savewhole.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body>
<fieldset><legend>Are you legally authorized to work in the United States?</legend>
  <label><input type="radio" name="auth" value="Yes">Yes</label><label><input type="radio" name="auth" value="No">No</label></fieldset>
<fieldset><legend>Will you now or in the future require visa sponsorship?</legend>
  <label><input type="radio" name="sponsor" value="Yes">Yes</label><label><input type="radio" name="sponsor" value="No">No</label></fieldset>
<fieldset><legend>Are you at least 18 years of age?</legend>
  <label><input type="radio" name="adult" value="Yes">Yes</label><label><input type="radio" name="adult" value="No">No</label></fieldset>
<fieldset><legend>Are you willing to relocate?</legend>
  <label><input type="radio" name="relocate" value="Yes">Yes</label><label><input type="radio" name="relocate" value="No">No</label></fieldset>
<script>
let state = {};
for (const el of document.querySelectorAll('input')) {
  el.addEventListener('change', () => {
    state = { ...state, [el.name]: el.value };
    fetch('/slow-save', { method: 'POST', body: JSON.stringify(state) })
      .then(r => r.json()).then(j => { state = j; document.body.dataset.saved = JSON.stringify(j); });
  });
}
</script>
</body>''')
# A veteran self-identification page and nothing else (UC's VEVRAA step).
(site / 'veteran.html').write_text('''<!doctype html><meta charset="utf-8"><title>Veteran status</title><body>
<h2>Veteran Status</h2>
<fieldset><legend>Please select the veteran status which applies to you</legend>
  <label><input type="radio" name="VETERAN_STS" value="P">I identify as one or more of the classifications of protected veteran</label>
  <label><input type="radio" name="VETERAN_STS" value="N">I am not a protected veteran</label>
  <label><input type="radio" name="VETERAN_STS" value="D">I do not wish to self-identify</label></fieldset>
</body>''')
# Workday's preferred name: ticking the box reveals First and Last Name boxes
# under "Preferred Name", already holding a copy of the legal name.
(site / 'preferred.html').write_text('''<!doctype html><meta charset="utf-8"><title>My Information</title><body>
<h3>Legal Name</h3>
<label for="name--legalName--firstName">First Name</label><input id="name--legalName--firstName" name="legalName--firstName">
<label for="name--legalName--lastName">Last Name</label><input id="name--legalName--lastName" name="legalName--lastName">
<label><input type="checkbox" id="name--preferredCheck" name="preferredCheck">I have a preferred name</label>
<div id="pref"></div>
<script>
document.getElementById('name--preferredCheck').addEventListener('change', e => {
  const legal = document.getElementById('name--legalName--firstName').value;
  const last = document.getElementById('name--legalName--lastName').value;
  document.getElementById('pref').innerHTML = e.target.checked ? `<h4>Preferred Name</h4>
    <label for="name--preferredName--firstName">First Name</label><input id="name--preferredName--firstName" name="preferredName--firstName" value="${legal}">
    <label for="name--preferredName--lastName">Last Name</label><input id="name--preferredName--lastName" name="preferredName--lastName" value="${last}">` : '';
});
</script>
</body>''')
# YC's Work at a Startup: two unnamed tick boxes, Yes and No, with the question
# in a paragraph before them and no fieldset. The label rules read two fields
# called "Yes" and "No"; the page-structure round finds the question.
(site / 'yc.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body>
<p>This role is in Portland. Are you in Portland or willing to relocate to Portland? *</p>
<div class="grid"><label><input type="checkbox"> Yes</label><label><input type="checkbox"> No</label></div>
<label for="em3">Email</label><input id="em3" name="email">
</body>''')
# Workday, as it draws its application: ids that start with their section,
# search prompts that keep the choice as pills, a category that opens its own
# list, Month/Day/Year spin boxes for the date signed, and the site's menus in
# a header. The dial-code phone box is Recruitee's.
(site / 'workday.html').write_text('''<!doctype html><meta charset="utf-8"><title>Apply</title><body>
<header><div data-automation-id="utilityButtonBar">
  <button aria-haspopup="listbox" aria-expanded="false" id="languageSelectorButton"><span>English</span></button></div></header>
<main><h2>My Information</h2>
<div data-automation-id="formField-source">
  <label for="source--source">How Did You Hear About Us?<abbr>*</abbr></label>
  <div data-automation-id="multiSelectContainer" id="ms-source">
    <input data-uxi-widget-type="selectinput" placeholder="Search" autocomplete="off" aria-required="true" id="source--source" value="">
    <ul role="listbox" data-automation-id="selectedItemList"></ul>
    <div data-automation-id="promptAriaInstruction" aria-hidden="true">0 items selected</div>
  </div></div>
<div data-automation-id="formField-countryPhoneCode">
  <label for="phoneNumber--countryPhoneCode">Country Or Region Phone Code<abbr>*</abbr></label>
  <div data-automation-id="multiSelectContainer" id="ms-code">
    <input data-uxi-widget-type="selectinput" placeholder="Search" autocomplete="off" id="phoneNumber--countryPhoneCode" value="">
    <ul role="listbox" data-automation-id="selectedItemList"><li><div role="option" data-automation-id="selectedItem">
      <p data-automation-id="promptOption" data-automation-label="United States of America (+1)">United States of America (+1)</p></div></li></ul>
    <div data-automation-id="promptAriaInstruction" aria-hidden="true">1 item selected, United States of America (+1)</div>
  </div></div>
<div class="q-row"><div class="q-title">Which team would you like to join?*</div>
  <div class="fake-select"><div class="fake-value">Choose one</div></div></div>
<label for="shift">Preferred shift</label><select id="shift" name="shift"><option value="">Select</option><option>Day</option><option>Night</option></select>
<label for="candidate.phone">Phone number *</label><input type="tel" id="candidate.phone" name="candidate.phone" value="+31">
<div class="application-field"><label for="location-input">Current location</label>
  <input class="location-input" id="location-input" type="text" name="location"><input id="selected-location" type="hidden" name="selectedLocation">
  <div class="dropdown-container" style="display:none"><div class="dropdown-results"></div>
    <div class="dropdown-no-results" style="display:none">No location found. Try entering a different location</div></div></div>
<h2>Voluntary Self-Identification of Disability</h2>
<label for="selfIdentifiedDisabilityData--employeeId">Employee ID (if applicable)</label>
<input type="text" id="selfIdentifiedDisabilityData--employeeId" name="employeeId">
<fieldset><legend><label>Date<abbr>*</abbr></label></legend>
  <input role="spinbutton" aria-label="Month" id="selfIdentifiedDisabilityData--dateSignedOn-dateSectionMonth-input" value="">
  <input role="spinbutton" aria-label="Day" id="selfIdentifiedDisabilityData--dateSignedOn-dateSectionDay-input" value="">
  <input role="spinbutton" aria-label="Year" id="selfIdentifiedDisabilityData--dateSignedOn-dateSectionYear-input" value="">
</fieldset></main>
<script>
// As live Workday: the options arrive in stages, a category carries a side
// arrow, and its own list loads from the server into the same elements.
const TREE = { "Company Website": null, "Social Media": ["Facebook", "X"], "Job Board": ["Glassdoor", "Indeed", "LinkedIn"] };
let popup = null;
function close() { if (popup) { popup.remove(); popup = null; } }
function choose(box, label) {
  box.querySelector("[data-automation-id=selectedItemList]").innerHTML =
    `<li><div role="option" data-automation-id="selectedItem"><p data-automation-id="promptOption" data-automation-label="${label}">${label}</p></div></li>`;
  box.querySelector("[data-automation-id=promptAriaInstruction]").textContent = `1 item selected, ${label}`;
  box.querySelector("input").value = "";
  close();
}
function setOption(o, box, label) {
  o.setAttribute("data-automation-label", label);
  o.textContent = label;
  if (TREE[label]) o.setAttribute("data-uxi-multiselectlistitem-hassidecharm", "true");
  else o.removeAttribute("data-uxi-multiselectlistitem-hassidecharm");
  o.onclick = () => {
    const kids = TREE[label];
    if (kids) setTimeout(() => fillList(box, kids), 900); else choose(box, label);
  };
}
function fillList(box, labels) {
  const old = [...popup.children];
  labels.forEach((label, i) => {
    const o = old[i] || popup.appendChild(Object.assign(document.createElement("div"), {}));
    o.setAttribute("role", "option");
    o.setAttribute("data-automation-id", "promptOption");
    setOption(o, box, label);
  });
  old.slice(labels.length).forEach(o => o.remove());
}
function show(box, labels) {
  close();
  popup = document.createElement("div");
  popup.setAttribute("data-automation-id", "activeListContainer");
  popup.setAttribute("role", "listbox");
  document.body.append(popup);
  fillList(box, labels.slice(0, 2));
  if (labels.length > 2) setTimeout(() => { if (popup) fillList(box, labels); }, 120);
}
const source = document.getElementById("ms-source");
source.querySelector("input").addEventListener("click", () => show(source, Object.keys(TREE)));
source.querySelector("input").addEventListener("keydown", e => { if (e.key === "Escape") close(); });
// Lever's location box: suggestions for what is typed, a click picks one, and
// leaving with nothing picked clears the box.
const loc = document.getElementById("location-input");
const drop = document.querySelector(".dropdown-container");
loc.addEventListener("input", () => {
  const hits = /^oak/i.test(loc.value) ? ["Oakland, CA, USA", "Oakland, NJ, USA", "Oakland, MO, USA"] : [];
  setTimeout(() => {
    drop.style.display = hits.length ? "flex" : "none";
    drop.querySelector(".dropdown-results").innerHTML = hits.map((h, i) => `<div class="dropdown-location" id="location-${i}">${h}</div>`).join("");
    for (const d of drop.querySelectorAll(".dropdown-location")) d.addEventListener("click", () => {
      loc.value = d.textContent;
      document.getElementById("selected-location").value = d.textContent;
      drop.style.display = "none";
    });
  }, 150);
});
loc.addEventListener("blur", () => setTimeout(() => {
  if (!document.getElementById("selected-location").value) loc.value = "";
  drop.style.display = "none";
}, 100));
const code = document.getElementById("ms-code");
code.querySelector("input").addEventListener("click", () => show(code, ["Netherlands (+31)", "United States of America (+1)"]));
</script></body>''')
(site / 'embed.html').write_text('''<!doctype html><meta charset="utf-8"><body>
<label for="li">LinkedIn profile</label><input id="li" name="linkedin">
<label for="ce">Current employer</label><input id="ce" name="current_employer">
</body>''')


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    # A slow server for forms that save as they go (savefields.html).
    def do_GET(self):
        if self.path.startswith('/slow-session'):
            time.sleep(1.5)
            return self._reply('{"session": "s1"}')
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith('/slow-save'):
            body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            time.sleep(1.2)
            return self._reply(body.decode() or '{}')
        self.send_error(404)

    def _reply(self, text):
        data = text.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class DualStack(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6
    daemon_threads = True  # an open connection must not hold the script at exit

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


# Any free port: a fixed one can be taken by something else on the machine,
# which then answers "not found" for every fixture.
server = DualStack(('::', 0), functools.partial(Handler, directory=str(site)))
FIXTURE_PORT = server.server_address[1]
for path in site.iterdir():
    path.write_text(path.read_text().replace(':8765/', f':{FIXTURE_PORT}/'))
threading.Thread(target=server.serve_forever, daemon=True).start()

# Runs inside the options page, an extension page, so it drives the real
# orchestrator against a real tab. Only TypeSafe is stubbed: fetch to its API
# answers from a table of labels, the way the real model would on these fields.
(build / 'e2e.js').write_text('''
const NONE = "__none__";
const TABLE = [
  [/company size/i, NONE], [/authorized to work/i, "authorization.authorizedToWork"],
  [/sponsorship/i, "authorization.requiresSponsorship"], [/relocate/i, "preferences.willingToRelocate"],
  [/privacy policy/i, "preferences.agreeToTerms"], [/hear about/i, "preferences.howHeard"],
  [/phone type/i, "contact.phoneType"], [/phone/i, "contact.phone"],
  [/non-compete agreement/i, "preferences.nonCompete"], [/industry/i, "preferences.nonCompeteIndustry"],
  [/linkedin/i, "links.linkedin"], [/employer/i, "work.currentCompany"],
  [/first name/i, "identity.firstName"], [/last name/i, "identity.lastName"], [/email/i, "contact.email"],
  [/institution name/i, "education.school"], [/^name$/i, "identity.fullName"], [/relationship/i, "references.relationship"], [/current location|currently located|^location$/i, "address.location"], [/^country$/i, "address.country"], [/^to$/i, "employment.endDate"], [/graduate from high school/i, "work.highSchoolGraduate"],
  [/veteran status/i, "demographics.veteranStatus"], [/^job title\*?$/i, "employment.title"], [/^company\*?$/i, "employment.company"],
  [/^school or university\s*\*?$/i, "education.school"], [/^employer$/i, "employment.company"],
  [/^field of study$/i, "education.major"], [/^type to add skills$/i, "work.skills"], [/gpa/i, "education.gpa"],
  [/^i currently work here$/i, "employment.current"]
];
// Inside a references block the real model answers with the reference's own
// key; the stub does the same.
const IN_REFERENCE = { "identity.fullName": "references.fullName", "identity.firstName": "references.firstName",
  "contact.phone": "references.phone" };
const SAME = { cell: "Mobile", linkedin: "Job Board" };
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("api.typesafe.ai")) return realFetch(url, init);
  // A stalled request, as TypeSafe now and then has: it never answers until
  // cancelled. Only the first request of a fill marked to stall.
  if (window.__stall) {
    window.__stall = false;
    return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  }
  const body = JSON.parse(init.body);
  calls.push(body);
  const answers = {};
  const profile = body.state.candidate_profile || {};
  for (const [id, q] of Object.entries(body.questions)) {
    const keys = Object.keys(q.criteria);
    let choice = NONE;
    // Which CV goes with the job: the one made for a kind of job the role names.
    if (id === "cv" && body.state.cvs) {
      const role = String(body.state.application.role).toLowerCase();
      choice = keys.find(k => String(body.state.cvs[k].made_for || "").toLowerCase().split(/\\W+/).some(w => w.length > 3 && role.includes(w))) || keys[0];
      answers[id] = { type: "choice", choice, confidence: 0.9 };
      continue;
    }
    // The page-structure round (structure.js): an anonymous tick box takes the
    // question near it, as the real model does; anything named keeps its name.
    if (typeof q.instructions === "object" && typeof q.instructions.control === "string") {
      const marker = q.instructions.control;
      const lines = keys.filter(k => /^L\d+$/.test(k));
      // The longest nearby line: the question, in these fixtures.
      const asks = lines.slice().sort((a, b) => String(q.criteria[a]).length - String(q.criteria[b]).length).filter(k => String(q.criteria[k]).length > 30);
      if (/^option /.test(marker)) {
        answers[id] = { type: "choice", choice: "__none__", confidence: 0.5 };
      } else if (/: checkbox$/.test(marker) && asks.length) {
        answers[id] = { type: "choice", choice: asks[asks.length - 1], confidence: 0.95 };
      } else {
        answers[id] = { type: "choice", choice: "__self__", confidence: 0.2 };
      }
      continue;
    }
    if (typeof q.instructions === "object" && /^Which option/.test(q.instructions.question)) {
      // A dropdown asked about its own options: answer with the option that
      // says what the saved value says.
      const hit = TABLE.find(([re]) => re.test(q.instructions.form_field.label));
      const saved = hit && profile[hit[1]] ? String(profile[hit[1]].value).toLowerCase() : "";
      const want = (SAME[saved] || saved).toLowerCase();
      choice = keys.find(k => k.toLowerCase() === saved) || keys.find(k => k.toLowerCase() === want) ||
        (want.length > 2 && keys.find(k => k.toLowerCase().startsWith(want))) ||
        (want === "yes" && keys.find(k => /^yes/i.test(k))) || (want === "no" && keys.find(k => /^no/i.test(k))) || NONE;
    } else if (typeof q.instructions === "object") {
      const label = q.instructions.form_field.label;
      if (!/[a-z]/i.test(label.replace(/no label/i, "")) && keys.includes("preferences.agreeToTerms")) {
        answers[id] = { type: "choice", choice: "preferences.agreeToTerms", confidence: 0.88 };
        continue;
      }
      const hit = TABLE.find(([re]) => re.test(label));
      const inRef = /reference/i.test(q.instructions.form_field.headings_above || "");
      const key = hit && (inRef && IN_REFERENCE[hit[1]] ? IN_REFERENCE[hit[1]] : hit[1]);
      if (key && keys.includes(key)) choice = key;
    } else if (/offers only these entries/.test(q.instructions)) {
      // The closest entry for an answer a searched list lacks (pickEquivalents):
      // the one sharing the most words, as the model picks; else the list's Other.
      const own = (/(?:own answer is|skill is) "([^"]*)"/.exec(q.instructions) || [])[1] || "";
      const words = t => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));
      const mine = words(own);
      let best = NONE, most = 0;
      for (const k of keys) {
        const shared = [...words(String(q.criteria[k]))].filter(w => mine.has(w)).length;
        if (shared > most) { most = shared; best = k; }
      }
      choice = best !== NONE ? best : (keys.find(k => /^other$/i.test(String(q.criteria[k]).trim())) || NONE);
    } else {
      const said = (/answer to that question is "([^"]*)"/.exec(q.instructions) || [])[1] || "";
      const want = (SAME[said.toLowerCase()] || said).toLowerCase();
      choice = keys.find(k => k.toLowerCase() === want) || NONE;
    }
    // The model unsure, as it is on a question the profile only hints at.
    // Bare "Month" and "Year" boxes too: live, it read Workday's at 0.36-0.67.
    const unsure = typeof q.instructions === "object" && (/preferred shift/i.test(q.instructions.form_field.label) ||
      (/^(month|year)$/i.test(q.instructions.form_field.label) && choice === NONE));
    if (unsure && /preferred shift/i.test(q.instructions.form_field.label)) choice = "Day";
    answers[id] = { type: "choice", choice, confidence: unsure ? 0.45 : 0.95 };
  }
  return new Response(JSON.stringify({ model: "stub", answers, usage: { input_tokens: 1, output_tokens: 0 } }),
    { status: 200, headers: { "content-type": "application/json" } });
};

window.__e2e = "idle";
window.__e2eStep = "idle";
// A later fill on another page of the same site, in the same session.
window.addEventListener("hashchange", async () => {
  if (!location.hash.startsWith("#step")) return;
  window.__e2eStep = "running";
  window.__stall = location.hash === "#step-stall";
  try {
    if (location.hash === "#step-preferred") {
      const store = await import("./src/background/storage.js");
      await store.saveProfile({ ...(await store.getProfile()), "identity.preferredName": "Sam" });
    }
    if (location.hash === "#step-identity") {
      const store = await import("./src/background/storage.js");
      await store.saveSettings({ ...(await store.getSettings()), fillDemographics: false });
      await store.saveProfile({ ...(await store.getProfile()),
        custom: [{ id: "lgbt1", question: "Yes, I identify as LGBTQ+.", answer: "yes" }] });
    }
    if (location.hash === "#step-stale") {
      const store = await import("./src/background/storage.js");
      await store.saveDocument("resume", { filename: "cv.pdf", mimeType: "application/pdf", data: btoa("%PDF-1.4 test") });
    }
    if (location.hash === "#step-datepickers") {
      const store = await import("./src/background/storage.js");
      await store.saveProfile({ ...(await store.getProfile()),
        employment: [{ company: "Globex", title: "Engineer", startDate: "2021-03", endDate: "2023-06" }],
        education: [{ school: "Portland State University", startYear: "2014", endYear: "2016" }] });
    }
    if (location.hash === "#step-orient") {
      const store = await import("./src/background/storage.js");
      await store.saveSettings({ ...(await store.getSettings()), fillDemographics: true });
      await store.saveProfile({ ...(await store.getProfile()), "demographics.gender": "Male", "demographics.veteranStatus": "" });
    }
    if (location.hash === "#step-veteran-saved") {
      const store = await import("./src/background/storage.js");
      await store.saveProfile({ ...(await store.getProfile()), "demographics.veteranStatus": "I am not a protected veteran" });
    }
    if (location.hash === "#step-country") {
      const store = await import("./src/background/storage.js");
      await store.saveProfile({ ...(await store.getProfile()), "address.location": "Oakland, California" });
    }
    if (location.hash === "#step-place") {
      const store = await import("./src/background/storage.js");
      await store.saveProfile({ ...(await store.getProfile()), "address.location": "Oakland, California" });
    }
    if (location.hash === "#step-upload") {
      const store = await import("./src/background/storage.js");
      await store.saveDocument("resume", { filename: "cv.pdf", mimeType: "application/pdf", data: btoa("%PDF-1.4 test") });
    }
    if (location.hash === "#step-wdjobs") {
      const store = await import("./src/background/storage.js");
      await store.saveProfile({ ...(await store.getProfile()), employment: [
        { company: "Globex", title: "Engineer", startDate: "2021-03", endDate: "2023-06" },
        { company: "Acme", title: "Analyst", startDate: "2018-01", endDate: "2021-02" }] });
    }
    if (location.hash === "#step-wdcurrent") {
      const store = await import("./src/background/storage.js");
      await store.saveProfile({ ...(await store.getProfile()), employment: [
        { company: "Globex", title: "Engineer", startDate: "2023-07", current: true },
        { company: "Acme", title: "Analyst", startDate: "2021-03", endDate: "2023-06" },
        { company: "Initech", title: "Intern", startDate: "2018-01", endDate: "2021-02" }] });
    }
    if (location.hash === "#step-wdadd" || location.hash === "#step-plainadd") {
      const store = await import("./src/background/storage.js");
      await store.saveProfile({ ...(await store.getProfile()), employment: [
        { company: "Globex", title: "Engineer", startDate: "2021-03", endDate: "2023-06" },
        { company: "Acme", title: "Analyst", startDate: "2018-01", endDate: "2021-02" }],
        education: [{ school: "Portland State University", degree: "BA" }],
        references: [{ fullName: "Bob Diaz", phone: "4155550102" }] });
    }
    if (location.hash === "#step-wdschool") {
      const store = await import("./src/background/storage.js");
      await store.saveProfile({ ...(await store.getProfile()),
        education: [{ school: "Lakeside College", degree: "AA" }, { school: "Nowhere Tech", degree: "BA" }] });
    }
    if (location.hash === "#step-cancel") {
      const store = await import("./src/background/storage.js");
      await store.saveProfile({ ...(await store.getProfile()),
        education: [{ school: "Lakeside College" }, { school: "Nowhere Tech" }] });
    }
    if (location.hash === "#step-wdmore") {
      const store = await import("./src/background/storage.js");
      await store.saveDocument("resume", { filename: "cv.pdf", mimeType: "application/pdf", data: btoa("%PDF-1.4 test") });
      await store.saveProfile({ ...(await store.getProfile()), "work.skills": "Python, SQL, Cobol",
        employment: [{ company: "Globex", title: "Engineer", startDate: "2021-03", endDate: "2023-06" }],
        education: [{ school: "Northfield University", major: "Computer Science & Game Design", gpa: "3.5" },
                    { school: "Lakeside College", major: "Transfer Pathway, Early Start" }] });
    }
    if (location.hash === "#step-cvpick" || location.hash === "#step-cvpick-ld") {
      const store = await import("./src/background/storage.js");
      await store.saveDocument("resume", null);
      await store.saveDocument("resume", { filename: "cv-retail.pdf", mimeType: "application/pdf", data: btoa("%PDF-1.4 retail"), category: "Retail, customer service" });
      await store.saveDocument("resume", { filename: "cv-eng.pdf", mimeType: "application/pdf", data: btoa("%PDF-1.4 eng"), category: "Software engineering", text: "Pat Brien. Backend engineer at Acme." });
    }
    if (location.hash === "#step-ghupload") {
      const store = await import("./src/background/storage.js");
      await store.saveDocument("resume", { filename: "cv.pdf", mimeType: "application/pdf", data: btoa("%PDF-1.4 test") });
    }
    if (location.hash === "#step-calcareers-add") {
      const store = await import("./src/background/storage.js");
      await store.saveProfile({ ...(await store.getProfile()), education: [{ school: "Portland State University", degree: "BA" }] });
    }
    if (location.hash === "#step-calcareers") {
      const store = await import("./src/background/storage.js");
      await store.saveProfile({ ...(await store.getProfile()), education: [
        { school: "Portland State University", city: "Portland" }, { school: "Reed College", city: "Portland" }] });
    }
    const [tab] = await chrome.tabs.query({ url: "http://127.0.0.1/*" });
    const { runFill } = await import("./src/background/orchestrator.js");
    const before = calls.length;
    const { beginTrace, endTrace } = await import("./src/background/trace.js");
    beginTrace();
    let summary;
    try {
      // The cancel step presses Cancel a moment into the fill.
      const ctl = new AbortController();
      window.__e2eStarted = Date.now();
      if (location.hash === "#step-cancel") setTimeout(() => ctl.abort(), 1500);
      summary = await runFill({ tabId: tab.id, url: tab.url, onProgress: () => {}, signal: ctl.signal });
    } finally {
      window.__e2eEnded = Date.now();
      window.__e2eTrace = endTrace();
      if (location.hash === "#step-orient") {  // later steps expect demographics off and unsaved, as the identity step left them
        const store = await import("./src/background/storage.js");
        await store.saveSettings({ ...(await store.getSettings()), fillDemographics: false });
        await store.saveProfile({ ...(await store.getProfile()), "demographics.gender": "" });
      }
      if (location.hash === "#step-veteran-saved") {
        const store = await import("./src/background/storage.js");
        await store.saveProfile({ ...(await store.getProfile()), "demographics.veteranStatus": "" });
      }
    }
    // What TypeSafe was asked in this fill, by question.
    const asked = calls.slice(before).flatMap(c => Object.values(c.questions)
      .filter(q => !(typeof q.instructions === "object" && typeof q.instructions.control === "string"))
      .map(q => typeof q.instructions === "object" ? (q.instructions.form_field.label || "(no label)") : String(q.instructions).slice(0, 80)));
    const events = (window.__e2eTrace && window.__e2eTrace.events) || [];
    const reverted = events.filter(e => e.kind === "extraction").map(e => e.reverted || []);
    const decided = events.filter(e => e.kind === "decided").flatMap(e => e.plan.map(p => [p.label, p.profileKey, p.via].join(" / ")));
    const structure = events.filter(e => e.kind === "structure").map(e => e.changes)
      .concat(calls.slice(before).filter(c => Object.values(c.questions).some(q => typeof q.instructions === "object" && typeof q.instructions.control === "string"))
        .map(c => Object.entries(c.questions).map(([k, q]) => k + ":" + q.instructions.control + ":" + Object.values(q.criteria).join("|").slice(0, 120))));
    const filled = events.filter(e => e.kind === "filled").flatMap(e => e.results.filter(r => !r.ok));
    const sureness = Object.fromEntries(events.filter(e => e.kind === "decided").flatMap(e => e.plan.map(p => [p.label, p.confidence])));
    window.__e2eStep = JSON.stringify({ summary, asked, reverted, decided, structure, filled, sureness });
  } catch (e) {
    const events = (window.__e2eTrace && window.__e2eTrace.events) || [];
    window.__e2eStep = JSON.stringify({ error: e.message, ms: (window.__e2eEnded || Date.now()) - (window.__e2eStarted || Date.now()),
      decided: events.filter(ev => ev.kind === "decided").map(ev => ({ plan: ev.plan, unfilled: ev.unfilled })),
      fields: events.filter(ev => ev.kind === "extraction").map(ev => ev.fields) });
  }
});
window.addEventListener("hashchange", async () => {
  if (location.hash !== "#e2e") return;
  window.__e2e = "running";
  try {
    const store = await import("./src/background/storage.js");
    await store.saveSettings({ typesafeApiKey: "stub", classifier: "typesafe", longTextMode: "skip", highlightFilled: true });
    await store.saveProfile({
      "identity.firstName": "Pat", "identity.lastName": "Brien", "contact.email": "pat@example.com",
      "contact.phone": "+1 415 555 0134", "contact.phoneType": "Cell",
      "authorization.authorizedToWork": "yes", "authorization.requiresSponsorship": "no",
      "preferences.willingToRelocate": "yes", "preferences.agreeToTerms": "yes", "preferences.howHeard": "LinkedIn",
      "preferences.nonCompete": "yes", "preferences.nonCompeteIndustry": "Payments",
      "links.linkedin": "https://linkedin.com/in/patbrien", "address.city": "Oakland", "address.state": "California",
      "address.country": "United States",
      employment: [{ company: "Globex", title: "Engineer", startDate: "2021-03" }],
      references: [
        { fullName: "Alice Ng", relationship: "Former manager", phone: "4155550101" },
        { fullName: "Bob Diaz", relationship: "Colleague", phone: "4155550102" },
        { fullName: "Cara Li", relationship: "Professor", phone: "4155550103" }
      ]
    });
    const [tab] = await chrome.tabs.query({ url: "http://127.0.0.1/*" });
    const granted = await chrome.permissions.contains({ origins: ["http://127.0.0.1/*", "http://localhost/*"] });
    const { runFill } = await import("./src/background/orchestrator.js");
    const summary = await runFill({ tabId: tab.id, url: tab.url, onProgress: () => {}, signal: new AbortController().signal });
    const structured = calls.some(c => Object.values(c.questions).some(q => q.instructions && q.instructions.form_field));
    const offered = Math.max(...calls.flatMap(c => Object.values(c.questions).map(q => Object.keys(q.criteria).length)));
    const answering = calls.filter(c => !Object.values(c.questions).some(q => typeof q.instructions === "object" && typeof q.instructions.control === "string"));
    const firstRound = answering.length ? Object.keys(answering[0].questions).length : 0;
    const isStructure = c => Object.values(c.questions).some(q => typeof q.instructions === "object" && typeof q.instructions.control === "string");
    window.__e2e = JSON.stringify({ summary, granted, structured, offered, calls: calls.filter(c => !isStructure(c)).length,
      structureCalls: calls.filter(isStructure).length, allCalls: calls.length, firstRound });
  } catch (e) {
    window.__e2e = JSON.stringify({ error: e.message, stack: String(e.stack).slice(0, 600) });
  }
});
''')

log = tempfile.NamedTemporaryFile(prefix='applicator-ff-', suffix='.log', delete=False)
# Through LaunchServices, so Firefox runs with its own privacy permissions:
# started as a child of an editor or terminal it cannot read its own data
# folder and stops at "Profile Missing". FIREFOX.parents[2] is Firefox.app.
# Firefox 159 grants Marionette system access only through the environment
# variable (the flag stopped working); open(1) passes it with --env.
proc = subprocess.Popen(
    ['/usr/bin/open', '-n', '-W', '-a', str(FIREFOX.parents[2]), '--env', 'MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1', '--args',
     '--headless', '--marionette', '-remote-allow-system-access', '--profile', profile],
    stdout=log, stderr=subprocess.STDOUT, start_new_session=True)

try:
    m = Marionette(PORT)
    m.send('WebDriver:NewSession', {'capabilities': {}})
    m.send('Addon:Install', {'path': str(build), 'temporary': True})

    m.send('Marionette:SetContext', {'value': 'chrome'})
    uuids = m.send('WebDriver:ExecuteScript', {
        'script': "return Services.prefs.getStringPref('extensions.webextensions.uuids','{}');",
        'args': []})
    uuid = json.loads(uuids['value']).get(ADDON_ID)
    m.send('Marionette:SetContext', {'value': 'content'})

    check('the add-on installed and was assigned an internal id', bool(uuid))
    if not uuid:
        raise SystemExit(1)

    # Installing opens the welcome tab, which can take over the session's
    # browsing context; work from a known live window.
    time.sleep(2)
    handles = m.send('WebDriver:GetWindowHandles')
    handles = handles.get('value', handles) if isinstance(handles, dict) else handles
    m.send('WebDriver:SwitchToWindow', {'handle': handles[0]})

    m.send('WebDriver:Navigate', {'url': f'moz-extension://{uuid}/src/options/options.html'})
    time.sleep(6)

    probed = m.send('WebDriver:ExecuteScript', {
        'script': 'return [window.__probeSave, window.__probeBackground];', 'args': []})['value'] or [None, None]
    check('saving settings round-trips', probed[0] == 'ok', str(probed[0]))
    # A reply to a message means the background script evaluated and listens.
    check('the background script evaluated and answers a message', probed[1] == 'ok', str(probed[1]))

    rendered = m.send('WebDriver:ExecuteScript', {
        'script': "return document.querySelectorAll('input,select,textarea').length;", 'args': []})
    check('the options page rendered its form controls', (rendered['value'] or 0) > 20,
          f"{rendered['value']} controls")

    # Site skills are a dev build's view: hidden here, and #skills shows the profile.
    hidden_skills = m.send('WebDriver:ExecuteScript', {'script': '''
        const tab = document.querySelector(".tab[data-tab='skills']");
        tab.click();
        return [getComputedStyle(tab).display, document.getElementById('panel-profile').hidden];''', 'args': []})['value'] or []
    check('outside the dev build the Site skills tab is hidden, and opening it shows the profile',
          hidden_skills == ['none', False], json.dumps(hidden_skills))
    # The rest of this test looks at the panel as the dev build shows it.
    m.send('WebDriver:ExecuteScript', {'script': "document.body.classList.add('dev');", 'args': []})

    # Every tab is rendered by script, so a runtime error in any of them is
    # invisible until someone clicks it.
    for tab in ['profile', 'settings', 'responses', 'skills', 'history', 'data']:
        m.send('WebDriver:ExecuteScript', {
            'script': "document.querySelector(`.tab[data-tab='${arguments[0]}']`).click();",
            'args': [tab]})
        time.sleep(1.2)
        shown = m.send('WebDriver:ExecuteScript', {
            'script': "return !document.getElementById('panel-' + arguments[0]).hidden;",
            'args': [tab]})
        check(f'the {tab} tab opens', bool(shown['value']))

    # Opening a tab is not proof it rendered: a throwing renderer leaves the
    # panel visible and empty, which is how a missing function slipped through.
    responses = m.send('WebDriver:ExecuteScript', {'script': '''
        document.querySelector("[data-tab='responses']").click();
        document.getElementById('add-response').click();
        return document.querySelectorAll('#responses-list .item').length;
    ''', 'args': []})
    check('the responses editor adds an entry', (responses['value'] or 0) > 0,
          f"{responses['value']} cards")

    skills = m.send('WebDriver:ExecuteScript', {'script': '''
        document.querySelector("[data-tab='skills']").click();
        return document.getElementById('skills-list').innerHTML.length;
    ''', 'args': []})
    check('the skills tab renders content', (skills['value'] or 0) > 0)
    m.send('WebDriver:ExecuteScript', {'script': "document.body.classList.remove('dev');", 'args': []})

    m.send('WebDriver:ExecuteScript', {
        'script': "document.querySelector(\".tab[data-tab='profile']\").click();", 'args': []})
    time.sleep(1)

    employment = m.send('WebDriver:ExecuteScript', {
        'script': "return document.querySelectorAll('#employment-list [data-prop]').length;", 'args': []})
    check('the employment history editor rendered', (employment['value'] or 0) > 0,
          f"{employment['value']} inputs")
    projects = m.send('WebDriver:ExecuteScript', {
        'script': """const before = document.querySelectorAll('#projects-list [data-card]').length;
            document.getElementById('add-projects').click();
            return [before, document.querySelectorAll('#projects-list [data-card]').length,
                    document.querySelectorAll('#projects-list textarea[data-prop="description"]').length];""", 'args': []})
    pv = projects['value'] or [0, 0, 0]
    check('the projects editor renders and its + adds a project', pv[0] >= 1 and pv[1] == pv[0] + 1 and pv[2] == pv[1], json.dumps(pv))

    # Adding a job, and the conditional non-compete question, both run on the
    # page rather than through any model, so they are checkable here.
    added = m.send('WebDriver:ExecuteScript', {'script': '''
        const before = document.querySelectorAll('[data-card^="employment:"]').length;
        document.getElementById('add-employment').click();
        return document.querySelectorAll('[data-card^="employment:"]').length - before;
    ''', 'args': []})
    check('adding another job works', added['value'] == 1, f"added {added['value']}")

    lists = m.send('WebDriver:ExecuteScript', {'script': '''
        const school = document.querySelectorAll('#education-list [data-prop]').length;
        document.getElementById('add-education').click();
        const schools = document.querySelectorAll('[data-card^="education:"]').length;
        const learned = !!document.getElementById('custom-list');
        const noDuplicate = !document.getElementById('pf-work.currentCompany') && !document.getElementById('pf-work.school');
        return [school > 0, schools === 2, learned, noDuplicate];
    ''', 'args': []})
    check('the education list, learned answers and no duplicate current-job rows render',
          lists['value'] == [True, True, True, True], json.dumps(lists['value']))

    added = m.send('WebDriver:ExecuteScript', {'script': '''
        const before = document.querySelectorAll('#custom-list [data-custom]').length;
        document.getElementById('custom-add').click();
        const after = document.querySelectorAll('#custom-list [data-custom]').length;
        return [before, after, document.activeElement && document.activeElement.dataset.cprop];''', 'args': []})['value']
    check('settings can add another answer by hand', added and added[1] == added[0] + 1 and added[2] == 'question', json.dumps(added))

    # A CV's words are read from the file itself, so nobody has to paste them.
    cv_files = {'simple.pdf': cv_simple_pdf(), 'packed.pdf': cv_packed_pdf(), 'cv.docx': cv_docx_file()}
    m.send('WebDriver:ExecuteScript', {'script': """
        window.__cvText = null;
        import(chrome.runtime.getURL('src/common/doctext.js')).then(async ({ documentText }) => {
          const out = {};
          for (const [filename, data] of Object.entries(arguments[0])) out[filename] = await documentText({ filename, data });
          window.__cvText = out;
        }).catch(e => { window.__cvText = { error: e.message }; });""",
        'args': [{k: base64.b64encode(v).decode() for k, v in cv_files.items()}]})
    cv_text = None
    for _ in range(50):
        cv_text = m.send('WebDriver:ExecuteScript', {'script': 'return window.__cvText;', 'args': []})['value']
        if cv_text:
            break
        time.sleep(0.1)
    cv_text = cv_text or {}
    check('a PDF\'s text is read with its lines, spaces and curly quotes',
          cv_text.get('simple.pdf') == 'Pat Brien\nPortland, OR \u00b7 415-555-0134\nSoftware Engineer\n\u201cTyped\u201d APIs \u2014 Globex',
          json.dumps(cv_text.get('simple.pdf') or cv_text))
    check('a PDF with Type0 fonts in object streams is read page by page',
          cv_text.get('packed.pdf') == 'acme r\u00e9sum\u00e9\nA b \u2014 c\n\nsecond page', json.dumps(cv_text.get('packed.pdf') or cv_text))
    check('a Word file\'s text is read a paragraph a line',
          cv_text.get('cv.docx') == 'Pat Brien\nEngineer, Globex & Acme\nCut costs 40%', json.dumps(cv_text.get('cv.docx') or cv_text))
    holder = m.send('WebDriver:ExecuteScript', {'script': """
        return [!!document.querySelector('#resume-text-holder textarea[data-key="documents.resumeText"]'),
                !document.querySelector('#documents-fields [data-key="documents.resumeText"]'),
                document.getElementById('resume-read').textContent];""", 'args': []})['value'] or []
    check('the CV text box sits under the upload, once, with a status line', holder[:2] == [True, True] and bool(holder[2]), json.dumps(holder))

    conditional = m.send('WebDriver:ExecuteScript', {'script': '''
        const row = document.querySelector('[data-field-row="preferences.nonCompeteIndustry"]');
        if (!row) return 'missing';
        const before = row.hidden;
        const select = document.getElementById('pf-preferences.nonCompete');
        select.value = 'yes';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return before && !row.hidden ? 'appeared' : 'before=' + before + ' after=' + row.hidden;
    ''', 'args': []})
    check('the non-compete industry question appears on yes',
          conditional['value'] == 'appeared', str(conditional['value']))

    inferred = m.send('WebDriver:ExecuteScript', {'script': '''
        const set = (k, v) => {
          const el = document.getElementById('pf-' + k);
          el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set('identity.firstName', 'Pat');
        set('identity.lastName', 'Brien');
        return document.getElementById('pf-identity.fullName').placeholder;
    ''', 'args': []})
    check('a full name is inferred from the parts', inferred['value'] == 'Pat Brien',
          f"placeholder was {inferred['value']!r}")

    # The popup's script must load, including the learn-from-page controls.
    m.send('WebDriver:Navigate', {'url': f'moz-extension://{uuid}/src/popup/popup.html'})
    time.sleep(2)
    popup = m.send('WebDriver:ExecuteScript', {'script': '''
        return [!!document.getElementById('learn'), document.getElementById('learn-panel').hidden,
                getComputedStyle(document.getElementById('learn-panel')).display];''', 'args': []})['value']
    check('the popup loads with a hidden learn panel', popup == [True, True, 'none'], json.dumps(popup))
    label = m.send('WebDriver:ExecuteScript', {'script': '''
        const b = document.getElementById('build'); return [b.hidden, b.textContent];''', 'args': []})['value']
    check('the popup shows which build it is', not label[0] and re.match(r'^(Build \d+|v[\d.]+)$', label[1]),
          json.dumps(label))
    if os.environ.get('POPUP_SHOT'):
        import base64
        shot = m.send('WebDriver:TakeScreenshot', {'full': False})['value']
        open(os.environ['POPUP_SHOT'], 'wb').write(base64.b64decode(shot))

    # Saving answers from a page: one row per answer, each saved on its own.
    rows = m.send('WebDriver:ExecuteAsyncScript', {'script': '''
        const done = arguments[arguments.length - 1];
        const applied = [];
        const items = [
          { type: 'custom', question: "Do you have a driver's license?", answer: 'Yes', saveTo: 'A new saved answer' },
          { type: 'field', key: 'contact.email', value: 'new@example.com', question: 'Email', answer: 'new@example.com',
            replaces: 'old@example.com', saveTo: 'Email' },
          { type: 'custom', question: 'Shirt size', answer: 'M', saveTo: 'A new saved answer' }
        ];
        chrome.runtime.sendMessage = async msg => {
          if (msg.type === 'learn-preview') return { ok: true, data: { proposals: items } };
          if (msg.type === 'learn-apply') { applied.push(...msg.payload.proposals); return { ok: true, data: { applied: msg.payload.proposals.length } }; }
          return { ok: true, data: {} };
        };
        const wait = ms => new Promise(r => setTimeout(r, ms));
        (async () => {
          document.getElementById('learn').click();
          await wait(300);
          const list = document.getElementById('learn-list');
          const shown = [...list.children].map(li => [li.querySelector('.q').textContent, li.querySelector('.to').textContent,
                                                     li.querySelector('[data-save]')?.textContent]);
          list.querySelector('[data-save="1"]').click();
          await wait(200);
          document.getElementById('learn-save').click();
          await wait(200);
          done({ shown, applied: applied.map(a => [a.question, !!a.replace]),
                 saved: [...list.querySelectorAll('.done')].length, headline: document.getElementById('learn-headline').textContent });
        })();''', 'args': []})['value'] or {}
    shown = rows.get('shown') or []
    check('each answer on the page is its own row, with where it saves and a button',
          len(shown) == 3 and shown[0][2] == 'Save' and 'Saves to' in shown[0][1], json.dumps(rows))
    check('a value that differs from the saved one offers Replace',
          len(shown) > 1 and shown[1][2] == 'Replace' and 'old@example.com' in shown[1][1], json.dumps(rows))
    check('Replace saves that one row, as a replacement', (rows.get('applied') or [[None]])[0] == ['Email', True], json.dumps(rows))
    check('Save all saves the rest, but never a replacement',
          sorted(a[0] for a in (rows.get('applied') or [])[1:]) == ["Do you have a driver's license?", 'Shirt size']
          and rows.get('saved') == 3, json.dumps(rows))

    # Extraction in a real DOM: whose block each repeated label belongs to.
    m.send('WebDriver:Navigate', {'url': f'moz-extension://{uuid}/form.html'})
    probe = {}
    for _ in range(40):
        time.sleep(0.5)
        probe = m.send('WebDriver:ExecuteScript', {'script': 'return window.__probe || null;', 'args': []})['value'] or {}
        if probe:
            break
    expect = {
        'home-city': ('personal', None), 'avail': ('personal', None),
        'c1': ('employment', 1), 'w1': ('employment', 1), 's1': ('employment', 1),
        'w2': ('employment', 2), 'rp': ('reference', None),
        'spl-form-element_12': ('employment', 1),
        # Greenhouse: the heading is <p> in div.education--header, and "degree--1" names no school.
        'degree--0': ('education', 0), 'end-year--1': ('education', 1),
    }
    for fid, (scope, repeat) in expect.items():
        got = probe.get(fid) or {}
        check(f'extract places #{fid} in the {scope} block',
              got.get('scope') == scope and got.get('repeat') == repeat,
              json.dumps(got))
    ups = m.send('WebDriver:ExecuteScript', {'script': 'return window.__uploads || [];', 'args': []})['value'] or []
    cl = next((u for u in ups if u.get('kind') == 'coverLetter'), {})
    check("a required cover letter upload offers its \"Enter manually\" button (Tailscale)",
          cl.get('required') and 'cl-text' in (cl.get('manualSelector') or ''), json.dumps(cl))
    kinds = {u.get('selector'): u.get('kind') for u in ups}
    kind_of = lambda testid: next((k for sel, k in kinds.items() if f'"{testid}"' in (sel or '')), None)
    check("Rippling's \"Drop or select\" boxes are known by their testids and labels (backlog)",
          kind_of('input-resume') == 'resume' and kind_of('input-cover_letter') == 'coverLetter', json.dumps(kinds))
    sms = m.send('WebDriver:ExecuteScript', {'script': 'return window.__sms || [];', 'args': []})['value'] or []
    check("radios hidden inside visible role=radio boxes are read as one question (backlog: Rippling)",
          len(sms) == 1 and len(sms[0].get('options') or []) == 2 and sms[0]['options'][0].startswith('Yes'), json.dumps(sms))
    typed = probe.get('cl-typed') or {}
    check("the box it opens is not labelled with the button's words",
          typed.get('label') != 'Enter manually' and 'Cover Letter' in (typed.get('label') or '') + (typed.get('section') or ''), json.dumps(typed))
    shadow = m.send('WebDriver:ExecuteScript', {'script': 'return window.__shadow || null;', 'args': []})['value'] or {}
    check('fields inside web components are found, labelled and filled',
          shadow.get('found') and shadow.get('autocomplete') == 'given-name' and shadow.get('filled') == 'Pat', json.dumps(shadow))
    check('an autocomplete suggestion matching the state is picked',
          shadow.get('chosen') == 'Oakland, CA, US' and shadow.get('picked'), json.dumps(shadow))
    check("a question slotted into a web component's label is read (backlog: SmartRecruiters)",
          ((probe.get('sd-degree') or {}).get('label') or '').startswith('What is your highest degree?'), json.dumps(probe.get('sd-degree')))
    check("a Workday button named \" Select One Required\" takes the asking sentence of its long legend (backlog)",
          (probe.get('wd1') or {}).get('label') == 'Please select "yes" if you acknowledge.', json.dumps(probe.get('wd1')))
    check('a radio group is labelled by its question, not its first option',
          (probe.get('pr1') or {}).get('label') == 'Preferred Pronouns', json.dumps(probe.get('pr1')))
    check("a sidebar of job facts is not the form's section heading (backlog: Ashby \"Compensation\")",
          'Compensation' not in ((probe.get('sb1') or {}).get('section') or ''), json.dumps(probe.get('sb1')))
    check("a red \"Required\" above a box, or text before its form, is not its label; the placeholder is (backlog: YC)",
          (probe.get('yc-first') or {}).get('label') == 'First Name *', json.dumps(probe.get('yc-first')))
    check("a \"0 / 200\" counter is not part of the label (backlog: SmartRecruiters)",
          (probe.get('ct') or {}).get('label') == 'What is your major?', json.dumps(probe.get('ct')))
    check("a group of tick boxes is not named after its first box (backlog: Ashby \"LinkedIn\")",
          (probe.get('hear') or {}).get('name') == '' and (probe.get('hear') or {}).get('label') == 'How did you hear about us?', json.dumps(probe.get('hear')))
    outlined = m.send('WebDriver:ExecuteScript', {'script': 'return window.__outlined || "";', 'args': []})['value'] or ''
    check("a dropdown's outline goes on the box a person sees, not its tiny search input (backlog: Zipline)",
          'applicator-filled' in outlined, outlined)

    # --- a whole run, end to end -------------------------------------------
    home = m.send('WebDriver:GetWindowHandle')['value']
    tab = m.send('WebDriver:NewWindow', {'type': 'tab'})['handle']
    m.send('WebDriver:SwitchToWindow', {'handle': tab})
    m.send('WebDriver:Navigate', {'url': f'http://127.0.0.1:{FIXTURE_PORT}/app.html'})
    time.sleep(2)
    m.send('WebDriver:SwitchToWindow', {'handle': home})
    m.send('WebDriver:Navigate', {'url': f'moz-extension://{uuid}/src/options/options.html'})
    time.sleep(3)
    m.send('WebDriver:ExecuteScript', {'script': "location.hash = '#e2e';", 'args': []})
    e2e = None
    for _ in range(120):
        time.sleep(1)
        raw = m.send('WebDriver:ExecuteScript', {'script': 'return window.__e2e;', 'args': []})['value']
        if raw not in (None, 'idle', 'running'):
            e2e = json.loads(raw)
            break
    e2e = e2e or {'error': 'the run never finished'}
    check('a full run completes', 'error' not in e2e, json.dumps(e2e)[:600])
    summary = e2e.get('summary') or {}
    check('the test copy holds its granted origins', e2e.get('granted') is True, str(e2e.get('granted')))
    check('TypeSafe is asked with structured field descriptions', e2e.get('structured') is True)
    check('TypeSafe is offered every saved key, not a shortlist', (e2e.get('offered') or 0) > 17, str(e2e.get('offered')))
    check('the run read the page again for fields that appeared', (summary.get('passes') or 0) >= 2,
          f"{summary.get('passes')} passes")
    # One request plans the whole form; the second pass asks only about the
    # question an answer revealed. No separate request maps saved values onto
    # a dropdown's options, because dropdowns are asked about their options.
    check('one model round per pass, and nothing more', e2e.get('calls') == summary.get('passes') == 2,
          f"{e2e.get('calls')} requests over {summary.get('passes')} passes")
    check('the first round covers every field a model should see', (e2e.get('firstRound') or 0) >= 10,
          f"{e2e.get('firstRound')} questions")
    check('an embedded frame without access is reported',
          f'http://[::1]:{FIXTURE_PORT}' in (summary.get('blockedFrames') or []), json.dumps(summary.get('blockedFrames')))

    m.send('WebDriver:SwitchToWindow', {'handle': tab})
    page = m.send('WebDriver:ExecuteScript', {'script': """
        const v = id => document.getElementById(id);
        const q = document.querySelectorAll('.question');
        const radio = i => Array.from(q[i].querySelectorAll('input')).filter(r => r.checked).map(r => r.value).join(',');
        return {
          first: v('fn').value, last: v('ln').value, email: v('em').value, phone: v('ph').value,
          size: v('size').value, authorized: radio(0), sponsorship: radio(1),
          relocate: Array.from(document.querySelectorAll('#relocate [aria-checked=true]')).map(r => r.textContent).join(','),
          heard: v('hh').textContent, phoneType: v('pt').textContent, noncompete: v('nc').value,
          industry: v('nci') ? v('nci').value : null, agree: v('agree').getAttribute('aria-checked'),
          headcount: v('csz').value,
          refName: v('r-name').value, refFirst: v('r-first').value, refPhone: v('r-phone').value, refRel: v('r-rel').value,
          phoneFlagged: v('ph').classList.contains('applicator-review')
        };""", 'args': []})['value'] or {}
    frame_el = m.send('WebDriver:FindElement', {'using': 'css selector', 'value': '#granted'})['value']
    m.send('WebDriver:SwitchToFrame', {'element': list(frame_el.values())[0]})
    embed = m.send('WebDriver:ExecuteScript', {'script': """
        return { linkedin: document.getElementById('li').value, employer: document.getElementById('ce').value };""",
        'args': []})['value'] or {}
    m.send('WebDriver:SwitchToParentFrame', {})

    expect_page = {
        'first': 'Pat', 'last': 'Brien', 'email': 'pat@example.com', 'phone': '(415) 555-0134',
        'authorized': 'yes', 'sponsorship': 'no', 'relocate': 'Yes', 'heard': 'LinkedIn',
        'phoneType': 'Mobile', 'noncompete': 'Yes', 'industry': 'Payments', 'agree': 'true', 'size': '',
        'headcount': '', 'refName': 'Alice Ng', 'refFirst': 'Alice', 'refPhone': '4155550101',
        'refRel': 'Former manager'
    }
    names = {
        'first': 'a field named by its autocomplete attribute is filled',
        'last': 'a plain text field is filled', 'email': 'the email is filled',
        'phone': 'a masked phone box keeps the number, without the country code it rejects',
        'authorized': 'an unnamed radio group gets its own answer (authorized: yes)',
        'sponsorship': 'the next unnamed radio group gets its own answer (sponsorship: no)',
        'relocate': 'a styled ARIA radio group is answered',
        'heard': 'a dropdown drawn by a design system is chosen from',
        'phoneType': 'a dropdown whose options match nothing saved is answered from the options it shows',
        'noncompete': 'a native select is answered', 'industry': 'a question revealed by an answer is filled on the next pass',
        'agree': 'a styled ARIA tick box is ticked',
        'size': 'a dropdown the model finds nothing saved for ("Company size") is left empty',
        'headcount': 'a keyword match the model rejects ("Company size" text box) is left empty',
        'refName': "a references block gets the first reference's name, not yours",
        'refFirst': "a reference's first name is taken from their full name",
        'refPhone': "a references block gets the reference's phone, not yours",
        'refRel': "a reference's relationship is filled"
    }
    for key, want in expect_page.items():
        check(names[key], page.get(key) == want, f'got {page.get(key)!r}, wanted {want!r}')
    check('a form inside a cross-origin frame is filled',
          embed.get('linkedin') == 'https://linkedin.com/in/patbrien' and embed.get('employer') == 'Globex', json.dumps(embed))
    check('a form whose every question is read reports nothing missed', not summary.get('possiblyMissed'),
          json.dumps(summary.get('possiblyMissed')))
    check('the overruled keyword match is counted', (summary.get('overruledByModel') or 0) >= 1,
          str(summary.get('overruledByModel')))
    check('a fill estimates the time it saved and adds it to the total',
          (summary.get('timeSavedSeconds') or 0) > 60 and (summary.get('allTime') or {}).get('seconds') == summary.get('timeSavedSeconds'),
          json.dumps({k: summary.get(k) for k in ('timeSavedSeconds', 'allTime', 'charged')}))
    cost = summary.get('cost') or {}
    check('the run is priced from every TypeSafe request, under the cap',
          len(cost.get('calls') or []) == e2e.get('allCalls') and cost.get('capCents') == 10 and not cost.get('capped')
          and abs(cost.get('priceCents', 0) - cost.get('cents', -1) * 3) < 0.0005,
          f"{len(cost.get('calls') or [])} priced, {e2e.get('allCalls')} sent ({e2e.get('structureCalls')} structure) "
          + json.dumps([c.get('label') for c in cost.get('calls') or []]))
    print(f"  run: {summary.get('filled')} of {summary.get('fieldsFound')} filled in {summary.get('passes')} passes, "
          f"{e2e.get('calls')} TypeSafe requests, {summary.get('durationMs')} ms")
    left = [u for u in summary.get('unfilled') or []]
    if left:
        print('  left empty: ' + '; '.join(f"{u['label'][:40]} ({u['reason'][:60]})" for u in left[:8]))

    # --- the next page on the same site asks for one more reference -------
    def fill_step(label, page='step2.html', read=None, settle=0.3):
        m.send('WebDriver:SwitchToWindow', {'handle': tab})
        m.send('WebDriver:Navigate', {'url': f'http://127.0.0.1:{FIXTURE_PORT}/{page}'})
        time.sleep(settle)  # Navigate returns once loaded; a moment for scripts that render after load
        m.send('WebDriver:SwitchToWindow', {'handle': home})
        m.send('WebDriver:ExecuteScript', {'script': "location.hash = '#step-' + arguments[0];", 'args': [label]})
        out = None
        for _ in range(600):
            time.sleep(0.1)
            raw = m.send('WebDriver:ExecuteScript', {'script': 'return window.__e2eStep;', 'args': []})['value']
            if raw not in (None, 'idle', 'running'):
                out = json.loads(raw)
                m.send('WebDriver:ExecuteScript', {'script': "window.__e2eStep = 'idle';", 'args': []})
                break
        m.send('WebDriver:SwitchToWindow', {'handle': tab})
        shown = m.send('WebDriver:ExecuteScript', {'script': read or """
            return [document.getElementById('r-name').value, document.getElementById('r-phone').value];""", 'args': []})['value']
        m.send('WebDriver:SwitchToWindow', {'handle': home})
        return out or {'error': 'never finished'}, shown

    step, shown = fill_step('first')
    check('the next page of the same site gets the next reference',
          shown == ['Bob Diaz', '4155550102'], f'{shown} {json.dumps(step)[:200]}')
    # Fresh page again (the same form a second time): Bob was given, so Cara.
    step, shown = fill_step('again')
    check('and the page after that gets the one after', shown == ['Cara Li', '4155550103'], f'{shown} {json.dumps(step)[:200]}')

    # Workday's prompts, ids and date boxes, and a phone box holding a dial code.
    step, wd = fill_step('workday', 'workday.html', """
        const v = id => document.getElementById(id);
        return { heard: v('ms-source').querySelector('[data-automation-id=promptAriaInstruction]').textContent,
                 code: v('ms-code').querySelector('[data-automation-id=promptAriaInstruction]').textContent,
                 shift: v('shift').value, shiftReview: v('shift').classList.contains('applicator-review'),
                 phone: v('candidate.phone').value, location: v('location-input').value, picked: v('selected-location').value,
                 employeeId: v('selfIdentifiedDisabilityData--employeeId').value,
                 month: v('selfIdentifiedDisabilityData--dateSignedOn-dateSectionMonth-input').value,
                 day: v('selfIdentifiedDisabilityData--dateSignedOn-dateSectionDay-input').value,
                 year: v('selfIdentifiedDisabilityData--dateSignedOn-dateSectionYear-input').value };""")
    wd = wd or {}
    labels = [f.get('label') for f in (step.get('summary') or {}).get('unfilled') or []]
    today = time.localtime()
    check('a Workday prompt is chosen through its category (Job Board, then LinkedIn)',
          wd.get('heard') == '1 item selected, LinkedIn', f"{json.dumps(wd)} {json.dumps([[d for d in step.get('decided') or [] if 'Hear' in d], step.get('filled'), [u for u in (step.get('summary') or {}).get('unfilled') or [] if 'Hear' in (u.get('label') or '')], [a for a in step.get('asked') or [] if 'Hear' in a]])[:1500]}")
    check('a Workday prompt that already holds a choice is left alone',
          wd.get('code') == '1 item selected, United States of America (+1)', json.dumps(wd))
    missed = (step.get('summary') or {}).get('possiblyMissed') or []
    check('a question drawn without any control Applicator reads is reported as possibly missed',
          any('Which team' in q for q in missed), json.dumps(missed))
    check('and nothing else on that page is', len(missed) == 1, json.dumps(missed))
    check("a guessed dropdown logs the model's confidence, not its rule's (backlog)",
          (step.get('sureness') or {}).get('Preferred shift') == 0.45, json.dumps(step.get('sureness'))[:400])
    check('an unsure answer is filled as a best guess, outlined for review',
          wd.get('shift') == 'Day' and wd.get('shiftReview') and (step.get('summary') or {}).get('guessed') == 1, json.dumps(wd))
    check('a location is picked from several suggestions, not typed',
          wd.get('picked') == 'Oakland, CA, USA' and wd.get('location') == 'Oakland, CA, USA',
          f"{json.dumps(wd)} {json.dumps([step.get('filled'), step.get('decided'), step.get('reverted'), (step.get('summary') or {}).get('passes')])[:2500]}")
    check('a phone box holding only a dial code gets the number', wd.get('phone') == '+1 415 555 0134', json.dumps(wd))
    check('a signature date gets today, month, day and year',
          [wd.get('month'), wd.get('day'), wd.get('year')] ==
          [f'{today.tm_mon:02d}', f'{today.tm_mday:02d}', str(today.tm_year)], json.dumps(wd))
    check("the site's header menu is not read as a question",
          not any('english' in str(l).lower() for l in labels) and (step.get('summary') or {}).get('fieldsFound', 99) <= 9,
          json.dumps((step.get('summary') or {}).get('fieldsFound')))

    # A TypeSafe request that stalls is sent again, and the fill goes on.
    step, shown = fill_step('stall')
    took = (step.get('summary') or {}).get('durationMs') or 0
    check('a stalled TypeSafe request is sent again and the fill completes',
          'error' not in step and 3000 <= took < 10000 and shown[0], f'{took} ms {json.dumps(step)[:300]}')

    # A school the page already lists, as a CalCareers button, is not added
    # again: the next saved school goes in the form.
    step, edu = fill_step('calcareers', 'calcareers.html', "return document.getElementById('edu-name').value;")
    check('a school the page already lists is not filled again; the next one is',
          edu == 'Reed College', f"{edu!r} {json.dumps(step)[:300]}")

    step, pb = fill_step('postback', 'postback.html', "return [document.getElementById('pb-type').value, document.getElementById('pb-country').value];")
    check("a box written after a select that posts back is not undone by the server's answer (backlog: PeopleSoft)",
          pb == ['M', 'United States'] and not any(step.get('reverted') or []),
          f"{pb!r} {json.dumps([step.get('reverted'), step.get('decided'), step.get('filled'), (step.get('summary') or {}).get('unfilled')])[:900]}")

    step, up = fill_step('upload', 'upload.html', "return document.getElementById('u-state').textContent;")
    check("an upload the page refuses is not counted as attached, and the popup is told (backlog: Ashby)",
          (step.get('summary') or {}).get('uploadsUnsure') == [{'kind': 'resume', 'failed': True}] and (step.get('summary') or {}).get('documentsAttached') == 0,
          f"{up!r} {json.dumps([(step.get('summary') or {}).get(k) for k in ('uploadsUnsure', 'documentsAttached', 'uploadsOffered')])}")

    step, ch = fill_step('choices', 'choices.html', """
        return { picked: (document.querySelector('input[name=sponsorship]:checked') || {}).value || '' };""")
    check('radios in a box called "choices" are answered, not taken for a select skin (practice form)',
          (ch or {}).get('picked') == 'No', json.dumps(ch))
    step, sp = fill_step('sponsor', 'sponsor.html', """
        const v = id => document.getElementById(id).value;
        return { spon: v('s-spon'), type: v('s-type'), reloc: v('s-reloc'), heard: v('s-heard'), spec: v('s-spec'), email: v('s-email') };""")
    sp = sp or {}
    check("a box whose UUID name holds \"2fa\" is not taken for a two-factor code (Genesis)", '@' in (sp.get('email') or ''), json.dumps(sp))
    check("a long 'If you will require sponsorship, please specify' after a No gets N/A (Greenhouse)",
          sp.get('spon') == 'No' and sp.get('type') == 'N/A', f"{json.dumps(sp)} {json.dumps([step.get('decided'), (step.get('summary') or {}).get('unfilled')])[:800]}")
    check("a required 'Please specify' after a list answered with its own option gets N/A (Rocket Lab)",
          sp.get('heard') == 'LinkedIn' and sp.get('spec') == 'N/A', json.dumps(sp))
    check("'If you will require relocation, what is your timeline?' is not answered with a bare Yes",
          sp.get('reloc') != 'Yes', json.dumps(sp))

    step, ak = fill_step('ask', 'ask.html', """
        const box = document.getElementById('a-shirt');
        const layer = document.querySelector('applicator-ask-layer');
        const tag = layer && layer.shadowRoot.querySelector('.tag');
        const marked = box.classList.contains('applicator-ask') && !!tag;
        box.value = 'Medium';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        tag && tag.querySelector('.tick').click();
        return { marked, text: tag ? tag.textContent : '' };""")
    ak = ak or {}
    check("a required question Phil cannot answer is marked on the page with a tick to save it",
          ak.get('marked') is True and (step.get('summary') or {}).get('asked') == 2 and 'phil needs you' in ak.get('text', ''),
          f"{json.dumps(ak)} {json.dumps([(step.get('summary') or {}).get(k) for k in ('asked', 'requiredEmpty', 'unfilled')])[:600]}")
    def saved_shirt():
        for _ in range(30):
            time.sleep(0.1)
            got = m.send('WebDriver:ExecuteScript', {'script': """
                return import('/src/background/storage.js').then(store => store.getProfile()).then(p => {
                  const c = (p.custom || []).find(c => /T-shirt size/.test(c.question));
                  return c ? c.answer : ''; });""", 'args': []})['value']
            if got: return got
        return ''
    check("and the answer ticked is saved for next time", saved_shirt() == 'Medium', 'not saved')
    m.send('WebDriver:SwitchToWindow', {'handle': tab})
    m.send('WebDriver:ExecuteScript', {'script': """
        const box = document.getElementById('a-shirt'); box.value = 'Large';
        box.dispatchEvent(new Event('change', { bubbles: true }));""", 'args': []})
    m.send('WebDriver:SwitchToWindow', {'handle': home})
    time.sleep(1.2)
    check("and changing it later updates the saved answer without asking", saved_shirt() == 'Large', 'not updated')
    # A custom dropdown: its open list is never covered by the tag, and a
    # choice shown only as text turns the tick on.
    m.send('WebDriver:SwitchToWindow', {'handle': tab})
    m.send('WebDriver:ExecuteScript', {'script': "document.getElementById('a-polc').dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));", 'args': []})
    time.sleep(0.6)
    dd = m.send('WebDriver:ExecuteScript', {'script': """
        const layer = document.querySelector('applicator-ask-layer');
        const tags = [...layer.shadowRoot.querySelectorAll('.tag')];
        const tag = tags.find(t => !t.classList.contains('saved') && !t.classList.contains('gone')) || null;
        const m = document.getElementById('a-polm').getBoundingClientRect();
        const r = tag ? tag.getBoundingClientRect() : null;
        const covers = !!tag && !tag.hidden && r.left < m.right && r.right > m.left && r.top < m.bottom && r.bottom > m.top;
        document.querySelector('#a-polm [role=option]').click();
        return { tagged: !!tag, covers, n: tags.length };""", 'args': []})['value'] or {}
    time.sleep(0.6)
    dd2 = m.send('WebDriver:ExecuteScript', {'script': """
        const layer = document.querySelector('applicator-ask-layer');
        const tag = [...layer.shadowRoot.querySelectorAll('.tag')].find(t => !t.classList.contains('saved'));
        return { enabled: !!tag && !tag.querySelector('.tick').disabled };""", 'args': []})['value'] or {}
    m.send('WebDriver:SwitchToWindow', {'handle': home})
    check("a custom dropdown's open list is not covered by Phil's tag (Greenhouse)", dd.get('tagged') and not dd.get('covers'), json.dumps(dd))
    check("and a choice it shows only as text turns the tick on", dd2.get('enabled') is True, json.dumps([dd, dd2]))

    step, wj = fill_step('wdjobs', 'wdjobs.html', """
        const v = id => (document.getElementById(id) || {}).value;
        const job = c => ['jobTitle', 'companyName', 'startDate-dateSectionMonth-input', 'startDate-dateSectionYear-input',
          'endDate-dateSectionMonth-input', 'endDate-dateSectionYear-input'].map(k => v('workExperience-' + c + '--' + k));
        return { one: job(4), two: job(15) };""")
    wj = wj or {}
    norm_month = lambda xs: [x.lstrip('0') if i in (2, 4) and x else x for i, x in enumerate(xs or [])]
    check("Workday's second job block gets the second saved job, though its id says 15 (Accenture)",
          norm_month(wj.get('two')) == ['Analyst', 'Acme', '1', '2018', '2', '2021'],
          f"{json.dumps(wj)} {json.dumps([step.get('decided'), (step.get('summary') or {}).get('unfilled')])[:1200]}")
    check("and a Month and Year under To get the job's end date, not its start",
          norm_month(wj.get('one')) == ['Engineer', 'Globex', '3', '2021', '6', '2023'], json.dumps(wj))

    step, wc = fill_step('wdcurrent', 'wdcurrent.html', """
        return [4, 15, 28].map(c => document.getElementById('workExperience-' + c + '--currentlyWorkHere').checked);""")
    check("each job block's own \"I currently work here\" box is ticked for that job only, though all share a name (Accenture)",
          wc == [True, False, False],
          f"{json.dumps(wc)} {json.dumps([step.get('decided'), (step.get('summary') or {}).get('unfilled')])[:1200]}")

    step, wa = fill_step('wdadd', 'wdadd.html', """
        const titles = [...document.querySelectorAll('input[name=jobTitle]')].map(i => i.value);
        const companies = [...document.querySelectorAll('input[name=companyName]')].map(i => i.value);
        const schools = [...document.querySelectorAll('input[name=school]')].map(i => i.value);
        return { titles, companies, schools };""")
    wa = wa or {}
    check("Workday's \"Add Another\" is pressed until there is a block per saved job, and each is filled",
          wa.get('titles') == ['Engineer', 'Analyst'] and wa.get('companies') == ['Globex', 'Acme'],
          f"{json.dumps(wa)} {json.dumps([step.get('error')] + [(step.get('summary') or {}).get(k) for k in ('entriesAdded', 'addEntries', 'unfilled')])[:1200]}")
    check("and a plain \"Add\" under Education adds the school block, and fills it",
          wa.get('schools') == ['Portland State University'], json.dumps(wa))
    check("and the popup is not asked to have the user add them",
          not (step.get('summary') or {}).get('addEntries') and (step.get('summary') or {}).get('entriesAdded') == 2, json.dumps((step.get('summary') or {}).get('addEntries')))

    step, pa = fill_step('plainadd', 'plainadd.html', """
        return { employers: [...document.querySelectorAll('input[name=employer]')].map(i => i.value), url: location.pathname };""")
    pa = pa or {}
    check("on a form that does not number its blocks, \"+ Add another\" adds one block per saved job",
          len(pa.get('employers') or []) == 2 and set(pa.get('employers')) == {'Globex', 'Acme'},
          f"{json.dumps(pa)} {json.dumps([step.get('error')] + [(step.get('summary') or {}).get(k) for k in ('entriesAdded', 'addEntries', 'unfilled')])[:1200]}")
    check("and an \"Add reference\" link that leaves the page is not followed, only named for the user",
          pa.get('url') == '/plainadd.html' and [b.get('text') for b in (step.get('summary') or {}).get('addEntries') or []] == ['Add reference'],
          json.dumps([pa, (step.get('summary') or {}).get('addEntries')]))

    step, ws = fill_step('wdschool', 'wdschool.html', """
        return [...document.querySelectorAll('[data-automation-id=promptAriaInstruction]')].map(d => d.textContent);""")
    check("a Workday school search is typed, searched with Enter, and the closest school clicked (Lakeside College)",
          (ws or [None])[0] == '1 item selected, Lakeside Community College',
          f"{json.dumps(ws)} {json.dumps(step)[:2500]}")
    check("and a school the list does not have gets its Other", (ws or [None, None])[1] == '1 item selected, Other',
          json.dumps([ws, step.get('decided'), step.get('filled'), (step.get('summary') or {}).get('unfilled')])[:1500])

    step, cn = fill_step('cancel', 'cancel.html', "return document.querySelector('input[data-uxi-widget-type=selectinput]').value;")
    check("Cancel stops a fill stuck searching a list, within moments",
          step.get('error') == 'Fill cancelled.' and step.get('ms', 1e9) < 5000, json.dumps(step)[:600])
    time.sleep(1.5)
    m.send('WebDriver:SwitchToWindow', {'handle': tab})
    typed = m.send('WebDriver:ExecuteScript', {'script': "return [...document.querySelectorAll('input[data-uxi-widget-type=selectinput]')].map(i => i.value);", 'args': []})['value']
    m.send('WebDriver:SwitchToWindow', {'handle': home})
    check("and the page stops typing too", typed == ['', ''] or all(len(t) < 20 for t in typed or []), json.dumps(typed))

    step, wm = fill_step('wdmore', 'wdmore.html', """
        const pills = id => [...document.getElementById(id).closest('[data-automation-id=multiSelectContainer]')
          .querySelectorAll('[data-automation-id=selectedItem]')].map(p => p.textContent);
        const held = id => document.getElementById(id).dataset.held;
        return { school1: pills('education-11--school'), school2: pills('education-18--school'),
                 study1: pills('education-11--fieldOfStudy'), study2: pills('education-18--fieldOfStudy'),
                 skills: pills('skills--skills'), gpa: document.getElementById('education-11--gradeAverage').value,
                 dates: ['startDate', 'endDate'].flatMap(w => ['Month', 'Year'].map(p => held('workExperience-4--' + w + '-dateSection' + p + '-input'))),
                 alerts: [...document.querySelectorAll('[data-automation-id=inputAlert]')].filter(a => !a.hidden).length,
                 files: document.getElementById('cvfiles').files.length };""")
    wm = wm or {}
    detail = f"{json.dumps(wm)} {json.dumps([step.get('error')] + [(step.get('summary') or {}).get(k) for k in ('unfilled',)])[:1500]}"
    check("a Workday school is kept only once its result is clicked and shows as a pill (Northfield University)",
          wm.get('school1') == ['Northfield University'], detail)
    check("and the closest school is clicked when the saved one is not listed (Lakeside)", wm.get('school2') == ['Lakeside Community College'], detail)
    check("a field of study the list lacks gets the closest one (Computer Science)", wm.get('study1') == ['Computer Science'], detail)
    check("and one sharing no words gets the list's Other, not a broad field, its comma not split as a place", wm.get('study2') == ['Other'], detail)
    check("skills from the profile are added one by one, and one the list lacks is left out, never Other",
          wm.get('skills') == ['Python (Programming Language)', 'SQL'], detail)
    check("a school's GPA goes in its Overall Result (GPA) box", wm.get('gpa') == '3.5', detail)
    check("dates Workday marks invalid are typed again as key presses and left with a click, and it takes them",
          wm.get('dates') == ['3', '2021', '6', '2023'] and wm.get('alerts') == 0, detail)
    check("a CV already shown beside the drop zone is not attached a second time", wm.get('files') == 0, detail)

    step, gh = fill_step('ghupload', 'ghupload.html', "return document.getElementById('g-wrap').textContent;")
    check("an attached CV shown as its file name is not reported as a missed question (Greenhouse)",
          'cv.pdf' in str(gh) and not (step.get('summary') or {}).get('possiblyMissed'),
          f"{gh!r} {json.dumps([(step.get('summary') or {}).get(k) for k in ('possiblyMissed', 'documentsAttached')])}")

    step, hs = fill_step('calcareers-add', 'calcareers-add.html', "return document.getElementById('hs0').checked;")
    summ = step.get('summary') or {}
    check("an ASP.NET radio list's question comes from the label on its span, and a college entry answers high school (backlog: CalCareers)",
          hs is True and 'Did you graduate' in json.dumps(step.get('decided')), f"{hs!r} {json.dumps([step.get('decided'), step.get('error'), summ.get('unfilled')])[:800]}")
    check("required questions left empty are named for the popup, marked by ** or a Workday legend abbr (backlog)",
          sorted(summ.get('requiredEmpty') or []) == ['Username', 'Which team would you join?'], json.dumps([summ.get('requiredEmpty'), summ.get('unfilled')])[:900])
    desc = [u.get('reason') for u in summ.get('unfilled') or [] if u.get('label') == 'Description']
    check("a school's Description box is not drafted (backlog: SmartRecruiters)",
          desc and 'About one school' in desc[0], json.dumps(desc))
    check("an \"Add Employment Record\" button is passed on for the popup to mention (backlog: CalCareers)",
          [b.get('text') for b in summ.get('addEntries') or []] == ['Add Employment Record'], json.dumps([step.get('error'), summ.get('addEntries')])[:400])

    # With demographics off, identity questions are neither answered nor put
    # to the model, however they are labelled; the rest of the page is filled.
    step, ident = fill_step('identity', 'identity.html', """
        const v = n => document.querySelector('[name=' + n + ']');
        return { age: [...document.querySelectorAll('[name=age]')].some(r => r.checked), gender: v('q_7f3a').value,
                 eu: v('UC_ETH_EUROPE_CHK').checked, af: v('UC_ETH_AMBLACK_CHK').checked,
                 orient: v('GEND_ORNT_P_VW_DESCR').value, email: v('email').value };""")
    ident = ident or {}
    leaked = [a for a in step.get('asked') or [] if a != 'Email']
    check('identity questions are left empty with demographics off',
          not ident.get('age') and not ident.get('gender') and not ident.get('eu') and not ident.get('af') and not ident.get('orient'),
          f"{json.dumps(ident)} {json.dumps(step)[:300]}")
    check('and are not put to the model', not leaked, json.dumps(leaked))
    check('while the rest of the page is filled', ident.get('email') == 'pat@example.com', json.dumps(ident))

    # Ashby's Yes/No buttons are read as questions and answered by pressing
    # the button, without submitting the form they sit in.
    step, yn = fill_step('ashby', 'ashby.html', """
        const pressed = id => { const b = document.querySelector('#' + id + ' [aria-pressed="true"]'); return b ? b.textContent : ''; };
        return { url: location.pathname, auth: pressed('yn-auth'), spon: pressed('yn-spon') };""")
    yn = yn or {}
    labels = [f.get('label') for f in (step.get('summary') or {}).get('unfilled') or []]
    check("Ashby's Yes/No buttons are answered from the profile",
          yn.get('auth') == 'Yes' and yn.get('spon') == 'No', f"{json.dumps(yn)} {json.dumps(step)[:400]}")
    check('pressing them does not submit the form', yn.get('url') == '/ashby.html', json.dumps(yn))
    check('and the question is read from its label, not the description under it',
          not any('Our address' in str(l) for l in labels) and (step.get('summary') or {}).get('filled') == 2,
          json.dumps((step.get('summary') or {}).get('unfilled')))

    # The form's own state holds every answer, not only the boxes on screen.
    step, wk = fill_step('workable', 'workable.html', "return JSON.parse(document.body.dataset.state || '{}');")
    wk = wk or {}
    check("a radio drawn around a hidden radio is answered, though the page redraws its ids (Workable)",
          wk.get('auth') == 'true', f"{json.dumps(wk)} {json.dumps((step.get('summary') or {}).get('unfilled'))[:400]}")
    check("and an entry written in an inline editor is kept by pressing its Update, one left empty is not (Workable)",
          str(wk.get('phone', '')).startswith('saved:') and len(wk['phone']) > 8 and 'color' not in wk, json.dumps(wk))

    step, st = fill_step('stale', 'stale.html', "return JSON.parse(document.body.dataset.state || '{}');")
    st = st or {}
    check("a form that saves changes on a copy of its state keeps every answer",
          all(st.get(k) for k in ('name', 'email', 'phone', 'auth')), f"{json.dumps(st)} {json.dumps(step)[:300]}")
    check("and a slow upload saved over an old copy of the form does not wipe them",
          st.get('resume') == 'cv.pdf' and all(st.get(k) for k in ('name', 'email', 'phone', 'auth')), json.dumps(st))

    step, sl = fill_step('slowlists', 'slowlists.html',
        "return document.querySelector('#sl8v .select__single-value')?.textContent || '';", settle=0.5)
    check("a dropdown the first read had no time to open is decided from the options it showed (Instacart)",
          sl == 'Job Board', f"{sl!r} " + json.dumps([[x for x in (step.get(k) or []) if 'hear' in json.dumps(x).lower()]
                                                   for k in ('decided', 'filled', 'asked')] + [[u for u in (step.get('summary') or {}).get('unfilled') or [] if 'hear' in (u.get('label') or '').lower()]])[:1500])

    step, lz = fill_step('lazyframe', 'lazyframe.html',
        "return document.getElementById('lz').contentDocument?.getElementById('lz-email')?.value || '';")
    check("a form in a lazy iframe below the fold is loaded and filled (Lyft)",
          lz == 'pat@example.com', f"{lz!r} {json.dumps(step)[:400]}")

    step, bl = fill_step('blur', 'blur.html', "return JSON.parse(document.body.dataset.taken || '{}');")
    bl = bl or {}
    check("every box is left with a focus-out the form hears, even when blur() fires nothing",
          all(bl.get(k) for k in ('name', 'email', 'phone', 'linkedin')), f"{json.dumps(bl)} {json.dumps(step)[:200]}")

    step, sr = fill_step('srlist', 'srlist.html', "return document.getElementById('s-country').textContent;")
    check("a list whose options hold \"-option\" pieces picks the whole option (backlog: SmartRecruiters)",
          sr == 'United States', f"{sr!r} {json.dumps([step.get('decided'), step.get('filled'), (step.get('summary') or {}).get('unfilled')])[:1200]}")

    step, co = fill_step('country', 'country.html', "return document.getElementById('c-loc').value;")
    check("a location list of countries gets the country when the city finds nothing (Runway)",
          co == 'United States', f"{co!r} {json.dumps([step.get('decided'), (step.get('summary') or {}).get('unfilled')])[:600]}")
    check("a \"Role @ Company\" page title names the company, with no og:site_name (backlog: Ashby)",
          (step.get('summary') or {}).get('company') == 'Globex', str((step.get('summary') or {}).get('company')))

    step, mk = fill_step('mask', 'mask.html', "return [document.getElementById('m-phone').value, document.getElementById('m-type').selectedOptions[0].text];")
    mk, mtype = (mk or ['', ''])
    check("a select showing its first option with none marked selected is not taken as answered (backlog: CalCareers)",
          mtype == 'Mobile', f"{mtype!r} {json.dumps((step.get('summary') or {}).get('unfilled'))[:300]}")
    check("a masked phone box that shifts a pasted number gets every digit, typed (backlog: CalCareers)",
          mk == '(415) 555-0134', f"{mk!r} {json.dumps([step.get('decided'), (step.get('summary') or {}).get('unfilled')])[:600]}")

    step, dk = fill_step('datepickers', 'datepickers.html', """
        return { from: document.getElementById('experienceData[0].fromTo.startDate').value,
                 to: document.getElementById('experienceData[0].fromTo.endDate').value,
                 year: document.getElementById('educationData[0].fromTo.startDate').value,
                 open: !!document.querySelector('.react-datepicker') };""")
    dk = dk or {}
    check("a month picker that drops typed text gets the month chosen in its calendar (Abbott)",
          dk.get('from') == '03/2021' and dk.get('to') == '06/2023', f"{json.dumps(dk)} {json.dumps([step.get('decided'), (step.get('summary') or {}).get('unfilled')])[:900]}")
    check("a year picker paged by decade gets the year (Abbott)", dk.get('year') == '2014', json.dumps(dk))
    check("and no calendar is left open", dk.get('open') is False, json.dumps(dk))

    step, ori = fill_step('orient', 'orient.html', """
        return { trans: (document.querySelector('input[name=trans]:checked') || {}).value || '', vet: document.getElementById('q-vet').value };""")
    ori = ori or {}
    check("an identity question nothing saved answers gets its own prefer-not option, not a guess from gender (Reddit)",
          ori.get('trans') == 'Prefer not', f"{json.dumps(ori)} {json.dumps([step.get('decided'), (step.get('summary') or {}).get('unfilled')])[:800]}")
    check("and so does a required dropdown", ori.get('vet') == 'I decline to self-identify', json.dumps(ori))

    step, pl = fill_step('place', 'place.html', """
        return { loc: document.getElementById('p-loc').value, sf: document.getElementById('o-sf').checked,
                 ny: document.getElementById('o-ny').checked };""")
    pl = pl or {}
    check("a place box that shows nothing for the first typing is typed into again (Mercor)",
          pl.get('loc') == 'Oakland, California, United States', f"{json.dumps(pl)} {json.dumps([step.get('decided'), (step.get('summary') or {}).get('unfilled'), step.get('error')])[:1500]}")
    check("two office tick boxes are one question, answered with the office near home (Mercor)",
          pl.get('sf') is True and pl.get('ny') is False, f"{json.dumps(pl)} {json.dumps(step)[:300]}")

    step, dp = fill_step('datepick', 'datepick.html', "return document.getElementById('d-start').value;")
    check("reading the page does not pick a day in a date box", dp != 'PICKED-BY-OPENING', f"{dp!r} {json.dumps(step)[:200]}")

    step, sv = fill_step('savefields', 'savefields.html', "return JSON.parse(document.body.dataset.saved || '{}');", settle=2.0)
    sv = sv or {}
    check("a form that saves each answer to a slow server has them all saved when the fill ends",
          all(sv.get(k) for k in ('name', 'email', 'phone')), f"{json.dumps(sv)} {json.dumps(step)[:200]}")

    step, sw = fill_step('savewhole', 'savewhole.html', """
        return { saved: JSON.parse(document.body.dataset.saved || '{}'),
                 shown: Object.fromEntries([...document.querySelectorAll('input:checked')].map(r => [r.name, r.value])) };""")
    sw = sw or {}
    check("a form that saves its whole state per click keeps every choice (Sentry)",
          len(sw.get('shown') or {}) >= 3 and sw.get('saved') == sw.get('shown'), f"{json.dumps(sw)} {json.dumps(step)[:300]}")

    # A tick box with no words to read is never ticked, whatever the model says.
    step, uc = fill_step('uc-status', 'uc-status.html', """
        return { rm: document.getElementById('UC_RM_CHK').checked, rp: document.getElementById('UC_RP_CHK').checked,
                 email: document.querySelector('[name=email]').value };""")
    uc = uc or {}
    check('a tick box with a blank label is not ticked as an agreement',
          uc.get('rm') is False and uc.get('rp') is False and uc.get('email') == 'pat@example.com', f"{json.dumps(uc)} {json.dumps(step)[:300]}")

    # A box the page cleared after it was written is written again.
    step, reset = fill_step('reset', 'reset.html', """
        return { city: document.getElementById('city').value, li: document.getElementById('li').value };""")
    reset = reset or {}
    check('a box the page cleared after the fill is written again',
          reset.get('li') == 'https://linkedin.com/in/patbrien' and bool(reset.get('city')),
          f"{json.dumps(reset)} reverted per pass {step.get('reverted')} {json.dumps(step)[:200]}")

    # A page of only voluntary questions, with demographics off, is not an error.
    step, _ = fill_step('veteran', 'veteran.html', "return null;")
    check('a page of only demographic questions, switched off, ends normally',
          'error' not in step and (step.get('summary') or {}).get('onlyByChoice') == 'demographics'
          and (step.get('summary') or {}).get('charged') is False, json.dumps(step)[:400])
    # A saved answer is used even with the setting unticked (Greenhouse's
    # Veteran Status was left empty with "Not a veteran" saved).
    step, vet = fill_step('veteran-saved', 'veteran.html',
        "return (document.querySelector('input[name=VETERAN_STS]:checked') || {}).value || '';")
    check('a saved veteran status is given with the demographics box unticked',
          vet == 'N', f"{json.dumps(vet)} {json.dumps(step)[:1500]}")

    # A saved preferred name ticks Workday's box and goes in the boxes it
    # reveals, over the copy of the legal name Workday puts there.
    step, pref = fill_step('preferred', 'preferred.html', """
        const v = id => document.getElementById(id);
        return { ticked: v('name--preferredCheck').checked, first: v('name--legalName--firstName').value,
                 preferred: (v('name--preferredName--firstName') || {}).value, last: (v('name--preferredName--lastName') || {}).value };""")
    pref = pref or {}
    check('a saved preferred name ticks the box and fills the boxes it reveals',
          pref.get('ticked') and pref.get('first') == 'Pat' and pref.get('preferred') == 'Sam' and pref.get('last') == 'Brien',
          f"{json.dumps(pref)} {json.dumps(step.get('decided'))}")

    # The question for unnamed Yes/No boxes is read from the page, and only the
    # box that is the answer is ticked.
    step, yc = fill_step('yc', 'yc.html', """
        const b = [...document.querySelectorAll('input[type=checkbox]')];
        return { yes: b[0].checked, no: b[1].checked };""")
    yc = yc or {}
    check('unnamed Yes/No boxes get their question from the page; only Yes is ticked',
          yc.get('yes') is True and yc.get('no') is False,
          f"{json.dumps(yc)} {json.dumps(step.get('structure'))} {json.dumps((step.get('summary') or {}).get('unfilled'))[:400]}")

    step, cvp = fill_step('cvpick', 'cvpick.html', "return document.getElementById('c-cv').files[0]?.name || '';")
    check("with a CV for each kind of job, the one for this job is attached and named in the summary",
          cvp == 'cv-eng.pdf' and ((step.get('summary') or {}).get('cvUsed') or {}).get('filename') == 'cv-eng.pdf',
          f"{cvp!r} {json.dumps((step.get('summary') or {}).get('cvUsed'))}")
    step, cvp = fill_step('cvpick-ld', 'cvpick-ld.html', "return document.getElementById('c-cv').files[0]?.name || '';")
    check("a form page with no description reads the posting from its JobPosting data (Ashby)",
          cvp == 'cv-eng.pdf', f"{cvp!r} {json.dumps((step.get('summary') or {}).get('cvUsed'))}")
    # Settings shows both, each with the jobs it is for; "Make main" puts the
    # other first and its words in the CV text box.
    m.send('WebDriver:SwitchToWindow', {'handle': home})
    m.send('WebDriver:Navigate', {'url': f'moz-extension://{uuid}/src/options/options.html'})
    time.sleep(1.5)
    cvs_shown = lambda: m.send('WebDriver:ExecuteScript', {'script': """
        return { rows: [...document.querySelectorAll('[data-cv]')].map(r => [r.querySelector('b').textContent,
                   r.querySelector('[data-cv-category]')?.value, !!r.querySelector('[data-cv-main]')]),
                 count: document.getElementById('cv-count').textContent,
                 add: document.getElementById('upload-resume-label').textContent,
                 text: document.getElementById('pf-documents.resumeText').value };""", 'args': []})['value'] or {}
    before = cvs_shown()
    check('settings lists each CV with the jobs it is for, and offers another',
          before.get('rows') == [['cv-retail.pdf', 'Retail, customer service', False], ['cv-eng.pdf', 'Software engineering', True]]
          and before.get('count') == '2 CVs' and before.get('add') == 'Add another CV', json.dumps(before))
    m.send('WebDriver:ExecuteScript', {'script': "document.querySelector('[data-cv-main]').click();", 'args': []})
    time.sleep(1)
    after = cvs_shown()
    check('"Make main" puts that CV first, and its words in the CV text box',
          [r[0] for r in after.get('rows') or []] == ['cv-eng.pdf', 'cv-retail.pdf'] and after.get('text') == 'Pat Brien. Backend engineer at Acme.',
          json.dumps(after))

    # The popup shows what a fill cost, and a page that hit the cap opens the
    # report form. The result arrives as the background's RUN_DONE message,
    # sent here from a frame, since a page does not hear its own messages.
    m.send('WebDriver:SwitchToWindow', {'handle': home})
    m.send('WebDriver:Navigate', {'url': f'moz-extension://{uuid}/src/popup/popup.html'})
    time.sleep(2)
    m.send('WebDriver:ExecuteScript', {'script': """
        const done = { filled: 3, fieldsFound: 4, durationMs: 2100, written: 0, modelCalls: 2, charged: true,
                       timeSavedSeconds: 720, allTime: { seconds: 7200, fills: 9, today: 3, spentCents: 31, streakDays: 3, streakToday: true },
                       cost: { cents: 10.4, priceCents: 20.8, capCents: 10, capped: true, calls: [],
                               byProvider: { typesafe: { cents: 0.06, calls: 1, inputTokens: 14256, outputTokens: 0 },
                                             deepseek: { cents: 10.34, calls: 1, inputTokens: 3000, outputTokens: 8000 } } } };
        const f = document.createElement('iframe');
        f.src = 'about:blank';
        document.body.append(f);
        f.contentWindow.chrome.runtime.sendMessage({ type: arguments[0], payload: done });""",
        'args': ['run-done']})
    time.sleep(2.5)  # the reward counts up, then the total
    shown = m.send('WebDriver:ExecuteScript', {'script': """
        const t = id => document.getElementById(id);
        return { reward: !t('reward').hidden, time: t('reward-time').textContent, money: t('reward-money').textContent,
                 spent: t('reward-spent').textContent, spentShown: !t('reward-spent-line').hidden, costShown: !t('result-cost').hidden,
                 wage: t('wage-edit').textContent, streak: t('reward-streak').textContent,
                 confetti: t('reward-burst').children.length, allTime: t('alltime-time').textContent,
                 allMoney: t('alltime-money').textContent, allShown: !t('alltime').hidden,
                 allLine: t('alltime-line').innerText.replace(/\s+/g, ' ').trim(),
                 streakShown: !t('streak-chip').hidden, streakDays: t('streak-days').textContent,
                 goalShown: !t('reward-goal').hidden, ret: t('reward-return').textContent,
                 cost: t('result-cost').textContent, capped: !t('result-capped').hidden, report: !t('report').hidden,
                 parts: Array.from(t('result-cost-parts').children).map(li => li.textContent) };""",
        'args': []})['value'] or {}
    # In a popup-sized window, the Fill button stays in sight over a long result.
    rect = m.send('WebDriver:GetWindowRect', {})
    rect = rect.get('value', rect)
    m.send('WebDriver:SetWindowRect', {'width': 380, 'height': 560})
    time.sleep(0.3)
    inview = m.send('WebDriver:ExecuteScript', {'script': """
        window.scrollTo(0, 0);
        const r = document.getElementById('fill').getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, h: innerHeight, page: document.documentElement.scrollHeight };""", 'args': []})['value'] or {}
    if os.environ.get('POPUP_SHOT'):
        import base64
        pathlib.Path(os.environ['POPUP_SHOT']).write_bytes(base64.b64decode(m.send('WebDriver:TakeScreenshot', {'full': False})['value']))
    m.send('WebDriver:SetWindowRect', {'width': rect['width'], 'height': rect['height']})
    check('after a fill the Fill button is in sight without scrolling',
          inview.get('page', 0) > inview.get('h', 0) and 0 <= inview.get('top', -1) and inview.get('bottom', 1e9) <= inview.get('h', 0), json.dumps(inview))
    check('the reward shows the time the fill saved, counted up', shown.get('reward') and shown.get('time') == '12 min', json.dumps(shown))
    check('and what it is worth at $16 an hour', shown.get('money') == '$3.20' and shown.get('wage') == '$16/hr', json.dumps(shown))
    check('with confetti', (shown.get('confetti') or 0) > 10, json.dumps(shown))
    check('an ordinary fill (3rd today, 9th in all) has no milestone line', shown.get('streak') == '' and not shown.get('goalShown'), json.dumps(shown))
    check('the all-time counter shows the new total', shown.get('allShown') and shown.get('allTime') == '2 h 00 min'
          and shown.get('allMoney') == '$32.00', json.dumps(shown))
    check('and sets what the user spent in all against what they saved',
          shown.get('allLine') == "You've spent $0.31 and saved $32.00 of your time (2 h 00 min)", json.dumps(shown))
    check('the header shows the day streak', shown.get('streakShown') and shown.get('streakDays') == '3', json.dumps(shown))
    check('and the fill\'s return on what it cost', shown.get('ret') == '31× what it cost', json.dumps(shown))
    wage = m.send('WebDriver:ExecuteAsyncScript', {'script': """
        const done = arguments[arguments.length - 1];
        const t = id => document.getElementById(id);
        t('wage-edit').click();
        t('wage-input').value = '30';
        t('wage-form').requestSubmit();
        setTimeout(async () => {
          const stored = await chrome.runtime.sendMessage({ type: 'get-status' });
          done({ money: t('reward-money').textContent, chip: t('wage-edit').textContent, all: t('alltime-money').textContent,
                 stored: stored && stored.data && stored.data.hourlyWage });
        }, 400);""", 'args': []})['value'] or {}
    check('the wage can be changed from the reward, and is kept',
          wage.get('money') == '$6.00' and wage.get('chip') == '$30/hr' and wage.get('all') == '$60.00'
          and wage.get('stored') == 30, json.dumps(wage))
    check('the reward sets what the fill cost, in dollars, against what it saved',
          shown.get('spentShown') and shown.get('spent') == '$0.10' and not shown.get('costShown'), json.dumps(shown))
    check('the popup says what each provider cost, in dollars',
          shown.get('parts') == ['TypeSafe $0.0006: 14,256 input tokens, 1 request',
                                 'DeepSeek $0.10: 3,000 in, 8,000 out, 1 request',
                                 'Model cost $0.10, price $0.21'], json.dumps(shown, ensure_ascii=False))
    check('a fill that hit the cap opens the report form', shown.get('capped') and shown.get('report'), json.dumps(shown))
    m.send('WebDriver:ExecuteScript', {'script': """
        document.getElementById('report-note').value = 'test report';
        document.getElementById('report-send').click();""", 'args': []})
    saved = ''
    for _ in range(20):
        time.sleep(0.5)
        saved = m.send('WebDriver:ExecuteScript', {'script': "return document.getElementById('report-result').textContent;",
                                                   'args': []})['value']
        if saved and saved != 'Saving...':
            break
    issues = m.send('WebDriver:ExecuteAsyncScript', {'script': """
        const done = arguments[arguments.length - 1];
        chrome.runtime.sendMessage({ type: arguments[0] }).then(r => done(r && r.ok ? r.data.map(i => i.note) : r));""",
        'args': ['list-issues']})['value']
    check('a report is saved with the note', saved.startswith('Saved') and 'test report' in (issues or []),
          f'{saved!r} {json.dumps(issues)[:200]}')

    # A popup opened again on the page it just filled gets that fill back, so
    # it can still be reported; once the tab loads a new page, it is gone.
    kept = m.send('WebDriver:ExecuteAsyncScript', {'script': """
        const done = arguments[arguments.length - 1];
        (async () => {
          const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
          await chrome.storage.session.set({ ['lastRun:' + tab.id]: { url: tab.url, summary: { filled: 2, fieldsFound: 3 }, trace: null } });
          const r = await chrome.runtime.sendMessage({ type: 'get-last-run', payload: { tabId: tab.id } });
          done({ tabId: tab.id, url: tab.url, run: r && r.data });
        })().catch(e => done({ error: e.message }));""", 'args': []})['value'] or {}
    check('a reopened popup gets the last fill on its tab',
          (kept.get('run') or {}).get('url') == kept.get('url') and ((kept.get('run') or {}).get('summary') or {}).get('filled') == 2,
          json.dumps(kept))
    m.send('WebDriver:SwitchToWindow', {'handle': tab})
    m.send('WebDriver:Refresh', {})
    time.sleep(1.5)
    m.send('WebDriver:SwitchToWindow', {'handle': home})
    gone = m.send('WebDriver:ExecuteAsyncScript', {'script': """
        const done = arguments[arguments.length - 1];
        chrome.runtime.sendMessage({ type: 'get-last-run', payload: { tabId: arguments[0] } }).then(r => done(r));""",
        'args': [kept.get('tabId')]})['value'] or {}
    check('and forgets it when the tab loads a new page', gone.get('ok') and gone.get('data') is None, json.dumps(gone))

    # The options page starts a new profile with three blank references.
    m.send('WebDriver:SwitchToWindow', {'handle': home})
    m.send('WebDriver:ExecuteScript', {'script': "chrome.storage.local.clear();", 'args': []})
    m.send('WebDriver:Navigate', {'url': f'moz-extension://{uuid}/src/options/options.html#reset'})
    time.sleep(3)
    cards = m.send('WebDriver:ExecuteScript', {'script': """
        return document.querySelectorAll('[data-card^="references:"]').length;""", 'args': []})['value']
    check('a new profile shows three blank references', cards == 3, f'{cards} cards')

    # Every error the browser saw from the extension, pages and content scripts included.
    m.send('Marionette:SetContext', {'value': 'chrome'})
    errors = m.send('WebDriver:ExecuteScript', {'script': """
        const out = [];
        for (const msg of Services.console.getMessageArray() || []) {
          let e; try { e = msg.QueryInterface(Ci.nsIScriptError); } catch { continue; }
          if (e.flags & Ci.nsIScriptError.warningFlag) continue;
          // Firefox's note that a reply came after its page navigated away (a
          // fixture tab moving on mid-call): timing, not an extension error.
          // It failed whole autofix attempts at random.
          if (/^Promise (resolved|rejected) after context unloaded/.test(e.errorMessage)) continue;
          if (/moz-extension:|src\\/content\\//.test(e.sourceName + ' ' + e.errorMessage)) out.push(e.errorMessage + ' @ ' + e.sourceName + ':' + e.lineNumber);
        }
        return out;""", 'args': []})['value'] or []
    m.send('Marionette:SetContext', {'value': 'content'})
    check('the extension logged no JavaScript errors', not errors, '; '.join(e[:200] for e in errors[:3]))

finally:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        proc.terminate()
    time.sleep(2)
    # Firefox can relaunch itself outside the process group; find it by profile.
    subprocess.run(['pkill', '-f', profile], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

server.shutdown()
shutil.rmtree(site, ignore_errors=True)

shutil.rmtree(profile, ignore_errors=True)
shutil.rmtree(build.parent, ignore_errors=True)

print()
if failures:
    print(f'{len(failures)} browser check(s) failed. Firefox log: {log.name}')
    sys.exit(1)
os.unlink(log.name)
print('Extension loads and works in Firefox.')
