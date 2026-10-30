# Philform: context for Claude

Philform (formerly Applicator; the repo, add-on id, CSS classes, storage and
export names still say `applicator`, keep them so installs keep their data)
is a Chrome/Firefox MV3 extension that fills job applications from a profile
the user enters once. Plain JavaScript in `src/`, no build step, no
dependencies. `README.md` describes how it works; this file holds the
requirements and the working knowledge behind it.

## What the product must be

- **For non-technical job seekers.** They enter their details, click Fill, and
  it just works. User-facing text is plain language; no jargon, no settings
  they must understand first.
- **It adapts to forms it has never seen.** This is the pitch. A paid fill that
  leaves half of a new page empty, or breaks when a site changes its markup, is
  a product failure. Judge every change by coverage on unseen forms (corpus fill
  rate and "Missed?" column) as well as correctness.
- **Infer, don't abstain.** TypeSafe exists to pick the most likely answer even
  without an exact saved match. Below the confidence floor, fill a best guess
  outlined in amber (`GUESS_FLOOR` 0.35, `classify.js`). Never guess identity
  questions (gender, race, veteran, disability, age) or conditional ones
  ("If so, ..."). Never submit a form.
- **Cheap and capped.** Every model call is metered (`cost.js`) and shown in the
  popup per provider. Cap 10¢ per fill; the customer price is 3× cost (30¢
  cap). Typical fill 0.05–0.5¢.
- **Paid from a wallet, for reach before margin.** 10 free applications
  (counted by application: every page of one is free), then each fill takes
  3× what it used from a wallet topped up $5 at a time, like a transport
  card: about 400 applications per $5 at today's costs. Prices go up after
  market penetration, not now. The rules are `src/common/wallet.js`, shared
  by the extension (`billing.js`) and the service (`backend/server.mjs`). The
  dev build goes through the live service like a store build (`dev.py --direct`
  for own keys and a local test wallet). A friend's account can be made
  unlimited by hand (`tools/accounts.py`): never charged, its cost kept as gifted. No per-fill vision/screenshot checks: reserve expensive checks
  for pages the free missed-question check or a user flags.
- **Fast.** Under 10 s per page, nearly instant when nothing needs writing.
  Short fields are filled while DeepSeek drafts in parallel.
- **Rewarding to use, even a little addictive.** After a fill the popup
  celebrates (Duolingo-style: Phil jumps, confetti, count-up) with the time
  saved, then "You spent" against "You saved" side by side (its worth at the
  user's hourly rate, `hourlyWage`, default $16) and the return ("800× what it
  cost"). A line under it only at a milestone (5 today, with extra confetti;
  1st, 10th, 25th... in all), never "keep going" after every fill; a flame in
  the header counts the day streak, and
  the all-time line reads "You've spent $0.31 and saved $42.00 of your time". The estimate
  (`timesaved.js`) uses Keystroke-Level Model times per field, essays at the
  ~10 words a minute timed writing tests allow less editing time, minus time
  spent checking; it is deliberately believable, and only fills that
  count as a completion add to the total. Respect `prefers-reduced-motion`.
- **Gets better with use.** Site skills, "Save my answers from this page", the
  missed-question check and the thumbs after a fill are the learning loop.
  The popup asks "How did phil do?" with a thumb up and a thumb down (user,
  2026-10-27: no small report button, and no form to fill in first). A
  thumb down sends the page's address for review at once, then offers a
  note; what reaches the service (`POST /v1/reports`, `accounts.py
  reports`) is the address, verdict, note, counts and question labels,
  never an answer. The full report with answers stays in the browser
  (`saveIssue`) and goes only to a dev server. A
  required question a fill leaves empty is marked on the page (`askUser`,
  fill.js) with a one-line tag above the box (hidden while it would cover an
  open list or the focused box) and a ✓: the user answers there, ticks, and it is a
  saved answer; later edits update it silently. The popup says it once,
  with "Show me".
