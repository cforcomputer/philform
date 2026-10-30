/**
 * Applicator - profile schema and field taxonomy.
 *
 * PROFILE_FIELDS is the canonical list of things a job application can ask for.
 * Every entry is addressable by a dotted `key`. The heuristic matcher, the LLM
 * prompts, the options UI and the site skills all speak this same vocabulary,
 * so adding a field here is the only change needed to teach the whole system
 * about a new answer.
 */

/** Grouping used to lay out the options page. */
export const SECTIONS = [
  { id: 'identity', title: 'Identity', blurb: 'Your name as it appears on official documents.' },
  { id: 'contact', title: 'Contact', blurb: 'How employers reach you.' },
  { id: 'address', title: 'Address', blurb: 'Used for location and relocation questions.' },
  { id: 'links', title: 'Links', blurb: 'Profiles and portfolios employers ask for.' },
  { id: 'references', title: 'References', blurb: 'People an employer may contact about you, in the order you want them given. A form asking for several gets them in this order; a site that asks for one at a time gets the next one each time you fill, until the browser closes.' },
  { id: 'work', title: 'Current situation', blurb: 'Where you stand now. Your current job and school come from the history lists below.' },
  { id: 'employment', title: 'Employment history', blurb: 'Any order. The newest job, worked out from the dates, answers "current or most recent employer" questions, and forms asking for several jobs are filled newest first.' },
  { id: 'education', title: 'Education', blurb: 'Any order. The newest entry answers "school", "degree" and "graduation year" questions; forms asking for several are filled newest first.' },
  { id: 'projects', title: 'Projects', blurb: 'Things you built or ran that are not on your résumé, or deserve more than a line there: side projects, open source, freelance work. Written answers can draw on them.' },
  { id: 'authorization', title: 'Work authorization', blurb: 'Right-to-work and sponsorship questions.' },
  { id: 'compensation', title: 'Compensation', blurb: 'Only sent when a form actually asks.' },
  { id: 'preferences', title: 'Preferences', blurb: 'Relocation, remote work, start date.' },
  { id: 'screening', title: 'Screening questions', blurb: 'Common on public-sector and hourly applications. Leave any blank to answer it yourself on the form.' },
  { id: 'demographics', title: 'Voluntary demographics', blurb: 'Equal-opportunity questions. Every field is optional and is only used to answer a question the form already asks.' },
  { id: 'documents', title: 'Documents', blurb: 'Source material the writing model draws on.' }
];

/**
 * type drives both the options-page input and the value coercion at fill time.
 *   text | longtext | email | tel | url | date | number | select | boolean
 * `sensitive: true` fields are withheld from the model unless a field on the
 * page is confidently matched to them.
 */
