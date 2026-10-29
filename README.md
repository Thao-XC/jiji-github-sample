# jiji-github-sample

Engineers manage their work as **GitHub Issues**. Everything stays in sync with the
Backlog project テスト_メコムjiji (key `JIJI`), so engineering work shows on the same
Backlog Gantt chart as sales items like the NDA.

| In GitHub | What happens in Backlog |
| --- | --- |
| Click **Run workflow** (once) | Backlog engineering issues (children of `JIJI-2`) are copied into GitHub Issues as `[JIJI-10] 声と画面の結合確認…` |
| Push a commit that mentions `#1` or `JIJI-10` | Commit posted as a comment on JIJI-10; Open → **In Progress** |
| Close GitHub issue #1 | JIJI-10 → **Closed** |
| Reopen it | JIJI-10 → **In Progress** |
| Edit the dates in the issue | JIJI-10's Start / Due Date change on the Gantt |
| New issue with the "Engineering task" form | New Backlog issue under JIJI-2, with its dates |

The NDA (`JIJI-1`) is not copied. It isn't under the engineering parent, so it stays sales-only.

## Setup (once, about 10 minutes)

1. **Backlog API key:** Backlog → profile icon → Personal Settings → API → Register → copy.
2. **GitHub repo:** github.com → New repository → `jiji-github-sample`, **Private**,
   leave "Add a README" unticked → Create.
3. **Secret:** repo → Settings → Secrets and variables → Actions → New repository secret.
   Name `BACKLOG_API_KEY`, value = the key.
4. **Check the parent key:** in Backlog, find the key of the issue
   `jiji受付アバター開発 / jiji avatar development`. If it isn't `JIJI-2`, change
   `BACKLOG_PARENT_KEY` in `.github/workflows/backlog-sync.yml`.
5. **Upload the files.** In a terminal inside this folder (replace YOUR-ORG):

```bash
git init
git add .
git commit -m "add Backlog sync"
git branch -M main
git remote add origin https://github.com/YOUR-ORG/jiji-github-sample.git
git push -u origin main
```

## Import the Backlog engineering issues into GitHub

6. GitHub repo → **Actions** → **Sync to Backlog** (left list) → **Run workflow** → **Run workflow**.
7. Open the **Issues** tab. You should see the 11 engineering issues, e.g.
   `[JIJI-10] 声と画面の結合確認 / Voice + screen`.

Safe to run again later: issues already in GitHub are skipped.

## Try it

Change a line in `src/greeting.js`, then (use a real issue number from your Issues tab):

```bash
git add .
git commit -m "join voice and screen output (#1)"
git push
```

- GitHub → Actions: green tick
- Backlog → that issue: new comment, status **In Progress**
- GitHub → close issue #1 → Backlog status **Closed**, and the bar color changes on the Gantt

Tip: `Fixes #1` in a commit message pushed to `main` closes GitHub issue #1 automatically,
which then closes the Backlog issue too.
