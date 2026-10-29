// ============================================================
// GitHub Issues  ->  Backlog (and its Gantt chart)
//
// Issue opened    -> creates a matching Backlog issue (with dates),
//                    renames the GitHub issue to "[JIJI-14] title"
// Issue edited    -> updates the Backlog title and dates
// Issue closed    -> Backlog status = Closed
// Issue reopened  -> Backlog status = In Progress
// Code pushed     -> commits that mention "#5" (GitHub issue) or
//                    "JIJI-14" are posted as a comment on the Backlog
//                    issue, and an Open issue moves to In Progress
// ============================================================

const HOST = process.env.BACKLOG_HOST;
const API_KEY = process.env.BACKLOG_API_KEY;
const PROJECT_KEY = process.env.BACKLOG_PROJECT_KEY;
const PARENT_KEY = process.env.BACKLOG_PARENT_KEY || '';
const ISSUE_TYPE_NAME = process.env.BACKLOG_ISSUE_TYPE || 'Task';

const STATUS = { OPEN: 1, IN_PROGRESS: 2, RESOLVED: 3, CLOSED: 4 };
const PRIORITY_NORMAL = 3;
const KEY_IN_TITLE = /^\[([A-Z][A-Z0-9_]*-\d+)\]\s*/;

// ---------- Backlog API ----------
async function backlog(method, path, params = {}) {
  const url = new URL(`https://${HOST}/api/v2${path}`);
  url.searchParams.set('apiKey', API_KEY);
  const clean = Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined);
  const opts = { method, headers: {} };
  if (method === 'GET') {
    clean.forEach(([k, v]) => url.searchParams.append(k, v));
  } else {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(clean).toString();
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`Backlog ${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// ---------- helpers ----------
// Reads "### Start date\n\n2026-11-02" from an issue-form body
function readDate(body, label) {
  const re = new RegExp(`###\\s*${label}\\s*\\n+\\s*([^\\n]+)`, 'i');
  const m = (body || '').match(re);
  const v = m ? m[1].trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

function backlogKeyFromTitle(title) {
  const m = (title || '').match(KEY_IN_TITLE);
  return m ? m[1] : null;
}

function stripKey(title) {
  return (title || '').replace(KEY_IN_TITLE, '');
}

// ---------- issue events ----------
async function onIssue({ github, context, core }) {
  const { action, issue } = context.payload;
  const { owner, repo } = context.repo;
  const key = backlogKeyFromTitle(issue.title);
  const startDate = readDate(issue.body, 'Start date');
  const dueDate = readDate(issue.body, 'Due date');

  if (action === 'opened') {
    // Title already has a Backlog key -> link to that existing issue, don't create a new one
    if (key) {
      await backlog('PATCH', `/issues/${key}`, { startDate, dueDate });
      return core.info(`Linked to existing ${key}`);
    }

    const project = await backlog('GET', `/projects/${PROJECT_KEY}`);
    const types = await backlog('GET', `/projects/${PROJECT_KEY}/issueTypes`);
    const type = types.find((t) => t.name === ISSUE_TYPE_NAME) || types[0];
    let parentIssueId = '';
    if (PARENT_KEY) parentIssueId = (await backlog('GET', `/issues/${PARENT_KEY}`)).id;

    const created = await backlog('POST', '/issues', {
      projectId: project.id,
      summary: issue.title,
      issueTypeId: type.id,
      priorityId: PRIORITY_NORMAL,
      description: `GitHub issue: ${issue.html_url}\n\n${issue.body || ''}`,
      startDate,
      dueDate,
      parentIssueId,
    });

    const newKey = created.issueKey;
    await github.rest.issues.update({
      owner, repo, issue_number: issue.number,
      title: `[${newKey}] ${issue.title}`,
    });
    await github.rest.issues.createComment({
      owner, repo, issue_number: issue.number,
      body: `🔗 Linked to Backlog **${newKey}**: https://${HOST}/view/${newKey}` +
        (startDate && dueDate ? `\n\nOn the Gantt chart: ${startDate} → ${dueDate}` :
          '\n\n⚠️ No start/due date, so it will be in "unscheduled issues" until dates are added.'),
    });
    return core.info(`Created ${newKey}`);
  }

  if (!key) return core.info('No Backlog key in title, nothing to sync');

  if (action === 'edited') {
    await backlog('PATCH', `/issues/${key}`, { summary: stripKey(issue.title), startDate, dueDate });
    return core.info(`Updated ${key}`);
  }
  if (action === 'closed') {
    await backlog('PATCH', `/issues/${key}`, { statusId: STATUS.CLOSED });
    return core.info(`Closed ${key}`);
  }
  if (action === 'reopened') {
    await backlog('PATCH', `/issues/${key}`, { statusId: STATUS.IN_PROGRESS });
    return core.info(`Reopened ${key}`);
  }
}

// ---------- push events ----------
async function onPush({ github, context, core }) {
  const { owner, repo } = context.repo;
  const commits = context.payload.commits || [];
  const branch = (context.payload.ref || '').replace('refs/heads/', '');
  const byKey = new Map();
  const titleCache = new Map();

  for (const c of commits) {
    const keys = new Set(c.message.match(new RegExp(`${PROJECT_KEY}-\\d+`, 'g')) || []);
    for (const [, num] of c.message.matchAll(/#(\d+)/g)) {
      if (!titleCache.has(num)) {
        try {
          const { data } = await github.rest.issues.get({ owner, repo, issue_number: Number(num) });
          titleCache.set(num, data.title);
        } catch { titleCache.set(num, ''); }
      }
      const k = backlogKeyFromTitle(titleCache.get(num));
      if (k) keys.add(k);
    }
    keys.forEach((k) => byKey.set(k, [...(byKey.get(k) || []), c]));
  }

  if (byKey.size === 0) return core.info('No linked issues in these commits');

  for (const [key, list] of byKey) {
    const lines = list.map((c) => `- [${c.message.split('\n')[0]}](${c.url}) (${c.id.slice(0, 7)})`);
    await backlog('POST', `/issues/${key}/comments`, {
      content: `${list[0].author.name} pushed to GitHub \`${branch}\`:\n${lines.join('\n')}`,
    });
    const current = await backlog('GET', `/issues/${key}`);
    if (current.status.id === STATUS.OPEN) {
      await backlog('PATCH', `/issues/${key}`, { statusId: STATUS.IN_PROGRESS });
    }
    core.info(`Commented on ${key}`);
  }
}

// ---------- one-click import: Backlog -> GitHub Issues ----------
// Copies the existing Backlog engineering issues (children of BACKLOG_PARENT_KEY,
// or all project issues if no parent is set) into GitHub as "[JIJI-10] title".
// Safe to run again: issues already in GitHub are skipped.
async function onImport({ github, context, core }) {
  const { owner, repo } = context.repo;
  const project = await backlog('GET', `/projects/${PROJECT_KEY}`);
  const query = { 'projectId[]': project.id, count: 100, sort: 'startDate', order: 'asc' };
  if (PARENT_KEY) query['parentIssueId[]'] = (await backlog('GET', `/issues/${PARENT_KEY}`)).id;
  const items = await backlog('GET', '/issues', query);

  const existing = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'all', per_page: 100 });
  const linked = new Set(existing.map((i) => backlogKeyFromTitle(i.title)).filter(Boolean));

  let made = 0;
  for (const b of items) {
    if (linked.has(b.issueKey)) { core.info(`Skip ${b.issueKey} (already in GitHub)`); continue; }
    const day = (d) => (d ? d.slice(0, 10) : '');
    const { data } = await github.rest.issues.create({
      owner, repo,
      title: `[${b.issueKey}] ${b.summary}`,
      body: `### Start date\n\n${day(b.startDate)}\n\n### Due date\n\n${day(b.dueDate)}\n\n` +
        `### Details\n\n${b.description || ''}\n\nBacklog: https://${HOST}/view/${b.issueKey}`,
    });
    if (b.status && b.status.id === STATUS.CLOSED) {
      await github.rest.issues.update({ owner, repo, issue_number: data.number, state: 'closed' });
    }
    made++;
    core.info(`Imported ${b.issueKey} as GitHub #${data.number}`);
  }
  core.info(`Done: ${made} imported, ${items.length - made} skipped`);
}

module.exports = async function sync(ctx) {
  if (!API_KEY) throw new Error('Missing secret BACKLOG_API_KEY');
  const ev = ctx.context.eventName;
  if (ev === 'workflow_dispatch') return onImport(ctx);
  if (ev === 'issues') return onIssue(ctx);
  if (ev === 'push') return onPush(ctx);
};
module.exports._test = { readDate, backlogKeyFromTitle, stripKey };