export const PROFILE_FIELDS = [
  // --- identity -----------------------------------------------------------
  { key: 'identity.firstName', label: 'First name', type: 'text', section: 'identity', autocomplete: ['given-name'] },
  { key: 'identity.middleName', label: 'Middle name', type: 'text', section: 'identity', autocomplete: ['additional-name'] },
  { key: 'identity.lastName', label: 'Last name', type: 'text', section: 'identity', autocomplete: ['family-name'] },
  // Most people have none: a Suffix list with nothing saved is left alone, never guessed (PG&E offered "Jr.").
  { key: 'identity.suffix', label: 'Name suffix (Jr., III)', type: 'text', section: 'identity', autocomplete: ['honorific-suffix'] },
  { key: 'identity.fullName', label: 'Full name', type: 'text', section: 'identity', autocomplete: ['name'], derived: p => [p['identity.firstName'], p['identity.middleName'], p['identity.lastName']].map(v => String(v || '').trim()).filter(Boolean).join(' ') },
  { key: 'identity.namePronunciation', label: 'Name pronunciation', type: 'text', section: 'identity',
    help: 'Optional, e.g. "PAT BRY-en". Left blank, pronunciation questions stay empty.' },
  { key: 'identity.preferredName', label: 'Preferred name', type: 'text', section: 'identity', autocomplete: ['nickname'] },
  { key: 'identity.pronouns', label: 'Pronouns', type: 'text', section: 'identity' },

  // --- contact ------------------------------------------------------------
  { key: 'contact.email', label: 'Email', type: 'email', section: 'contact', autocomplete: ['email'] },
  { key: 'contact.phone', label: 'Phone', type: 'tel', section: 'contact', autocomplete: ['tel'] },
  { key: 'contact.phoneCountryCode', label: 'Phone country code', type: 'text', section: 'contact', autocomplete: ['tel-country-code'] },
  { key: 'contact.phoneType', label: 'Phone type', type: 'select', section: 'contact', choices: ['Cell', 'Home', 'Work'] },
  { key: 'contact.preferredMethod', label: 'Preferred contact method', type: 'select', section: 'contact', choices: ['Email', 'Phone call', 'Text message'] },
  { key: 'contact.textConsent', label: 'Agree to be contacted by text message', type: 'boolean', section: 'contact' },

  // --- address ------------------------------------------------------------
  { key: 'address.line1', label: 'Street address', type: 'text', section: 'address', autocomplete: ['address-line1', 'street-address'] },
  { key: 'address.line2', label: 'Address line 2', type: 'text', section: 'address', autocomplete: ['address-line2'] },
  { key: 'address.city', label: 'City', type: 'text', section: 'address', autocomplete: ['address-level2'] },
  { key: 'address.state', label: 'State / Province', type: 'text', section: 'address', autocomplete: ['address-level1'] },
  { key: 'address.postalCode', label: 'Postal code', type: 'text', section: 'address', autocomplete: ['postal-code'] },
  { key: 'address.country', label: 'Country', type: 'text', section: 'address', autocomplete: ['country-name'] },
  // "Where are you based?" wants a place, not a street address.
  { key: 'address.location', label: 'Location (city and state)', type: 'text', section: 'address', inferredOnly: true,
    derived: p => [p['address.city'], p['address.state']].map(v => String(v || '').trim()).filter(Boolean).join(', ') },

  // --- links --------------------------------------------------------------
  { key: 'links.linkedin', label: 'LinkedIn URL', type: 'url', section: 'links' },
  { key: 'links.github', label: 'GitHub URL', type: 'url', section: 'links' },
  // A personal site is the portfolio, and the other way round, when only one is saved (Lever asks both).
  { key: 'links.portfolio', label: 'Portfolio URL', type: 'url', section: 'links', derived: p => p['links.website'] || '' },
  { key: 'links.website', label: 'Personal website', type: 'url', section: 'links', derived: p => p['links.portfolio'] || '' },
  { key: 'links.other', label: 'Other profile URL', type: 'url', section: 'links' },

  // --- references -----------------------------------------------------------
  // Other people's details, kept as a list like jobs and schools. A field in a
  // form's references block resolves against the entry that block is for.
  { key: 'references.fullName', label: 'Full name', type: 'text', section: 'references', repeating: true },
  { key: 'references.relationship', label: 'Relationship', type: 'text', section: 'references', repeating: true, placeholder: 'Former manager' },
  { key: 'references.company', label: 'Company', type: 'text', section: 'references', repeating: true },
  { key: 'references.title', label: 'Job title', type: 'text', section: 'references', repeating: true },
  { key: 'references.phone', label: 'Phone', type: 'tel', section: 'references', repeating: true },
  { key: 'references.email', label: 'Email', type: 'email', section: 'references', repeating: true },
  { key: 'references.yearsKnown', label: 'Years known', type: 'number', section: 'references', repeating: true },
  // For forms that ask for the name in parts.
  { key: 'references.firstName', label: 'First name', type: 'text', section: 'references', repeating: true,
    inferredOnly: true, fromEntry: e => nameParts(e.fullName).first },
  { key: 'references.lastName', label: 'Last name', type: 'text', section: 'references', repeating: true,
    inferredOnly: true, fromEntry: e => nameParts(e.fullName).last },

  // --- current work -------------------------------------------------------
  { key: 'work.employmentStatus', label: 'Current situation', type: 'select', section: 'work',
    choices: ['Employed', 'Not currently employed', 'Student', 'Self-employed', 'Contractor'],
    help: 'A form that asks for your current employer is answered from your most recent job when you are not working.' },
  // Current role is always read from the newest job in the history, so there
  // is one place to keep it and nothing to contradict. It is not shown in the
  // editor. Someone not currently employed still has a most recent job, which
  // is what these questions are really asking.
  { key: 'work.currentTitle', label: 'Current or most recent job title', type: 'text', section: 'work', autocomplete: ['organization-title'],
    inferredOnly: true, derived: p => employmentEntry(p, 0).title },
  { key: 'work.currentCompany', label: 'Current or most recent employer', type: 'text', section: 'work', autocomplete: ['organization'],
    inferredOnly: true, derived: p => employmentEntry(p, 0).company },
  { key: 'work.yearsExperience', label: 'Years of experience', type: 'number', section: 'work' },
  { key: 'work.languages', label: 'Languages you speak', type: 'text', section: 'work',
    help: 'Comma separated, the one you are strongest in first, e.g. "English, Spanish".' },
  { key: 'work.noticePeriod', label: 'Notice period', type: 'text', section: 'work' },
  // Read from the résumé's Skills section until the user writes their own.
  { key: 'work.skills', label: 'Skills', type: 'text', section: 'work',
    help: 'Comma separated, most important first, e.g. "SQL, Python, Tableau". Filled from your résumé until you change it.',
    derived: p => skillsFromResume(p['documents.resumeText']) },
  // Read from the newest education entry, like the current job above.
  { key: 'work.highestDegree', label: 'Highest degree', type: 'text', section: 'work', inferredOnly: true, derived: p => listEntry(p, 'education', 0).degree },
  { key: 'work.school', label: 'School / University', type: 'text', section: 'work', inferredOnly: true, derived: p => listEntry(p, 'education', 0).school },
  { key: 'work.fieldOfStudy', label: 'Field of study', type: 'text', section: 'work', inferredOnly: true, derived: p => listEntry(p, 'education', 0).major },
  { key: 'work.graduationYear', label: 'Graduation year', type: 'number', section: 'work', inferredOnly: true, derived: p => yearOf(listEntry(p, 'education', 0).endYear) },
  // Any school past high school, or a finished high school, means yes. A
  // high school with no end year says nothing, so the question stays open.
  { key: 'work.highSchoolGraduate', label: 'Graduated from high school', type: 'boolean', section: 'work', inferredOnly: true,
    derived: p => (listEntries(p, 'education').some(e => !/high\s*school|secondary|\bged\b/i.test(`${e.school} ${e.degree}`) || yearOf(e.endYear)) ? 'yes' : '') },

  // --- employment history -------------------------------------------------
  // These keys carry no index. A form field that belongs to the second employer
  // block resolves against the second entry, so one key serves every repeat.
  { key: 'employment.company', label: 'Employer', type: 'text', section: 'employment', repeating: true },
  { key: 'employment.title', label: 'Job title', type: 'text', section: 'employment', repeating: true },
  { key: 'employment.positionType', label: 'Position type', type: 'select', section: 'employment', repeating: true,
    choices: ['Full-time', 'Part-time', 'Contract', 'Seasonal / temporary', 'Internship', 'Per diem', 'Volunteer'] },
  { key: 'employment.startDate', label: 'Start date', type: 'text', section: 'employment', repeating: true, placeholder: '2021-03' },
  { key: 'employment.endDate', label: 'End date', type: 'text', section: 'employment', repeating: true, placeholder: 'Blank if current' },
  { key: 'employment.current', label: 'Current job', type: 'boolean', section: 'employment', repeating: true,
    inferredOnly: true, fromEntry: e => (isOngoing(e, 'employment') ? 'yes' : 'no') },
  { key: 'employment.address', label: 'Company street address', type: 'text', section: 'employment', repeating: true },
  { key: 'employment.city', label: 'Company city', type: 'text', section: 'employment', repeating: true,
    fromEntry: e => locationPart(e.location, 'city') },
  { key: 'employment.state', label: 'Company state', type: 'text', section: 'employment', repeating: true,
    fromEntry: e => locationPart(e.location, 'state') },
  { key: 'employment.postalCode', label: 'Company postal code', type: 'text', section: 'employment', repeating: true },
  { key: 'employment.country', label: 'Company country', type: 'text', section: 'employment', repeating: true,
    fromEntry: e => locationPart(e.location, 'country'), fallback: 'address.country' },
  { key: 'employment.phone', label: 'Company phone', type: 'tel', section: 'employment', repeating: true },
  { key: 'employment.supervisor', label: "Supervisor's name", type: 'text', section: 'employment', repeating: true },
  { key: 'employment.mayContact', label: 'May they be contacted', type: 'boolean', section: 'employment', repeating: true },
  { key: 'employment.description', label: 'Duties', type: 'longtext', section: 'employment', repeating: true },
  { key: 'employment.reasonForLeaving', label: 'Reason for leaving', type: 'text', section: 'employment', repeating: true },

  // --- education ------------------------------------------------------------
  { key: 'education.school', label: 'Institution', type: 'text', section: 'education', repeating: true },
  { key: 'education.type', label: 'Institution type', type: 'select', section: 'education', repeating: true,
    choices: ['High school or equivalent', 'College or university', 'Technical school', 'Graduate school', 'Certification'] },
  { key: 'education.degree', label: 'Degree or certificate', type: 'text', section: 'education', repeating: true },
  { key: 'education.major', label: 'Major / course of study', type: 'text', section: 'education', repeating: true },
  { key: 'education.city', label: 'City', type: 'text', section: 'education', repeating: true },
  { key: 'education.state', label: 'State', type: 'text', section: 'education', repeating: true },
  { key: 'education.country', label: 'Country', type: 'text', section: 'education', repeating: true, fallback: 'address.country' },
  { key: 'education.startYear', label: 'Year started', type: 'text', section: 'education', repeating: true },
  { key: 'education.endYear', label: 'Year finished', type: 'text', section: 'education', repeating: true, placeholder: 'Blank if still studying' },
  { key: 'education.gpa', label: 'GPA', type: 'text', section: 'education', repeating: true, placeholder: 'e.g. 3.6, or blank' },

  // --- authorization ------------------------------------------------------
  { key: 'authorization.authorizedToWork', label: 'Authorized to work in the countries you may work in', type: 'boolean', section: 'authorization' },
  { key: 'authorization.requiresSponsorship', label: 'Will require visa sponsorship in the countries you may work in', type: 'boolean', section: 'authorization' },
  { key: 'authorization.citizenship', label: 'Citizenship status', type: 'text', section: 'authorization',
    help: 'As forms ask it. Pick one or type your own; list each citizenship you hold.',
    suggestions: ['U.S. citizen', 'U.S. citizen and EU citizen', 'EU citizen', 'U.S. permanent resident', 'Canadian citizen',
      'UK citizen', 'H-1B visa holder', 'F-1 student (OPT)'] },
  { key: 'authorization.visaStatus', label: 'Visa / work status', type: 'text', section: 'authorization' },
  { key: 'authorization.countriesAuthorized', label: 'Countries you may work in (any other country would need sponsorship)', type: 'text', section: 'authorization',
    help: 'Separate countries with commas. "European Union" covers every EU country, plus Norway, Iceland, Liechtenstein and Switzerland.',
    suggestions: ['United States', 'United States, European Union', 'European Union', 'Canada', 'United Kingdom', 'United States, Canada'] },
  { key: 'authorization.over18', label: 'At least 18 years old', type: 'boolean', section: 'authorization' },

  // --- compensation -------------------------------------------------------
  { key: 'compensation.desired', label: 'Desired compensation', type: 'text', section: 'compensation', sensitive: true,
    help: 'Not typed into forms: salary questions get the lowest pay the job posts. With no pay posted, they are left for you, or answered "Market rate" when required.' },
  { key: 'compensation.current', label: 'Current compensation', type: 'text', section: 'compensation', sensitive: true },
  { key: 'compensation.currency', label: 'Currency', type: 'text', section: 'compensation' },

  // --- preferences --------------------------------------------------------
  { key: 'preferences.willingToRelocate', label: 'Willing to relocate', type: 'boolean', section: 'preferences' },
  { key: 'preferences.maxTravelPercent', label: 'Most you are willing to travel for work (% of the time)', type: 'text', section: 'preferences',
    help: 'A number: 0 for no travel, 25 for up to a quarter of the time. Phil answers "Can you travel up to 25%?" and travel ranges from it.' },
  // Many screening questions ask whether you will meet the job's in-office
  // requirement ("five days a week in our SF office"). Answering no ends the
  // application; plenty of people say yes to get the interview and talk terms later.
  { key: 'preferences.acceptOnsite', label: 'Say yes to in-office and on-site requirements', type: 'boolean', section: 'preferences',
    help: 'Answer yes when a job asks if you will work in its office a set number of days, so the application is not screened out.' },
  { key: 'preferences.remotePreference', label: 'Remote / hybrid / onsite preference', type: 'text', section: 'preferences' },
  { key: 'preferences.availableStartDate', label: 'Available start date', type: 'text', section: 'preferences' },
  { key: 'preferences.hoursPerWeek', label: 'Hours per week you can work', type: 'text', section: 'preferences',
    help: 'e.g. "40" or "32-40".' },
  // The date a declaration is signed: always today, never saved.
  // Not counted as something the user saved, and not offered to the model:
  // only a rule that sees a signature date asks for it.
  { key: 'preferences.todaysDate', label: "Today's date (date signed)", type: 'date', section: 'preferences', inferredOnly: true, always: true,
    derived: () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; } },
  { key: 'preferences.howHeard', label: 'How you heard about the role', type: 'text', section: 'preferences' },
  { key: 'preferences.referredBy', label: 'Referred by', type: 'text', section: 'preferences' },
  { key: 'preferences.previouslyEmployed', label: 'Previously employed by this company', type: 'boolean', section: 'preferences' },
  { key: 'preferences.nonCompete', label: 'Bound by a non-compete', type: 'boolean', section: 'preferences' },
  // Only shown, and only ever sent, when the answer above is yes.
  { key: 'preferences.nonCompeteIndustry', label: 'Non-compete industry or scope', type: 'text', section: 'preferences',
    showWhen: { key: 'preferences.nonCompete', equals: 'yes' },
    help: 'Which industry, companies or roles the agreement covers. Forms that ask about a non-compete almost always ask this next.' },

  { key: 'preferences.agreeToTerms', label: 'Tick agreement boxes', type: 'boolean', section: 'preferences',
    help: 'Yes ticks "I agree to the terms / privacy policy" and "I understand" notices. Statements certifying your answers are true are always left for you to tick.' },

  // --- screening ------------------------------------------------------------
  { key: 'screening.everDischarged', label: 'Ever discharged, or resigned in lieu of discharge', type: 'boolean', section: 'screening' },
  { key: 'screening.relatedToEmployee', label: 'Related to an employee of the employer', type: 'boolean', section: 'screening' },
  { key: 'screening.essentialFunctions', label: 'Can perform the essential functions of the job, with or without accommodation', type: 'boolean', section: 'screening' },
  { key: 'screening.licenses', label: 'Professional licenses and certificates', type: 'text', section: 'screening',
    help: 'Write "None" if you hold none; forms usually require an answer.' },
  { key: 'screening.equipment', label: 'Machines and equipment you can operate', type: 'text', section: 'screening' },
  { key: 'screening.securityClearance', label: 'Active security clearance', type: 'text', section: 'screening',
    help: 'Write "None" if you hold none. Common on defence, aerospace and government applications.' },
  // Answered from the Settings box "I can pass a background check" (ticked
  // unless the user unticks it), not typed on the Profile tab.
  { key: 'screening.backgroundCheck', label: 'Can meet a background and reference check', type: 'boolean', section: 'screening',
    fromSetting: 'passBackgroundCheck' },
  { key: 'screening.gapExplanation', label: 'Explanation of gaps in employment', type: 'longtext', section: 'screening' },

  // --- demographics (voluntary) -------------------------------------------
  { key: 'demographics.gender', label: 'Gender', type: 'text', section: 'demographics', sensitive: true },
  { key: 'demographics.pronounsDisclosure', label: 'Pronouns (EEO form)', type: 'text', section: 'demographics', sensitive: true },
  { key: 'demographics.raceEthnicity', label: 'Race / ethnicity', type: 'text', section: 'demographics', sensitive: true },
  { key: 'demographics.hispanicLatino', label: 'Hispanic or Latino', type: 'text', section: 'demographics', sensitive: true },
  { key: 'demographics.sexualOrientation', label: 'Sexual orientation', type: 'text', section: 'demographics', sensitive: true },
  { key: 'demographics.transgender', label: 'Transgender experience', type: 'text', section: 'demographics', sensitive: true },
  { key: 'demographics.veteranStatus', label: 'Veteran status', type: 'text', section: 'demographics', sensitive: true },
  { key: 'demographics.disabilityStatus', label: 'Disability status', type: 'text', section: 'demographics', sensitive: true },
  { key: 'demographics.neurodiverse', label: 'Neurodiverse', type: 'boolean', section: 'demographics', sensitive: true },

  // --- documents ----------------------------------------------------------
  { key: 'documents.resumeText', label: 'Resume (plain text)', type: 'longtext', section: 'documents', help: 'Paste your resume. The writing model quotes from this for open-ended questions.' },
  { key: 'projects.name', label: 'Project name', type: 'text', section: 'projects', repeating: true, placeholder: 'Pricing bot' },
  { key: 'projects.description', label: 'What you did and what came of it', type: 'longtext', section: 'projects', repeating: true,
    help: 'A few plain sentences: what it is, what you built or did, the tools, and any result you can stand behind (users, money, time saved).' },
  { key: 'projects.link', label: 'Link (optional)', type: 'url', section: 'projects', repeating: true },
  { key: 'projects.when', label: 'When (optional)', type: 'text', section: 'projects', repeating: true, placeholder: '2024' },
  { key: 'documents.summary', label: 'Professional summary', type: 'longtext', section: 'documents', help: 'Two or three sentences describing what you do and what you are looking for.' },
  { key: 'documents.achievements', label: 'Key achievements', type: 'longtext', section: 'documents', help: 'One per line. Used as raw material for "tell us about a time..." questions.' },
  { key: 'documents.coverLetterTemplate', label: 'Cover letter template', type: 'longtext', section: 'documents', help: 'Optional. Use {{company}} and {{role}} as placeholders.' },
  { key: 'documents.writingSamples', label: 'Your own writing', type: 'longtext', section: 'documents', help: 'Paste a few cover letters or answers you wrote yourself. Written answers are drafted in your voice, so they read like you, not like a robot.' }
];

