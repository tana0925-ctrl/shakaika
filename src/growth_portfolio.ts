// ========== 個人ポートフォリオ（学びの記録）・年度末の成長レポート ==========
// 見られるのは本人と管理者だけ。点数・順位・「この視点が良い」という評価は出さない。
// 問いは本人の記述・記録からテンプレートで作る（推測で補わない）。
import {
  GV_CANON, GV_ADMIN_CSS, fyRange, fyOfDate, currentFY, splitChoices, questionKind,
  loadAliases, canonOf, canonOrder, gvEsc
} from './growth_common'

type Deps = {
  authMiddleware: any
  adminMiddleware: any
  commonHead: string
  stepKeywords?: Record<string, string[]>
  report?: boolean
}

const RECALL_LABEL: Record<string, string> = { tried: 'やってみた', a_little: 'ちょっとだけ', not_yet: 'まだ', changed: '考えが変わった' }
const KEPT_MAX = 300

function cut(s: any, n: number): string {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
function md(ds: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(ds || '')
  return m ? (+m[1]) + '月' + (+m[2]) + '日' : ds
}
function ownGroups(st: string): string[] {
  if (st === 'junior_high') return ['共通', '中学校']
  if (st === 'admin_staff') return ['主幹・管理職']
  return ['共通']
}

// ---- 1人分の記録を集める ----
export async function buildPortfolio(db: D1Database, uid: number, fyParam: string | null, withKept: boolean, stepKeywords?: Record<string, string[]>) {
  const u = await db.prepare('SELECT id, name, school, school_type, role FROM users WHERE id = ?').bind(uid).first() as any
  if (!u) return null
  const all = fyParam === 'all'
  const fy = all ? currentFY() : (parseInt(String(fyParam || ''), 10) || currentFY())
  const [start, end] = all ? ['0000-01-01', '9999-12-31'] : fyRange(fy)
  const am = await loadAliases(db)

  const { results: evRows } = await db.prepare(
    `SELECT e.id, e.title, e.event_date, a.attended_at FROM attendances a JOIN events e ON e.id = a.event_id
     WHERE a.user_id = ? AND e.event_date >= ? AND e.event_date <= ? ORDER BY e.event_date, e.id`
  ).bind(uid, start, end).all() as any
  const { results: qa } = await db.prepare(
    `SELECT ca.event_id, ca.question_id, ca.answer_text, q.question_text, q.question_type, q.sort_order
     FROM custom_answers ca JOIN survey_questions q ON q.id = ca.question_id JOIN events e ON e.id = ca.event_id
     WHERE ca.user_id = ? AND e.event_date >= ? AND e.event_date <= ? ORDER BY e.event_date, q.sort_order`
  ).bind(uid, start, end).all() as any
  let recalls: any[] = []
  try {
    const r = await db.prepare(
      `SELECT r.event_id, r.status, r.note, r.source_answer_text, se.title AS source_title, se.event_date AS source_date
       FROM recall_reflections r JOIN events e ON e.id = r.event_id LEFT JOIN events se ON se.id = r.source_event_id
       WHERE r.user_id = ? AND e.event_date >= ? AND e.event_date <= ?`
    ).bind(uid, start, end).all() as any
    recalls = r.results || []
  } catch (e) { recalls = [] }

  const events: any[] = []
  const byId: Record<number, any> = {}
  for (const e of (evRows || [])) {
    const o = { id: e.id, title: e.title, date: e.event_date, growth: [] as string[], growth_raw: [] as string[], answered: false, texts: [] as any[], recall: null as any }
    events.push(o); byId[e.id] = o
  }
  for (const a of (qa || [])) {
    const ev = byId[a.event_id]; if (!ev) continue
    const txt = String(a.answer_text || '').trim()
    if (!txt) continue
    ev.answered = true
    const kind = questionKind(a)
    if (kind === 'growth') {
      for (const raw of splitChoices(txt)) {
        ev.growth_raw.push(raw)
        const cn = canonOf(raw, am)
        if (cn && ev.growth.indexOf(cn) < 0) ev.growth.push(cn)
      }
    } else if (kind === 'choice') {
      ev.texts.push({ kind, q: a.question_text, qid: a.question_id, text: txt })
    } else {
      ev.texts.push({ kind, q: a.question_text, qid: a.question_id, text: txt.slice(0, 2000) })
    }
  }
  for (const r of recalls) {
    const ev = byId[r.event_id]; if (!ev) continue
    ev.recall = { status: r.status, label: r.status ? RECALL_LABEL[r.status] : '', note: r.note || '', source_text: r.source_answer_text || '', source_title: r.source_title || '', source_date: r.source_date || '' }
  }

  // 視点の回数（研修会ごとに1回）
  const counts: Record<string, number> = {}
  let growthEvents = 0
  for (const ev of events) { if (ev.growth.length) growthEvents++; for (const cn of ev.growth) counts[cn] = (counts[cn] || 0) + 1 }

  // 道しるべ（STEP表）：本人が選んだ現在地
  const { results: sel } = await db.prepare('SELECT viewpoint, step, memo FROM selections WHERE user_id = ?').bind(uid).all() as any
  const selBy: Record<string, any> = {}
  for (const s of (sel || [])) selBy[s.viewpoint] = s
  const groups = ownGroups(u.school_type)
  const rubric: any[] = []
  for (const cd of GV_CANON) {
    const mine = groups.indexOf(cd.group) >= 0
    if (!mine && !counts[cd.name]) continue
    let step: any = null
    const keys = cd.keys.filter((k) => (u.school_type === 'junior_high') === k.startsWith('j_'))
    for (const k of keys) {
      const s = selBy[k]
      if (s) { step = { key: k, step: s.step, memo: s.memo || '', keyword: stepKeywords && stepKeywords[k] ? (stepKeywords[k][s.step - 1] || '') : '' }; break }
    }
    rubric.push({ name: cd.name, group: cd.group, count: counts[cd.name] || 0, step })
  }

  const noteFy = all ? currentFY() : fy
  const note = await db.prepare('SELECT goal, reflection FROM annual_notes WHERE user_id = ? AND fiscal_year = ?').bind(uid, noteFy).first() as any

  let kept: any[] = []
  if (withKept) {
    try {
      const r = await db.prepare(
        `SELECT k.id, k.event_id, k.question_id, k.body, e.title, e.event_date FROM kept_words k LEFT JOIN events e ON e.id = k.event_id
         WHERE k.user_id = ? AND (e.event_date IS NULL OR (e.event_date >= ? AND e.event_date <= ?)) ORDER BY e.event_date, k.id`
      ).bind(uid, start, end).all() as any
      kept = r.results || []
    } catch (e) { kept = [] }
  }

  // 年度の一覧（選べる年度）
  const { results: fyr } = await db.prepare('SELECT DISTINCT e.event_date d FROM attendances a JOIN events e ON e.id = a.event_id WHERE a.user_id = ?').bind(uid).all() as any
  const fys: number[] = [currentFY()]
  for (const r of (fyr || [])) { const f = fyOfDate(r.d); if (f && fys.indexOf(f) < 0) fys.push(f) }
  fys.sort()

  return {
    user: { id: u.id, name: u.name, school: u.school || '', school_type: u.school_type || '' },
    fy: all ? 'all' : fy, fys, note_fy: noteFy,
    canon: canonOrder(am), counts, growth_events: growthEvents,
    events, rubric,
    annual: { goal: note?.goal || '', reflection: note?.reflection || '' },
    kept,
    prompts: makePrompts(events, counts, rubric, note, recalls),
    next_prompts: makeNextYearPrompts(events, counts, rubric, note, kept, groups)
  }
}

// ---- 次の目標を考えるための問い（本人の記録からテンプレートで作る） ----
function makePrompts(events: any[], counts: Record<string, number>, rubric: any[], note: any, recalls: any[]): string[] {
  const P: string[] = []
  const g = events.filter((e) => e.growth.length)
  // 最近よく選んでいる視点（直近3回で2回以上）
  const recent = g.slice(-3)
  const rc: Record<string, number> = {}
  for (const e of recent) for (const cn of e.growth) rc[cn] = (rc[cn] || 0) + 1
  const top = Object.keys(rc).filter((k) => rc[k] >= 2).sort((a, b) => rc[b] - rc[a])
  if (top.length) {
    P.push('最近よく選んでいる視点は「' + top[0] + '」ですね（直近' + recent.length + '回のうち' + rc[top[0]] + '回）。次はどんな場面で試してみますか？')
    const rb = rubric.find((r) => r.name === top[0] && r.step)
    if (rb) P.push('成長の道しるべでは、「' + rb.name + '」を今「STEP' + rb.step.step + (rb.step.keyword ? '：' + rb.step.keyword : '') + '」にしています。研修で選んだことと、つながっているところはありますか？')
  }
  // はじめて選んだ視点（3回目以降の最新回で）
  if (g.length >= 3) {
    const last = g[g.length - 1]
    const before = new Set<string>()
    for (const e of g.slice(0, -1)) for (const cn of e.growth) before.add(cn)
    const fresh = last.growth.filter((cn: string) => !before.has(cn))
    if (fresh.length) P.push(md(last.date) + 'の研修会で、はじめて「' + fresh[0] + '」を選んでいます。どんなことがきっかけでしたか？')
  }
  // 前回の学びカードの記録 → なければ最新の「試してみたいこと」
  const withRecall = events.filter((e) => e.recall && (e.recall.status || e.recall.note))
  const lastRecall = withRecall.length ? withRecall[withRecall.length - 1].recall : null
  const lastTryEv = [...events].reverse().find((e) => e.texts.some((t: any) => t.kind === 'try'))
  const lastTry = lastTryEv ? lastTryEv.texts.find((t: any) => t.kind === 'try').text : ''
  if (lastRecall && lastRecall.status && lastRecall.source_text) {
    const s = cut(lastRecall.source_text, 40)
    if (lastRecall.status === 'tried') P.push('「' + s + '」を「やってみた」と記録しています。次に、少し変えてみたいところはありますか？')
    else if (lastRecall.status === 'a_little') P.push('「' + s + '」を「ちょっとだけ」試したと記録しています。続けるとしたら、どの場面がよさそうですか？')
    else if (lastRecall.status === 'not_yet') P.push('「' + s + '」は「まだ」と記録しています。試せそうな場面はありそうですか？')
    else if (lastRecall.status === 'changed') P.push('「' + s + '」について「考えが変わった」と記録しています。今は、どのように考えていますか？')
  }
  if (lastTry && (!lastRecall || !lastRecall.source_text || cut(lastRecall.source_text, 40) !== cut(lastTry, 40))) {
    P.push(md(lastTryEv.date) + 'に「' + cut(lastTry, 40) + '」と書いていました。その後、試せた場面はありましたか？')
  }
  if (note && String(note.goal || '').trim()) P.push('今年度の目標は「' + cut(note.goal, 40) + '」でした。ここまでの研修で、目標に近づいたと感じた場面はありましたか？')
  if (!P.length) P.push('これまでの研修会で、いちばん心に残っている場面はどれですか？')
  return P.slice(0, 5)
}

function makeNextYearPrompts(events: any[], counts: Record<string, number>, rubric: any[], note: any, kept: any[], groups: string[]): string[] {
  const P: string[] = []
  const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a])
  if (names.length) {
    const topN = counts[names[0]]
    const ties = names.filter((n) => counts[n] === topN)
    if (ties.length === 1 && topN >= 2) P.push('この1年でいちばん多く選んだ視点は「' + names[0] + '」でした（' + topN + '回）。来年度、この視点でどんなことに挑戦してみたいですか？')
    else P.push('この1年で選んだ視点には、' + names.slice(0, 4).map((n) => '「' + n + '」').join('') + 'がありました。来年度、どの視点でどんなことに挑戦してみたいですか？')
  }
  const zero = GV_CANON.filter((c) => groups.indexOf(c.group) >= 0 && !counts[c.name]).map((c) => c.name)
  if (names.length && zero.length) P.push('今年度はまだ選んでいない視点（' + zero.slice(0, 3).map((z) => '「' + z + '」').join('') + 'など）もあります。来年度、のぞいてみたいものはありますか？')
  const goal = note && String(note.goal || '').trim(), refl = note && String(note.reflection || '').trim()
  if (goal && refl) P.push('年度初めの目標「' + cut(goal, 40) + '」と、年度末の振り返りを読み比べてみて、来年度の目標にしたいことは何ですか？')
  else if (goal) P.push('年度初めの目標は「' + cut(goal, 40) + '」でした。1年をふり返って、来年度も続けたいこと・変えたいことは何ですか？')
  if (kept.length) P.push('残した言葉「' + cut(kept[kept.length - 1].body, 40) + '」は、来年度のどんな場面で生かせそうですか？')
  const tried = events.filter((e) => e.recall && (e.recall.status === 'tried' || e.recall.status === 'a_little')).length
  if (tried) P.push('前回の学びカードで「やってみた／ちょっとだけ」と記録した回が' + tried + '回ありました。来年度も続けたい実践はどれですか？')
  if (!P.length) P.push('来年度、研修会でどんなことを学んでみたいですか？')
  return P.slice(0, 5)
}

