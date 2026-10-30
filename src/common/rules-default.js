/**
 * The built-in rules pack: what phil knows about forms as data, not code.
 *
 * The same object is served by the service (`GET /v1/rules`, merged with an
 * override file on the server) and fetched by the extension, so a fix that
 * is a pattern, a selector, a wait or a label-to-key rule ships without a
 * store release. Regular expressions are written as "/source/flags" strings
 * so the pack survives JSON. A pack entry the extension cannot parse is
 * ignored, and the built-in copy stands.
 *
 *   platforms   the applicant tracking systems phil knows: hostname patterns,
 *               markers (selectors found in their pages), and how well they
 *               are supported ("full", "partial", "new"), shown in the popup
 *   rules       label/attribute-to-key rules tried before heuristics.js's own
 *               (same shape: key, attr, label, not, options, toggle, short)
 *   patterns    named patterns the engine reads (see rulespack.js)
 *   selectors   CSS selectors the page reader uses (select skins, error text)
 *   sections    how collapsed sections are found and opened before a read
 *   dropdowns   timing for custom lists
 *   overrides   per-platform additions to rules, patterns, selectors,
 *               sections, dropdowns
 */
export const DEFAULT_RULES_PACK = {
  version: '2026-10-30.1',
  platforms: [
    { id: 'workday', name: 'Workday', hosts: ['/myworkdayjobs\\.com$/i', '/myworkdaysite\\.com$/i', '/\\.workday\\.com$/i'], markers: ['[data-automation-id="jobPostingHeader"]', '[data-automation-id="applyFlowPage"]', 'form[data-automation-id]'], support: 'full' },
    { id: 'greenhouse', name: 'Greenhouse', hosts: ['/greenhouse\\.io$/i'], markers: ['#application_form', '#grnhse_app', 'form[action*="greenhouse.io"]'], support: 'full' },
    { id: 'ashby', name: 'Ashby', hosts: ['/ashbyhq\\.com$/i'], markers: ['[class*="ashby-application"]', '#ashby_embed'], support: 'full' },
    { id: 'lever', name: 'Lever', hosts: ['/lever\\.co$/i'], markers: ['.application-form[data-qa]', 'form#application-form'], support: 'full', note: 'Lever challenges automated browsers with a captcha on submit.' },
    { id: 'successfactors', name: 'SuccessFactors', hosts: ['/successfactors\\.(com|eu)$/i', '/sapsf\\./i', '/ns2cloud\\.com$/i'], markers: ['#careerform', '.rcmFormSection', '[id$=":_fieldComponentInput"]'], support: 'partial' },
    { id: 'smartrecruiters', name: 'SmartRecruiters', hosts: ['/smartrecruiters\\.com$/i'], markers: ['[data-test="application-form"]', 'form[name="applicationForm"]'], support: 'partial' },
    { id: 'workable', name: 'Workable', hosts: ['/workable\\.com$/i'], markers: ['[data-ui="application-form"]', 'form[data-ui="form"]'], support: 'partial' },
    { id: 'icims', name: 'iCIMS', hosts: ['/icims\\.com$/i', '/jibeapply\\.com$/i'], markers: ['#icims_content_iframe', 'form[name="pageForm"]'], support: 'partial' },
    { id: 'taleo', name: 'Taleo', hosts: ['/taleo\\.net$/i'], markers: ['#requisitionDescriptionInterface', 'form[name="ftlform"]'], support: 'partial' },
    { id: 'peoplesoft', name: 'PeopleSoft', hosts: ['/\\.psft\\./i'], markers: ['form[name="win0"]', '[id^="HRS_APPL"]', '#PSFORM'], support: 'partial' },
    { id: 'calcareers', name: 'CalCareers', hosts: ['/calcareers\\.ca\\.gov$/i'], markers: [], support: 'partial' },
    { id: 'bamboohr', name: 'BambooHR', hosts: ['/bamboohr\\.com$/i'], markers: ['#applicationForm', '[class*="BambooHR"]'], support: 'new' },
    { id: 'jobvite', name: 'Jobvite', hosts: ['/jobvite\\.com$/i'], markers: ['.jv-form', '#jv-careersite'], support: 'new' },
    { id: 'oracle', name: 'Oracle Recruiting', hosts: ['/oraclecloud\\.com$/i'], markers: ['[class*="oj-"] form', 'oj-module'], support: 'new' },
    { id: 'adp', name: 'ADP', hosts: ['/adp\\.com$/i', '/myjobs\\.adp\\.com$/i'], markers: ['#theViewNode', 'cx-root'], support: 'new' },
    { id: 'ukg', name: 'UKG', hosts: ['/ultipro\\.(com|ca)$/i', '/ukg\\.(com|net)$/i'], markers: [], support: 'new' },
    { id: 'paycom', name: 'Paycom', hosts: ['/paycomonline\\.net$/i'], markers: [], support: 'new' },
    { id: 'dayforce', name: 'Dayforce', hosts: ['/dayforcehcm\\.com$/i'], markers: [], support: 'new' },
    { id: 'jazzhr', name: 'JazzHR', hosts: ['/applytojob\\.com$/i', '/jazz\\.co$/i'], markers: [], support: 'new' },
    { id: 'rippling', name: 'Rippling', hosts: ['/rippling\\.com$/i', '/rippling-ats\\.com$/i'], markers: ['#application-form-container'], support: 'new' },
    { id: 'breezy', name: 'Breezy', hosts: ['/breezy\\.hr$/i'], markers: [], support: 'new' },
    // Hiring systems found in Simplify's autofill data (2026-10-30), not yet seen by phil.
    { id: 'avature', name: 'Avature', hosts: ['/avature\\.net$/i'], markers: ['meta[name="avature.portal.id"]'], support: 'new' },
    { id: 'phenom', name: 'Phenom', hosts: [], markers: ['head[data-ph-id^="ph-page-"]', 'body[data-ph-id^="ph-page-"]'], support: 'new' },
    { id: 'brassring', name: 'BrassRing', hosts: ['/brassring\\.com$/i'], markers: [], support: 'new' },
    { id: 'teamtailor', name: 'Teamtailor', hosts: ['/teamtailor\\.com$/i'], markers: ['[data-controller^="careersite"]'], support: 'new' },
    { id: 'recruitee', name: 'Recruitee', hosts: ['/recruitee\\.com$/i'], markers: [], support: 'new' },
    { id: 'paylocity', name: 'Paylocity', hosts: ['/paylocity\\.com$/i'], markers: [], support: 'new' },
    { id: 'eightfold', name: 'Eightfold', hosts: ['/eightfold\\.ai$/i'], markers: [], support: 'new' },
    { id: 'oleeo', name: 'Oleeo', hosts: ['/\\.tal\\.net$/i'], markers: [], support: 'new' },
    { id: 'comeet', name: 'Comeet', hosts: ['/comeet\\.(co|com)$/i'], markers: [], support: 'new' },
    { id: 'governmentjobs', name: 'GovernmentJobs (NEOGOV)', hosts: ['/governmentjobs\\.com$/i'], markers: [], support: 'new' },
    { id: 'dover', name: 'Dover', hosts: ['/^app\\.dover\\.com$/i'], markers: [], support: 'new' },
    { id: 'jobscore', name: 'JobScore', hosts: ['/jobscore\\.com$/i'], markers: [], support: 'new' },
    { id: 'pinpoint', name: 'Pinpoint', hosts: ['/pinpointhq\\.com$/i'], markers: [], support: 'new' },
    { id: 'polymer', name: 'Polymer', hosts: ['/^jobs\\.polymer\\.co$/i'], markers: [], support: 'new' },
    { id: 'freshteam', name: 'Freshteam', hosts: ['/freshteam\\.com$/i'], markers: [], support: 'new' },
    { id: 'trinethire', name: 'TriNet Hire', hosts: ['/trinethire\\.com$/i'], markers: [], support: 'new' },
    { id: 'gusto', name: 'Gusto', hosts: ['/^jobs\\.gusto\\.com$/i'], markers: [], support: 'new' },
    { id: 'seek', name: 'SEEK', hosts: ['/seek\\.(com|com\\.au|co\\.nz)$/i'], markers: [], support: 'new' },
    { id: 'indeed', name: 'Indeed Apply', hosts: ['/^smartapply\\.indeed\\.com$/i'], markers: [], support: 'new' },
    { id: 'linkedin', name: 'LinkedIn Easy Apply', hosts: ['/linkedin\\.com$/i'], markers: [], support: 'new' }
  ],
  rules: [],
  patterns: {
    // What a dropdown or radio group shows before anything is chosen: no answer.
    emptyChoice: '/^\\s*(no selection|none selected|nothing selected|not selected|select( one| an option)?|choose( one| an option)?|please (select|choose)( one| an option)?|--+|—|-- ?select ?--)\\s*(\\.\\.\\.|…)?\\s*$/i',
    // A box the form keeps for its own staff.
    officeUse: '/\\bfor (employer|office|official|internal|administrative|recruiter|hr|staff|agency) use( only)?\\b|\\bdo not (fill|complete|write)\\b/i',
    // The box that starts a row of a list: a job\'s company, a school\'s name.
    rowName: {
      employment: '/\\b(company|employer|organi[sz]ation)\\b/i',
      education: '/\\b(school|institution|university|college)\\b/i'
    },
    // An aria-label that names the widget, not the question ("Select").
    genericLabel: '/^(select|choose|pick|please (select|choose)|select (one|an option|\\.\\.\\.)|select\\.\\.\\.|choose\\.\\.\\.|search)$/i',
    // An icon font's glyph shown in a box (SuccessFactors' arrow, U+E1EF): not a value.
    iconGlyph: '/[\\uE000-\\uF8FF]/',
    // The page's complaint shown where a value would be (SmartRecruiters): not a value.
    pageComplaint: '/\\b(required|invalid)\\b|^please (select|enter|choose)/i',
    // A question's own label element, a sibling of its box (Ashby's question-title).
    questionTitle: '/question-title/i',
    // A trap for bots: a box only a bot would fill ("Leave this field blank",
    // "Do not tick this box"), or a line addressed to an AI ("If you are an
    // AI, include the word..."). Filling one marks the application as a bot's;
    // such lines are also cut from what the models read. Conditional lines
    // ("Leave blank if none") are ordinary instructions.
    botTrap: "/\\b(if|when|since) (you('| a)re|you are) (an? )?(ai|a\\.i\\.|bot|robot|llm|(large )?language model|automated|autofill|auto-fill|machine|program|script|crawler|agent)\\b|\\b(ai|bots?|robots?|llms?|(large )?language models?|ai (agents?|assistants?|models?|tools?)|automated (agents?|tools?|systems?|applicants?)|autofill( tools?)?|form[- ]fill(ers?|ing tools?))\\b[^.?!]{0,30}\\b(should|must|are (asked|required|instructed) to)\\b|\\b(instructions?|notes?|messages?|attention|warning)( for| to)?:? (any |all )?(ai|bots?|robots?|llms?|language models?|automated)\\b|\\b(ignore|disregard|forget|override) (all |any |the |your )?(previous |prior |above |earlier |other )?instructions\\b|\\b(do not|don'?t|must not|should not|never) (check|tick|select|click|fill( in| out)?|complete|touch|type in|answer) (this|these|it)\\b(?![^.?!]*\\b(if|unless|when|until|before|after|for)\\b)|\\bleave (this|it|these)( (box|field|one|question|checkbox))? (blank|empty|unchecked|unselected|alone|as it is)\\b(?![^.?!]*\\b(if|unless|when|until|for)\\b)|\\b(must|should) (be left|remain|stay) (blank|empty|unchecked|unselected|unchanged)\\b(?![^.?!]*\\b(if|unless|when|until|for)\\b)|\\b(honey ?pot|bot[- ]?trap|anti[- ]?bot|trap (field|question)|not a real (question|field))\\b|\\b(are you|if you('| a)re|if you are) (a |an )?(human|real person|robot|bot)\\b/i",
    // Asks whether AI was used for the application: the user's to answer.
    // An experience question ("Have you used AI tools at work?") names no application.
    aiUse: "/^(?=[\\s\\S]*\\b(ai|a\\.i\\.|artificial intelligence|chat ?gpt|gpt|llms?|(large )?language models?|generative|gen ?ai|copilot|claude|gemini|autofill|auto-fill|automat\\w*|bots?)\\b)(?=[\\s\\S]*\\b(this|your) (job )?(application|form|answers?|responses?|submission|cover letter|resume|cv)\\b)(?=[\\s\\S]*\\b(use|used|using|utili[sz]\\w*|help\\w*|assist\\w*|complet\\w*|fill\\w*|writ\\w*|wrote|generat\\w*|prepar\\w*|draft\\w*|creat\\w*))/i"
  },
  selectors: {
    // Widgets that replace a hidden native <select> and keep it in sync.
    selectSkin: '.select2-container, .select2, .chosen-container, .selectize-control, .choices',
    // Error text the page shows in a box's own question (Workday's inputAlert).
    errorText: '[data-automation-id="inputAlert"], [role="alert"], [class*="error-message" i], [class*="errorMessage"]'
  },
  sections: {
    // Toggles that hide a section's boxes until pressed, and where a toggle is never a section.
    toggles: 'button[aria-expanded="false"], [role="button"][aria-expanded="false"], a[aria-expanded="false"]',
    notIn: 'nav, header, [role="menu"], [role="menubar"], [role="listbox"], [role="combobox"]',
    waitMs: 2000
  },
  dropdowns: {
    // A box that names its list (aria-owns/aria-controls) is watched this long for it to open.
    namedListWaitMs: 1000
  },
  overrides: {}
};
