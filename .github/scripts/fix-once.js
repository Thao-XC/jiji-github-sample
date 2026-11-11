// ONE-TIME: 5 corrections to the Mecom Gantt in Backlog JIJI. Delete afterwards.
// confirm empty = dry run, "APPLY" = do it. Each row is only changed if its title is still the expected one.
const HOST = process.env.BACKLOG_HOST, API_KEY = process.env.BACKLOG_API_KEY;
async function backlog(method, apiPath, params = []) {
  const url = new URL(`https://${HOST}/api/v2${apiPath}`);
  url.searchParams.set('apiKey', API_KEY);
  const opts = { method, headers: {} };
  if (method !== 'GET') { opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(params).toString(); }
  const res = await fetch(url, opts); const text = await res.text();
  if (!res.ok) throw new Error(`Backlog ${method} ${apiPath} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const CHANGES = [
  ['JIJI-2', '構想のご説明 / Concept meeting', { summary: '①デモ / Demo 1', startDate: '2026-08-17', dueDate: '2026-08-17' }],
  ['JIJI-17', '②デモ', { summary: '②デモ準備・要件確認 / Demo 2 prep & requirements' }],
  ['JIJI-6', 'デモ実施 / Demo at MECOM HQ', { summary: '要件・進捗の打ち合わせ / Requirements & progress meeting', startDate: '2026-09-15', dueDate: '2026-09-15' }],
  ['JIJI-21', 'Phase 1 開発 / Phase 1 development', { summary: 'Phase 1：②デモに向けた開発 / toward Demo 2', startDate: '2026-08-18', dueDate: '2026-10-14' }],
  ['JIJI-38', 'Final presentation / Phase 1 最終報告・記者発表（午前）', { summary: '②デモ（メコム本社）・記者発表 / Demo 2 at Mecom HQ & press event', startDate: '2026-10-14', dueDate: '2026-10-14' }],
];
module.exports = async function fix({ context, core }) {
  const apply = ((context.payload.inputs && context.payload.inputs.confirm) || '').trim() === 'APPLY';
  core.info(apply ? '*** APPLYING ***' : '*** DRY RUN: nothing will change ***');
  let done = 0;
  for (const [key, expected, fields] of CHANGES) {
    const i = await backlog('GET', `/issues/${key}`);
    if (i.summary !== expected && i.summary !== fields.summary) { core.warning(`${key} skipped: title is "${i.summary}", expected "${expected}"`); continue; }
    core.info(`${apply ? '' : 'would '}${key}  "${i.summary}" ${(i.startDate || '').slice(0, 10)}→${(i.dueDate || '').slice(0, 10)}  ->  "${fields.summary}" ${fields.startDate || (i.startDate || '').slice(0, 10)}→${fields.dueDate || (i.dueDate || '').slice(0, 10)}`);
    if (!apply) continue;
    await backlog('PATCH', `/issues/${key}`, Object.entries(fields));
    const after = await backlog('GET', `/issues/${key}`);
    const ok = after.summary === fields.summary && (!fields.dueDate || (after.dueDate || '').startsWith(fields.dueDate)) && (!fields.startDate || (after.startDate || '').startsWith(fields.startDate));
    core.info(`  check: ${ok ? 'OK' : 'NOT AS EXPECTED'}  "${after.summary}" ${(after.startDate || '').slice(0, 10)}→${(after.dueDate || '').slice(0, 10)}`);
    if (ok) done++;
  }
  core.summary.addHeading(apply ? 'Corrections done' : 'Dry run: nothing changed').addRaw(`${apply ? done : CHANGES.length} of ${CHANGES.length} rows ${apply ? 'corrected' : 'would be corrected'}.`).write();
};