export const FIELD_BY_KEY = Object.fromEntries(PROFILE_FIELDS.map(f => [f.key, f]));

/**
 * Lists: entries the profile keeps several of. Each has its own fields (the
 * `repeating` keys in its section) and the two properties its dates live in,
 * which decide which entry is newest.
 */
export const LISTS = {
  employment: { max: 5, start: 'startDate', end: 'endDate' },
  education: { max: 4, start: 'startYear', end: 'endYear' },
  // No dates: references keep the order they were typed, and the editor
  // starts with three, since three is what forms usually ask for.
  references: { max: 5, initial: 3 },
  // A maker's site and GitHub hold more than ten (2026-10-24: 19).
  projects: { max: 25 }
};

/** "Ana María de la Cruz" as a first name and the rest. */
export function nameParts(full) {
  const words = String(full || '').trim().split(/\s+/).filter(Boolean);
  return { first: words[0] || '', last: words.slice(1).join(' ') };
}

/** The fields inside one entry of a list, in the order the options page shows them. */
export function listFields(list) {
  return PROFILE_FIELDS
    .filter(f => f.section === list && f.repeating)
    .map(f => ({ ...f, prop: f.key.split('.')[1] }));
}

export function blankEntry(list) {
  const entry = {};
  for (const f of listFields(list)) if (!f.inferredOnly) entry[f.prop] = '';
  return entry;
}