- **"Add another" is pressed for the user.** Before deciding, a fill
  presses each safe add button (named by its own words or the heading it
  sits under: Workday's plain "Add") until the page has a block per saved
  job, school and reference (`addEntryBlocks`, `blockCounts`). Each press
  must add boxes or that button stops. Post-backs, submit inputs and links
  away are never pressed: the popup names them instead (`entriesToAdd`).
- **First install opens a guided tour** (`options.html#tour`,
  `src/options/tour.js`): Phil's bubbles switch the settings tabs
  themselves and light up the CV upload, the profile, **Save profile**
  (nothing is kept until it is pressed), Export/Import, the wallet email,
  the password lock and the thumbs, then open the practice form on the
  site (`deploy/site/demo.html`, served at `/demo`), which says how to pin
  phil, fill and rate. Practice fills are free, 5 per account
  (`DEMO_APP_KEY`, server.mjs). "Take the tour" in the settings header
  replays it.
- **Optional password lock** (Data tab, `background/vault.js` under
  `storage.js`): profile, saved answers, documents and saved reports are
  kept in one AES-GCM record with a PBKDF2 key from the password; the
  unlocked key lives in `chrome.storage.session` (memory, gone when the
  browser closes). Reading them while locked throws `LockedError`; the
  popup and settings page show an unlock form. No recovery: a forgotten
  password means delete everything and import a backup.
- **Accounts stay anonymous; an email only keeps the wallet.** Uninstalling
  wipes the token, and the next fill makes a new account. The service
  limits that with counters kept in `db.limits` (hashed addresses,
  current day and month only): 5 new accounts per address a day, and past
  20 in a month a new account starts with no free applications. An
  optional email (Data tab, `/v1/email/start` and `/verify`, a 6-digit
  code) links the wallet, or restores the wallet already kept under it
  with this browser's money added. The email given at Stripe checkout is
  recorded too. Sending needs `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`,
  `MAIL_FROM` on the server (built-in implicit-TLS client); without them
  the routes return 503. Production sends through Resend's SMTP from
  `philform <no-reply@mail.philformapp.com>` on port **2465**: Hetzner
  blocks outgoing 25, 465 and 587. Support mail to
  `support@philformapp.com` is forwarded by Cloudflare Email Routing.
- **The Fill button is always in sight** (a bar pinned to the popup's
  bottom). Reopened after a fill, the popup shows it in one line; a page
  asking other questions (Workday's next step, same address) is shown fresh.

## Brand

- **philform** and **phil**, always lowercase wherever a user sees them
  (the wordmark, titles, messages, the store, the site), even at the start
  of a sentence; the button reads "phil this application", and "phil is
  philling..." while it runs. Like "lifeform", and "fill form". **Phil** is the AI
  character: a soft white rounded cube with a kawaii cat face (round eyes,
  "ω" mouth, pink cheeks), small round bear ears, and between them an
  adorable angler-fish lure whose glowing bulb is the green check (its stalk
  grey-white in dark mode), and two stubby feet in front. Nothing on the
  belly or round the middle: a collar was too kawaii, and a belly badge read
  as censoring. User-facing text says Phil for what it does
  ("Phil fills it next time") and Philform for the product, settings and data.
- Cute but professional and clean, palette after LINE: one green on white
  and soft grey, sumi charcoal text, gold for rewards. Bright `#06c755` for
  fills, bars and Phil's check; `#04873b` behind white text (4.6:1). Pink only
  in Phil's cheeks and ears: pink against orange clashed. Chunky Duolingo
  buttons on a darker ledge; rounded type (`--round`) for the wordmark and big
  moments only.
- The toolbar icon is Phil on a bright green rounded tile (like Honey's
  orange one) so it stands out among grey icons; there the lure turns white
  with a dark green check, and the 16 px icon leaves the angler off. The 128 px
  icon keeps Chrome's store margin. The pages draw Phil without the tile.
- Phil is drawn once in `tools/make-icons.py`, which writes the PNG icons and
  `src/common/phil.js` (the SVG the pages draw via `data-phil`). Never edit
  phil.js by hand. Phil runs along the progress bar and jumps on the reward.
- Where it is going: a suite for job seekers and anyone facing tedious forms,
  then personalised AI job search; a reply to an AI recruiter is a Philform.

## Decisions already made

- TypeSafe (System One, `jev-latest`) decides: one batched request per pass for
  the whole form (key questions, option questions over the page's own options,
  saved-response matching), checking every keyword rule. DeepSeek V4 Pro writes;
  slow drafts are hedged to DeepSeek Flash after 5 s, stalled TypeSafe requests
  re-sent after 3 s.
- **No Claude/Anthropic in the product.** The Claude writer was removed; do not
  suggest re-adding it.
- Demographics: an answer saved on the Profile tab is always used (saving
  it is consent; runFill turns the gate on for the fill). "Answer voluntary
  demographic questions" (`DEMOGRAPHIC_KEYS`) then only decides whether an
  identity question nothing saved answers gets the form's own "prefer not
  to answer" (`declineOption`), never a guess; with nothing saved and it
  off, they are left alone. Salary is sensitive but not demographic; a question with
  its own key (sexual orientation, transgender experience) needs that key
  saved, since "Male" says nothing about either. With it off, the popup says
  how many were left and where to turn them on (`demographicsOff`).
- "Have you used/built X?" with nothing saved and TypeSafe unsure is No
  unless the résumé, a saved job or a project names X (`usedProduct`,
  `experienceText`, orchestrator.js), and only for a named tool or product:
  "Have you built customer-facing demos?" is a judgment TypeSafe makes from
  the résumé and projects (a word match once said No). A required
  follow-up whose condition is not met gets "N/A" (Ashby rejects it empty),
  only after a definite yes/no, never a guessed one.
- Written answers must not read as machine-written. The writer prompt
  carries the blader/humanizer patterns (Wikipedia's "Signs of AI writing")
  plus the user's own finds ("actually", "is the kind of", "on day one",
  a colon setting up an explanation, three parallel phrases "X, Y, and Z");
  `aiTells` (write.js) checks every sentence locally, sends hits to the
  fact check's Flash edit, and `withoutTells` cuts what survives. Add a new
  tell to both the prompt and `TELLS` when the user spots one.
- A follow-up question ("How did you know it worked?", `continuesPrevious`)
  shares the lead example of the question before it, goes in the same
  writer request, and may repeat its figures.
- A question asking for something the material doesn't have ("a multi-device
  test rig you owned") is answered honestly: the writer names the gap in a
  `gap` field and that sentence leads the answer, then the closest true
  example. The fact check's Flash edit sees the material, so it trims a
  flagged sentence to its true part instead of dropping it; sentences the edit
  words anew (`fromDraft`, write.js) are fact-checked again and dropped if
  invented (refusing the whole edit left Factory's answer one dangling line).
- "Why us?" questions (`isWhyUs`, write.js) make or break an application:
  with `whyUsResearch` on (Settings, default on) DeepSeek Flash first lists
  what's specific about the company (`researchCompany`: posting or
  well-known facts, no figures), and those questions go in their own writer
  request with reasoning (`deepseekWhyUsEffort` low, not hedged for 30 s).
  About 1¢ cost and ~10 s more, written while the rest of the form fills.
  The answer is about the company (user, 2026-10-25): it opens with the
  company's mission or problem and why it matters, then how the candidate's
  skills help it get there, with one short example as evidence. Never a past
  job retold and then "I'd like to do that here".
- A question that sets a threshold is answered from a saved figure, not a
  saved yes/no: "Able to travel up to 25%?" compares against
  `preferences.maxTravelPercent` (Profile tab), and a list of travel ranges
  gets the range holding it (`travelAnswer`, orchestrator.js). Add the next
  such question (hours a week, commute distance) the same way.
- "Can you pass a background and reference check?" is answered from the
  Settings box `passBackgroundCheck` (ticked by default), never guessed:
  runFill puts it in `screening.backgroundCheck`.
- The job posting comes from the page's schema.org JobPosting when it has one
  (`jobPosting`, extract.js): Ashby's application tab shows only the form, and
  "Why Sesame?" was written with no posting.
- One project per answer: each written question gets its own lead example
  from the résumé and Projects (`assignExamples`), and a figure told twice
  is removed from all but the answer it fits (`repeatedSentences`).
  Parallel writer requests otherwise all tell the strongest project.
- The fact check counts "I haven't used X" as supported. It once removed
  every honest "none", leaving required answers empty.
- The CV's text is read from the uploaded file in the browser
  (`common/doctext.js`: PDF text layer, .docx, .rtf, .txt; no library) into
  `documents.resumeText`, shown under the upload only to check. A scan or
  .doc reads nothing and the page asks for the text.
- Several CVs, one per kind of job (`documents.resumes`, each with the
  jobs it is for in `category`). The first is the main one, and its text is
  `documents.resumeText`; the others keep their own `text`. With two or more,
  one TypeSafe Choice (`pickResume`, classify.js) picks the CV for the job's
  title and posting, falling back to the stated jobs' words
  (`resumeByWords`), then the main one. That CV is attached and is the
  résumé the writer, fact check and TypeSafe read for the fill (`chooseResume`,
  orchestrator.js), and later pages of one application (same tab and site)
  reuse it. The old single `documents.resume` is read as a list of one.
- Projects (Settings, a list like Employment) hold work beyond the résumé;
  the writer, fact check and TypeSafe all read them.
- Salary questions get the lowest pay the job page posts (`lowestPay`,
  schema.js), never the saved figure. No pay posted: optional ones are left
  empty, required text boxes get "Market rate".
- Embedded forms are granted per **site** (`https://*.greenhouse.io/*`), not
  per origin, because embeds redirect within their site.
- **What phil knows about forms is data, shipped without a release.** The
  rules pack (`src/common/rules-default.js`, logic in `common/rulespack.js`,
  fetch and cache in `background/rules.js`) holds the platform list
  (hostnames, page markers, support level), label-to-key rules tried before
  `heuristics.js`'s own, named patterns (`emptyChoice`, `officeUse`,
  `rowName`, `genericLabel`, `iconGlyph`, `pageComplaint`,
  `questionTitle`), the page reader's selectors (`selectSkin`,
  `errorText`), how collapsed sections are opened, dropdown waits, and
  per-platform overrides. A constant the page reader matches against
  belongs in the pack, with the built-in copy kept as the fallback. The service serves it at `GET /v1/rules` (the
  built-in pack under the server's override file, `PHILFORM_RULES`), the
  extension fetches it every 6 h with its ETag, and a fill starts with
  what is cached. Regexes are "/source/flags" strings; a bad entry is
  ignored. It is data, never code (the stores forbid remote code). A fix
  that is a pattern, selector, wait or rule goes in the pack; a new widget
  driver still needs a release. The popup shows a circle for the page's
  platform support (full, partial, seen before, new) from
  `MSG.GET_PAGE_SUPPORT`, and reports carry the platform (user,
  2026-10-27: fixes per page were too slow and each needed a store build).
- Site skills learn by themselves and TypeSafe checks every learned mapping
  on each fill. Users never manage them: the Site skills tab, its popup
  button and the slow-site setting are `.dev-only`. Improve them in code,
  never by asking the user to correct rows.
- Commits go on a branch, not `main`. Only commit when asked.

## Privacy rules for this repo

- Never commit personal data. `.dev/` (runs, corpus, answer keys,
  `personal-config.json`), `src/common/local-config.js` (API keys) and
  `src/common/dev-config.js` are gitignored. Before committing, grep the diff
  for the user's name, email, phone, addresses, GitHub/LinkedIn handles.
- Use fictional values in tests and comments (Pat Brien, 415-555-0134,
  Portland, Acme/Globex).
- Never print API keys. Do not kill the user's own processes (their Firefox,
  their `dev.py`, `job_board.py`).

