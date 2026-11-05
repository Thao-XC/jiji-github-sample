// ONE-TIME clean-up of the Mecom schedule in Backlog JIJI (delete afterwards).
//  - 出光へヒアリング and its children: not Mecom -> renamed "【対象外】…", dates cleared, Closed
//  - Phase 2 キックオフ / Phase 2のデータ取り込み: stay Open, dates cleared (no deadline yet)
//  - everything else whose due date has passed: Closed
// confirm empty = dry run, "APPLY" = do it
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
  const byId = Object.fromEntries(all.map((i) => [i.id, i]));
  const idemitsuParent = all.find((i) => i.summary === '出光へヒアリング');
  const notMecom = all.filter((i) => idemitsuParent && (i.id === idemitsuParent.id || i.parentIssueId === idemitsuParent.id));
  const phase2 = all.filter((i) => /^Phase 2 キックオフ|^Phase 2のデータ取り込み/.test(i.summary));
  const day = (d) => (d ? d.slice(0, 10) : '');
  const plan = [];
  for (const i of all) {
    if (notMecom.includes(i)) plan.push([i, `rename to "【対象外】${i.summary}", clear dates, Closed`, [['summary', `【対象外】${i.summary}`], ['startDate', ''], ['dueDate', ''], ['statusId', 4]]]);
    else if (phase2.includes(i)) plan.push([i, 'clear dates, stays Open', [['startDate', ''], ['dueDate', ''], ['statusId', 1]]]);
    else if (day(i.dueDate) && day(i.dueDate) < today && i.status.id !== 4) plan.push([i, `Closed (due ${day(i.dueDate)})`, [['statusId', 4]]]);
  }
  for (const [i, what, params] of plan) {
    const parent = i.parentIssueId && byId[i.parentIssueId] ? `  [under ${byId[i.parentIssueId].summary}]` : '';
    core.info(`${apply ? '' : 'would '}${i.issueKey}  ${i.summary}${parent}  ->  ${what}`);
    if (apply) {
      await backlog('PATCH', `/issues/${i.issueKey}`, params);
      const after = await backlog('GET', `/issues/${i.issueKey}`);
      if (params.some(([k]) => k === 'dueDate') && after.dueDate) core.warning(`${i.issueKey}: Backlog kept the due date ${day(after.dueDate)}`);
    }
  }
  const left = all.length - plan.length;
  core.summary.addHeading(apply ? 'Clean-up done' : 'Dry run: nothing changed').addRaw(`${plan.length} issues ${apply ? 'changed' : 'would change'}, ${left} unchanged.`).write();
};