export function registerPortfolio(app: any, deps: Deps) {
  const { authMiddleware, adminMiddleware, commonHead } = deps
  const withReport = !!deps.report

  app.get('/api/me/portfolio', authMiddleware, async (c: any) => {
    const me = c.get('user')
    const d = await buildPortfolio(c.env.DB, me.id, c.req.query('fy') || null, withReport, deps.stepKeywords)
    if (!d) return c.json({ error: '見つかりません' }, 404)
    return c.json(d)
  })
  app.get('/api/admin/portfolio/:uid', authMiddleware, adminMiddleware, async (c: any) => {
    const uid = parseInt(c.req.param('uid'), 10)
    if (!uid) return c.json({ error: '不正なIDです' }, 400)
    const d = await buildPortfolio(c.env.DB, uid, c.req.query('fy') || null, withReport, deps.stepKeywords)
    if (!d) return c.json({ error: '会員が見つかりません' }, 404)
    return c.json(d)
  })

  app.get('/mypage/portfolio', (c: any) => c.html(portfolioPage(commonHead, false, withReport)))
  app.get('/admin/portfolio', (c: any) => c.html(portfolioPage(commonHead, true, withReport)))

  if (!withReport) return

  // ---- 印象に残った言葉（本人が自分の記述から選んで残す） ----
  app.post('/api/me/kept-words', authMiddleware, async (c: any) => {
    const db = c.env.DB as D1Database
    const me = c.get('user')
    let body: any = {}
    try { body = await c.req.json() } catch (e) { return c.json({ error: '入力が不正です' }, 400) }
    const eventId = parseInt(String(body.event_id || ''), 10)
    const qid = parseInt(String(body.question_id || ''), 10)
    const text = typeof body.body === 'string' ? body.body.trim() : ''
    if (!eventId || !qid) return c.json({ error: '入力が不正です' }, 400)
    if (!text) return c.json({ error: '言葉が空です' }, 400)
    if (text.length > KEPT_MAX) return c.json({ error: KEPT_MAX + '文字以内にしてください' }, 400)
    const ans = await db.prepare("SELECT id FROM custom_answers WHERE user_id = ? AND event_id = ? AND question_id = ? AND trim(COALESCE(answer_text,'')) <> ''").bind(me.id, eventId, qid).first()
    if (!ans) return c.json({ error: '自分の回答が見つかりません' }, 404)
    const cnt = await db.prepare('SELECT COUNT(*) n FROM kept_words WHERE user_id = ?').bind(me.id).first() as any
    if (cnt && cnt.n >= 200) return c.json({ error: '残せる言葉は200個までです' }, 400)
    await db.prepare("INSERT INTO kept_words (user_id, event_id, question_id, body, created_at, updated_at) VALUES (?,?,?,?,datetime('now'),datetime('now')) ON CONFLICT(user_id, event_id, question_id) DO UPDATE SET body = excluded.body, updated_at = datetime('now')").bind(me.id, eventId, qid, text).run()
    return c.json({ success: true })
  })
  app.delete('/api/me/kept-words/:id', authMiddleware, async (c: any) => {
    const me = c.get('user')
    const id = parseInt(c.req.param('id'), 10)
    if (!id) return c.json({ error: '不正なIDです' }, 400)
    await c.env.DB.prepare('DELETE FROM kept_words WHERE id = ? AND user_id = ?').bind(id, me.id).run()
    return c.json({ success: true })
  })

  app.get('/mypage/report', (c: any) => c.html(reportPage(commonHead, false)))
  app.get('/admin/report', (c: any) => c.html(reportPage(commonHead, true)))
}