export const EMPLOYMENT_FIELDS = listFields('employment');

/** How many past jobs the profile keeps. Forms rarely ask for more than four. */
export const MAX_EMPLOYMENT = LISTS.employment.max;

export function blankEmployment() {
  return blankEntry('employment');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A date as written in a profile ("2022-03", "03/2022", "Mar 2022", "2022"),
 * as a number that sorts. Unreadable text gives null.
 */
export function dateRank(text) {
  const parts = dateParts(text);
  return parts ? parts.year * 13 + (parts.month || 0) : null;
}

/** Year and month (1-12, or 0 when not given) of a date as a person writes it. */
export function dateParts(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const year = t.match(/\b(19|20)\d{2}\b/);
  if (!year) return null;
  let month = 0;
  const iso = t.match(/\b(?:19|20)\d{2}[-/.](\d{1,2})\b/);
  const us = t.match(/\b(\d{1,2})[-/.](?:\d{1,2}[-/.])?(?:19|20)\d{2}\b/);
  const word = MONTHS.findIndex(m => t.includes(m));
  if (iso) month = Number(iso[1]);
  else if (us) month = Number(us[1]);
  else if (word >= 0) month = word + 1;
  return { year: Number(year[0]), month: month >= 1 && month <= 12 ? month : 0 };
}

export function yearOf(text) {
  const parts = dateParts(text);
  return parts ? String(parts.year) : '';
}

/**
 * Take one part of a free-text location such as "Austin, TX, USA".
 * A location with fewer parts than asked for yields nothing rather than a guess.
 */
export function locationPart(location, part) {
  const pieces = String(location || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!pieces.length) return '';
  if (part === 'city') return pieces[0];
  if (part === 'state') return pieces.length >= 2 ? pieces[1] : '';
  if (part === 'country') return pieces.length >= 3 ? pieces[pieces.length - 1] : '';
  return '';
}

/** An entry with no end date, or one that says "present", is still going. */
export function isOngoing(entry, list = 'employment') {
  const end = String(entry?.[LISTS[list]?.end || 'endDate'] || '').trim();
  return !end || /present|current|now|ongoing/i.test(end);
}

/**
 * Entries of a list that have anything in them, newest first.
 *
 * The order is worked out from the dates, not from the order they were typed,
 * so a history entered oldest first still answers "most recent employer" with
 * the newest job. An ongoing entry comes first; then the latest end date; then
 * the latest start. Entries without readable dates keep their typed order.
 * Schools attended without a degree go after those with one.
 */
export function listEntries(profile, list) {
  const { start, end } = LISTS[list];
  const raw = Array.isArray(profile?.[list]) ? profile[list] : [];
  const filled = raw
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => Object.values(e || {}).some(v => String(v || '').trim() !== ''));
  // A list without dates keeps the order it was typed in.
  if (!start) return filled.map(({ e }) => e);
  // A school left without a degree comes after one that gave a degree: a
  // form with a single education block and a required Degree list gets the
  // highest degree held, never a degree claimed for an unfinished program.
  const degreeless = e => list === 'education' && !String(e.degree || '').trim();
  return filled
    .sort((a, b) => {
      const held = Number(degreeless(a.e)) - Number(degreeless(b.e));
      if (held) return held;
      const ongoing = Number(isOngoing(b.e, list)) - Number(isOngoing(a.e, list));
      if (ongoing) return ongoing;
      const byEnd = (dateRank(b.e[end]) ?? -1) - (dateRank(a.e[end]) ?? -1);
      if (byEnd) return byEnd;
      const byStart = (dateRank(b.e[start]) ?? -1) - (dateRank(a.e[start]) ?? -1);
      return byStart || a.i - b.i;
    })
    .map(({ e }) => e);
}

