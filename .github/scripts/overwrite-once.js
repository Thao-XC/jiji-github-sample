// ============================================================
// ONE-TIME: overwrite the old Mecom test issues in Backlog JIJI with the new
// schedule (.github/scripts/mecom-data.json), because the API key may not delete.
// Old issues are reused (title, dates, description, parent, status Open);
// the rest are created. Delete this file and mecom-data.json afterwards.
//   confirm empty  -> dry run (plan only)    confirm "APPLY" -> do it
// ============================================================
const fs = require('fs');
const HOST = process.env.BACKLOG_HOST;
const API_KEY = process.env.BACKLOG_API_KEY;
const PROJECT = 'JIJI';

async function backlog(method, apiPath, params = []) {
  const url = new URL(`https://${HOST}/api/v2${apiPath}`);
  url.searchParams.set('apiKey', API_KEY);
  const opts = { method, headers: {} };
  if (method === 'GET') params.forEach(([k, v]) => url.searchParams.append(k, v));
  else { opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(params).toString(); }
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`Backlog ${method} ${apiPath} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const num = (k) => Number(k.split('-').pop());

module.exports = async function overwrite({ github, context, core }) {
  const apply = ((context.payload.inputs && context.payload.inputs.confirm) || '').trim() === 'APPLY';
  core.info(apply ? '*** APPLYING ***' : '*** DRY RUN: nothing will change ***');
  const rows = JSON.parse(fs.readFileSync('.github/scripts/mecom-data.json', 'utf8'));
  const project = await backlog('GET', `/projects/${PROJECT}`);
  const types = await backlog('GET', `/projects/${PROJECT}/issueTypes`);
  const type = types.find((t) => t.name === 'Task') || types[0];
  const old = [];
  for (let offset = 0; ; offset += 100) {
    const page = await backlog('GET', '/issues', [['projectId[]', project.id], ['count', 100], ['offset', offset]]);
    old.push(...page); if (page.length < 100) break;
  }
  const oldTop = old.filter((i) => !i.parentIssueId).sort((a, b) => num(a.issueKey) - num(b.issueKey));
  const oldChild = old.filter((i) => i.parentIssueId).sort((a, b) => num(a.issueKey) - num(b.issueKey));
  const newTop = rows.filter((r) => !r.parent);
  const newChild = rows.filter((r) => r.parent);
  if (oldTop.length > newTop.length || oldChild.length > newChild.length) throw new Error('More old issues than new rows: stop');
  newTop.forEach((r, i) => { r.reuse = oldTop[i]; });
  newChild.forEach((r, i) => { r.reuse = oldChild[i]; });

  const keyOf = {}; // subject of a parent row -> its Backlog issue {id, key}
  const fields = (r, parent) => {
    const p = [['summary', r.subject], ['description', r.description || ' '], ['startDate', r.start], ['dueDate', r.due],
      ['issueTypeId', type.id], ['priorityId', 3]];
    if (parent) p.push(['parentIssueId', parent.id]);
    return p;
  };
  const save = async (r) => {
    const parent = r.parent ? keyOf[r.parent] : null;
    if (r.parent && !parent && apply) throw new Error(`Parent "${r.parent}" not ready for "${r.subject}"`);
    let res;
    if (r.reuse) {
      core.info(`${apply ? 'overwrite' : 'would overwrite'} ${r.reuse.issueKey}  "${r.reuse.summary}"  ->  "${r.subject}"  ${r.start} → ${r.due}${r.parent ? `  (child of ${r.parent})` : ''}`);
      if (apply) res = await backlog('PATCH', `/issues/${r.reuse.issueKey}`, [...fields(r, parent), ['statusId', 1]]);
    } else {
      core.info(`${apply ? 'create' : 'would create'}  "${r.subject}"  ${r.start} → ${r.due}${r.parent ? `  (child of ${r.parent})` : ''}`);
      if (apply) res = await backlog('POST', '/issues', [['projectId', project.id], ...fields(r, parent)]);
    }
    if (!r.parent) keyOf[r.subject] = apply ? { id: res.id, key: res.issueKey } : { id: 0, key: '?' };
  };
  for (const r of newTop) await save(r);   // parents first
  for (const r of newChild) await save(r);

  // Close the old GitHub test issues, so editing them can never overwrite the new Backlog issues
  const { owner, repo } = context.repo;
  const open = (await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'open', per_page: 100 })).filter((i) => !i.pull_request);
  for (const i of open) {
    core.info(`${apply ? 'close' : 'would close'} GitHub #${i.number}  ${i.title}`);
    if (apply) await github.rest.issues.update({ owner, repo, issue_number: i.number, state: 'closed', state_reason: 'not_planned' });
  }
  const reused = rows.filter((r) => r.reuse).length;
  core.summary.addHeading(apply ? 'Overwrite done' : 'Dry run: nothing changed')
    .addRaw(`${reused} old issues ${apply ? 'overwritten' : 'would be overwritten'}, ${rows.length - reused} ${apply ? 'created' : 'would be created'}, ${open.length} GitHub test issues ${apply ? 'closed' : 'would be closed'}.`).write();
};
