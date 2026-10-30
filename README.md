# philform

**phil fills your job applications.** Enter your details once; on any
application click **phil this application**, and philform reads the form,
works out what each box is asking, fills it, drafts the open-ended answers and
outlines everything for you to check. It never submits.

philform is open source (AGPL-3.0) and works on forms it has never seen:
there is no hand-written recipe per job site. A model reads each page's own
questions and options, so a new site, or a site that changes its markup,
still gets filled.

- **Firefox:** the latest signed build is on [philformapp.com](https://philformapp.com).
- **Chrome:** in closed beta; load `dist/chrome` unpacked after `./build.sh`.

## What it costs

Your first 10 applications are free (every page of one application counts as
one). After that each fill takes three times its model cost from a wallet you
top up $5 at a time: a typical fill costs a fraction of a cent, about 400
applications per $5, and no fill can cost more than 30¢. The rules are in
[`src/common/wallet.js`](src/common/wallet.js), shared by the extension and
the service.

**Bring your own key for writing.** Reading the form always runs through
philform's service on its TypeSafe account. Writing the open-ended answers
can use your own DeepSeek key instead: paste it under **Settings > Written
answers**. Those requests then go from your browser straight to DeepSeek,
billed to your DeepSeek account, and your philform wallet is charged only for
reading the form. Your key stays in your browser; philform's service never
sees it.

## What it sends where

- Your profile, saved answers and CVs stay in your browser (optionally
  encrypted under a password: **Settings > Data**).
- To fill a page, the form's questions and the parts of your profile they
  need go to TypeSafe (through philform's service, which meters the cost), and
  the questions that need writing go to DeepSeek.
- A thumbs-down sends the page's address, your note and the question labels,
  never your answers. See [PRIVACY.md](PRIVACY.md).

## What the user sees

1. **Profile.** Name, contact, address, work history, education, references,
   work authorization, and a CV, uploaded and read in the browser or pasted as
   text (written answers are only as good as it). Someone with a CV for each
   kind of job uploads each one and says what jobs it is for; each fill sends
   the one TypeSafe picks for the job and writes from it.
2. **phil this application.** A progress bar steps through Read, Match and
   Fill, then a small celebration shows the time the fill saved and what that
   time is worth at the user's rate ($16/hr to start, editable in the popup and
   in settings), with an all-time total underneath. Blue outline: filled from
   your details. Amber outline: a best guess or a draft, check it.
3. **Save my answers from this page.** After typing in anything philform
   missed, or correcting something it filled, this lists each answer on its
   own row, with where it would be saved and its own **Save** (or **Replace**)
   button. Next time philform fills it, on that site and on any other that
   asks the same thing.
4. **How did phil do?** A thumb up or down after each fill. A thumb down
   sends the page's address for review, then offers a note.

## How a fill works

| Step | What happens | Cost |
|---|---|---|
| Read | Every frame is reduced to field descriptors; custom dropdowns are opened to read their options | Free |
| Rules | Site skills and keyword rules propose an answer per field | Free |
| Decide | **One TypeSafe request** for the whole form: which saved value fits each box, which of its own options each dropdown should get, which saved response answers each essay; it also checks every rule's proposal | ~0.05¢ |
| Write | DeepSeek drafts what nothing saved answers, in parallel, while the rest is filled | ~0.1–0.5¢ |
| Fill | Written with real key and pointer events, read back, retried by typing if the page rejected it | Free |
| Again | The page is read again for questions that appeared, up to three passes | As above, for new fields only |

**Fill what is most likely, flag what is unsure.** TypeSafe's answers are
calibrated. At or above the confidence setting (default 0.6) an answer is
filled normally. Between 0.35 and that it is filled as a **best guess** and
outlined in amber, instead of leaving a required field for the user to find.
A required one-line question nothing saved answers ("How many hours a week can
you work?") gets a short draft, also amber. Never guessed: questions about who
someone is (gender, race, veteran or disability status, age), questions that
only apply after another answer ("If so, ..."), and anything the user switched
off.

**Notice what was missed.** After a fill, the page is checked for question text
inside the form that no field was read for: the sign of a widget philform
does not recognise yet. It costs nothing, needs no screenshot, and the popup
then asks the user to report the page. That, and the reports, are how new form
designs get supported. A vision check is deliberately not run per fill: it would
cost more than the fill. It is reserved for pages this check or a user flags.

**Cost is metered and capped.** Every call is priced from the tokens its
provider reports (`src/background/cost.js`). The popup shows the cost per
provider, and the price, which is three times the cost. A fill is capped at 10¢ of cost: the
writer's budget is cut to fit, and a fill that reaches the cap says so and
opens the report form. A typical fill costs 0.05–0.5¢ and takes 2–6 seconds.

**Robust to the page.** Design-system dropdowns (react-select, MUI, Radix,
Workday prompts, select2), ARIA radios and tick boxes, unnamed radio groups,
web components, suggestion boxes that must be picked from, masked inputs,
cross-origin frames, and questions revealed by earlier answers. A stalled
TypeSafe request is sent again after three seconds.

**Embedded forms.** A form in a frame from another site needs that site's
permission once: **Allow access** in the popup grants the whole site, so an
embed that redirects within it (`boards.greenhouse.io` to
`job-boards.greenhouse.io`) is covered. If access is allowed and the form still
cannot be read, the popup offers **Reload page** rather than asking again.

## Development

```bash
python3 tools/dev.py             # Firefox with the dev build; reloads on every save
python3 tools/dev.py --review    # the same, and Claude Code reviews each fill
./test.sh                        # every offline check, about two minutes
```

Plain JavaScript in `src/`, no build step and no dependencies. You need
Firefox, Python 3.9+, and Node (`brew install node`) for web-ext and the
backend tests. Put your own TypeSafe and DeepSeek keys in
`src/common/local-config.js` (copy `local-config.example.js`; gitignored): the
dev build then calls them directly. `python3 tools/dev.py --direct` does the
same with a local test wallet. Your own answers for testing live in
`.dev/personal-config.json` (gitignored); in the dev build, **Settings > Data >
Save to project** writes it. `CLAUDE.md` holds the requirements and the
lessons behind the code, for people and for Claude Code alike.

Contributions are welcome: open an issue with the page's address when a form
fills badly, or a pull request with a fixture in `tools/test-firefox.py` that
reproduces it. Never commit personal data: use fictional values (Pat Brien,
415-555-0134, Acme, Globex) in tests and comments.

### The dev loop

`tools/dev.py` opens its own Firefox (profile in `.dev/firefox-profile`, so
sign-ins persist) with a development build, and rebuilds and reloads it on
every save; an edit that does not parse is reported and not loaded. Fill a page
from the popup or with **Alt+Shift+F**. The dev build, and only it, reports
each fill to `dev.py`, which saves it in `.dev/runs/<time>-<site>/`
(`latest` points at the newest):

| File | Holds |
|---|---|
| `page.md` | Every field: options, TypeSafe's choice and runners-up, the decision and why, what the page shows, and possibly missed questions |
| `report.json` | The full trace: extraction, every TypeSafe question and answer, decisions, the writer's raw replies, fill results, cost |
| `before.html`, `after.html`, `screenshot.png` | The page around the fill |
| `review.md` | With `--review`: Claude Code's review, naming causes by file and line |

`python3 tools/dev.py review [RUN]` reviews a saved run. Pages reported from
the popup land in `.dev/issues/`.

**Your answers for development.** `.dev/personal-config.json` is the profile
and settings every dev tool uses when no `--config` is given. On the dev
build's settings page, **Save to project (dev build)** writes it, without API
keys. A production build's Export downloads `applicator-config-<date>.json` as
usual. `--config FILE` loads any other export.

### Checking changes

```bash
./test.sh                                   # parse, wiring, logic, pipeline, browser, dev loop
python3 tools/test-live.py --typesafe-only  # the real TypeSafe benchmark, a fraction of a cent
python3 tools/try-form.py URL [--probe]     # one real fill of a live page, with a timeline
python3 tools/corpus.py run                 # every saved live form, filled and scored
```

- **`test.sh`** needs no network. The browser step installs the build in
  headless Firefox and fills local pages built from the forms that used to
  fail, with TypeSafe stubbed, checking each field in the page afterwards. It
  fails on any JavaScript error from the extension.
- **The corpus** (`tools/corpus.py add URL`, `run`, `accept NAME`, `score`) is
  the regression suite: live application pages, each with an answer key, filled
  headless exactly as a click would. `run` writes
  `.dev/corpus-runs/<time>/scorecard.md` with fields right, flagged, possibly
  missed, time and cost per page. A change is an improvement only if the
  scorecard says so. Answer keys hold personal values and stay in `.dev/`.
- **`try-form.py`** prints every stage, request and decision for one page.
  `--probe` only reads it; `--grant PATTERN` allows an embedded form's site;
  `--experiment FILE` runs a script in the page.

`tools/verify.py` (in `test.sh`) also enforces the extension's promises: no
`<all_urls>`, no permissions beyond those declared, no `submit()` anywhere,
and the dev hooks (`src/common/dev-config.js`) never in the source tree.

## Your profile, in brief

`src/common/schema.js` is the vocabulary everything speaks: adding a field
there teaches the rules, the prompts, the settings page and the skills editor.

- Work history and education are lists; the newest answers "current employer",
  "school", "degree". Employer blocks on a form get jobs newest first; an "add
  employer" dialog gets the next job not already listed.
- References (three to start, up to five) go to references blocks only, the
  next one on each page of a site within a browser session.
- Demographic answers are used only when **Answer voluntary demographic
  questions** is on. Salary is not demographic and is always used.
- Saved responses (the Responses tab) fill essays word for word, or tailored to
  the role, with `{{company}}` and `{{role}}` placeholders.
- Site skills remember each site's fields and are checked by TypeSafe on every
  fill, so a wrong one corrects itself. Users never see them: the Site skills
  tab (correct, lock, share) is in the dev build only.

## Shipping

- **Keys and paying.** Direct mode uses your own TypeSafe and DeepSeek keys
  and is for development. The product uses proxy mode, philform's service
  (`backend/server.mjs`): the extension sends the providers' own requests to
  its relay (`src/background/llm/relay.js`), which holds the keys and prices
  each call from the usage reported. Every user gets an anonymous account,
  made on first use, with 10 free applications; after those each fill is
  charged 3× its model cost (at most 30¢) from a wallet topped up through
  Stripe Checkout, $5 at least (`src/common/wallet.js`, `billing.js`). A fill
  that fills nothing is never charged. A DeepSeek key of the user's own
  (`ownDeepseekKey`) is used for writing even in proxy mode; those calls skip
  the relay, so only TypeSafe is metered.
- **Running the service.** `node backend/server.mjs` with `TYPESAFE_API_KEY`,
  `DEEPSEEK_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and
  `PUBLIC_URL` set (Node 22+, no dependencies). Point Stripe's
  `checkout.session.completed` webhook at `/v1/stripe/webhook`. For testing
  without Stripe, `PHILFORM_FREE_RELOADS=1` credits a reload at once. It keeps
  accounts in one JSON file (`backend/data/`, gitignored), held in memory.
  Endpoints are listed at the top of `server.mjs`;
  `node tools/test-backend.mjs` checks them.
- **Release build.** `RELEASE=1 ./build.sh` leaves `local-config.js` out of
  `dist/` and gives Firefox the store id `philform@philform`. Load
  `dist/chrome` unpacked, or `dist/firefox/manifest.json` as a temporary
  add-on.
- **Store review.** Single purpose, no remote code, `storage`, `activeTab` and
  `scripting` only, web origins optional and granted per site from the popup,
  sensitive fields (passwords, payment, government IDs, date of birth) refused
  at extraction and again at fill time. `PRIVACY.md` and `STORE_LISTING.md`
  hold the policy and the store answers.

## Layout

```
src/content/      extract.js reads the form; fill.js writes it
src/background/   timesaved.js estimates the time each fill saved and keeps the total;
                  orchestrator.js runs a fill; classify.js asks TypeSafe; write.js asks DeepSeek;
                  heuristics.js, scope.js, shortlist.js decide what a field is; frames.js spans
                  frames; cost.js meters; learn.js saves answers from a page; issues.js reports
src/popup/        the toolbar popup
src/options/      profile, settings, responses, site skills, data
tools/            dev.py, corpus.py, try-form.py, runreport.py and the tests
```

## Known limits

- Each page of a multi-step form is its own fill; the popup says when there is
  a next step.
- Only the CVs and cover letter stored in settings are ever uploaded.
- Closed shadow roots cannot be reached by any extension.
- philform presses a form's safe "add another" buttons until there is a block
  for each saved job, school and reference; one that would leave the page or
  submit it is named in the popup for you to press instead.
- The automated browser test runs in Firefox; Chrome shares every file but the
  manifest.

## License

[AGPL-3.0](LICENSE). You may use, change and share philform; if you run a
modified copy as a service for others, you must publish your changes under the
same license.