/** One entry, newest first. Always an object, so properties can be read freely. */
export function listEntry(profile, list, index) {
  return { ...blankEntry(list), ...(listEntries(profile, list)[index] || {}) };
}

/** Position in the typed list of the newest entry, or -1 when there is none. */
export function newestIndex(profile, list) {
  const raw = Array.isArray(profile?.[list]) ? profile[list] : [];
  const newest = listEntries(profile, list)[0];
  return newest ? raw.indexOf(newest) : -1;
}

/**
 * Bring a profile saved by an earlier version up to date, without losing
 * anything: a job's free-text location is split into city, state and country,
 * and education typed as single fields becomes the first education entry.
 */
export function normaliseProfile(profile) {
  const p = { ...(profile || {}) };
  if (Array.isArray(p.employment)) {
    p.employment = p.employment.map(e => {
      if (!e || !e.location || e.city) return e;
      return {
        ...e,
        city: locationPart(e.location, 'city'),
        state: e.state || locationPart(e.location, 'state'),
        country: e.country || locationPart(e.location, 'country')
      };
    });
  }
  const flat = ['work.school', 'work.fieldOfStudy', 'work.highestDegree', 'work.graduationYear']
    .some(k => String(p[k] || '').trim());
  if (flat && !(Array.isArray(p.education) && p.education.length)) {
    p.education = [{
      ...blankEntry('education'),
      school: p['work.school'] || '',
      major: p['work.fieldOfStudy'] || '',
      degree: p['work.highestDegree'] || '',
      endYear: String(p['work.graduationYear'] || '')
    }];
  }
  if (!Array.isArray(p.custom)) p.custom = [];
  // An answer saved under a question of only "*" (an older version kept
  // them) matches anything with a required mark.
  p.custom = p.custom.filter(c => c && /[a-z]/i.test(String(c.question || '')));
  return p;
}

