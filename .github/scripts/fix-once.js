// ============================================================
// ONE-TIME clean-up of the Mecom schedule in Backlog JIJI. Delete afterwards.
//  1. Mecom rows are regrouped: 営業・打ち合わせ / Sales & meetings, デモ / Demo,
//     Phase 1 開発 / Phase 1 development, 記者発表 準備・本番 / Press event
//  2. Mecom rows whose due date has passed -> Closed
//  3. Phase 2 キックオフ -> stays Open, dates cleared (no deadline yet)
//  4. Every other issue (copied from the 出光 project by mistake) ->
//     renamed "【対象外・出光】…", dates cleared (off the Gantt chart), Closed
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

const SALES = '営業・打ち合わせ / Sales & meetings';
const DEMO = 'デモ / Demo';
const DEV = 'Phase 1 開発 / Phase 1 development';
const PRESS = '記者発表 準備・本番 / Press event';
const KICKOFF = 'Phase 2 キックオフ / Phase 2 kick-off';
const NEW_PARENTS = { [SALES]: ['2026-08-10', '2026-10-02'], [DEMO]: ['2026-09-07', '2026-09-15'] };
// Mecom rows -> the parent they belong under
const MECOM = {
  'NDA締結 / NDA signing': SALES,
  '構想のご説明 / Concept meeting': SALES,
  '進捗ご報告 / Progress report': SALES,
  'ノートPCに導入 / Install on laptop': DEMO,
  'デモ実施 / Demo at MECOM HQ': DEMO,
  '振り返り・7項目の改善・設計 / Review, 7 fixes, design': DEV,
  '会話・画面・声・貴社の情報の開発 / Development': DEV,
  'Fold Idemitsu lane into 1.1': DEV,
  'Audio-check logic': DEV,
  'jiji 1.1 tag & macOS installer': DEV,
  'Voice: natural and fast voice synthesis': DEV,
  'Hearing: mic, proper nouns, short words': DEV,
  'Visual UI (conversation & media screen)': DEV,
  'Full build on laptop / graph data': DEV,
  'Windows 1.1 install & soak test': DEV,
  'Media list files: shared drive upload': PRESS,
  'デモPCへの統合 / Demo laptop integration': PRESS,
  '顧客情報の準備・声の選定 / Data, voice': PRESS,
  '声と画面の結合確認・社内リハーサル / Voice + screen, internal rehearsal': PRESS,
  '通しリハーサル・機能凍結 / Full dress rehearsal & feature freeze': PRESS,
  '移動・予備日 / Travel, on-site backup': PRESS,
  'Final presentation / Phase 1 最終報告・記者発表（午前）': PRESS,
};
const day = (d) => (d ? d.slice(0, 10) : '');

module.exports = async function fix({ context, core }) {
  const apply = ((context.payload.inputs && context.payload.inputs.confirm) || '').trim() === 'APPLY';
  const log = (s) => core.info((apply ? '' : 'would ') + s);
  core.info(apply ? '*** APPLYING ***' : '*** DRY RUN: nothing will change ***');
  const today = new Date().toISOString().slice(0, 10);
  const project = await backlog('GET', '/projects/JIJI');
  const types = await backlog('GET', '/projects/JIJI/issueTypes');
  const type = types.find((t) => t.name === 'Task') || types[0];
  const all = [];
  for (let offset = 0; ; offset += 100) {
    const page = await backlog('GET', '/issues', [['projectId[]', project.id], ['count', 100], ['offset', offset]]);
    all.push(...page); if (page.length < 100) break;
  }
  const find = (s) => all.find((i) => i.summary === s);
  const missing = Object.keys(MECOM).filter((s) => !find(s));
  if (missing.length) throw new Error(`Not found in JIJI, stopping: ${missing.join(' | ')}`);

  // 1. parents
  const parents = {};
  for (const name of [SALES, DEMO, DEV, PRESS]) {
    let p = find(name);
    if (!p) {
      const [s, d] = NEW_PARENTS[name];
      log(`create parent "${name}" ${s} → ${d}`);
      p = apply ? await backlog('POST', '/issues', [['projectId', project.id], ['summary', name], ['issueTypeId', type.id], ['priorityId', 3], ['startDate', s], ['dueDate', d]])
        : { id: 0, issueKey: '(new)', summary: name, dueDate: d, status: { id: 1 } };
    }
    parents[name] = p;
  }
  // 1+2. Mecom rows: right parent, Closed when past due
  for (const [s, parentName] of Object.entries(MECOM)) {
    const i = find(s); const p = parents[parentName];
    const params = [];
    if (i.parentIssueId !== p.id) params.push(['parentIssueId', p.id]);
    if (day(i.dueDate) < today && i.status.id !== 4) params.push(['statusId', 4]);
    if (!params.length) continue;
    log(`${i.issueKey}  ${s}  ->  ${params.map(([k]) => (k === 'statusId' ? 'Closed' : `under "${parentName}"`)).join(', ')}`);
    if (apply) await backlog('PATCH', `/issues/${i.issueKey}`, params);
  }
  for (const p of Object.values(parents)) {
    if (day(p.dueDate) < today && p.status.id !== 4) {
      log(`${p.issueKey}  ${p.summary}  ->  Closed`);
      if (apply) await backlog('PATCH', `/issues/${p.issueKey}`, [['statusId', 4]]);
    }
  }
  // 3. Phase 2 kick-off
  const k = find(KICKOFF);
  if (k) {
    log(`${k.issueKey}  ${k.summary}  ->  Open, dates cleared`);
    if (apply) await backlog('PATCH', `/issues/${k.issueKey}`, [['startDate', ''], ['dueDate', ''], ['statusId', 1]]);
  }
  // 4. everything else = copied from the 出光 project
  const keep = new Set([...Object.keys(MECOM), SALES, DEMO, DEV, PRESS, KICKOFF]);
  const others = all.filter((i) => !keep.has(i.summary) && !i.summary.startsWith('【対象外'));
  for (const i of others) {
    log(`${i.issueKey}  ${i.summary}  ->  "【対象外・出光】${i.summary}", dates cleared, Closed`);
    if (apply) {
      await backlog('PATCH', `/issues/${i.issueKey}`, [['summary', `【対象外・出光】${i.summary}`], ['startDate', ''], ['dueDate', ''], ['statusId', 4]]);
      const after = await backlog('GET', `/issues/${i.issueKey}`);
      if (after.dueDate || after.startDate) core.warning(`${i.issueKey}: Backlog kept its dates`);
    }
  }
  core.summary.addHeading(apply ? 'Clean-up done' : 'Dry run: nothing changed')
    .addRaw(`${Object.keys(MECOM).length} Mecom rows regrouped/closed, ${others.length} rows from the 出光 project taken off the Gantt.`).write();
};
