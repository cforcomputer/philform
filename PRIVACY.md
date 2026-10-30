# philform privacy policy

_Last updated: 2026-10-29_

philform fills job application forms on the page you have open. This policy
describes exactly what it reads, what it stores and what it sends.

## What philform stores

Everything philform saves is held in your browser's extension storage on this
device, using the `storage` permission:

- **Your profile.** The name, contact details, links, work history, preferences
  and documents you type into the settings page.
- **Site skills.** Which form field on a site corresponds to which profile
  value, so a second application on the same site is faster.
- **Saved responses.** Answers you have written yourself, with any example
  phrasings you added.
- **Run history.** A record of each run: the site, how long it took, how many
  fields were filled and which were left empty. By default the values that were
  typed are not recorded. You can turn history off entirely.
- **Documents you upload**, such as a CV or cover letter. These are stored on
  this device so they can be attached to an upload field when a page asks for
  one. They are never sent to a model provider.
- **Your API keys**, if you are running philform with your own keys.

If you turn on the **password lock** (Data tab), your profile, saved
responses, documents and saved reports are stored encrypted (AES-GCM, with a
key made from your password). The password itself is never stored or sent
anywhere. Once unlocked, the key is held in the browser's memory until you
close it. If you forget the password, the encrypted data cannot be recovered.

None of this is stored by the extension's developer. There is no analytics,
no telemetry and no tracking of any kind.

## What philform reads from a page

philform reads a page only when you click its toolbar button, using the
`activeTab` permission. It does not run in the background and it does not read
pages you have not asked it to act on.

Some applications are embedded in a page from another site, such as a
Greenhouse form inside a company's careers page. philform can read and fill
that form only after you press **Allow access** in its popup, which grants that
one site. You can remove the permission at any time in your browser's extension
settings.

When you click, it inspects the form controls on that page and reduces them to
a short description of each one: its label, its type, its options and enough
information to find it again. It also reads the page title and the job
description text, which is what allows a written answer to refer to the actual
role.

**Learn from this page** reads the answers you typed into the form on the page
you have open, only when you click it. It shows you what it found, and saves
only what you leave ticked, to your profile on this device. Nothing is sent to
any service while learning, and demographic answers are never learned.

## What philform sends, and to whom

Only the field descriptions above, the job title and description, and the
relevant values from your profile are sent. Raw page HTML is never sent.

When a page asks an open-ended question and you have saved responses, those
saved responses are also sent to whichever provider does the matching, so the model can judge which of them answers the
question that was asked. This is how a saved answer is found when the wording
differs from anything you anticipated. If you have no saved responses, nothing
of the kind is sent.

The references you save are other people's details: their names, phone
numbers, email addresses and how you know them. They are sent only when the
page you are filling has a references section, and only so that section can
be filled. On any other form they stay on your device. Which references you
have already given on a site is remembered only until you close the browser.

Deciding which saved value belongs in each field goes to TypeSafe
(`api.typesafe.ai`), and writing the open-ended answers goes to DeepSeek
(`api.deepseek.com`). Their handling of that data is governed by their own
policies. How the requests reach them depends on the mode in settings:

- **philform's service** (the default). Requests go to the philform service
  (`philformapp.com`), which forwards them to the two providers and
  records what each fill cost, to charge your wallet. Your account is anonymous: a random token stored in this
  browser, with no name, unless you choose to add an email (below). The service keeps your wallet balance,
  how many free applications you have left, the address of each
  application you filled for free (so later pages of it stay free), and for
  a few hours after each fill its application address and what it cost. It
  passes the questions on to the providers but does not keep them, your
  answers or your profile. Payments are made on
  Stripe's checkout page: philform never sees your card. When you pay, the
  email you give Stripe is recorded on your wallet, so you can get the wallet
  back after a reinstall. To limit misuse of the free applications, the
  service counts new accounts per internet address, keeping only a one-way
  hash of the address, and only for the current day and month.
- **Your email, if you add one.** Under Data, "Keep your wallet" sends a
  6-digit code to the address you enter; the code links the address to your
  wallet, or brings back a wallet already kept under it. The address is used
  for nothing else: no newsletters, no sharing.
- **Your own DeepSeek key, if you add one.** Under Settings, written answers
  then go from your browser straight to DeepSeek on your key, and not through
  philform's service. The key is kept in this browser only and is never sent
  to philform.
- **Direct mode.** The extension calls the two providers itself with API keys
  you enter, and nothing goes to philform's service.

## Rating a fill

After a fill the popup asks how phil did. A thumbs up or down, through
philform's service, sends the page's address, your rating, any note you
write, how many fields were filled, which kind of job site it was and the
questions' labels (such as "First name"). It never sends your answers or
anything from your profile.

A thumbs down also saves a full report in the extension's storage on your
device: what was read from the page, what was asked and answered, what each
field shows now, the page's HTML and your note. Because the page is filled
with your details, that report contains them; it stays on your device (the
most recent 20), and you can download or delete it under Data in settings.

## Uploads

philform can attach a CV or cover letter to a file upload field, but only a
file you stored in its settings yourself, and only to a field the page presents
as asking for one of those two documents. It cannot and does not read files
from your computer.

## What philform refuses to touch

philform will not read from or write to fields that look like passwords, PINs,
card numbers, bank details, national identifiers such as a Social Security
number, passport numbers, dates of birth, or one-time verification codes. These
are excluded during extraction and blocked again at fill time, so they are never
sent anywhere and never filled.

Voluntary demographic questions are only answered if you switch that on and fill
in those fields yourself. They are off by default.

## What philform never does

- It never submits an application. You review every field and submit yourself.
- It never fills a field on a page you did not invoke it on.
- It never sells your data, and never shares or transmits it to any party
  other than philform's service and the model providers needed to fill the
  form you asked it to fill, and Stripe when you add money to your wallet.

## Exporting your data

The Data tab writes everything philform holds to a file you choose the
contents of, so you can move to another browser or machine. API keys are
excluded from that file unless you explicitly tick the box that includes them.
Nothing is uploaded; the file is saved by your browser to your own device.

## Deleting your data

Settings, then the Data tab, then "Delete all philform data". This removes
your profile, every site skill, all history and your saved API keys from this
browser immediately. Removing the extension also deletes its storage.

Your wallet on philform's service is tied to the random token in your
browser, and to your email if you added one. Without an email, once that
token is deleted the wallet can no longer be linked to you. To have your
wallet, email or ratings deleted from the service, contact us below.

## This website

The website at philformapp.com sets no cookies, runs no analytics and loads
nothing from other companies. If you join the early-access list, we keep your
email address, the date and which browser you use, only to send you an invite.
To be removed from the list, contact us below.

## Contact

Questions about this policy, or a request to delete your wallet or your
early-access email: support@philformapp.com, or see
[philform support](https://philformapp.com/support).
