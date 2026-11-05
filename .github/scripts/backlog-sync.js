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
// Issue edited           -> updates Backlog title, dates and parent
// "Parent issue" field   -> empty = project default, "none" = top level,
//                           "#18" or "JIJI-14" = child of that issue (one level only)
//
// STATUS (4 statuses, GitHub labels are the switch):
//   open, no status label        -> Open        (board: Todo)
//   label "in-progress"          -> In Progress (board: In Progress)
//   label "resolved"             -> Resolved    (board: Resolved)
//   issue closed                 -> Closed      (board: Done)
//   Adding or removing a label moves the status both ways. The two labels
//   replace each other. Assigning someone, reopening, or pushing a commit
//   that mentions the issue adds "in-progress" automatically.
//
// Code pushed            -> commits mentioning "#5" or "KEY-14" are posted as a comment
// Run workflow (manual)  -> mode "import": copies existing Backlog engineering issues
//                           into GitHub Issues; mode "setup-board": creates the
//                           GitHub Projects board and fills it (needs PROJECT_TOKEN)
// ============================================================

const fs = require('fs');
const path = require('path');
const { makeBoard } = require('./board.js');

const HOST = process.env.BACKLOG_HOST;
const API_KEY = process.env.BACKLOG_API_KEY;
const ISSUE_TYPE_NAME = process.env.BACKLOG_ISSUE_TYPE || 'Task';
const CONFIG_PATH = process.env.BACKLOG_CONFIG || path.join('.github', 'backlog-projects.json');

const STATUS = { OPEN: 1, IN_PROGRESS: 2, RESOLVED: 3, CLOSED: 4 };
const PRIORITY_NORMAL = 3;
const KEY_IN_TITLE = /^\[([A-Z][A-Z0-9_]*-\d+)\]\s*/;
const STATUS_NAMES = { 1: 'Open', 2: 'In Progress', 3: 'Resolved', 4: 'Closed' };
const LABEL_IN_PROGRESS = 'in-progress';
const LABEL_RESOLVED = 'resolved';
const STATUS_LABELS = [LABEL_IN_PROGRESS, LABEL_RESOLVED];
const LABEL_COLORS = { [LABEL_IN_PROGRESS]: '2e86c1', [LABEL_RESOLVED]: '2a9d8f' };
const LABEL_HELP = {
  [LABEL_IN_PROGRESS]: 'Work started: Backlog In Progress',
  [LABEL_RESOLVED]: 'Done, waiting for check: Backlog Resolved',
};
let board = null; // GitHub Projects board helper, set per run

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

// Works out the Backlog parent for an issue from the form's "Parent issue" field:
//   empty -> the project's default parentKey   |  "none" -> top level (can be a parent itself)
//   "#18" -> the Backlog issue linked to GitHub issue #18   |  "JIJI-14" -> that Backlog issue
// Returns { id, key } (id '' = no parent) or { error } with a message for the GitHub comment.
async function resolveParent(github, owner, repo, issue, p, projectId) {
  const raw = readField(issue.body, 'Parent issue').trim();
  let parentKey = p.parentKey || '';
  if (/^(none|なし)$/i.test(raw)) parentKey = '';
  else if (/^#?\d+$/.test(raw)) {
    const num = Number(raw.replace('#', ''));
    let title = '';
    try { title = (await github.rest.issues.get({ owner, repo, issue_number: num })).data.title; } catch (e) { /* not found */ }
    parentKey = backlogKeyFromTitle(title);
    if (!parentKey) return { error: `Parent \`${raw}\`: GitHub issue #${num} is not linked to Backlog yet (its title has no [KEY-n]).` };
  } else if (/^[A-Z][A-Z0-9_]*-\d+$/.test(raw)) parentKey = raw;
  else if (raw) return { error: `Parent \`${raw}\` not understood. Use a GitHub number like #18, a Backlog key like JIJI-14, or none.` };

  if (!parentKey) return { id: '', key: '' };
  let parent;
  try { parent = await backlog('GET', `/issues/${parentKey}`); } catch (e) {
    return { error: `Parent ${parentKey} was not found in Backlog.` };
  }
  if (parent.projectId !== projectId) return { error: `Parent ${parentKey} is in a different Backlog project. Parent and child must be in the same project.` };
  if (parent.parentIssueId) return { error: `${parentKey} is already a child issue. Backlog allows only one level, so pick its parent or a top-level issue instead.` };
  return { id: parent.id, key: parentKey };
}