export const employmentEntries = profile => listEntries(profile, 'employment');
export const employmentEntry = (profile, index) => listEntry(profile, 'employment', index);
export const newestEmploymentIndex = profile => newestIndex(profile, 'employment');

/**
 * Answers the user saved from a form Applicator had no field for. Each one is
 * a question and an answer, addressed as `custom.<id>`, and is offered to the
 * classifier alongside the built-in fields so a similar question on another
 * site finds it.
 */
export function customFields(profile) {
  const list = Array.isArray(profile?.custom) ? profile.custom : [];
  // A question kept with no answer yet is a reminder for the user, not a
  // value to offer: it waits on the Answers list until they fill it in.
  return list
    .filter(c => c && c.id && String(c.question || '').trim() && String(c.answer ?? '').trim())
    .map(c => {
      const label = String(c.question).trim();
      // A saved answer to an identity question ("Yes, I identify as LGBTQ+.")
      // is demographic, whatever page it was learned from.
      return { key: `custom.${c.id}`, label, type: 'text', section: 'custom', custom: true,
        sensitive: IDENTITY_QUESTION.test(withoutAgeLimit(label)) || undefined };
    });
}

/**
 * Identity questions: never guessed, and with "Answer voluntary demographic
 * questions" off, never answered or put to a model. Race boxes are often
 * labelled only by their option ("European") under a race heading, and an
 * unlabelled dropdown can be a gender question only its options give away,
 * so the heading and the options count as well as the label.
 */
export const IDENTITY_QUESTION = new RegExp([
  'gender', 'transgender', 'sexual orientation', 'neurodiver', '\\blgbt', '\\brace\\b', 'ethnic', 'hispanic', 'latin[oax]\\b',
  'veteran', 'disabilit', 'religio', 'national origin', 'date of birth', '\\bage\\b', 'marital status',
  'african american', 'american indian', 'alaska native', 'pacific islander', 'native hawaiian', '\\basian\\b',
  'caucasian', 'descendant', 'enslaved', 'ancestry', 'self[- ]identif', 'equal employment', '\\beeo\\b'
].join('|'), 'i');
// Also the communities lists ("Person with disability", "Neurodiverse", "Veteran", "Refugee or immigrant": Clay).
const IDENTITY_OPTION = /^(male|female|man|woman|non-?binary|transgender|genderqueer|straight|heterosexual|gay|lesbian|bisexual|asexual|pansexual|queer|hispanic or latino|not hispanic|white|black or african american|asian|person with (a )?disabilit|neurodiver|veteran|refugee|lgbt)/i;
// "At least 18 years of age" is an eligibility question, not an identity one,
// and so is PG&E's "Are you currently age 18 years or older?".
const withoutAgeLimit = text => String(text || '').replace(/\b(at least|over|under|older than)\s+\d+\s*(years)?\s*(of age|old)?|\b(aged?\s+)?\d+\s*(years)?\s*(of age\s*)?(or|and)\s+(older|over|above)\b|\b(legal|working|minimum) age\b|years of age/gi, '');
/**
 * A question with its leading exception removed: "Other than time off for
 * reasons related to your religion, a disability, or a medical condition,
 * are there any days you are unavailable to work?" asks about availability
 * (Kairos Power got the saved disability status there).
 */