// ---------------- 画面 ----------------
const MEMBER_CSS = `
.top-bar { background: #fff; border-bottom: 3px solid var(--header-line); padding: 10px 16px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; gap: 8px; }
.top-bar .logo { font-family: 'Zen Maru Gothic', sans-serif; color: var(--header-line); font-size: 17px; font-weight: 700; }
.top-bar.adm { background:#1a237e; border-bottom-color:#1a237e; }
.top-bar.adm .logo { color:#fff; }
.back { padding: 7px 14px; border-radius: 8px; background: #fff3e0; color: #e65100; font-size: 13px; font-weight: 700; text-decoration: none; white-space: nowrap; }
.wrap { max-width: 760px; margin: 16px auto 50px; padding: 0 14px; }
.card { background: #fff; border: 2px solid #f0e6d2; border-radius: 14px; padding: 14px 16px; margin-bottom: 16px; box-shadow: 0 2px 10px rgba(0,0,0,0.04); }
.card h2 { font-family: 'Zen Maru Gothic', sans-serif; font-size: 16px; color: #5d4037; margin: 0 0 10px; display:flex; align-items:center; gap:8px; flex-wrap:wrap }
.lead { font-size: 12px; color: #8d6e63; line-height: 1.7; }
.who { font-size: 13px; color: #6d4c41; margin-bottom: 8px; }
select { font-family: inherit; font-size: 14px; padding: 6px 10px; border: 2px solid #e0d6c8; border-radius: 8px; background: #fff; }
.prompts { margin: 0; padding: 0; list-style: none; }
.prompts li { background: #fff8e1; border-left: 4px solid #ffb300; border-radius: 0 10px 10px 0; padding: 10px 12px; margin-bottom: 8px; font-size: 14px; line-height: 1.7; color: #4e342e; }
.cnt-row { display:flex; align-items:center; gap:8px; margin:6px 0; font-size:13px }
.cnt-row .nm { width: 7.5em; flex:none; color:#5d4037; font-weight:700 }
.cnt-row .bar { height: 12px; background: #ffcc80; border-radius: 6px; min-width: 2px }
.cnt-row .n { color:#8d6e63; font-size:12px; white-space:nowrap }
.mx-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin-top: 10px }
table.mx { border-collapse: collapse; font-size: 12px }
table.mx th, table.mx td { border: 1px solid #f0e6d2; padding: 4px 6px; text-align: center; white-space: nowrap }
table.mx th.vp { text-align: left; background: #fffaf0; color:#5d4037; position: sticky; left: 0 }
table.mx th.d { font-weight: 400; color: #8d6e63; font-size: 11px; writing-mode: horizontal-tb }
.dot { display:inline-block; width:12px; height:12px; border-radius:50%; background:#ef6c00 }
table.rb { border-collapse: collapse; width: 100%; font-size: 13px }
table.rb th, table.rb td { border-bottom: 1px solid #f0e6d2; padding: 7px 6px; text-align: left; vertical-align: top }
table.rb td:first-child { white-space:nowrap }
table.rb th { color: #8d6e63; font-size: 11px; font-weight: 700 }
.stp { display:inline-block; font-size: 11px; padding: 1px 8px; border-radius: 10px; font-weight: 700; background:#e3f2fd; color:#1565c0 }
.ev { border: 2px solid #f0e6d2; border-radius: 12px; padding: 12px 12px 6px; margin-bottom: 12px; background:#fff }
.ev-head { display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:baseline; border-bottom: 2px dashed #ffe0b2; padding-bottom: 6px; margin-bottom: 8px }
.ev-title { font-family: 'Zen Maru Gothic', sans-serif; font-weight:700; color:#e65100; font-size: 15px }
.ev-date { font-size: 12px; color:#999 }
.chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom: 8px }
.chip { font-size: 12px; padding: 2px 10px; border-radius: 12px; background:#fff3e0; color:#e65100; font-weight:700; border:1px solid #ffcc80 }
.qa { margin-bottom: 8px }
.qa .q { font-size: 11px; color: #9e9e9e }
.qa .a { font-size: 14px; color:#333; line-height:1.7; white-space: pre-wrap; word-break: break-word }
.keep { border:none; background:none; color:#bdbdbd; cursor:pointer; font-size:15px; padding:0 4px; vertical-align:middle }
.keep.on { color:#ffb300 }
.rc { background:#f3f8ff; border-radius: 10px; padding: 8px 10px; margin-bottom: 8px; font-size: 13px; color:#37474f; line-height:1.6 }
.rc b { color:#1565c0 }
.muted { color:#aaa; font-size: 12px }
.msg { text-align:center; color:#888; padding: 40px 10px; font-size: 14px; line-height:1.8 }
.btnrow { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px }
.btn { padding: 9px 16px; border-radius: 10px; border: none; font-size: 13px; font-weight: 700; cursor: pointer; font-family: inherit; text-decoration:none; display:inline-flex; align-items:center; gap:6px }
.btn-o { background:#e65100; color:#fff }
.btn-g { background:#eee; color:#555 }
.modal { display:none; position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:300; align-items:center; justify-content:center; padding:12px }
.modal.show { display:flex }
.modal .box { background:#fff; border-radius:14px; max-width:520px; width:100%; padding:16px }
.modal textarea { width:100%; min-height:110px; font-size:14px; font-family:inherit; border:2px solid #e0d6c8; border-radius:8px; padding:8px }
.kw { background:#fffde7; border-left:4px solid #ffb300; border-radius:0 10px 10px 0; padding:8px 10px; margin-bottom:8px; font-size:14px; line-height:1.7 }
.kw .src { font-size:11px; color:#999 }
.kw .del { float:right; border:none; background:none; color:#bbb; cursor:pointer }
`

