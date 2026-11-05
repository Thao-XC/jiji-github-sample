// ============================================================
// GitHub Projects board, kept in step with the Backlog status.
//
// Columns (a single-select field):  Todo | In Progress | Resolved | Done
//                    Backlog status:  Open | In Progress | Resolved | Closed
// Date fields "Start date" / "Due date" feed the board's Roadmap view.
//
// Needs the secret PROJECT_TOKEN (a classic GitHub token with the "repo" and
// "project" scopes). Without it, everything here is skipped quietly.
// ============================================================

const BOARD_TITLE = process.env.BOARD_TITLE || 'Backlog Gantt board';
const COLUMNS = ['Todo', 'In Progress', 'Resolved', 'Done']; // Backlog status id 1..4
const COLORS = ['GRAY', 'BLUE', 'GREEN', 'PURPLE'];
const START_FIELD = 'Start date';
const DUE_FIELD = 'Due date';

const FIND_QUERY = `query($login: String!) {
  repositoryOwner(login: $login) {
    id
    ... on ProjectV2Owner {
      projectsV2(first: 50) {
        nodes {
          id title number url
          fields(first: 50) {
            nodes {
              ... on ProjectV2Field { id name dataType }
              ... on ProjectV2SingleSelectField { id name dataType options { id name } }
            }
          }
        }
      }
    }
  }
}`;

function makeBoard({ github, getOctokit, core }) {
  const token = process.env.PROJECT_TOKEN;
  if (!token) return null;
  const client = getOctokit ? getOctokit(token) : new github.constructor({ auth: token });
  const gql = (q, v) => client.graphql(q, v);
  let state = null; // { projectId, url, statusField, options, startId, dueId }

  async function find(owner) {
    const r = await gql(FIND_QUERY, { login: owner });
    const nodes = (r.repositoryOwner.projectsV2 && r.repositoryOwner.projectsV2.nodes) || [];
    return { ownerId: r.repositoryOwner.id, project: nodes.find((p) => p && p.title === BOARD_TITLE) };
  }

  function read(project) {
    const fields = project.fields.nodes.filter(Boolean);
    const hasAll = (f) => f.options && COLUMNS.every((c) => f.options.some((o) => o.name === c));
    const statusField = fields.find((f) => f.name === 'Status' && hasAll(f)) || fields.find(hasAll);
    const byName = (n) => (fields.find((f) => f.name === n && f.dataType === 'DATE') || {}).id;
    return {
      projectId: project.id, url: project.url, statusField,
      startId: byName(START_FIELD), dueId: byName(DUE_FIELD),
    };
  }

  async function load(owner) {
    if (state) return state;
    const { project } = await find(owner);
    if (!project) { core.info(`Board "${BOARD_TITLE}" not found: run the workflow with mode "setup-board"`); return null; }
    state = read(project);
    if (!state.statusField) { core.info('Board has no status column with Todo/In Progress/Resolved/Done'); state = null; }
    return state;
  }

  // Put an issue on the board and set its column and dates. statusId null = leave column as is.
  async function setItem(owner, issueNodeId, statusId, startDate, dueDate) {
    const s = await load(owner);
    if (!s) return;
    const add = await gql(`mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input: {projectId: $p, contentId: $c}) { item { id } } }`,
      { p: s.projectId, c: issueNodeId });
    const itemId = add.addProjectV2ItemById.item.id;
    const set = (fieldId, value) => gql(`mutation($p: ID!, $i: ID!, $f: ID!, $v: ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input: {projectId: $p, itemId: $i, fieldId: $f, value: $v}) { projectV2Item { id } } }`,
      { p: s.projectId, i: itemId, f: fieldId, v: value });
    if (statusId) {
      const opt = s.statusField.options.find((o) => o.name === COLUMNS[statusId - 1]);
      if (opt) await set(s.statusField.id, { singleSelectOptionId: opt.id });
    }
    if (startDate && s.startId) await set(s.startId, { date: startDate });
    if (dueDate && s.dueId) await set(s.dueId, { date: dueDate });
  }

  // One-time: create the board (linked to the repo), its 4 columns and the 2 date fields.
  async function setup(owner, repositoryId) {
    let { ownerId, project } = await find(owner);
    if (!project) {
      await gql(`mutation($o: ID!, $t: String!, $r: ID!) { createProjectV2(input: {ownerId: $o, title: $t, repositoryId: $r}) { projectV2 { id } } }`,
        { o: ownerId, t: BOARD_TITLE, r: repositoryId });
      core.info(`Created board "${BOARD_TITLE}"`);
      ({ project } = await find(owner));
    }
    let s = read(project);
    if (!s.statusField) {
      const options = COLUMNS.map((name, i) => ({ name, color: COLORS[i], description: `Backlog: ${['Open', 'In Progress', 'Resolved', 'Closed'][i]}` }));
      const builtIn = project.fields.nodes.find((f) => f && f.name === 'Status' && f.options);
      try {
        if (!builtIn) throw new Error('no built-in Status field');
        await gql(`mutation($f: ID!, $o: [ProjectV2SingleSelectFieldOptionInput!]) {
          updateProjectV2Field(input: {fieldId: $f, singleSelectOptions: $o}) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`,
          { f: builtIn.id, o: options });
        core.info('Status column set to Todo / In Progress / Resolved / Done');
      } catch (e) {
        core.info(`Could not change the built-in Status field (${e.message}); adding "Backlog status" instead`);
        await gql(`mutation($p: ID!, $o: [ProjectV2SingleSelectFieldOptionInput!]) {
          createProjectV2Field(input: {projectId: $p, dataType: SINGLE_SELECT, name: "Backlog status", singleSelectOptions: $o}) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`,
          { p: project.id, o: options });
      }
    }
    for (const name of [START_FIELD, DUE_FIELD]) {
      if (project.fields.nodes.some((f) => f && f.name === name && f.dataType === 'DATE')) continue;
      await gql(`mutation($p: ID!, $n: String!) { createProjectV2Field(input: {projectId: $p, dataType: DATE, name: $n}) { projectV2Field { ... on ProjectV2Field { id } } } }`,
        { p: project.id, n: name });
      core.info(`Added date field "${name}"`);
    }
    ({ project } = await find(owner));
    state = read(project);
    return state.url;
  }

  return { setItem, setup, load };
}

module.exports = { makeBoard, COLUMNS, BOARD_TITLE };