export const withoutAside = text => String(text || '')
  .replace(/\b(other than|except( for)?|aside from|apart from|besides)\b.*?,\s*(?=(are|is|do|does|did|can|could|will|would|have|has)\b)/gi, '');
// Agreeing to terms on a "Voluntary Self-Identification" page is still agreeing.
const CONSENT = /\b(agree|acknowledge|certify|attest|consent|terms|i understand|i have read)\b/i;

export function isIdentityQuestion(field) {
  // Both readings: TypeSafe's question can be a description ("Let us know how
  // you'd like to be addressed") under the label that names it ("Pronouns").
  // "Preferred gender pronouns" asks for pronouns, which the Profile tab saves.
  const label = withoutAgeLimit(withoutAside(`${field.label || ''} ${field.extractedLabel || ''}`)).replace(/\bgender\s+pronouns?\b/gi, 'pronouns');
  if (IDENTITY_QUESTION.test(label)) return true;
  if (CONSENT.test(label)) return false;
  // Only choices are judged by their heading: a self-identification page's
  // "Name" and "Today's date" boxes are still the user's to have filled.
  const choice = field.type === 'checkbox' || field.type === 'radio' || field.tag === 'select' || !!field.options?.length;
  if (!choice) return false;
  const heading = String(field.section || '').split(' › ')[0];
  if (IDENTITY_QUESTION.test(withoutAgeLimit(heading))) return true;
  const options = (field.options || []).map(o => (typeof o === 'string' ? o : o.label || ''));
  // Mostly identity answers, not two among many: Lyft's 84 disciplines hold
  // "Asian Studies" and others, and the major went unanswered as "identity".
  const hits = options.filter(o => IDENTITY_OPTION.test(o.trim())).length;
  return hits >= 2 && hits >= options.length * 0.3;
}

/** Built-in and learned fields together. */
export function allFields(profile) {
  return [...PROFILE_FIELDS, ...customFields(profile)];
}

/** The definition of a key, built-in or learned. */
export function fieldDef(key, profile) {
  return FIELD_BY_KEY[key] || customFields(profile).find(f => f.key === key) || null;
}

/** Keys that are never sent to a model unless a page field matched them directly. */
export const SENSITIVE_KEYS = new Set(PROFILE_FIELDS.filter(f => f.sensitive).map(f => f.key));
/**
 * What "Answer voluntary demographic questions" switches: the EEO answers.
 * Salary is sensitive too, so it is never learned from a page, but it is not
 * demographic: a saved expected salary answers salary questions either way.
 */
export const DEMOGRAPHIC_KEYS = new Set(PROFILE_FIELDS.filter(f => f.sensitive && f.section === 'demographics').map(f => f.key));

/**
 * Input types and name patterns Applicator refuses to touch, regardless of what
 * any model suggests. This list is enforced in the content script at fill time,
 * so a bad model response cannot type into a password or payment box.
 */
export const FORBIDDEN_INPUT_TYPES = new Set(['password', 'hidden', 'file', 'image', 'submit', 'reset', 'button']);

export const FORBIDDEN_NAME_PATTERNS = [
  /pass(word|phrase)/i,
  /\bpin\b/i,
  /\bcvv\b|\bcvc\b|security[-_ ]?code/i,
  /card[-_ ]?number|cc[-_ ]?num|credit[-_ ]?card/i,
  /routing[-_ ]?number|account[-_ ]?number|iban|sort[-_ ]?code/i,
  /ssn|social[-_ ]?security|sin[-_ ]?number|national[-_ ]?insurance/i,
  /passport[-_ ]?number/i,
  /(driver|driving)[-_ ]?licen[cs]e[-_ ]?(no|number)/i,
  /date[-_ ]?of[-_ ]?birth|dob\b|birth[-_ ]?date/i,
  /\botp\b|one[-_ ]?time[-_ ]?code|verification[-_ ]?code|2fa/i
];

export function isForbiddenName(text) {
  if (!text) return false;
  return FORBIDDEN_NAME_PATTERNS.some(re => re.test(text));
}

/** Build a blank profile object keyed by dotted field key. */
export function emptyProfile() {
  const p = {};
  for (const f of PROFILE_FIELDS) p[f.key] = '';
  return p;
}

/**
 * Resolve a profile value, falling back to a derived value (e.g. fullName from
 * first + last) when the user left the field blank.
 */
export function profileValue(profile, key, { repeatIndex = 0 } = {}) {
  if (String(key).startsWith('custom.')) {
    const id = key.slice(7);
    const hit = (Array.isArray(profile?.custom) ? profile.custom : []).find(c => c && c.id === id);
    return hit && String(hit.answer || '').trim() !== '' ? hit.answer : '';
  }

  const field = FIELD_BY_KEY[key];

  // A repeating key belongs to one entry of a list rather than to the profile
  // as a whole, so it is read from the entry the form field sits in.
  if (field?.repeating) {
    const entry = listEntry(profile, field.section, repeatIndex);
    const value = field.inferredOnly ? '' : entry[field.key.split('.')[1]];
    if (value && String(value).trim() !== '') return value;
    const listed = listEntries(profile, field.section)[repeatIndex];
    const derived = listed && field.fromEntry ? field.fromEntry(listed) : '';
    if (derived && String(derived).trim() !== '') return derived;
    // Most jobs and schools are in the applicant's own country.
    if (listed && field.fallback) return profileValue(profile, field.fallback);
    return '';
  }

  // Inferred-only keys prefer the history; a value typed by an older version
  // is used only when there is no history to read from.
  if (field?.inferredOnly) {
    const d = field.derived(profile || {});
    if (d && String(d).trim() !== '') return d;
  }

  const direct = profile?.[key];
  if (direct !== undefined && direct !== null && String(direct).trim() !== '') return direct;

  if (field?.derived) {
    const d = field.derived(profile || {});
    if (d && String(d).trim() !== '') return d;
  }
  return '';
}

