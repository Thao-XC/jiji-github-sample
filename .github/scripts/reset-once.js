// ============================================================
// ONE-TIME RESET of the Mecom test data. Delete this file afterwards.
//
// Actions -> Sync to Backlog -> Run workflow -> mode "reset"
//   confirm empty     -> DRY RUN: only lists what would be deleted / closed
//   confirm "DELETE"  -> really deletes, cannot be undone
//
// What it touches:
//   1. Every issue in Backlog project JIJI (children first, then parents)
//   2. Backlog issue TEST_IWATA-48 only (the GitHub sync test issue),
//      and only if its title still mentions GitHub
//   3. Open GitHub issues in this repo: closed as "not planned" (not deleted)
// Backlog documents, files, wiki, categories and milestones are not touched.
// ============================================================

const HOST = process.env.BACKLOG_HOST;
const API_KEY = process.env.BACKLOG_API_KEY;
const PROJECT_TO_EMPTY = 'JIJI';
const SINGLE_ISSUE = { key: 'TEST_IWATA-48', mustContain: 'GitHub' };

async function backlog(method, apiPath, params = []) {
  const url = new URL(`https://${HOST}/api/v2${apiPath}`);
  url.searchParams.set('apiKey', API_KEY);
  params.forEach(([k, v]) => url.searchParams.append(k, v));
  const res = await fetch(url, { method });
  const text = await res.text();
  if (!res.ok) throw new Error(`Backlog ${method} ${apiPath} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

module.exports = async function reset({ github, context, core }) {
  const confirm = ((context.payload.inputs && context.payload.inputs.confirm) || '').trim();
  const really = confirm === 'DELETE';
  const { owner, repo } = context.repo;
  core.info(really ? '*** DELETING (confirm = DELETE) ***' : '*** DRY RUN: nothing will be deleted ***');

  // 1. All issues in JIJI
  const project = await backlog('GET', `/projects/${PROJECT_TO_EMPTY}`);
  const issues = [];
  for (let offset = 0; ; offset += 100) {
    const page = await backlog('GET', '/issues', [['projectId[]', project.id], ['count', 100], ['offset', offset], ['sort', 'created'], ['order', 'asc']]);
    issues.push(...page);
    if (page.length < 100) break;
  }
  const children = issues.filter((i) => i.parentIssueId);
  const parents = issues.filter((i) => !i.parentIssueId);
  core.info(`\nBacklog ${PROJECT_TO_EMPTY} (${project.name}): ${issues.length} issues`);
  for (const i of [...children, ...parents]) core.info(`  ${really ? 'delete' : 'would delete'}  ${i.issueKey}  ${i.summary}`);

  // 2. The single test issue in the other project
  let single = null;
  try {
    single = await backlog('GET', `/issues/${SINGLE_ISSUE.key}`);
  } catch (e) { core.info(`\n${SINGLE_ISSUE.key}: not found, skipped`); }
  if (single && !single.summary.includes(SINGLE_ISSUE.mustContain)) {
    core.info(`\n${SINGLE_ISSUE.key}: title is "${single.summary}", which is not the test issue. Skipped for safety.`);
    single = null;
  } else if (single) {
    core.info(`\n  ${really ? 'delete' : 'would delete'}  ${single.issueKey}  ${single.summary}`);
  }

  // 3. Open GitHub issues in this repo (pull requests excluded)
  const open = (await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'open', per_page: 100 }))
    .filter((i) => !i.pull_request);
  core.info(`\nGitHub ${owner}/${repo}: ${open.length} open issues`);
  for (const i of open) core.info(`  ${really ? 'close' : 'would close'}  #${i.number}  ${i.title}`);

  if (!really) {
    core.summary.addHeading('Dry run: nothing was deleted').addRaw(
      `Would delete ${issues.length} Backlog issues in ${PROJECT_TO_EMPTY}` +
      `${single ? ` and ${single.issueKey}` : ''}, and close ${open.length} GitHub issues. ` +
      'To do it, run again with confirm = DELETE.').write();
    return core.info('\nDry run finished. Run again with confirm = DELETE to really do it.');
  }

  for (const i of [...children, ...parents]) await backlog('DELETE', `/issues/${i.issueKey}`);
  if (single) await backlog('DELETE', `/issues/${single.issueKey}`);
  // Closed with the workflow's own token, so these closes don't start new sync runs
  for (const i of open) await github.rest.issues.update({ owner, repo, issue_number: i.number, state: 'closed', state_reason: 'not_planned' });

  core.summary.addHeading('Reset done').addRaw(
    `Deleted ${issues.length} Backlog issues in ${PROJECT_TO_EMPTY}${single ? ` and ${single.issueKey}` : ''}; ` +
    `closed ${open.length} GitHub issues.`).write();
  core.info('\nReset done.');
};
