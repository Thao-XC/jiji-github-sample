// ============================================================
// GitHub Issues  ->  Backlog (one repo, many Backlog projects)
//
// Which Backlog project an issue belongs to is decided by:
//   1. the "Project" dropdown in the Engineering task form, or
//   2. a GitHub label with the same name (e.g. "mecom")
// The names and their Backlog project keys live in
// .github/backlog-projects.json
//
// Issue opened / labeled -> creates the Backlog issue (with dates) in the
//                           right project, renames GitHub issue "[KEY-14] title"
// Issue edited           -> updates Backlog title and dates
// Issue closed           -> Backlog status = Closed
// Issue reopened         -> Backlog status = In Progress
// Code pushed            -> commits mentioning "#5" or "KEY-14" are posted
//                           as a comment; Open issues move to In Progress
// Run workflow (manual)  -> copies existing Backlog engineering issues of
//                           every project into GitHub Issues
// ============================================================

const fs = require('fs');
const path = require('path');

const HOST = process.env.BACKLOG_HOST;
const API_KEY = process.env.BACKLOG_API_KEY;
const ISSUE_TYPE_NAME = process.env.BACKLOG_ISSUE_TYPE || 'Task';
const CONFIG_PATH = process.env.BACKLOG_CONFIG || path.join('.github', 'backlog-projects.json');

const STATUS = { OPEN: 1, IN_PROGRESS: 2, RESOLVED: 3, CLOSED: 4 };
const PRIORITY_NORMAL = 3;
const KEY_IN_TITLE = /^\[([A-Z][A-Z0-9_]*-\d+)\]\s*/;

function loadProjects() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return cfg.projects || {};
}

// ---------- Backlog API ----------
async function backlog(method, apiPath, params = {}) {
  const url = new URL(`https://${HOST}/api/v2${apiPath}`);
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
  if (!res.ok) throw new Error(`Backlog ${method} ${apiPath} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// ---------- helpers ----------
// Reads "### Start date\n\n2026-11-02" style fields from an issue-form body
function readField(body, label) {
  const re = new RegExp(`###\\s*${label}\\s*\\n+\\s*([^\\n]+)`, 'i');
  const m = (body || '').match(re);
  const v = m ? m[1].trim() : '';
  return v === '_No response_' ? '' : v;
}

function readDate(body, label) {
  const v = readField(body, label);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

function backlogKeyFromTitle(title) {
  const m = (title || '').match(KEY_IN_TITLE);
  return m ? m[1] : null;
}

function stripKey(title) {
  return (title || '').replace(KEY_IN_TITLE, '');
}

// Decide the project: form dropdown first, then labels
function pickProject(issue, projects) {
  const fromForm = readField(issue.body, 'Project').toLowerCase();
  if (projects[fromForm]) return fromForm;
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name).toLowerCase());
  return labels.find((l) => projects[l]) || null;
}

async function ensureLabel(github, owner, repo, name) {
  try {
    await github.rest.issues.createLabel({ owner, repo, name, color: '1f6feb', description: 'Backlog project' });
  } catch (e) { /* already exists */ }
}

