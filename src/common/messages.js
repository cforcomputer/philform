/** Message type constants shared by popup, options, background and content scripts. */
export const MSG = {
  // popup -> background
  RUN_FILL: 'run-fill',
  CANCEL_RUN: 'cancel-run',
  GET_STATUS: 'get-status',
  GET_PAGE_SUMMARY: 'get-page-summary',
  LEARN_PREVIEW: 'learn-preview',
  LEARN_APPLY: 'learn-apply',
  REPORT_ISSUE: 'report-issue',
  GET_LAST_RUN: 'get-last-run',
  GET_PAGE_SUPPORT: 'get-page-support',
  UNLOCK: 'unlock',
  EMAIL_START: 'email-start',
  EMAIL_VERIFY: 'email-verify',

  // background -> popup (via runtime broadcast)
  RUN_PROGRESS: 'run-progress',
  RUN_DONE: 'run-done',
  RUN_ERROR: 'run-error',

  // options -> background
  GET_SETTINGS: 'get-settings',
  SAVE_SETTINGS: 'save-settings',
  GET_PROFILE: 'get-profile',
  SAVE_PROFILE: 'save-profile',
  LIST_RESPONSES: 'list-responses',
  SAVE_RESPONSES: 'save-responses',
  SEED_RESPONSES: 'seed-responses',
  GET_DOCUMENTS: 'get-documents',
  SAVE_DOCUMENT: 'save-document',
  SAVE_RESUMES: 'save-resumes',
  LIST_SKILLS: 'list-skills',
  SHARE_SKILL: 'share-skill',
  ADOPT_SKILL: 'adopt-skill',
  FORGET_ALL_SKILLS: 'forget-all-skills',
  SAVE_SKILL: 'save-skill',
  DELETE_SKILL: 'delete-skill',
  LIST_RUNS: 'list-runs',
  CLEAR_RUNS: 'clear-runs',
  TEST_PROVIDER: 'test-provider',
  GET_USAGE: 'get-usage',
  GET_WALLET: 'get-wallet',
  RELOAD_WALLET: 'reload-wallet',
  EXPORT_PARTS: 'export-parts',
  EXPORT_DATA: 'export-data',
  IMPORT_DATA: 'import-data',
  LIST_ISSUES: 'list-issues',
  CLEAR_ISSUES: 'clear-issues'
};

/** Stages reported to the popup while a run is in flight. */
export const STAGE = {
  INJECTING: 'injecting',
  EXTRACTING: 'extracting',
  ANALYZING: 'analyzing',
  MATCHING_SKILL: 'matching-skill',
  CLASSIFYING: 'classifying',
  MATCHING_RESPONSES: 'matching-responses',
  WRITING: 'writing',
  FILLING: 'filling',
  DONE: 'done'
};

export const STAGE_LABEL = {
  [STAGE.INJECTING]: 'Reading the page',
  [STAGE.EXTRACTING]: 'Finding form fields',
  [STAGE.ANALYZING]: 'Analyzing the form',
  [STAGE.MATCHING_SKILL]: 'Applying saved site skill',
  [STAGE.CLASSIFYING]: 'Matching fields to your profile',
  [STAGE.MATCHING_RESPONSES]: 'Looking for a saved answer',
  [STAGE.WRITING]: 'Drafting written answers',
  [STAGE.FILLING]: 'Filling the form',
  [STAGE.DONE]: 'Done'
};
