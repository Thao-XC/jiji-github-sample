# jiji-github-sample

Engineers work in **GitHub Issues**. Every change reaches **Backlog** within about
20 seconds, so engineering work shows on each project's Backlog Gantt chart next to
sales items (NDAs, quotes, contracts).

日本語の詳しいガイドは「Backlog Gantt Guide」（English / 日本語）を見てください。

---

## Daily use (engineers)

### Create a task

**Issues → New issue → Engineering task**, then fill in:

| Field | What to enter |
| --- | --- |
| Title | What the work is |
| **Project** | Which project it belongs to. Decides which Backlog Gantt it goes to |
| **Parent issue** | Empty = the project's usual group · `none` = a new parent · `#21` or `JIJI-17` = child of that issue |
| **Start date / Due date** | `YYYY-MM-DD`. Without both, there's no bar on the Gantt |

The bot renames the issue to `[JIJI-18] title`. **Never delete that key**: it's the link to Backlog.

### Status: four steps, set with labels

| On GitHub | Backlog status | Gantt bar |
| --- | --- | --- |
| Open, no status label | **Open** (未対応) | Red |
| Label **`in-progress`** | **In Progress** (処理中) | Blue |
| Label **`resolved`** | **Resolved** (処理済み): done, waiting for a check | Teal |
| Issue **closed** | **Closed** (完了) | Green |

- Adding or removing a label changes Backlog both ways (remove `resolved` → back to Open).
- `in-progress` and `resolved` replace each other automatically.
- These also add `in-progress` for you: **assigning** someone, **reopening**, or **pushing a commit** that mentions the issue.
- Merging a pull request that says `Fixes #18` closes the issue → **Closed**.
- Each change leaves a comment in Backlog with **who** did it on GitHub.

### Link your code

- Commit messages: `Add face greeting (#22)` or `JIJI-18 add face greeting`
- Pull request description: `Fixes #22`

### What syncs

| Change in GitHub | Reaches Backlog |
| --- | --- |
| New issue (with Project) | ✅ new issue, dates, parent |
| Title, dates, parent | ✅ |
| Labels / assign / close / reopen | ✅ status |
| Commits mentioning the issue | ✅ comment |
| Details text after creation | ❌ edit in Backlog |

Changes made **in Backlog** do not flow back to GitHub. Edit engineering issues in GitHub.

---

## Watching progress (leads and admins)

**Saved searches** on the Issues tab:

| Want | Search |
| --- | --- |
| Not started | `is:open -label:in-progress -label:resolved` |
| In progress | `is:open label:in-progress` |
| Waiting for a check | `is:open label:resolved` |
| My work | `is:open assignee:@me` |
| One project | `label:mecom` |

**Projects board "Backlog Gantt board"** (Projects tab): columns Todo / In Progress /
Resolved / Done, plus a Roadmap (timeline) view from the start and due dates. The board
**follows the labels**. Change status with labels or by closing the issue, not by dragging
cards: dragging only moves the card on GitHub and does not reach Backlog.

---

## Setup (admin)

### Secrets (Settings → Secrets and variables → Actions)

| Secret | Required | What it is |
| --- | --- | --- |
| `BACKLOG_API_KEY` | Yes | Backlog → your icon → Personal Settings → API → Register. Its owner must be a member of every connected Backlog project. A shared bot user is best. |
| `PROJECT_TOKEN` | For the board | GitHub → your icon → Settings → Developer settings → Personal access tokens → **Tokens (classic)** → Generate. Scopes: **repo** and **project**. |

### Projects (`.github/backlog-projects.json`)

```json
"projects": {
  "mecom":    { "projectKey": "JIJI",       "parentKey": "JIJI-2" },
  "idemitsu": { "projectKey": "TEST_IWATA", "parentKey": "" }
}
```

To add a project: create it in Backlog, add one line here, and add the same name to the
**Project** list in `.github/ISSUE_TEMPLATE/engineering-task.yml`.

- `projectKey`: the Backlog project key (shown next to the project name in Backlog)
- `parentKey`: optional Backlog issue that groups new engineering issues. Empty = top level.

### Run workflow (Actions → Sync to Backlog → Run workflow)

| Mode | What it does |
| --- | --- |
| `import` | Copies Backlog engineering issues (children of `parentKey`) into GitHub. Skips projects with no `parentKey`, so sales items never come over. Safe to run again. |
| `setup-board` | Creates the board "Backlog Gantt board" (needs `PROJECT_TOKEN`), adds every linked issue in its Backlog column, and makes open issues' labels match Backlog. Then in the browser: open the board → **+ New view → Board** and **+ New view → Roadmap** (set dates to Start date / Due date). |

### Files

| File | Purpose |
| --- | --- |
| `.github/workflows/backlog-sync.yml` | When the sync runs, and its settings |
| `.github/scripts/backlog-sync.js` | GitHub → Backlog sync |
| `.github/scripts/board.js` | Projects board |
| `.github/backlog-projects.json` | Project list |
| `.github/ISSUE_TEMPLATE/engineering-task.yml` | The issue form |

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Red ❌ in the Actions tab | Open the run to see the error. Usually the API key is missing or its owner isn't a member of that Backlog project. |
| Bot says "no project chosen" | Add the project label (e.g. `mecom`) to the issue. |
| Bot says the parent is wrong | Edit the issue and fix the **Parent issue** line. Backlog allows one level of parent/child, in the same project. |
| No bar on the Gantt | Add both dates, or move the Gantt's Start Date earlier. |
| Board doesn't update | Check the `PROJECT_TOKEN` secret, then run `setup-board` again. |
