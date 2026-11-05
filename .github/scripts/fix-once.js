// ============================================================
// ONE-TIME clean-up of the Mecom schedule in Backlog JIJI. Delete afterwards.
//  1. No "Idemitsu" / 出光 anywhere: 2 titles renamed, the word removed from descriptions
//  2. Every issue whose due date has passed -> Closed
//  3. Phase 2 キックオフ -> stays Open, dates cleared (no deadline yet)
// confirm empty = dry run, "APPLY" = do it
// ============================================================
const HOST = process.env.BACKLOG_HOST, API_KEY = process.env.BACKLOG_API_KEY;
async function backlog(method, apiPath, params = []) {
  const url = new URL(`https://${HOST}/api/v2${apiPath}`);
  url.searchParams.set('apiKey', API_KEY);
  const opts = { method, headers: {} };
  if (method === 'GET') params.forEach(([k, v]) => url.searchParams.append(k, v));
  else { opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(params).toString(); }
  const res = await fetch(url, opts); const text = await res.text();
  if (!res.ok) throw new Error(`Backlog ${method} ${apiPath} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const RENAME = {
  'Fold Idemitsu lane into 1.1': 'Merge numeric lane data into 1.1',
  '出光へヒアリング': 'お客様へのヒアリング / Customer hearing',
};
const WORD = /出光|idemitsu/i;
const clean = (t) => (t || '').replace(/出光/g, 'お客様').replace(/idemitsu/gi, 'customer');
const KICKOFF = /^Phase 2 キックオフ/;
const day = (d) => (d ? d.slice(0, 10) : '');

module.exports = async function fix({ context, core }) {
  const apply = ((context.payload.inputs && context.payload.inputs.confirm) || '').trim() === 'APPLY';
  core.info(apply ? '*** APPLYING ***' : '*** DRY RUN: nothing will change ***');
  const today = new Date().toISOString().slice(0, 10);
  const project = await backlog('GET', '/projects/JIJI');
  const all = [];
  for (let offset = 0; ; offset += 100) {
    const page = await backlog('GET', '/issues', [['projectId[]', project.id], ['count', 100], ['offset', offset]]);
    all.push(...page); if (page.length < 100) break;
  }
  let changed = 0;
  for (const i of all) {
    const params = []; const what = [];
    if (WORD.test(i.summary)) { const s = RENAME[i.summary] || clean(i.summary); params.push(['summary', s]); what.push(`rename to "${s}"`); }
    if (WORD.test(i.description || '')) { params.push(['description', clean(i.description)]); what.push('remove the word from the description'); }
    if (KICKOFF.test(i.summary)) {
      params.push(['startDate', ''], ['dueDate', ''], ['statusId', 1]); what.push('Open, dates cleared');
    } else if (day(i.dueDate) && day(i.dueDate) < today && i.status.id !== 4) {
      params.push(['statusId', 4]); what.push(`Closed (due ${day(i.dueDate)})`);
    }
    if (!params.length) continue;
    changed++;
    core.info(`${apply ? '' : 'would '}${i.issueKey}  ${i.summary}  ->  ${what.join(', ')}`);
    if (apply) await backlog('PATCH', `/issues/${i.issueKey}`, params);
  }
  if (apply) { // check nothing still carries the word
    const left = [];
    for (const i of all) {
      const now = await backlog('GET', `/issues/${i.issueKey}`);
      if (WORD.test(now.summary) || WORD.test(now.description || '')) left.push(now.issueKey);
    }
    core.info(left.length ? `STILL CONTAINS THE WORD: ${left.join(', ')}` : 'Check: no issue title or description contains Idemitsu / 出光');
  }
  core.summary.addHeading(apply ? 'Clean-up done' : 'Dry run: nothing changed')
    .addRaw(`${changed} of ${all.length} issues ${apply ? 'changed' : 'would change'}.`).write();
};