function guardJs(isAdmin: boolean, back: string): string {
  return `
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');
const IS_ADMIN_VIEW = ${isAdmin ? 'true' : 'false'};
const params = new URLSearchParams(location.search);
const UID = params.get('uid');
if (!token) { window.location.href = '/login?redirect=' + encodeURIComponent('${back}'); throw new Error('redirect'); }
if (IS_ADMIN_VIEW && (!user || user.role !== 'admin' || !UID)) { window.location.href = '/admin'; throw new Error('redirect'); }
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
function md(ds) { const m = /^\\d{4}-(\\d{2})-(\\d{2})/.exec(ds || ''); return m ? (+m[1]) + '/' + (+m[2]) : (ds || ''); }
async function api(path, opt) {
  opt = opt || {};
  opt.headers = Object.assign({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, opt.headers || {});
  const r = await fetch(path, opt);
  if (r.status === 401) { localStorage.removeItem('token'); window.location.href = '/login'; throw new Error('auth'); }
  let d = null; try { d = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((d && d.error) || ('エラー (' + r.status + ')'));
  return d;
}
function dataUrl(fy) { return (IS_ADMIN_VIEW ? '/api/admin/portfolio/' + encodeURIComponent(UID) : '/api/me/portfolio') + (fy ? '?fy=' + encodeURIComponent(fy) : ''); }
const KL = { reason:'選んだ理由', try:'試してみたいこと', impression:'感想・学び', other:'', choice:'' };
`
}