## Working on it

```bash
python3 tools/dev.py                        # dev Firefox, reloads on save, saves every fill to .dev/runs/
./test.sh                                   # all offline checks (JSC + headless Firefox), ~2 min
python3 tools/test-live.py --typesafe-only  # real TypeSafe benchmark (24 cases)
python3 tools/try-form.py URL [--probe]     # one live page, timeline and decisions
node tools/try-writer.mjs QUESTIONS.json    # written answers only, straight to DeepSeek, ~10 s
python3 tools/corpus.py run [NAME ...]      # every saved live form, scored: .dev/corpus-runs/<t>/scorecard.md
                                            # (behind a sign-in: "steps" in entry.json, creds from .creds.env)
python3 tools/dev.py --improve              # dev Firefox + review every fill + fix what reviews find
python3 tools/dev.py backlog                # problems found by reviews, and what became of them
python3 tools/dev.py fix [SLUG]             # fix one backlog problem now
deploy/deploy.sh [--setup]                  # the service to philformapp.com (Hetzner, systemd + Caddy)
python3 tools/accounts.py [unlimited ID]    # the service's accounts; give one unlimited fills
python3 tools/publish-firefox.py            # sign unlisted with Mozilla, host the .xpi and updates.json
```

- Production: one Hetzner box (Germany) reached as `ssh -F .dev/ssh/config
  philform`; secrets in `/etc/philform.env`, data in `/var/lib/philform/db.json`
  (the service keeps it in memory: edit only with the service stopped, as
  `accounts.py` does). The privacy policy is served from `PRIVACY.md` at
  `/privacy`. The website (`deploy/site/`, static, self-hosted fonts, no
  tracking) is the landing page. Its last section offers the newest signed
  Firefox build (read from `/firefox/updates.json`, so a publish updates
  the button) with a still-in-development note and the support email;
  Chrome is a closed beta, so the early-access form stays for it
  (`accounts.py waitlist`). Filling in `STORES` in `site.js` turns them
  into store buttons. Credentials (AMO issuer/secret, Cloudflare token) are in the
  gitignored `.creds.env`; never print them.