// ---------- status ----------
function labelNames(issue) {
  return (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name).toLowerCase());
}

// The Backlog status an issue should have, read from its GitHub state and labels
function desiredStatus(issue) {
  if (issue.state === 'closed') return STATUS.CLOSED;
  const labels = labelNames(issue);
  if (labels.includes(LABEL_RESOLVED)) return STATUS.RESOLVED;
  if (labels.includes(LABEL_IN_PROGRESS)) return STATUS.IN_PROGRESS;
  return STATUS.OPEN;
}

async function ensureStatusLabels(github, owner, repo) {
  for (const name of STATUS_LABELS) {
    try {
      await github.rest.issues.createLabel({ owner, repo, name, color: LABEL_COLORS[name], description: LABEL_HELP[name] });
    } catch (e) { /* already exists */ }
  }
}

// Make the issue carry exactly one status label (or none). Updates issue.labels in place.
async function setStatusLabel(github, owner, repo, issue, want) {
  const have = labelNames(issue);
  for (const name of STATUS_LABELS) {
    if (name !== want && have.includes(name)) {
      try { await github.rest.issues.removeLabel({ owner, repo, issue_number: issue.number, name }); } catch (e) { /* gone */ }
    }
  }
  if (want && !have.includes(want)) {
    await ensureStatusLabels(github, owner, repo);
    await github.rest.issues.addLabels({ owner, repo, issue_number: issue.number, labels: [want] });
  }
  issue.labels = (issue.labels || []).filter((l) => {
    const n = (typeof l === 'string' ? l : l.name).toLowerCase();
    return !STATUS_LABELS.includes(n);
  }).concat(want ? [{ name: want }] : []);
}