function portfolioPage(commonHead: string, isAdmin: boolean, withReport: boolean): string {
  return `<!DOCTYPE html><html lang="ja"><head>${commonHead}
<meta name="robots" content="noindex, nofollow">
<title>学びの記録（ポートフォリオ） - 社会科同好会</title>
<style>${MEMBER_CSS}</style>
</head><body>
<div class="top-bar${isAdmin ? ' adm' : ''}">
  <div class="logo"><i class="fas fa-seedling"></i> ${isAdmin ? '学びの記録（管理者として閲覧）' : 'わたしの学びの記録'}</div>
  ${isAdmin ? '<a class="back" href="/admin"><i class="fas fa-arrow-left"></i> 管理画面</a>' : '<a class="back" href="/mypage"><i class="fas fa-arrow-left"></i> マイページ</a>'}
</div>
<div class="wrap">
  <div class="card">
    <div class="who" id="who"></div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <select id="fySel" aria-label="年度"></select>
      ${withReport ? '<a class="btn btn-g" id="reportLink" href="#"><i class="fas fa-file-alt"></i> 年度末の成長レポート</a>' : ''}
      ${isAdmin ? '<a class="btn btn-g" id="sheetLink" href="#" target="_blank" rel="noopener" title="A4縦1枚の個人まとめシート（管理者用）"><i class="fas fa-id-card"></i> 1枚シート</a>' : ''}
    </div>
    <div class="lead" style="margin-top:8px">参加した研修会と、アンケートに書いたこと・選んだ視点を、時間の流れでまとめています。${isAdmin ? '本人と管理者だけが見られます。' : 'このページは、あなたと運営（管理者）だけが見られます。'}点数や順位はつけていません。</div>
  </div>
  <div id="body"><div class="msg"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div></div>
</div>
<div class="modal" id="keepModal"><div class="box">
  <div style="font-weight:700;color:#5d4037;margin-bottom:6px"><i class="fas fa-star" style="color:#ffb300"></i> 印象に残った言葉として残す</div>
  <div class="lead" style="margin-bottom:6px">残したい部分だけにしてもかまいません（${KEPT_MAX}文字まで）。年度末の成長レポートにのります。</div>
  <textarea id="keepText" maxlength="${KEPT_MAX}"></textarea>
  <div class="btnrow" style="justify-content:flex-end"><span id="keepStatus" class="muted" style="margin-right:auto;align-self:center"></span><button class="btn btn-g" type="button" id="keepCancel">やめる</button><button class="btn btn-o" type="button" id="keepSave">残す</button></div>
</div></div>
<script>
${guardJs(isAdmin, isAdmin ? '/admin' : '/mypage/portfolio')}
const WITH_REPORT = ${withReport ? 'true' : 'false'};
let P = null, keepTarget = null;
async function load(fy) {
  const body = document.getElementById('body');
  body.innerHTML = '<div class="msg"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div>';
  try { P = await api(dataUrl(fy)); } catch (e) { body.innerHTML = '<div class="msg" style="color:#c62828">' + esc(e.message) + '</div>'; return; }
  document.getElementById('who').innerHTML = '<b>' + esc(P.user.name) + '</b> さん' + (IS_ADMIN_VIEW && P.user.school ? '（' + esc(P.user.school) + '）' : '');
  const fs = document.getElementById('fySel');
  fs.innerHTML = P.fys.slice().reverse().map(function(f) { return '<option value="' + f + '"' + (String(P.fy) === String(f) ? ' selected' : '') + '>' + f + '年度</option>'; }).join('') + '<option value="all"' + (P.fy === 'all' ? ' selected' : '') + '>すべての年度</option>';
  const rl = document.getElementById('reportLink');
  if (rl) rl.href = (IS_ADMIN_VIEW ? '/admin/report?uid=' + encodeURIComponent(UID) + '&' : '/mypage/report?') + 'fy=' + (P.fy === 'all' ? P.note_fy : P.fy);
  const sl = document.getElementById('sheetLink');
  if (sl && IS_ADMIN_VIEW) sl.href = '/admin/sheet?uid=' + encodeURIComponent(UID) + '&fy=' + (P.fy === 'all' ? P.note_fy : P.fy);
  render();
}
function keptKey(eid, qid) { return eid + ':' + qid; }
function render() {
  const keptMap = {}; (P.kept || []).forEach(function(k) { keptMap[keptKey(k.event_id, k.question_id)] = k; });
  let h = '';
  if (!P.events.length) {
    document.getElementById('body').innerHTML = '<div class="card"><div class="msg"><i class="fas fa-seedling fa-2x" style="color:#ffcc80"></i><br>この年度に参加した研修会の記録はまだありません。<br>受付QRで出席すると、ここにたまっていきます。</div></div>';
    return;
  }
  // 問い
  h += '<div class="card"><h2><i class="fas fa-lightbulb" style="color:#ffb300"></i> 次の目標を考えるための問い</h2><ul class="prompts">' + P.prompts.map(function(p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul><div class="lead">あなたが書いたこと・記録したことから作った問いです。答えを書く必要はありません。</div></div>';
  // 視点の回数と変化
  const used = P.canon.filter(function(cn) { return P.counts[cn]; });
  h += '<div class="card"><h2><i class="fas fa-compass"></i> 選んだ成長の視点</h2>';
  if (!used.length) { h += '<div class="muted">まだ、成長の視点の回答はありません。</div>'; }
  else {
    h += '<div class="lead">成長の視点を答えた研修会 ' + P.growth_events + '回のうち、その視点を選んだ回数です（1回にいくつも選べます）。</div>';
    let mx = 0; used.forEach(function(cn) { mx = Math.max(mx, P.counts[cn]); });
    used.forEach(function(cn) { h += '<div class="cnt-row"><span class="nm">' + esc(cn) + '</span><span class="bar" style="width:' + Math.round(P.counts[cn] / mx * 55) + '%"></span><span class="n">' + P.counts[cn] + '回</span></div>'; });
    const gev = P.events.filter(function(e) { return e.growth.length; });
    h += '<div class="lead" style="margin-top:12px"><b>回ごとの変化</b>（左が古く、右が新しい回）</div><div class="mx-wrap"><table class="mx"><tr><th class="vp"></th>' + gev.map(function(e) { return '<th class="d" title="' + esc(e.title) + '">' + esc(md(e.date)) + '</th>'; }).join('') + '</tr>';
    used.forEach(function(cn) { h += '<tr><th class="vp">' + esc(cn) + '</th>' + gev.map(function(e) { return '<td>' + (e.growth.indexOf(cn) >= 0 ? '<span class="dot" title="' + esc(e.title) + '"></span>' : '') + '</td>'; }).join('') + '</tr>'; });
    h += '</table></div>';
  }
  h += '</div>';
  // 道しるべとのつながり
  if (P.rubric.length) {
    h += '<div class="card"><h2><i class="fas fa-map-signs"></i> 成長の道しるべとのつながり</h2><div class="lead">道しるべ（STEP表）で' + (IS_ADMIN_VIEW ? '本人' : 'あなた') + 'が選んでいる「今の自分」と、研修で選んだ回数を並べています。' + (IS_ADMIN_VIEW ? '' : ' <a href="/mypage">道しるべを見る・変える</a>') + '</div><table class="rb"><tr><th>視点</th><th>研修で選んだ回数</th><th>道しるべの「今の自分」</th></tr>';
    P.rubric.forEach(function(r) { h += '<tr><td><b>' + esc(r.name) + '</b></td><td>' + r.count + '回</td><td>' + (r.step ? '<span class="stp">STEP' + r.step.step + '</span> ' + esc(r.step.keyword || '') + (r.step.memo ? '<div class="muted">メモ：' + esc(r.step.memo) + '</div>' : '') : '<span class="muted">まだ選んでいません</span>') + '</td></tr>'; });
    h += '</table></div>';
  }
  // 印象に残った言葉
  if (WITH_REPORT) {
    h += '<div class="card"><h2><i class="fas fa-star" style="color:#ffb300"></i> 印象に残った言葉</h2>';
    if (!(P.kept || []).length) h += '<div class="lead">' + (IS_ADMIN_VIEW ? 'まだありません。' : '下の記録の中で、残しておきたい自分の言葉の <i class="far fa-star"></i> を押すと、ここに集まります。') + '</div>';
    (P.kept || []).forEach(function(k) { h += '<div class="kw">' + (IS_ADMIN_VIEW ? '' : '<button class="del" type="button" data-del="' + k.id + '" title="残すのをやめる"><i class="fas fa-times"></i></button>') + esc(k.body) + '<div class="src">' + esc((k.event_date || '') + ' ' + (k.title || '')) + '</div></div>'; });
    h += '</div>';
  }
  // 時系列
  h += '<div class="card"><h2><i class="fas fa-stream"></i> 参加した研修会（新しい順）</h2>';
  P.events.slice().reverse().forEach(function(e) {
    h += '<div class="ev"><div class="ev-head"><span class="ev-title">' + esc(e.title) + '</span><span class="ev-date"><i class="fas fa-calendar-day"></i> ' + esc(e.date) + '</span></div>';
    if (e.recall && (e.recall.status || e.recall.note)) {
      h += '<div class="rc"><i class="fas fa-bookmark" style="color:#1565c0"></i> 前回の学びカード：' + (e.recall.source_text ? '「' + esc(e.recall.source_text) + '」' : '') + (e.recall.label ? ' → <b>' + esc(e.recall.label) + '</b>' : '') + (e.recall.note ? '<div>ひとこと：' + esc(e.recall.note) + '</div>' : '') + '</div>';
    }
    if (e.growth.length) h += '<div class="chips">' + e.growth.map(function(cn) { return '<span class="chip">' + esc(cn) + '</span>'; }).join('') + '</div>';
    e.texts.forEach(function(t) {
      const k = keptMap[keptKey(e.id, t.qid)];
      const canKeep = WITH_REPORT && !IS_ADMIN_VIEW && t.kind !== 'choice';
      h += '<div class="qa"><div class="q">' + esc(KL[t.kind] || t.q) + '</div><div class="a">' + esc(t.text) + (canKeep ? ' <button type="button" class="keep' + (k ? ' on' : '') + '" data-e="' + e.id + '" data-q="' + t.qid + '" title="' + (k ? '残しています（押すと直せます）' : '印象に残った言葉として残す') + '"><i class="' + (k ? 'fas' : 'far') + ' fa-star"></i></button>' : '') + '</div></div>';
    });
    if (!e.answered) h += '<div class="muted" style="margin-bottom:6px">アンケートの回答はありません</div>';
    h += '</div>';
  });
  h += '</div>';
  document.getElementById('body').innerHTML = h;
  document.querySelectorAll('.keep').forEach(function(b) { b.addEventListener('click', function() { openKeep(+b.getAttribute('data-e'), +b.getAttribute('data-q')); }); });
  document.querySelectorAll('[data-del]').forEach(function(b) { b.addEventListener('click', async function() { if (!confirm('この言葉を残すのをやめますか？（元の回答は消えません）')) return; try { await api('/api/me/kept-words/' + b.getAttribute('data-del'), { method: 'DELETE' }); load(P.fy); } catch (e) { alert(e.message); } }); });
}
function openKeep(eid, qid) {
  const ev = P.events.find(function(e) { return e.id === eid; }); if (!ev) return;
  const t = ev.texts.find(function(x) { return x.qid === qid; }); if (!t) return;
  const k = (P.kept || []).find(function(x) { return x.event_id === eid && x.question_id === qid; });
  keepTarget = { eid: eid, qid: qid };
  document.getElementById('keepText').value = (k ? k.body : t.text).slice(0, ${KEPT_MAX});
  document.getElementById('keepStatus').textContent = '';
  document.getElementById('keepModal').classList.add('show');
}
document.getElementById('keepCancel').addEventListener('click', function() { document.getElementById('keepModal').classList.remove('show'); });
document.getElementById('keepSave').addEventListener('click', async function() {
  const txt = document.getElementById('keepText').value.trim();
  if (!txt) { document.getElementById('keepStatus').textContent = '言葉が空です'; return; }
  try { await api('/api/me/kept-words', { method: 'POST', body: JSON.stringify({ event_id: keepTarget.eid, question_id: keepTarget.qid, body: txt }) }); document.getElementById('keepModal').classList.remove('show'); load(P.fy); }
  catch (e) { document.getElementById('keepStatus').textContent = e.message; }
});
document.getElementById('fySel').addEventListener('change', function() { load(this.value); });
load(params.get('fy') || '');
</script>
</body></html>`
}