// ---------- issue events ----------
async function onIssue({ github, context, core }) {
  const { action } = context.payload;
  const { owner, repo } = context.repo;
  // Re-read the issue: another run (opened vs labeled) may have linked it a moment ago
  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: context.payload.issue.number });
  const projects = loadProjects();
  const key = backlogKeyFromTitle(issue.title);
  const startDate = readDate(issue.body, 'Start date');
  const dueDate = readDate(issue.body, 'Due date');

  if (action === 'opened' || action === 'labeled') {
    if (key) {
      if (action === 'opened') await backlog('PATCH', `/issues/${key}`, { startDate, dueDate });
      return core.info(`Already linked to ${key}`);
    }

    const name = pickProject(issue, projects);
    if (!name) {
      if (action === 'opened') {
        await github.rest.issues.createComment({
          owner, repo, issue_number: issue.number,
          body: `⚠️ Not sent to Backlog yet: no project chosen.\n\nAdd one of these labels: ${Object.keys(projects).map((p) => `\`${p}\``).join(', ')}. ` +
            'The issue will be sent to that Backlog project automatically.',
        });
      }
      return core.info('No project chosen, skipped');
    }

    const p = projects[name];
    const project = await backlog('GET', `/projects/${p.projectKey}`);
    const types = await backlog('GET', `/projects/${p.projectKey}/issueTypes`);
    const type = types.find((t) => t.name === ISSUE_TYPE_NAME) || types[0];
    let parentIssueId = '';
    if (p.parentKey) parentIssueId = (await backlog('GET', `/issues/${p.parentKey}`)).id;

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
    await ensureLabel(github, owner, repo, name);
    await github.rest.issues.update({
      owner, repo, issue_number: issue.number,
      title: `[${newKey}] ${issue.title}`,
    });
    await github.rest.issues.addLabels({ owner, repo, issue_number: issue.number, labels: [name] });
    await github.rest.issues.createComment({
      owner, repo, issue_number: issue.number,
      body: `🔗 Linked to Backlog **${newKey}** (project ${p.projectKey}): https://${HOST}/view/${newKey}` +
        (startDate && dueDate ? `\n\nOn the Gantt chart: ${startDate} → ${dueDate}` :
          '\n\n⚠️ No start/due date, so it will be in "unscheduled issues" until dates are added.'),
    });
    return core.info(`Created ${newKey} in ${p.projectKey}`);
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
  const projects = loadProjects();
  const keysRe = new RegExp(`\\b(?:${Object.values(projects).map((p) => p.projectKey).join('|')})-\\d+\\b`, 'g');
  const commits = context.payload.commits || [];
  const branch = (context.payload.ref || '').replace('refs/heads/', '');
  const byKey = new Map();
  const titleCache = new Map();

  for (const c of commits) {
    const keys = new Set(c.message.match(keysRe) || []);
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
// For every project in the config: copies its Backlog engineering issues
// (children of parentKey, or all issues if no parent) into GitHub as
// "[KEY-10] title" with the project label. Already-copied issues are skipped.
async function onImport({ github, context, core }) {
  const { owner, repo } = context.repo;
  const projects = loadProjects();
  const existing = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'all', per_page: 100 });
  const linked = new Set(existing.map((i) => backlogKeyFromTitle(i.title)).filter(Boolean));
  const day = (d) => (d ? d.slice(0, 10) : '');

  for (const [name, p] of Object.entries(projects)) {
    await ensureLabel(github, owner, repo, name);
    const project = await backlog('GET', `/projects/${p.projectKey}`);
    const query = { 'projectId[]': project.id, count: 100, sort: 'startDate', order: 'asc' };
    if (p.parentKey) query['parentIssueId[]'] = (await backlog('GET', `/issues/${p.parentKey}`)).id;
    const items = await backlog('GET', '/issues', query);

    let made = 0;
    for (const b of items) {
      if (linked.has(b.issueKey)) continue;
      const { data } = await github.rest.issues.create({
        owner, repo,
        title: `[${b.issueKey}] ${b.summary}`,
        labels: [name],
        body: `### Project\n\n${name}\n\n### Start date\n\n${day(b.startDate)}\n\n### Due date\n\n${day(b.dueDate)}\n\n` +
          `### Details\n\n${b.description || ''}\n\nBacklog: https://${HOST}/view/${b.issueKey}`,
      });
      if (b.status && b.status.id === STATUS.CLOSED) {
        await github.rest.issues.update({ owner, repo, issue_number: data.number, state: 'closed' });
      }
      made++;
    }
    core.info(`${name} (${p.projectKey}): ${made} imported, ${items.length - made} already in GitHub`);
  }
}

module.exports = async function sync(ctx) {
  if (!API_KEY) throw new Error('Missing secret BACKLOG_API_KEY');
  const ev = ctx.context.eventName;
  if (ev === 'workflow_dispatch') return onImport(ctx);
  if (ev === 'issues') return onIssue(ctx);
  if (ev === 'push') return onPush(ctx);
};
module.exports._test = { readField, readDate, backlogKeyFromTitle, stripKey, pickProject };
