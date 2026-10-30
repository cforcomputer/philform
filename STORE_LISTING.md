# Chrome Web Store submission notes

Copy for the listing, and the answers the review form asks for. Written to match
what the code actually does, because a mismatch between the two is the most
common cause of rejection.

## Listing

**Name:** philform - AI Job Application Autofill

**Short description** (132 characters max)

> Meet phil, your form-filling friend. Fills job applications from your saved profile, so you apply in minutes, not hours.

**Category:** Productivity

**Detailed description**

> Meet phil, a small bear-eared cube with a glowing lure, who fills in forms. philform fills job
> application forms so you can spend your time on the
> applications that matter rather than typing your address for the fortieth
> time.
>
> Fill in your profile once: your name, contact details, links, work history,
> preferences, and your resume as text. Then open any job application and click
> the philform button. It reads the form, works out what each field is asking
> for, fills it from your profile, and drafts the open-ended questions.
>
> You review everything and submit yourself. phil never submits an
> application for you.
>
> WHAT IT DOES
> - Fills names, contact details, addresses, links, work history and preferences
> - Reuses answers you have already written, exactly as you wrote them
> - Drafts answers to open-ended questions, grounded in your resume
> - Highlights every field it touched so review is quick
> - Learns each site, so your second application there is faster
> - Tells you which fields it left empty, and why
> - Exports your whole setup to a file you can import on another machine
>
> WHAT IT WILL NOT TOUCH
> Passwords, card numbers, bank details, Social Security and other national
> identifiers, passport numbers, dates of birth and verification codes are
> refused. They are never read and never filled.
>
> Voluntary demographic questions are switched off until you turn them on.
>
> YOUR DATA
> Your profile stays in your browser. There is no analytics and no tracking.
> To fill a form, the field labels and the relevant parts of your profile are
> sent through philform's service to the AI providers that do the matching and
> writing. Page HTML is never sent.
>
> PRICING
> Your first 10 applications are free. After that, each fill is paid from a
> wallet you top up $5 at a time, and the popup shows what every fill cost.

## Single purpose

philform fills in job application forms from a profile the user saves once:
contact details, work history and saved answers, with drafts for open-ended
questions. The user reviews every answer and submits the form themselves.

## Permission justifications

| Permission | Justification to submit |
|---|---|
| `storage` | Stores the user's application profile, their per-site field mappings and their settings on their own device. Nothing is transmitted to the developer. |
| `activeTab` | Reads the form on the tab the user is on, only at the moment they click the extension's toolbar button. This is what lets the extension work on any job site without requesting access to every site in advance. |
| `scripting` | Injects the two content scripts that read the form fields and write the values into them. Both ship inside the package. |
| `optional_host_permissions` for web origins | Requested one origin at a time, only when the user presses "Allow access" in the popup, for a job application embedded in the page from another site (for example a Greenhouse or iCIMS form inside a company's careers page). `activeTab` does not reach into a frame from another site. Nothing is granted at install, and no origin is requested without that click. |

A store build (`RELEASE=1`) has no required host permissions: it talks only
to philform's service, which answers cross-origin requests. The model API hosts
are in the source manifests for direct mode, which only a development build offers.

**Remote code:** No. All logic ships in the package. Answers from the AI
providers and the service are data (JSON and text written into form fields),
never executed.

**Why not `<all_urls>`:** deliberately avoided. `activeTab` covers the use case
and is granted per click. Embedded forms from another site are the one case it
does not cover, and those are granted per origin, on request, from the popup.

## Data use disclosures

Tick **Personally identifiable information**, **Personal communications**,
**Website content** and **Web history**.

- **Collected:** name, email address, phone number, postal address, profile
  URLs, employment and education history, the resume text the user pastes, and
  any answers they save on the Responses tab. The form's question labels
  (website content). philform's service keeps, for each free application, the
  job page's address (site and path) so every page of one application counts
  once (web history).
- **Purpose:** filling the form the user asked to have filled. Nothing else.
  Saved answers are included in a request only when the page asks an
  open-ended question, so the provider can identify which saved answer fits.
- **Transmitted to:** philform's service, which forwards each request without
  storing it, then TypeSafe, which decides which saved value fits each field,
  and DeepSeek, which writes the open-ended answers. The service stores only
  the anonymous wallet and the addresses of free applications.
- **Not sold, and not used for anything unrelated to the single purpose.**
- **Not used for creditworthiness or lending.**

Certify all three statements: no selling to third parties, no use outside the
single purpose, and no use for creditworthiness.

**Privacy policy URL:** host the contents of `PRIVACY.md` at a public URL and
put that URL in the listing. The store requires a reachable link, not a file.

## Before you submit

- [ ] Publish the privacy policy at a public URL and put it in the listing.
- [ ] Take screenshots at 1280x800: the popup on a real application, the profile
      tab, and the reward after a fill.
- [ ] Ship with philform's service (proxy mode) as the default and its address
      set, because a key in the package is a published key. Run
      `backend/server.mjs` with Stripe set up first (README, Shipping).
- [ ] Bump `version` in both manifests.
- [ ] Build with `RELEASE=1 ./build.sh`, which leaves the gitignored
      `src/common/local-config.js` and its API key out of the package. A plain
      `./build.sh` includes it and warns you.
- [ ] Confirm the uploaded zip has no `local-config.js`:
      `unzip -l dist/philform-chrome.zip | grep local-config`
- [ ] Upload `dist/philform-chrome.zip`.

## Firefox

Submit `dist/philform-firefox.zip` to addons.mozilla.org. Change the
add-on id in `manifest.firefox.json` from `applicator@local.test` to one on a
domain you control first. Mozilla asks for the same data-use answers and reviews
source directly, which the no-build-step layout makes straightforward.