// Push the issue's GitHub status to Backlog (and the board). Comment in Backlog when it changes.
async function applyStatus(owner, issue, key, why) {
  const desired = desiredStatus(issue);
  const current = await backlog('GET', `/issues/${key}`);
  if (current.status.id !== desired) {
    await backlog('PATCH', `/issues/${key}`, { statusId: desired });
    await backlog('POST', `/issues/${key}/comments`, {
      content: `${why} on GitHub: ${STATUS_NAMES[current.status.id]} → ${STATUS_NAMES[desired]}\n${issue.html_url}`,
    });
  }
  if (board) await board.setItem(owner, issue.node_id, desired, readDate(issue.body, 'Start date'), readDate(issue.body, 'Due date'));
  return desired;
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

  // ----- status changes (linked issues only) -----
  const who = (context.payload.sender && context.payload.sender.login) || 'Someone';
  const changedLabel = context.payload.label ? context.payload.label.name.toLowerCase() : '';
  if (key && STATUS_LABELS.includes(changedLabel) && (action === 'labeled' || action === 'unlabeled')) {
    if (action === 'labeled') await setStatusLabel(github, owner, repo, issue, changedLabel); // the two labels replace each other
    const st = await applyStatus(owner, issue, key, `${who} ${action === 'labeled' ? 'added' : 'removed'} the "${changedLabel}" label`);
    return core.info(`${key} -> ${STATUS_NAMES[st]} (${action} ${changedLabel})`);
  }
  if (key && action === 'assigned') {
    if (issue.state === 'open' && !labelNames(issue).some((l) => STATUS_LABELS.includes(l))) {
      await setStatusLabel(github, owner, repo, issue, LABEL_IN_PROGRESS);
    }
    const st = await applyStatus(owner, issue, key, `${who} assigned ${context.payload.assignee ? context.payload.assignee.login : 'someone'}`);
    return core.info(`${key} -> ${STATUS_NAMES[st]} (assigned)`);
  }
  if (key && action === 'closed') {
    const st = await applyStatus(owner, issue, key, `${who} closed the issue`);
    return core.info(`${key} -> ${STATUS_NAMES[st]} (closed)`);
  }
  if (key && action === 'reopened') {
    await setStatusLabel(github, owner, repo, issue, LABEL_IN_PROGRESS);
    const st = await applyStatus(owner, issue, key, `${who} reopened the issue`);
    return core.info(`${key} -> ${STATUS_NAMES[st]} (reopened)`);
  }

  if (action === 'opened' || action === 'labeled' || (action === 'edited' && !key)) {
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
    const parent = await resolveParent(github, owner, repo, issue, p, project.id);
    if (parent.error) {
      await github.rest.issues.createComment({
        owner, repo, issue_number: issue.number,
        body: `⚠️ Not sent to Backlog yet. ${parent.error}\n\nEdit the issue to fix the **Parent issue** line, and it will be sent automatically.`,
      });
      return core.info(`Parent problem: ${parent.error}`);
    }
    const parentIssueId = parent.id;

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
        (parent.key ? `\n\nChild of **${parent.key}**.` : '\n\nTop-level issue (can be a parent).') +
        (startDate && dueDate ? `\n\nOn the Gantt chart: ${startDate} → ${dueDate}` :
          '\n\n⚠️ No start/due date, so it will be in "unscheduled issues" until dates are added.'),
    });
    if (board) await board.setItem(owner, issue.node_id, STATUS.OPEN, startDate, dueDate);
    return core.info(`Created ${newKey} in ${p.projectKey}`);
  }

  if (!key) return core.info('No Backlog key in title, nothing to sync');

  if (action === 'edited') {
    const changes = { summary: stripKey(issue.title), startDate, dueDate };
    const raw = readField(issue.body, 'Parent issue').trim();
    if (raw && !/^(none|なし)$/i.test(raw)) {
      const current = await backlog('GET', `/issues/${key}`);
      const parent = await resolveParent(github, owner, repo, issue, {}, current.projectId);
      if (parent.error) {
        await github.rest.issues.createComment({ owner, repo, issue_number: issue.number, body: `⚠️ Parent not changed. ${parent.error}` });
      } else if (parent.key === key) {
        await github.rest.issues.createComment({ owner, repo, issue_number: issue.number, body: '⚠️ Parent not changed: an issue cannot be its own parent.' });
      } else if (parent.id && parent.id !== current.parentIssueId) {
        changes.parentIssueId = parent.id;
      }
    }
    await backlog('PATCH', `/issues/${key}`, changes);
    if (board) await board.setItem(owner, issue.node_id, null, startDate, dueDate);
    return core.info(`Updated ${key}`);
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
  const numberOfKey = new Map(); // Backlog key -> GitHub issue number

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
      if (k) { keys.add(k); numberOfKey.set(k, Number(num)); }
    }
    keys.forEach((k) => byKey.set(k, [...(byKey.get(k) || []), c]));
  }

  if (byKey.size === 0) return core.info('No linked issues in these commits');

  // Keys written without "#n": find their GitHub issue by title
  if ([...byKey.keys()].some((k) => !numberOfKey.has(k))) {
    const all = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'all', per_page: 100 });
    for (const i of all) {
      const k = backlogKeyFromTitle(i.title);
      if (k && byKey.has(k) && !numberOfKey.has(k) && !i.pull_request) numberOfKey.set(k, i.number);
    }
  }

  for (const [key, list] of byKey) {
    const lines = list.map((c) => `- [${c.message.split('\n')[0]}](${c.url}) (${c.id.slice(0, 7)})`);
    await backlog('POST', `/issues/${key}/comments`, {
      content: `${list[0].author.name} pushed to GitHub \`${branch}\`:\n${lines.join('\n')}`,
    });
    const num = numberOfKey.get(key);
    if (num) {
      // Work has started: an open issue with no status label gets "in-progress"
      const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number: num });
      if (issue.state === 'open' && !labelNames(issue).some((l) => STATUS_LABELS.includes(l))) {
        await setStatusLabel(github, owner, repo, issue, LABEL_IN_PROGRESS);
        await applyStatus(owner, issue, key, `${list[0].author.name} pushed a commit`);
      }
    } else {
      const current = await backlog('GET', `/issues/${key}`);
      if (current.status.id === STATUS.OPEN) await backlog('PATCH', `/issues/${key}`, { statusId: STATUS.IN_PROGRESS });
    }
    core.info(`Commented on ${key}`);
  }
}