- Store builds (`RELEASE=1 ./build.sh`) have no host permissions (the service
  answers CORS) and, for Firefox, the id `philform@philform` and an update_url;
  dev builds keep `applicator@local.test`. Raise `version` in both manifests
  for every store upload. Firefox checks `updates.json` only once a day and
  has no `requestUpdateCheck`, so the popup reads it too (`offerUpdate`,
  popup.js; needs the CORS header in the Caddyfile) and offers "Update now".

- Self-healing (`tools/autofix.py`, dev only): each review ends with its
  problems as JSON and they merge into `.dev/backlog.json` by slug (a fixed
  one that reappears is reopened). `--improve` fixes the most pressing in a
  copy of the project; only a fix that passes `./test.sh` and does not lower
  the corpus score is copied into the working tree. Capped by `--max-fixes`
  (default 5), two attempts per problem and `--fix-budget` per session. It
  never commits and may not edit `tools/autofix.py` or `tools/dev.py`.

- Profiles: dev tools use `.dev/personal-config.json` (the dev build's
  "Save to project" writes it). The corpus uses `.dev/corpus/profile.json`,
  the profile its answer keys were written for; do not score it against a
  different profile.
- Read a fill through its `page.md` (fields, TypeSafe top-3, decisions, page
  readback, possibly missed) and `report.json` (`writer-raw`, `typesafe`,
  `filled` events).
