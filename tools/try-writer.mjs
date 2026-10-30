#!/usr/bin/env node
// Draft written answers straight through the writer, without a browser.
//
//   node tools/try-writer.mjs QUESTIONS.json
//
// QUESTIONS.json: {"company": "...", "role": "...", "description": "...",
//                  "questions": [{"id": "q1", "label": "...", "required": true}, ...]}
//
// Uses the dev profile (.dev/personal-config.json), the résumé and writing
// samples in .dev/writer-tests/, and the API keys in src/common/local-config.js,
// exactly as a fill would. Prints each answer, what the fact check took out,
// and any machine-writing tells left (aiTells). Costs one writer round.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { writeAnswers, aiTells } = await import(path.join(ROOT, 'src/background/write.js'));
const { beginTrace, endTrace } = await import(path.join(ROOT, 'src/background/trace.js'));
const { DEFAULT_SETTINGS } = await import(path.join(ROOT, 'src/background/storage.js')).catch(() => ({}));

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/try-writer.mjs QUESTIONS.json');
  process.exit(2);
}
const job = JSON.parse(fs.readFileSync(file, 'utf8'));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, '.dev/personal-config.json'), 'utf8'));
const data = config.data || config;
const profile = { ...(data.profile || {}) };
const read = name => { try { return fs.readFileSync(path.join(ROOT, '.dev/writer-tests', name), 'utf8'); } catch { return ''; } };
if (read('cv.txt')) profile['documents.resumeText'] = read('cv.txt');
if (read('samples.txt')) profile['documents.writingSamples'] = read('samples.txt');
// The CV a fill picked ("resume": a path) and the projects the apply harness adds when the export has none.
if (job.resume) profile['documents.resumeText'] = fs.readFileSync(job.resume, 'utf8');
const projects = path.join(ROOT, '.dev/apply/projects.json');
if (!profile.projects && fs.existsSync(projects)) profile.projects = JSON.parse(fs.readFileSync(projects, 'utf8'));

const settings = { ...(DEFAULT_SETTINGS || {}), ...(data.settings || {}) };
const local = fs.readFileSync(path.join(ROOT, 'src/common/local-config.js'), 'utf8');
for (const key of ['typesafeApiKey', 'deepseekApiKey']) {
  const m = local.match(new RegExp(key + ":\\s*'([^']*)'"));
  if (m && m[1]) settings[key] = m[1];
}
settings.deepseekWriterModel = settings.deepseekWriterModel || 'deepseek-v4-pro';
settings.longAnswerMaxWords = settings.longAnswerMaxWords || 180;

const fields = job.questions.map((q, i) => ({ id: q.id || `q${i + 1}`, label: q.label, required: !!q.required, maxLength: q.maxLength || null }));
const started = Date.now();
beginTrace();
const res = await writeAnswers({
  fields, profile, settings,
  context: { company: job.company || '', role: job.role || '', jobDescription: job.description || '' }
});
const trace = endTrace();

for (const f of fields) {
  const a = (res.answers || []).find(x => x.id === f.id) || {};
  console.log(`## ${f.label}${f.required ? ' (required)' : ''}`);
  console.log(a.answer || '(empty)');
  if (a.thin) console.log(`  [thin${a.note ? `: ${a.note}` : ''}]`);
  for (const t of aiTells(a.answer)) console.log(`  TELL ${t.tell}: ${t.sentence}`);
  console.log();
}
for (const e of trace.events.filter(e => e.kind === 'writer-check' || e.kind === 'writer-repeats')) {
  const list = e.removed || e.repeats || [];
  if (list.length) console.log(`${e.kind}:`, list.map(s => `\n  - ${s}`).join(''));
}
const research = trace.events.find(e => e.kind === 'writer-research');
if (research?.points) console.log('company research:', research.points.map(p => `\n  - [${p.source}] ${p.point}`).join(''));
const { callCents } = await import(path.join(ROOT, 'src/background/cost.js'));
let cents = 0;
for (const u of res.usages || []) cents += callCents('deepseek', u.model, u.usage);
for (const u of res.editUsages || []) cents += callCents('deepseek', 'deepseek-flash', u);
if (res.researchUsage) cents += callCents('deepseek', 'deepseek-flash', res.researchUsage);
if (res.checkUsage) cents += callCents('typesafe', '', res.checkUsage);
console.log(`\n${((Date.now() - started) / 1000).toFixed(1)} s, ${cents.toFixed(3)}¢`);
// A request the fill abandoned (a hedge that lost, a stalled TypeSafe call) keeps Node running for minutes.
process.exit(0);