// ---------- one-click import: Backlog -> GitHub Issues ----------
// For every project in the config that has a parentKey: copies the children of
// that parent issue (its engineering issues) into GitHub as
// "[KEY-10] title" with the project label. Already-copied issues are skipped.
async function onImport({ github, context, core }) {
  const { owner, repo } = context.repo;
  const projects = loadProjects();
  await ensureStatusLabels(github, owner, repo);
  const existing = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'all', per_page: 100 });
  const linked = new Set(existing.map((i) => backlogKeyFromTitle(i.title)).filter(Boolean));
  const day = (d) => (d ? d.slice(0, 10) : '');

  for (const [name, p] of Object.entries(projects)) {
    // No parent issue = no way to tell engineering issues from sales ones, so don't copy anything
    if (!p.parentKey) { core.info(`${name} (${p.projectKey}): skipped, no parentKey set`); continue; }
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
      const st = b.status ? b.status.id : STATUS.OPEN;
      if (st === STATUS.CLOSED) await github.rest.issues.update({ owner, repo, issue_number: data.number, state: 'closed' });
      else if (st === STATUS.IN_PROGRESS) await setStatusLabel(github, owner, repo, data, LABEL_IN_PROGRESS);
      else if (st === STATUS.RESOLVED) await setStatusLabel(github, owner, repo, data, LABEL_RESOLVED);
      if (board) await board.setItem(owner, data.node_id, st, day(b.startDate), day(b.dueDate));
      made++;
    }
    core.info(`${name} (${p.projectKey}): ${made} imported, ${items.length - made} already in GitHub`);
  }
}

// ---------- one-time: create the GitHub Projects board and fill it ----------
// Every linked issue goes on the board. Backlog's current status decides the column,
// and open GitHub issues get the matching status label so both sides agree.
async function onSetupBoard({ github, context, core }) {
  const { owner, repo } = context.repo;
  if (!board) throw new Error('Missing secret PROJECT_TOKEN (a classic GitHub token with the "repo" and "project" scopes)');
  await ensureStatusLabels(github, owner, repo);
  const url = await board.setup(owner, context.payload.repository.node_id);
  const all = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: 'all', per_page: 100 });
  let n = 0;
  for (const issue of all) {
    const key = backlogKeyFromTitle(issue.title);
    if (!key || issue.pull_request) continue;
    let b;
    try { b = await backlog('GET', `/issues/${key}`); } catch (e) { core.info(`${key}: not in Backlog, skipped`); continue; }
    const st = b.status.id;
    if (issue.state === 'open') {
      const want = st === STATUS.IN_PROGRESS ? LABEL_IN_PROGRESS : st === STATUS.RESOLVED ? LABEL_RESOLVED : null;
      if (st !== STATUS.CLOSED) await setStatusLabel(github, owner, repo, issue, want);
    }
    const day = (d) => (d ? d.slice(0, 10) : '');
    await board.setItem(owner, issue.node_id, st, readDate(issue.body, 'Start date') || day(b.startDate), readDate(issue.body, 'Due date') || day(b.dueDate));
    n++;
  }
  core.info(`Board ready with ${n} issues: ${url}`);
  core.info('Last step (in the browser): open the board, add a "Board" view and a "Roadmap" view.');
}

module.exports = async function sync(ctx) {
  if (!API_KEY) throw new Error('Missing secret BACKLOG_API_KEY');
  board = makeBoard(ctx);
  const ev = ctx.context.eventName;
  if (ev === 'workflow_dispatch') {
    const mode = (ctx.context.payload.inputs && ctx.context.payload.inputs.mode) || 'import';
    return mode === 'setup-board' ? onSetupBoard(ctx) : onImport(ctx);
  }
  if (ev === 'issues') return onIssue(ctx);
  if (ev === 'push') return onPush(ctx);
};
module.exports._test = { readField, readDate, backlogKeyFromTitle, stripKey, pickProject, desiredStatus };