/**
 * Whether a field should be shown and used at all. A conditional field, such as
 * which industry a non-compete covers, is meaningless until its condition holds.
 */
export function isFieldActive(profile, key) {
  const field = FIELD_BY_KEY[key];
  if (!field?.showWhen) return true;
  const { key: on, equals } = field.showWhen;
  return String(profile?.[on] ?? '').trim().toLowerCase() === String(equals).toLowerCase();
}

/** Profile keys that actually hold a value right now. */
export function filledKeys(profile) {
  return allFields(profile)
    .map(f => f.key)
    .filter(k => !FIELD_BY_KEY[k]?.always && isFieldActive(profile, k) && profileValue(profile, k) !== '');
}

/**
 * Fields whose value Applicator works out from other answers, such as a full
 * name from a first and last name. They stay editable: a typed value always
 * wins over the inferred one.
 */
export function inferredValue(profile, key) {
  const field = FIELD_BY_KEY[key];
  if (!field?.derived) return '';
  const typed = profile?.[key];
  if (typed !== undefined && typed !== null && String(typed).trim() !== '') return '';
  const value = field.derived(profile || {});
  return value && String(value).trim() !== '' ? String(value) : '';
}

/**
 * The lowest pay a job page names ("$180K – $240K", "USD 150,000 - 190,000"),
 * as a plain amount ("180,000"), or '' when it names none. Salary questions
 * are answered with it: asking for the bottom of the posted range is safe,
 * and a saved figure can sit far below or above what this job pays.
 */
export function lowestPay(text) {
  const t = String(text || '').replace(/–|—/g, '-');
  const MONEY = /(?:[$€£]|\b(?:usd|eur|gbp|cad|aud)\s?)\s?(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)\s?(k\b)?/gi;
  const amounts = [];
  for (const m of t.matchAll(MONEY)) {
    let n = Number(m[1].replace(/[,.](?=\d{3}\b)/g, ''));
    if (m[2]) n *= 1000;
    // A range written "$180 - 240K" gives its unit to both ends.
    else if (n < 1000 && /^\s?-\s?[$€£]?\s?\d+(?:\.\d+)?\s?k\b/i.test(t.slice(m.index + m[0].length))) n *= 1000;
    // Yearly salaries only: an hourly rate, a benefit or a bonus is not one.
    if (n < 10000 || n >= 10000000) continue;
    const before = t.slice(Math.max(0, m.index - 60), m.index);
    const next = t.slice(m.index + m[0].length, m.index + m[0].length + 40);
    // What follows this amount, up to the next one ("-$170k plus a $15,000 signing bonus").
    const after = next.replace(/(\s?(-|to)\s?)?[$€£\d].*$/s, '');
    if (/bonus|stipend|relocation|allowance|budget|raised|funding|series [a-e]\b|valuation|reimburs/i.test(after) ||
      /(bonus|stipend|relocation|allowance|budget|raised|funding|valuation) (of |up to )?$/i.test(before)) continue;
    const ranged = /^\s?(-|to)\s?(?:[$€£]|[a-z]{3}\s)?\d/i.test(next) || /\d\s?k?\s?(-|to)\s?$/i.test(before);
    if (ranged || /(salary|compensation|\bpay|\bbase|\bote|annual)\W{0,20}(\b\w+\W+){0,3}$/i.test(before) || /^\s?(\/\s?(yr|year)|per year|a year|annually)\b/i.test(after)) amounts.push(n);
  }
  if (!amounts.length) return '';
  return String(Math.round(Math.min(...amounts))).replace(/\B(?=(\d{3})+$)/g, ',');
}

/**
 * The skills a résumé lists under its Skills heading, as "SQL, Python,
 * Tableau": category labels ("Languages:") and bullets dropped, at most 15.
 */
export function skillsFromResume(text) {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex(l => /^\s*(technical |key |core )?skills\b[^a-z]*(&|and)?\s*[a-z ]{0,20}:?\s*$/i.test(l) || /^\s*(technical |key |core )?skills\s*:/i.test(l));
  if (start < 0) return '';
  const HEADING = /^\s*(experience|work experience|employment|education|projects?|certifications?|awards|publications|interests|references|summary|profile|volunteer\w*|languages)\b\s*:?\s*$/i;
  const body = [lines[start].replace(/^\s*(technical |key |core )?skills\b[^:]*:?/i, '')];
  for (const line of lines.slice(start + 1, start + 15)) {
    if (HEADING.test(line) || (/^[A-Z][A-Z &]{3,}$/.test(line.trim()) && !/,/.test(line))) break;
    if (!line.trim() && body.join('').trim()) break;
    body.push(line);
  }
  const items = body.join('\n').split(/[,;|•·\n]+|\s{2,}/)
    .map(x => x.replace(/^[^:]{1,30}:\s*/, '').replace(/^[-*–\s]+|[.\s]+$/g, '').trim())
    .filter(x => (x.length >= 2 || /^[A-Z]$/.test(x)) && x.length <= 40 && !/^(and|etc)$/i.test(x));
  return [...new Set(items)].slice(0, 15).join(', ');
}