function reportPage(commonHead: string, isAdmin: boolean): string {
  return `<!DOCTYPE html><html lang="ja"><head>${commonHead}
<meta name="robots" content="noindex, nofollow">
<title>年度末の成長レポート - 社会科同好会</title>
<style>${MEMBER_CSS}
.rp { max-width: 800px; margin: 16px auto 50px; padding: 0 14px; }
.sheet { background:#fff; border-radius: 14px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); padding: 26px 28px; }
.rp-title { font-family:'Zen Maru Gothic',sans-serif; font-size: 22px; color:#d84315; text-align:center; margin: 0 0 4px }
.rp-sub { text-align:center; font-size: 13px; color:#6d4c41; margin-bottom: 18px }
.sec { margin-bottom: 18px; page-break-inside: avoid; break-inside: avoid }
.sec h3 { font-family:'Zen Maru Gothic',sans-serif; font-size: 15px; color:#5d4037; border-left: 5px solid #ef6c00; padding: 2px 0 2px 8px; margin: 0 0 8px }
.box { border: 1.5px solid #f0e6d2; border-radius: 10px; padding: 10px 12px; font-size: 13.5px; line-height: 1.8; white-space: pre-wrap; word-break: break-word; min-height: 2.4em }
table.hist { border-collapse: collapse; width: 100%; font-size: 12.5px }
table.hist th, table.hist td { border: 1px solid #f0e6d2; padding: 5px 7px; text-align: left; vertical-align: top }
table.hist td:first-child { white-space:nowrap }
table.hist th { background:#fffaf0; color:#6d4c41; font-size: 11.5px }
.toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; justify-content:center; margin: 0 auto 14px; max-width: 800px; padding: 0 14px }
.hint { font-size: 12px; color:#8d6e63; text-align:center; margin-bottom: 12px }
.foot { font-size: 10.5px; color:#aaa; text-align:center; margin-top: 16px }
@page { size: A4 portrait; margin: 12mm }
@media print {
  body { background:#fff !important }
  .top-bar, .toolbar, .hint, .no-print { display:none !important }
  .rp { margin:0; padding:0; max-width:none }
  .sheet { box-shadow:none; padding:0; border-radius:0 }
  .mx-wrap { overflow: visible }
  table.mx th.vp { position: static }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact }
}
@media (max-width:600px) { .sheet { padding: 16px 12px } .rp-title { font-size: 19px } }
</style>
</head><body>
<div class="top-bar${isAdmin ? ' adm' : ''}">
  <div class="logo"><i class="fas fa-file-alt"></i> 年度末の成長レポート</div>
  <a class="back" id="backLink" href="${isAdmin ? '/admin' : '/mypage/portfolio'}"><i class="fas fa-arrow-left"></i> ${isAdmin ? '学びの記録' : '学びの記録'}</a>
</div>
<div class="toolbar">
  <select id="fySel" aria-label="年度"></select>
  <button class="btn btn-o" type="button" onclick="window.print()"><i class="fas fa-file-pdf"></i> 印刷・PDFで保存</button>
</div>
<div class="hint">「印刷・PDFで保存」を押して、送信先（プリンター）で「PDFに保存」を選ぶとPDFになります。</div>
<div class="rp"><div class="sheet" id="sheet"><div class="msg"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div></div></div>
<script>
${guardJs(isAdmin, isAdmin ? '/admin' : '/mypage/report')}
if (IS_ADMIN_VIEW) document.getElementById('backLink').href = '/admin/portfolio?uid=' + encodeURIComponent(UID);
async function load(fy) {
  const sheet = document.getElementById('sheet');
  sheet.innerHTML = '<div class="msg"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div>';
  let P;
  try { P = await api(dataUrl(fy)); } catch (e) { sheet.innerHTML = '<div class="msg" style="color:#c62828">' + esc(e.message) + '</div>'; return; }
  const fs = document.getElementById('fySel');
  fs.innerHTML = P.fys.slice().reverse().map(function(f) { return '<option value="' + f + '"' + (String(P.fy) === String(f) ? ' selected' : '') + '>' + f + '年度</option>'; }).join('');
  const fyLabel = P.fy + '年度（令和' + (P.fy - 2018) + '年度）';
  let h = '<div class="rp-title">' + esc(fyLabel) + ' 成長レポート</div>';
  h += '<div class="rp-sub">' + esc(P.user.name) + ' さん' + (P.user.school ? '　' + esc(P.user.school) : '') + '</div>';
  // 年度初めの目標
  h += '<div class="sec"><h3>年度初めの目標</h3><div class="box">' + (P.annual.goal ? esc(P.annual.goal) : '<span class="muted">（マイページの「今年度の目標」に書くと、ここにのります）</span>') + '</div></div>';
  // 参加履歴
  h += '<div class="sec"><h3>参加した研修会（' + P.events.length + '回）</h3>';
  if (!P.events.length) h += '<div class="box muted">この年度の参加記録はありません。</div>';
  else {
    h += '<table class="hist"><tr><th style="width:5.5em">日付</th><th>研修会</th><th>選んだ視点</th><th>試してみたいこと</th></tr>';
    P.events.forEach(function(e) {
      const tr = e.texts.filter(function(t) { return t.kind === 'try'; }).map(function(t) { return t.text; }).join(' / ');
      h += '<tr><td>' + esc(e.date) + '</td><td>' + esc(e.title) + '</td><td>' + esc(e.growth.join('・')) + '</td><td>' + esc(tr) + '</td></tr>';
    });
    h += '</table>';
  }
  h += '</div>';
  // 視点の変化
  const used = P.canon.filter(function(cn) { return P.counts[cn]; });
  const gev = P.events.filter(function(e) { return e.growth.length; });
  if (used.length) {
    h += '<div class="sec"><h3>選んだ成長の視点の移り変わり</h3><div class="lead">成長の視点を答えた ' + P.growth_events + '回のうち、選んだ回数と、回ごとの記録（左が古い回）。</div>';
    h += '<div class="mx-wrap"><table class="mx"><tr><th class="vp"></th>' + gev.map(function(e) { return '<th class="d">' + esc(md(e.date)) + '</th>'; }).join('') + '<th class="d">回数</th></tr>';
    used.forEach(function(cn) { h += '<tr><th class="vp">' + esc(cn) + '</th>' + gev.map(function(e) { return '<td>' + (e.growth.indexOf(cn) >= 0 ? '<span class="dot"></span>' : '') + '</td>'; }).join('') + '<td><b>' + P.counts[cn] + '</b></td></tr>'; });
    h += '</table></div></div>';
  }
  // 印象に残った言葉
  h += '<div class="sec"><h3>印象に残った言葉（自分で選んだもの）</h3>';
  if (!(P.kept || []).length) h += '<div class="box muted">' + (IS_ADMIN_VIEW ? '（まだ選ばれていません）' : '（学びの記録のページで、自分の言葉の ☆ を押すと、ここにのります）') + '</div>';
  else (P.kept || []).forEach(function(k) { h += '<div class="kw">' + esc(k.body) + '<div class="src">' + esc((k.event_date || '') + ' ' + (k.title || '')) + '</div></div>'; });
  h += '</div>';
  // 実践への挑戦
  const rcs = P.events.filter(function(e) { return e.recall && (e.recall.status || e.recall.note); });
  h += '<div class="sec"><h3>実践への挑戦の記録（前回の学びカード）</h3>';
  if (!rcs.length) h += '<div class="box muted">記録はありません。</div>';
  else {
    h += '<table class="hist"><tr><th style="width:5.5em">記録した日</th><th>前回「試してみたい」と書いたこと</th><th style="white-space:nowrap">その後</th><th>ひとこと</th></tr>';
    rcs.forEach(function(e) { h += '<tr><td>' + esc(e.date) + '</td><td>' + esc(e.recall.source_text) + '</td><td>' + esc(e.recall.label || '') + '</td><td>' + esc(e.recall.note) + '</td></tr>'; });
    h += '</table>';
  }
  h += '</div>';
  // 年度末の振り返り
  h += '<div class="sec"><h3>年度末の振り返り</h3><div class="box">' + (P.annual.reflection ? esc(P.annual.reflection) : '<span class="muted">（マイページの「今年度の振り返り」に書くと、ここにのります）</span>') + '</div></div>';
  // 来年度に向けた問い
  h += '<div class="sec"><h3>来年度に向けて考えてみたい問い</h3><ul class="prompts">' + P.next_prompts.map(function(p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul></div>';
  h += '<div class="foot">社会科同好会　成長の道しるべ　／　本人が書いた記録と選んだ内容をもとに作成しています（評価ではありません）</div>';
  sheet.innerHTML = h;
}
document.getElementById('fySel').addEventListener('change', function() { load(this.value); });
load(params.get('fy') || '');
</script>
</body></html>`
}
