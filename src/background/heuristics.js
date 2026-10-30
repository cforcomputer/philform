/**
 * Local field matcher.
 *
 * Most job applications ask the same two dozen questions, worded slightly
 * differently. Resolving those here - with no network call - is what keeps a
 * run fast and the per-completion cost low. Only the fields this module cannot
 * place are sent to a model.
 *
 * Each rule is tried against the field's autocomplete attribute, its name/id,
 * and its visible label, in that order of trust.
 */

import { normalize, similarity, cleanLabel } from '../common/util.js';
import { PROFILE_FIELDS, isForbiddenName, withoutAside } from '../common/schema.js';

/** Confidence floor for a heuristic answer to be used without a model. */
export const HEURISTIC_ACCEPT = 0.82;

/**
 * Rules are ordered: the first match wins, so put narrow patterns above broad
 * ones. `label` patterns are matched against the cleaned visible label; `attr`
 * patterns against name, id and placeholder joined together.
 */
/** Rules from the rules pack (background/rules.js), tried before RULES. */
let EXTRA_RULES = [];
export function setExtraRules(list) {
  EXTRA_RULES = Array.isArray(list) ? list : [];
}
const allRules = () => (EXTRA_RULES.length ? [...EXTRA_RULES, ...RULES] : RULES);

const RULES = [
  // --- identity -----------------------------------------------------------
  // Above every name rule: "Name pronunciation" must never get the name itself.
  { key: 'identity.namePronunciation', attr: /pronunc|phonetic/i, label: /pronunc|phonetic|how (do|should) (we|you) (say|pronounce)/i },
  { key: 'identity.firstName', attr: /^(first[-_ ]?name|fname|given[-_ ]?name|firstname)$/i, label: /^(first|given)\s*name/i },
  { key: 'identity.lastName', attr: /^(last[-_ ]?name|lname|surname|family[-_ ]?name|lastname)$/i, label: /^(last|family|sur)\s*name/i },
  // "Please sign by typing your Full Legal First, Middle Initial, and Last
  // Name" is a signature: the whole name, not the middle one (Block got "James").
  { key: 'identity.fullName', label: /\b(sign|signature)\b.*\b(typ(e|ing)|enter)\b.*\bname\b|\b(typ(e|ing)|enter)\b.*\bname\b.*\b(sign|signature)\b/i, not: /\bdate\b\W*$/i },
  { key: 'identity.middleName', attr: /middle[-_ ]?(name|initial)/i, label: /middle\s*(name|initial)/i },
  { key: 'identity.suffix', attr: /(name[-_ ]?)?suffix/i, label: /^(name\s*)?suffix$/i },
  { key: 'identity.preferredName', attr: /(preferred|nick)[-_ ]?name/i, label: /(preferred|nick)\s*((first\s*(&|and|\/)\s*last|full)\s*)?name|what.*like to be called/i },
  { key: 'identity.pronouns', attr: /pronoun/i, label: /pronoun/i },
  { key: 'identity.fullName', attr: /^(full[-_ ]?name|name|your[-_ ]?name|applicant[-_ ]?name|legal[-_ ]?name)$/i, label: /^(full|legal|your|applicant)?\s*name$/i },

  // --- contact ------------------------------------------------------------
  // Consent to texts before anything mentioning "communication" or "agree".
  // Ramp asks for SMS and WhatsApp consent separately (smsConsent, whatsAppConsent).
  { key: 'contact.textConsent', attr: /(text|sms|whats[-_ ]?app)[-_ ]?(consent|opt[-_ ]?in)|consent[-_ ]?approval/i, label: /text messages?|\bsms\b|whats ?app|communication policy/i },
  { key: 'contact.preferredMethod', attr: /(preferred|best)[-_ ]?(contact|communication)|contact[-_ ]?(method|preference)/i, label: /preferred (method of |way of )?(communication|contact)|(contact|communication) (method|preference)|how (would|should|do) (you like|we) (to )?(be )?contact/i },
  { key: 'contact.phoneType', attr: /(phone|number|contact[-_ ]?number)[-_ ]?type/i, label: /^(phone|number) type$|type of (phone|number)/i },
  { key: 'contact.email', attr: /e[-_ ]?mail/i, label: /e[-\s]?mail/i },
  { key: 'contact.phoneCountryCode', attr: /(country[-_ ]?code|phone[-_ ]?prefix|dial[-_ ]?code)/i, label: /country\s*code|dial\s*code/i },
  { key: 'contact.phone', attr: /(phone|mobile|cell|telephone|tel)\b/i, label: /phone|mobile|\bcell\b|telephone/i },

  // --- address ------------------------------------------------------------
  { short: true, key: 'address.line2', attr: /((address|addr|street|line)[-_ ]?(line)?[-_ ]?(2|two)\b|\b(apt|suite|unit)\b)/i, label: /(address|street)\s*(line\s*)?(2|two)\b|line\s*2|\b(apartment|apt|suite|unit)\b|address\s*\(?cont/i },
  { short: true, key: 'address.line1', attr: /(address[-_ ]?(line)?1|street|address$)/i, label: /street|address\s*(line\s*)?1?$/i },
  // Asked as a place to be, not a field of an address.
  { key: 'address.location', attr: /^(current[-_ ]?)?location$|^based[-_ ]?in$/i,
    label: /^(current |your )?location\b|where (are|do) you (currently )?(live|located|based|reside)|where (will|do|would|are) you (plan(ning)? (on|to) )?(be )?(work|working) from|where are you (currently )?located|(from )?where (do|will|would) you (intend|plan|expect|want) to (work|be based)\b|based in\?/i },
  // "Which location are you applying for?" over a list of offices: the one nearest home is picked from the options.
  { key: 'address.location', label: /which (of (our|these|the) )?(office |work )?(office|location|hub|site)(s|\(s\))? (are you|would you|do you)|(office|location) (are you|you are|you're) applying|preferred (office|work location|location)\b/i },
  { short: true, key: 'address.city', attr: /\b(city|town|locality)\b/i, label: /\bcity\b|\btown\b|^(office |work |job )location$/i },
  { short: true, key: 'address.state', attr: /\b(state|province|region|county)\b/i, label: /\bstate\b|province|region/i },
  { short: true, key: 'address.postalCode', attr: /(zip|postal|postcode)/i, label: /zip|postal\s*code|postcode/i },
  { short: true, key: 'address.country', attr: /\bcountry\b/i, label: /\bcountry\b/i },

  // --- links --------------------------------------------------------------
  { key: 'links.linkedin', attr: /linked[-_ ]?in/i, label: /linked\s*in/i },
  { key: 'links.github', attr: /git[-_ ]?hub/i, label: /git\s*hub/i },
  { key: 'links.portfolio', attr: /portfolio|dribbble|behance/i, label: /portfolio|dribbble|behance/i },
  { key: 'links.website', attr: /(personal[-_ ]?(site|website)|website|homepage|blog)/i, label: /website|personal\s*site|homepage|blog/i },

  // --- references -----------------------------------------------------------
  // Only ever used inside a references block; scope.js refuses them elsewhere.
  { key: 'references.yearsKnown', attr: /years?[-_ ]?known|known[-_ ]?(for|years)/i, label: /years? known|how long have you known|years? acquainted|known (them|this person) for/i },
  { key: 'references.relationship', attr: /relationship/i, label: /^(?!.*\b(relatives?|related to|employed|works? (at|for))\b).*(relationship|how do you know)/i },

  // --- employment and education lists -------------------------------------
  // Above the work rules: "This is my current employer" is a tick box about a
  // job, not a box wanting the employer's name.
  { key: 'employment.current', toggle: true, attr: /is[-_ ]?current|current[-_ ]?(employer|job|position)|still[-_ ]?employed/i, label: /current(ly)? (employer|job|position|role)|still (employed|work)|i currently work/i },
  { key: 'employment.reasonForLeaving', attr: /reason[-_ ]?(for[-_ ]?)?leav/i, label: /reason.{0,12}leav/i },
  { key: 'employment.supervisor', attr: /supervisor[-_ ]?(full[-_ ]?)?name|^supervisor$|manager[-_ ]?name|reports?[-_ ]?to/i, label: /supervisor'?s?\s*(full\s*)?name|^supervisor$|manager'?s?\s*name|reported to|name of (your )?(supervisor|manager)/i },
  { key: 'employment.positionType', attr: /position[-_ ]?(type|id)$|employment[-_ ]?type|job[-_ ]?type/i, label: /^(position|employment|job) type|type of (position|employment)/i },
  { key: 'employment.mayContact', attr: /may[-_ ]?we[-_ ]?contact|contact[-_ ]?(this[-_ ]?)?employer|ok[-_ ]?to[-_ ]?contact/i, label: /(may|can) we contact|ok(ay)? to contact|contact (this|your) (employer|supervisor)/i },
  // "Describe an equipment problem you diagnosed. What did you do?" (Solcoa)
  // asks for a story, not a job's duties.
  { key: 'employment.description', attr: /duties|responsibilit|job[-_ ]?description/i, label: /duties|responsibilit|what (did|do) you do|^(job |role |position )?description$/i,
    not: /\bdescribe (a|an|one)\b|\b(a time|an example|problem|challenge|situation|diagnosed)\b/i },
  // Bare "From" / "To" boxes in a job block; the block decides start or end.
  { key: 'employment.startDate', label: /^(from|to|start(ed)?|end(ed)?|until)$/i },
  { key: 'education.type', attr: /(institution|school)[-_ ]?type/i, label: /(institution|school) type|type of (school|institution)/i },
  { key: 'education.startYear', attr: /years?[-_ ]?attended|attended[-_ ]?(from|to)/i, label: /attended/i },

  // --- work ---------------------------------------------------------------
  { key: 'work.currentCompany', attr: /(current[-_ ]?(company|employer)|company|employer|organization)/i, label: /current\s*(company|employer)|^(company|employer|organization)( name)?$/i },
  { key: 'work.currentTitle', attr: /(current[-_ ]?(title|role|position)|job[-_ ]?title|title)/i, label: /current\s*(title|role|position)|job\s*title|^title$/i },
  // "How many years of experience do you have testing APIs?" asks about one
  // skill, not the whole career (Wonderschool got 5, 5 and 5).
  { key: 'work.yearsExperience', attr: /(years?[-_ ]?(of[-_ ]?)?experience|yoe|exp[-_ ]?years)/i, label: /years?\s*(of\s*)?((relevant|related|professional|full[- ]time|paid)\s*)*(work\s*)?experience/i,
    not: /experience (do you have |have you had )?(with|in|using|building|testing|maintaining|developing|writing|working (with|on|in)|managing|leading|doing|as an?)\b/i },
  // "Overall Result (GPA)" (Workday), "GPA", "Grade point average": a school's own.
  { key: 'education.gpa', attr: /^(gpa|grade[-_ ]?average|gradeAverage)$/i, label: /^(overall result\s*)?\(?\s*gpa\s*\)?|\bgrade point average\b|^gpa\b/i },
  // "Type to Add Skills" (Workday), "Skills", "Key skills": the list, not a question about them.
  { key: 'work.skills', attr: /^skills?$|^skills?[-_ ]?(prompt|list|input)$/i, label: /^(type to add |add |key |technical |relevant |your )?skills?\s*\*?$/i },
  { key: 'work.languages', attr: /languages?[-_ ]?(spoken|speak)|^languages$/i, label: /languages? (do )?you (speak|know)|languages? spoken|which languages|fluent in|^languages?$/i },
  { key: 'work.noticePeriod', attr: /notice[-_ ]?period/i, label: /notice\s*period/i },
  // Only a label that asks for a school: "If you're less than 3 years out of
  // school, what is your GPA?" mentions one without asking for it.
  { key: 'work.school', attr: /^(school|university|college|institution|alma[-_ ]?mater)([-_ ]?name)?$/i,
    label: /^(school|university|college|institution|alma mater)( name)?\b|(which|what|name of (your|the)) (school|university|college|institution)|(school|university|college) (attended|you attended)/i },
  { key: 'work.fieldOfStudy', attr: /(field[-_ ]?of[-_ ]?study|\bmajor\b|discipline|concentration)/i, label: /field\s*of\s*study|\bmajor\b|discipline/i,
    not: /\bgraduate (major|school|degree|program|studies|field)|\b(master'?s|phd|doctoral|doctorate) (major|field|program)/i },
  // Above the degree rule: "Do you have a high school diploma or GED?" is a yes or no.
  { key: 'work.highSchoolGraduate', attr: /high[-_ ]?school[-_ ]?(grad|diploma)|graduate[-_ ]?high[-_ ]?school/i,
    label: /graduat\w*\s+(from\s+)?high\s*school|high\s*school\s+(diploma|graduate|equivalen)|\bged\b|completed high\s*school/i },
  { key: 'work.highestDegree', attr: /(degree|education[-_ ]?level|qualification)/i, label: /degree|highest\s*(level\s*of\s*)?education|qualification/i },
  { key: 'work.graduationYear', attr: /(grad(uation)?[-_ ]?(year|date)|end[-_ ]?year)/i, label: /graduation\s*(year|date)/i },

  // --- authorization ------------------------------------------------------
  { key: 'authorization.requiresSponsorship', attr: /(sponsor(ship)?|visa[-_ ]?sponsor)/i, label: /sponsorship|will you (now or in the future )?require|require.*sponsor|\brequire (a )?(work|employment) authori[sz]ation\b/i },
  { key: 'authorization.authorizedToWork', attr: /(work[-_ ]?auth|authoriz|legally[-_ ]?(work|entitled)|right[-_ ]?to[-_ ]?work|eligible[-_ ]?to[-_ ]?work)/i, label: /legally\s*(authori[sz]ed|entitled|able)\s*to\s*work|right\s*to\s*work|eligible\s*to\s*work|authori[sz]ed\s*to\s*work/i },
  { key: 'authorization.citizenship', attr: /citizenship/i, label: /citizenship|are you a (u\.?s\.?|united states) citizen/i },
  { key: 'authorization.visaStatus', attr: /(visa|immigration|work[-_ ]?permit)/i, label: /visa\s*(status|type)|immigration\s*status|work\s*permit/i },
  { key: 'authorization.over18', attr: /(over[-_ ]?18|age[-_ ]?18|at[-_ ]?least[-_ ]?18|minimum[-_ ]?age)/i, label: /(at least|over|older than)\s*18|18 years( of age)? or older/i },

  // --- compensation -------------------------------------------------------
  { key: 'compensation.desired', attr: /(desired|expected|target)[-_ ]?(salary|compensation|pay|rate)/i, label: /(desired|expected|target|requested)\s*(salary|compensation|pay|rate)|(salary|compensation|pay)\s*expectation/i },
  { key: 'compensation.current', attr: /current[-_ ]?(salary|compensation|pay)/i, label: /current\s*(salary|compensation|pay)/i },

  // --- preferences --------------------------------------------------------
  // "This role is in our SF office five days a week. Are you willing to meet this requirement?"
  { key: 'preferences.acceptOnsite', label: /^(?=.*\b(willing|able|comfortable|open|okay|ok|meet|excited|happy|ready|interested|fine|agree|commit|aligned)\b)(?=.*(in[- ]person|on[- ]?site|in[- ]office|in the office|work from (the )?office|(days|times) (a|per|each) week|from (our|the) [^?]{0,50}(office|hq|headquarters)))/i },
  { key: 'preferences.willingToRelocate', attr: /reloc/i, label: /relocat/i },
  { key: 'preferences.remotePreference', attr: /(remote|work[-_ ]?(from|location)[-_ ]?pref|hybrid|onsite)/i, label: /remote|hybrid|on[-\s]?site|work\s*(arrangement|preference|location)/i },
  { key: 'preferences.hoursPerWeek', attr: /hours[-_ ]?per[-_ ]?week|weekly[-_ ]?hours/i, label: /hours (per|a|each) week|weekly hours|how many hours/i },
  { key: 'preferences.todaysDate', attr: /(date[-_ ]?signed|signed[-_ ]?(on|date)|signature[-_ ]?date|todays?[-_ ]?date)/i, label: /^(today'?s date|date signed|signature date|date of signature|date)$/i },
  // A start date split into month and year boxes is a job's (Greenhouse's employment rows, Coinbase), not availability.
  { key: 'preferences.availableStartDate', attr: /(start[-_ ]?date|available[-_ ]?(from|date)|availability|earliest)/i, label: /start[\s-]*date|available\s*(to\s*start|from)|earliest.*start|availability/i,
    not: /start[\s_-]*date[\s_-]*(month|year)\b/i },
  // "SUBSOURCE_DESC" and "Specific Referral Source" are the detail box beside
  // the question, not the question; "resource" is not a source at all.
  { key: 'preferences.howHeard', attr: /(how[-_ ]?(did[-_ ]?you[-_ ]?)?hear|(?<!re)(?<!sub)(?<!sub[-_ ])source|found[-_ ]?us)/i,
    label: /how (did |do )?you (first )?(hear|heard|find|found|learn|learned|discover|discovered|come across|came across|connect|connected)\b|where did you (first )?(hear|find|see|learn)|referral source|^source$/i,
    not: /sub[-_ ]?source|specific (referral )?source|source[-_ ]?(details?|desc)/i },
  { key: 'preferences.referredBy', attr: /((?<!p)referr?(ed|al)[-_ ]?(by|name)?|employee[-_ ]?referral)/i, label: /referred\s*by|referral\s*name|who referred/i },
  { key: 'preferences.previouslyEmployed', attr: /(previously[-_ ]?(employed|worked)|former[-_ ]?employee|worked[-_ ]?here|rehire)/i, label: /previously\s*(been\s*)?(employed|worked)|(are|were) you an? (current or )?former\s*employee|ever (been )?(worked|employed) (for|at|by)/i },
  { key: 'preferences.nonCompete', attr: /non[-_ ]?compete/i, label: /non[-\s]?compete/i },
  // A generic date inside a job or school block; the block decides which one.
  // An end date has its own key outside a recognised job block, where nothing else tells start from end.
  { key: 'employment.endDate', attr: /(end|until)[-_ ]?(date|month|year)/i, label: /\b(end|until)\b.*\b(date|month|year)|\b(date|month|year)\b.*\bend\b/i },
  { key: 'employment.startDate', attr: /(start|from|began|end|to|until)[-_ ]?(date|month|year)|dates?[-_ ]?employed/i, label: /\b(start|from|began|end|until)\b.*\b(date|month|year)|\b(date|month|year)\b.*\b(start|from|end)\b|dates? employed/i },
  // Declarations of truth are deliberately excluded: those are the user's to sign.
  // Consent asked as a choice ("Interview Recording Consent": consent / opt out) follows the same setting.
  // "Please confirm receipt of the ... Privacy Notice and US Arbitration Agreement" with one option, "Confirmed" (Coinbase).
  { key: 'preferences.agreeToTerms', label: /confirm (receipt|that you have (read|received))|privacy notice|arbitration agreement/i, options: /\b(confirm|acknowledge|agree|yes)/i },
  // "Can Metaview transcribe all your interviews?": consent to recording, asked as Yes/No (Sierra).
  { key: 'preferences.agreeToTerms', label: /interview[^?]*\b(record|transcrib|note[- ]?tak)|\b(record|transcrib|note[- ]?tak)\w*[^?]*interview/i, options: /^yes\b/i },
  { key: 'preferences.agreeToTerms', label: /\bconsent\b/i, options: /\bi (consent|agree)\b/i },
  { key: 'preferences.agreeToTerms', toggle: true, attr: /(agree|accept|consent|acknowledg)/i, label: /\bi (have read and )?(agree|accept|acknowledge|understand|consent)\b|terms (of (service|use)|and conditions)|privacy policy|will be required to submit proof|\b(ai|interview|candidate|applicant|recruiting|hiring)\b[\w\s]{0,20}\bpolicy\b(?!\s*\?)/i, not: /certif|true and (complete|correct|accurate)|signature|attest|under penalty|contact me (about|regarding|for)|future (opportunit|roles|positions|jobs|openings)|newsletter|marketing|talent (pool|community|network)|keep me (informed|updated)|job alerts/i },

  // --- screening ----------------------------------------------------------
  { key: 'screening.everDischarged', attr: /discharg|in[-_ ]?lieu/i, label: /discharged|dismissed from|terminated from|fired from|in lieu of (discharge|termination)/i },
  { key: 'screening.relatedToEmployee', attr: /related[-_ ]?to|relatives?/i, label: /related to (an|any|a current)? ?(employee|member|official|staff)|relatives? (who )?(work|employed)|\brelatives?\b.{0,160}\b(currently )?(employed|works?|working) (at|for|by|with)\b/i },
  { key: 'screening.essentialFunctions', attr: /essential[-_ ]?function/i, label: /essential (functions|duties)/i },
  { key: 'screening.licenses', attr: /licen[cs]es?[-_ ]?(and|or)?[-_ ]?certific|professional[-_ ]?licen/i, label: /professional licen|licen[cs]es?\s*(\/|or|and)\s*certific|(licen[cs]es?|certificates?|certifications?) (required|held|you (hold|have))/i },
  // "Can you meet a background check?", never "Have you been convicted?".
  { key: 'screening.backgroundCheck', attr: /background[-_ ]?check/i, label: /^(?!.*\b(convicted|conviction|felony|arrested|pled|plead)\b).*\b(background|reference) (checks?|screening|investigation)\b/i },
  { key: 'screening.securityClearance', attr: /clearance/i, label: /security clearance|clearance (level|status)|active clearance/i },
  { key: 'screening.equipment', attr: /equipment|machines?/i, label: /machines?|equipment you can operate|operate.*equipment/i },
  { key: 'screening.gapExplanation', attr: /gap/i, label: /gaps? in (your )?employment|employment gaps?|explain (any )?gaps?|periods? of unemployment/i },

  // --- voluntary demographics --------------------------------------------
  { key: 'demographics.hispanicLatino', attr: /(hispanic|latino|latinx)/i, label: /hispanic|latino|latinx/i },
  { key: 'demographics.raceEthnicity', attr: /(race|ethnic)/i, label: /race|ethnic/i },
  // Before gender: "Are you a person of transgender experience?" is its own question.
  { key: 'demographics.transgender', attr: /transgender/i, label: /transgender|trans experience/i },
  { key: 'demographics.sexualOrientation', attr: /(sexual[-_ ]?orientation|orientation)/i, label: /sexual orientation|\blgbt/i },
  { key: 'demographics.gender', attr: /(gender|\bsex\b)/i, label: /gender|^sex$/i },
  { key: 'demographics.veteranStatus', attr: /(veteran|military|protected[-_ ]?veteran)/i, label: /veteran|military service/i },
  { key: 'demographics.neurodiverse', attr: /neurodiver/i, label: /neurodiver/i },
  // "We are happy to provide accommodations for individuals with
  // disabilities. Do you require any support?" asks about the interview (Astera).
  { key: 'demographics.disabilityStatus', attr: /(disabilit(?!y?[-_ ]?form)|disabled)/i, label: /disabilit|disabled/i, not: /accommodat/i },

  // --- documents ----------------------------------------------------------
  { key: 'documents.coverLetterTemplate', attr: /cover[-_ ]?letter/i, label: /cover\s*letter/i },
  { key: 'documents.summary', attr: /(summary|about[-_ ]?you|bio|profile[-_ ]?summary|introduce)/i, label: /tell us about yourself|professional summary|short bio|introduce yourself/i }
];

/** Map an HTML autocomplete token straight to a profile key. */
const AUTOCOMPLETE_MAP = (() => {
  const map = {};
  for (const field of PROFILE_FIELDS) {
    for (const token of field.autocomplete || []) map[token] = field.key;
  }
  return map;
})();

/**
 * Try to resolve one extracted field to a profile key.
 *
 * @param {object} field  A descriptor produced by the content extractor.
 * @returns {{key: string, confidence: number, via: string}|null}
 */
export function matchField(field) {
  // Workday ids carry their section before "--"
  // ("selfIdentifiedDisabilityData--employeeId"); only the field's own part
  // names the field.
  const parts = String(field.idAttr || field.name || '').split('--');
  // ...except a preferred-name section's first name is the preferred name
  // (name--preferredName--firstName), and its last name is the last name.
  if (parts.length > 1 && parts.slice(0, -1).some(p => /preferred|nick/i.test(p))) {
    const own = parts[parts.length - 1];
    if (/first/i.test(own)) return { key: 'identity.preferredName', confidence: 0.9, via: 'attribute' };
    if (/last|family|sur/i.test(own)) return { key: 'identity.lastName', confidence: 0.9, via: 'attribute' };
  }
  const idAttr = String(field.idAttr || '').split('--').pop();
  field = { ...field, idAttr };
  const attrText = [field.name, field.idAttr, field.placeholder, field.dataAttr]
    .filter(Boolean)
    .join(' ');
  // "Title*" is "Title": the required marker is not part of the question.
  const labelText = cleanLabel(field.label || field.ariaLabel || '');
  // The extractor's own label, where TypeSafe read a longer question from the
  // page: a rule may know the short label ("Preferred Pronouns") better.
  if (field.extractedLabel && field.extractedLabel !== field.label) {
    const own = matchField({ ...field, label: field.extractedLabel, extractedLabel: undefined });
    const mine = matchField({ ...field, extractedLabel: undefined });
    if (own && (!mine || own.confidence > mine.confidence)) return own;
    return mine;
  }

  // A field whose label or name looks like a credential or government ID is
  // never matched, even if a rule would otherwise fire.
  if (isForbiddenName(attrText) || isForbiddenName(labelText)) return null;

  // 1. The autocomplete attribute is an explicit statement by the page author.
  const ac = normalize(field.autocomplete).split(/\s+/).pop();
  if (ac && AUTOCOMPLETE_MAP[ac]) {
    return { key: AUTOCOMPLETE_MAP[ac], confidence: 0.97, via: 'autocomplete' };
  }

  // 2. Exact-ish attribute name match.
  const bareAttr = normalize(attrText).replace(/[^a-z0-9]+/g, ' ').trim();
  const isToggle = field.type === 'checkbox' || field.type === 'radio' || !!field.options?.length;
  // A question sentence ("Are you related to an employee of the City?") is not
  // an address box, whatever words it shares with one.
  const sentence = /\?\s*\*?\s*$/.test(labelText) || labelText.split(/\s+/).length > 6;
  const fits = rule => {
    if (rule.toggle && !isToggle) return false;
    if (rule.options && !(field.options || []).some(o => rule.options.test(o.label || ''))) return false;
    if (rule.short && sentence && !rule.attr?.test(field.name || '')) return false;
    if (rule.not && (rule.not.test(labelText) || rule.not.test(attrText))) return false;
    return true;
  };
  for (const rule of allRules()) {
    if (!fits(rule)) continue;
    if (rule.attr && (rule.attr.test(field.name || '') || rule.attr.test(field.idAttr || '') || rule.attr.test(bareAttr))) {
      return { key: rule.key, confidence: 0.9, via: 'attribute' };
    }
  }

  // 3. Visible label match, without a leading "Other than ..." aside.
  // Without a trailing colon: PG&E's attestation boxes are "Name:" and "Date:".
  const label = normalize(withoutAside(labelText)).replace(/\s*[:：]\s*$/, '');
  if (label) {
    for (const rule of allRules()) {
      if (!fits(rule)) continue;
      if (rule.label && rule.label.test(label)) {
        return { key: rule.key, confidence: 0.86, via: 'label' };
      }
    }
  }

  // 4. Last resort: fuzzy similarity against the canonical field labels. Only
  //    a strong overlap counts, and the score stays below HEURISTIC_ACCEPT so
  //    the result is treated as a hint for the model rather than an answer.
  if (label) {
    let best = null;
    for (const f of PROFILE_FIELDS) {
      const score = similarity(label, f.label);
      if (score > 0.6 && (!best || score > best.confidence)) {
        best = { key: f.key, confidence: 0.55 + score * 0.25, via: 'fuzzy' };
      }
    }
    if (best) return best;
  }

  return null;
}

/**
 * Split extracted fields into those answered locally and those still open.
 *
 * @returns {{resolved: Array, unresolved: Array}}
 */
export function partitionFields(fields) {
  const resolved = [];
  const unresolved = [];
  for (const field of fields) {
    const match = matchField(field);
    if (match && match.confidence >= HEURISTIC_ACCEPT) {
      resolved.push({ ...field, profileKey: match.key, confidence: match.confidence, via: match.via });
    } else {
      unresolved.push({ ...field, hint: match ? match.key : null });
    }
  }
  return { resolved, unresolved };
}