- Headless Firefox never starts CSS animations (nothing paints): to see an
  animation frame, pause `document.getAnimations()` at a time and screenshot.
  Anything whose final state matters (counters) must run on timers, not
  animation frames.
- **Test fills live first.** Offline fixtures missed every Workday problem
  (entry click target, Enter-only search, staged results). Reproduce on the
  live page: a headless Firefox with a scratch profile and a free Marionette
  port, signed in and stepped to the page over WebDriver (never Submit),
  then `try-form.py - --attach PORT` for the real fill, or `--experiment`
  for one widget's filler. Before writing or trusting a fixture, check the
  live page for changes; add one only as a regression guard that does what
  the live page does. Passwords stay in environment variables, never files.
- Logic tests run in macOS JavaScriptCore via osascript (no timers, no async);
  anything needing the DOM, timers or events goes in `tools/test-firefox.py`
  fixtures. Add a fixture that reproduces a live-site bug before fixing it.
- Node is installed (brew) for web-ext only. Python is 3.9: no `match`, no
  `X | Y` types.

## Lessons that cost time

- Firefox launched from VS Code's process tree cannot read its profile folder
  ("Profile Missing"): always launch through `/usr/bin/open -n -W -a Firefox.app`.
- Firefox 159 (2026-10-27) grants Marionette system access (the chrome
  context the tools use to read the add-on's uuid) only with
  `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` in Firefox's environment; the
  `-remote-allow-system-access` flag and prefs no longer work. Through
  `open(1)` pass it with `--env`. Every launcher sets it.
- Headless harness pages must stay the focused window: a background tab runs
  timers once a second and skips animations (dropdowns open seconds late), and
  switching windows blurs inputs, which closes suggestion lists. `try-form`
  reports progress through attributes on the page for this reason.
- Widgets act on different halves of events: send whole key presses
  (down+up) and whole clicks (pointer/mouse down, up, click). Wait with a
  MutationObserver plus a 50 ms poll, not timers alone.
- A suggestion list's wrapper is not an entry (Lever "Berkeley" bug); a
  pre-filled dial code ("+31") is not an answer; Workday ids carry the section
  before `--`; a generic `aria-label="Select"` is not the question.
- Shared build folders race: each tool builds into its own `DIST`.
- Several agents may be working in this repo at once (one runs the dev
  loop and its tests while another fixes the backlog). Never assume a port,
  a Firefox or a build folder is yours: tools pick a free Marionette port
  (`free_port()`), and a port that is taken means use another one, never
  kill the process holding it. A test Firefox you did not start is someone
  else's run.
- DeepSeek's prompt cache: a changed system prompt makes the next fills cost
  several times more until cached. Keep shared material first in the prompt.
- Identity questions are found by label, nearest heading (choices only) and
  options (`isIdentityQuestion`, `schema.js`): race boxes are labelled only
  "European", gender dropdowns can be unlabelled. With demographics off they
  never reach a rule or a model; on, only saved answers are used.
- Fixture pages fill in a background tab. The test profile turns off
  Firefox's background timer throttling (once a second), which had made
  the browser test four minutes long; the two Firefox tests run in parallel.
  A fixture whose page must be ready before the fill (a slow form session)
  passes `settle=` to `fill_step`.
- Known gap: a request the page started before the fill's request tracker
  was installed (Ashby's form session on a slow line, Fill clicked within
  ~1.5 s of load) is not waited for (`savefields.html` settles 2 s).
- A `<button>` in a form submits it on click; `press()` blocks that submit.
- Some forms (Ashby) save each change a moment later on a copy of their state:
  answers written in one task overwrite each other, every box looks filled,
  and Submit says they are missing. `fill()` yields to the page after each
  field (`stale.html` fixture). Check a live form's real state by blanking
  one required box and reading its error list, never by looking at the boxes.
- Ashby saves every answer to its server as it changes (`ApiSetFormValue`,
  `ApiSetFormValueToFile`) and submits the server's copy. On a slow line,
  saves made before its form session exists, or still in flight, are lost:
  random "Missing entry" errors. `trackRequests` (frames.js) counts the
  page's requests in flight and `fill()` waits for none before and after
  writing (`savefields.html`). Files go in first, before the answers.
  A save's reply can also replace the page's state, undoing a choice made
  while it was out (Sentry lost alternate clicks): `fill()` waits for the
  page's requests after every field too (`savewhole.html`).
- Test written answers with `tools/try-writer.mjs`, not a whole browser
  fill: one writer round, no harness, no form.
- Ashby marks a required question on its label, a sibling of the box
  (`requiredByLabel`, extract.js). Its yes/no questions are a tick box with
  Yes/No buttons; with no rule for them they go to TypeSafe as a Yes/No
  choice (`yesNoBox`, orchestrator.js). A date picker showing today is
  showing its own default, not an answer.
- The harness and test Firefoxes run under Marionette, and captchas refuse
  them even when a person solves the challenge (Lever always challenges:
  Gridware, Velo3D; Workable's submit hangs on "Submitting…": Anthro). A form that challenges is finished in the user's own
  Firefox with phil; never hide the automation from a captcha.
- Repeated refused submits on Ashby trip its reCAPTCHA spam score: one real
  submit per job, and check a form's state read-only, never by submitting.
- Workday's school box lists nothing while you type: it searches on Enter
  and takes only a clicked result (`typeAndSearch`, fill.js). A school,
  degree or major the list lacks gets the closest entry by shared words
  ("Lakeside College" → "Lakeside Community College"), else the list's
  "Other" (no broad field: a transfer pathway is not "Liberal Arts"),
  outlined amber (`closestEntry`, `closestLabel`). Each search box gives
  up after 15 s (30 s on a slow line). Workday listens on an entry's inner
  node (`entryTarget`); typing shows the whole list (or the last results)
  until Enter; results arrive in stages (`settledList`).
- Workday's search prompts keep a choice only as a pill beside the box;
  the typed search is not an answer (`promptPicked`). Skills go in one
  at a time, each only as the entry that is it ("Python (Programming
  Language)"); for the rest TypeSafe says which entry, if any, is a close
  enough equivalent (`pickEquivalents`: Airflow → Apache Airflow), never
  "Other". They come from `work.skills` (defaults to the résumé's Skills section,
  `skillsFromResume`), never "Other". Its date parts are spin buttons that
  take only key presses, committed on a click outside (`setSpinbutton`);
  a box the page marks in error (`showsError`: aria-invalid, Workday's
  `inputAlert`) is never "already answered". An upload already showing a
  file is not attached again (`fileShownNear`).
- Cancel must stop the page too: `runFill` sends `__applicatorStop` on
  abort, which ends every wait, typing and press in fill.js, and `halt()`
  stops the fill between steps (`cancel.html`).
- Reading a page must not change it: the dropdown probe skips date boxes
  and puts back any value it changed.
- SuccessFactors' career portal (PG&E, `career4.successfactors.com`, behind
  a login) shows only section bars: every box is in the page under a
  `button[aria-expanded=false]` and phil saw one field. `openSections`
  (frames.js) opens collapsed sections before a fill's read (a submit set
  off by the click is held). Its dropdowns are inputs with `aria-owns`
  naming their list, which opens ~600 ms after the click: a box that names
  its list is read from that list only and waited for longer (`ownOptions`,
  `readOptions`), or the previous box's list is read as this one's. An
  empty dropdown shows "No Selection" and an icon-font arrow (U+E1EF): both
  are no answer (`EMPTY_CHOICE`, `shownNear`). Its rows open with "Current
  Employer?" and the dates, the company box third: rows split on the
  question that comes round once per row (`blocksByName`), and rows are
  counted by their name boxes before "Add" is pressed (`blockCounts`). Its
  date boxes are UI5 web components (`ui5-date-picker`), all with the inner
  id `inner`. The account's saved profile is in the HTML's `value`
  attributes: a reset for testing blanks the properties only.

## Where things are

- `src/content/extract.js` reads fields (labels, widgets, options, missed
  questions); `src/content/fill.js` writes them.
- `src/background/orchestrator.js` runs a fill; `classify.js` TypeSafe;
  `write.js` DeepSeek; `heuristics.js`/`scope.js`/`shortlist.js` field meaning;
  `frames.js` frames; `cost.js` metering; `learn.js` saving answers from a page;
  `issues.js` reports; `common/schema.js` the profile vocabulary;
  `common/rules-default.js` + `rulespack.js` + `background/rules.js` the
  rules pack (platforms, patterns, rules, served by `/v1/rules`).
- `tools/dev.py`, `corpus.py`, `try-form.py`, `runreport.py` (page.md), tests.

## Private notes

The repo is public. Anything about the maintainer's own job search, the
business plan or a session's handover goes in `CLAUDE.local.md`
(gitignored), never here: that file holds the handover notes between the
sessions that keep improving phil. Read it, act on it, and replace its
handover section with your own notes for the next session.

@CLAUDE.local.md
