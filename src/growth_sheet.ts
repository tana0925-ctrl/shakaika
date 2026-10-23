// ========== 個人まとめシート（A4縦1枚・管理者専用） ==========
// 会員1人分の情報をA4紙1枚にまとめる印刷用シート。見られるのは管理者だけ（会員本人の画面にはボタンも出さない）。
// 既存データは読むだけ（書き換えない・新しいテーブルなし）。1人分は会員IDの索引で読み、まとめ印刷は画面側で少しずつ分けて読み込む。
// 点数・順位・良し悪しの評価は出さない（参加率は「参加回数／対象回数」の事実だけ）。
import { fyRange, currentFY, parseFY, splitChoices, questionKind, loadAliases, canonOf, canonOrder } from './growth_common'

type Deps = {
  authMiddleware: any
  adminMiddleware: any
  commonHead: string
  stepKeywords?: Record<string, string[]>
}

const SHEET_MAX_IDS = 10 // 1回の読み込みで扱う人数（まとめ印刷は画面側でこの人数ずつ分けて読む）
const RECALL_LABEL: Record<string, string> = { tried: 'やってみた', a_little: 'ちょっとだけ', not_yet: 'まだ', changed: '考えが変わった' }
const ST_LABEL: Record<string, string> = { elementary: '小学校', junior_high: '中学校', admin_staff: '主幹・管理職' }

// 成長の道しるべ（STEP表）の視点：管理画面の会員一覧と同じ並び・名前
const RUBRIC_KEYS: Record<string, { key: string; label: string }[]> = {
  elementary: [
    { key: 'lesson_plan', label: '授業をつくる' }, { key: 'lesson_practice', label: '授業をする' },
    { key: 'student_eval', label: '子どもを見る' }, { key: 'connection', label: 'つながる' }, { key: 'research', label: '深める' }
  ],
  junior_high: [
    { key: 'j_lesson_plan', label: '授業をつくる' }, { key: 'j_material', label: '資料' }, { key: 'j_dialogue', label: '対話' },
    { key: 'j_inquiry', label: '探究' }, { key: 'j_student_eval', label: '生徒を見る' }, { key: 'j_connection', label: 'つながる' },
    { key: 'j_research', label: '深める' }
  ],
  admin_staff: [
    { key: 'a_school_support', label: '会の活動を支える' }, { key: 'a_school_mgmt', label: '会員同士をつなぐ' },
    { key: 'a_member_support', label: '会員の成長を支える' }, { key: 'a_leader_dev', label: '次世代リーダー' },
    { key: 'a_org_mgmt', label: '運営に貢献' }, { key: 'a_outreach', label: '外とつなぐ' }
  ]
}

// グループ名の照合用：全角/半角（NFKC）・前後空白・連続空白をそろえる（データは書き換えない）
export function normGroup(s: any): string {
  return String(s == null ? '' : s).normalize('NFKC').replace(/[\s　]+/g, ' ').trim()
}

// 校種が未設定のときは、道しるべで選んだ視点から推定（管理画面の inferSchoolType と同じ考え方）
function inferSchoolType(st: string, selKeys: string[]): string {
  if (st) return st
  if (!selKeys.length) return ''
  const j = selKeys.some((k) => k.startsWith('j_')), a = selKeys.some((k) => k.startsWith('a_'))
  const e = selKeys.some((k) => !k.startsWith('j_') && !k.startsWith('a_'))
  if (j && !e && !a) return 'junior_high'
  if (a && !e && !j) return 'admin_staff'
  if (e) return 'elementary'
  return ''
}

function cut(s: any, n: number): string {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
function todayJST(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10)
}

// ---- 会の「対象」を会名から判定する ----
// all：全体向け（スキルアップ研修会・全体会・フィールドワークなど）
// school：会名に「小学校部会」「中学校部会」「小中合同」→ その校種
// group：会名に「グループ」「授業力アップ」→ 会名に含まれるグループ名の会員（グループ名が読み取れない回は対象に数えない）
export type EvTarget = { kind: 'all' } | { kind: 'school'; types: string[] } | { kind: 'group'; group: string } | { kind: 'group_unknown' }
export function classifyEvent(title: string, groupNames: string[]): EvTarget {
  const t = normGroup(title)
  if (t.indexOf('グループ') >= 0 || t.indexOf('授業力アップ') >= 0) {
    const hits: string[] = []
    for (const g of groupNames) {
      if (!g) continue
      let hit = false
      if (/^[A-Za-z]$/.test(g)) {
        hit = new RegExp('(^|[^A-Za-z])' + g + '([^A-Za-z]|$)').test(t)
      } else {
        hit = t.indexOf(g) >= 0
      }
      if (hit && hits.indexOf(g) < 0) hits.push(g)
    }
    if (hits.length === 1) return { kind: 'group', group: hits[0] }
    return { kind: 'group_unknown' }
  }
  if (t.indexOf('小中合同') >= 0) return { kind: 'school', types: ['elementary', 'junior_high'] }
  if (t.indexOf('部会') >= 0) {
    const el = t.indexOf('小学校') >= 0, jh = t.indexOf('中学校') >= 0
    if (el && !jh) return { kind: 'school', types: ['elementary'] }
    if (jh && !el) return { kind: 'school', types: ['junior_high'] }
    if (el && jh) return { kind: 'school', types: ['elementary', 'junior_high'] }
  }
  return { kind: 'all' }
}
export const TARGET_RULE_NOTE = '対象回の決め方：全体向けの会（スキルアップ研修会・全体会など）は全員が対象。会名に「小学校部会」「中学校部会」「小中合同」とある回はその校種の会員、「グループ」「授業力アップ」とある回は会名のグループの会員が対象（会名から判定）。まだ開かれていない回と、出席者が一人もいない回は数えない。本人が出席した回は必ず対象に含める。'

type Ctx = { fy: number; start: string; end: string; events: any[]; groupNames: string[]; am: any; stepKeywords?: Record<string, string[]> }

async function loadCtx(db: D1Database, fy: number, stepKeywords?: Record<string, string[]>): Promise<Ctx> {
  const [start, end] = fyRange(fy)
  const today = todayJST()
  const last = end < today ? end : today
  let evRows: any[] = []
  try {
    const r = await db.prepare(
      `SELECT e.id, e.title, e.event_date,
         (SELECT COUNT(*) FROM attendances a WHERE a.event_id = e.id) + (SELECT COUNT(*) FROM guest_attendances g WHERE g.event_id = e.id) AS n
       FROM events e WHERE e.event_date >= ? AND e.event_date <= ? ORDER BY e.event_date, e.id`
    ).bind(start, last).all() as any
    evRows = r.results || []
  } catch (e) {
    const r = await db.prepare(
      `SELECT e.id, e.title, e.event_date, (SELECT COUNT(*) FROM attendances a WHERE a.event_id = e.id) AS n
       FROM events e WHERE e.event_date >= ? AND e.event_date <= ? ORDER BY e.event_date, e.id`
    ).bind(start, last).all() as any
    evRows = r.results || []
  }
  const { results: gr } = await db.prepare("SELECT DISTINCT training_group g FROM users WHERE training_group IS NOT NULL AND training_group <> ''").all() as any
  const groupNames: string[] = []
  for (const r of (gr || [])) { const g = normGroup(r.g); if (g && groupNames.indexOf(g) < 0) groupNames.push(g) }
  // 長い名前から照合（「A」より「A-1」などを先に）
  groupNames.sort((a, b) => b.length - a.length)
  const events = evRows.map((e: any) => ({ id: e.id, title: e.title, date: e.event_date, n: Number(e.n) || 0, target: classifyEvent(e.title, groupNames) }))
  const am = await loadAliases(db)
  return { fy, start, end, events, groupNames, am, stepKeywords }
}

// ---- 1人分を集める（すべて user_id で絞る。他の会員の情報は入らない） ----
export async function buildSheet(db: D1Database, uid: number, ctx: Ctx) {
  const u = await db.prepare('SELECT id, name, school, school_type, district, training_group, experience_years FROM users WHERE id = ?').bind(uid).first() as any
  if (!u) return null
  const { start, end } = ctx
  const [attR, qaR, selR, noteR] = await db.batch([
    db.prepare(`SELECT a.event_id, e.title, e.event_date FROM attendances a JOIN events e ON e.id = a.event_id
                WHERE a.user_id = ? AND e.event_date >= ? AND e.event_date <= ? ORDER BY e.event_date, e.id`).bind(uid, start, end),
    db.prepare(`SELECT ca.event_id, ca.question_id, ca.answer_text, q.question_text, q.question_type, q.sort_order
                FROM custom_answers ca JOIN survey_questions q ON q.id = ca.question_id JOIN events e ON e.id = ca.event_id
                WHERE ca.user_id = ? AND e.event_date >= ? AND e.event_date <= ? ORDER BY e.event_date, q.sort_order`).bind(uid, start, end),
    db.prepare('SELECT viewpoint, step, memo FROM selections WHERE user_id = ?').bind(uid),
    db.prepare('SELECT goal, reflection FROM annual_notes WHERE user_id = ? AND fiscal_year = ?').bind(uid, ctx.fy)
  ]) as any[]
  let recalls: any[] = []
  try {
    const r = await db.prepare(
      `SELECT r.event_id, r.status, r.note, r.source_answer_text FROM recall_reflections r JOIN events e ON e.id = r.event_id
       WHERE r.user_id = ? AND e.event_date >= ? AND e.event_date <= ?`
    ).bind(uid, start, end).all() as any
    recalls = r.results || []
  } catch (e) { recalls = [] }
  let kept: any[] = []
  try {
    const r = await db.prepare(
      `SELECT k.body, e.title, e.event_date FROM kept_words k LEFT JOIN events e ON e.id = k.event_id
       WHERE k.user_id = ? AND (e.event_date IS NULL OR (e.event_date >= ? AND e.event_date <= ?)) ORDER BY e.event_date, k.id LIMIT 20`
    ).bind(uid, start, end).all() as any
    kept = r.results || []
  } catch (e) { kept = [] }

  const sel: any[] = (selR && selR.results) || []
  const selBy: Record<string, any> = {}
  for (const s of sel) selBy[s.viewpoint] = s
  const st = inferSchoolType(String(u.school_type || ''), Object.keys(selBy))
  const group = normGroup(u.training_group)

  // 参加状況
  const attended: any[] = (attR && attR.results) || []
  const attSet = new Set<number>(attended.map((a: any) => a.event_id))
  const rows: any[] = []
  const seen = new Set<number>()
  for (const ev of ctx.events) {
    const mine = attSet.has(ev.id)
    let target = false
    if (mine) target = true
    else if (ev.n > 0) {
      const tg = ev.target as EvTarget
      if (tg.kind === 'all') target = true
      else if (tg.kind === 'school') target = tg.types.indexOf(st) >= 0
      else if (tg.kind === 'group') target = !!group && tg.group === group
    }
    if (target) { rows.push({ date: ev.date, title: ev.title, attended: mine }); seen.add(ev.id) }
  }
  // 出席したのに一覧に入っていない回（今日より後の日付の会に出席記録がある等）も必ず入れる
  for (const a of attended) {
    if (!seen.has(a.event_id)) { rows.push({ date: a.event_date, title: a.title, attended: true }); seen.add(a.event_id) }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const nAtt = rows.filter((r) => r.attended).length

  // 回ごとの振り返り
  const byEv: Record<number, any> = {}
  const hist: any[] = []
  for (const a of attended) {
    const o = { id: a.event_id, date: a.event_date, title: a.title, growth: [] as string[], reason: [] as string[], try: [] as string[], recall: null as any }
    byEv[a.event_id] = o; hist.push(o)
  }
  const counts: Record<string, number> = {}
  for (const a of ((qaR && qaR.results) || [])) {
    const ev = byEv[a.event_id]; if (!ev) continue
    const txt = String(a.answer_text || '').trim(); if (!txt) continue
    const kind = questionKind(a)
    if (kind === 'growth') {
      for (const raw of splitChoices(txt)) {
        const cn = canonOf(raw, ctx.am)
        if (cn && ev.growth.indexOf(cn) < 0) ev.growth.push(cn)
      }
    } else if (kind === 'reason') ev.reason.push(cut(txt, 200))
    else if (kind === 'try') ev.try.push(cut(txt, 200))
  }
  let growthEvents = 0
  for (const ev of hist) { if (ev.growth.length) growthEvents++; for (const cn of ev.growth) counts[cn] = (counts[cn] || 0) + 1 }
  for (const r of recalls) {
    const ev = byEv[r.event_id]; if (!ev) continue
    if (!r.status && !String(r.note || '').trim()) continue
    ev.recall = { label: r.status ? (RECALL_LABEL[r.status] || '') : '', note: cut(r.note, 120), source: cut(r.source_answer_text, 120) }
  }
  const history = hist
    .filter((e) => e.growth.length || e.reason.length || e.try.length || e.recall)
    .map((e) => ({ date: e.date, title: e.title, growth: e.growth, reason: e.reason.join(' / '), try: e.try.join(' / '), recall: e.recall }))

  // 選んだ成長の視点（回数。読みかえ表でまとめる）
  const order = canonOrder(ctx.am)
  const cnt = order.filter((n) => counts[n]).map((n) => ({ name: n, n: counts[n] }))
  for (const k of Object.keys(counts)) if (order.indexOf(k) < 0) cnt.push({ name: k, n: counts[k] })

  // 成長の道しるべ
  const rubric = (RUBRIC_KEYS[st] || RUBRIC_KEYS.elementary).map((v) => {
    const s = selBy[v.key]
    const kw = s && ctx.stepKeywords && ctx.stepKeywords[v.key] ? (ctx.stepKeywords[v.key][s.step - 1] || '') : ''
    return { label: v.label, step: s ? s.step : null, keyword: kw, memo: s ? cut(s.memo, 120) : '' }
  })

  const note = (noteR && noteR.results && noteR.results[0]) || null
  return {
    id: u.id,
    user: {
      name: u.name || '', school: u.school || '', district: u.district || '', group: group,
      school_type: st, school_type_label: ST_LABEL[st] || '未設定', school_type_inferred: !u.school_type && !!st,
      experience_years: u.experience_years == null || u.experience_years === '' ? null : u.experience_years
    },
    fy: ctx.fy,
    attendance: { rows, attended: nAtt, target: rows.length, rate: rows.length ? Math.round(nAtt / rows.length * 100) : null },
    annual: { goal: cut(note?.goal, 600), reflection: cut(note?.reflection, 600) },
    rubric,
    counts: cnt, growth_events: growthEvents,
    history,
    kept: kept.map((k: any) => ({ body: cut(k.body, 160), date: k.event_date || '', title: k.title || '' }))
  }
}

// ---- グループ別画面と同じ並びで、そのグループの会員IDを返す ----
// グループ別画面：role='member' を名前順に読み、グループごとに分ける。「未設定」は 小学校→中学校→主幹・管理職→校種未設定 の順。
export const UNSET_SECTION_ORDER = ['elementary', 'junior_high', 'admin_staff', '']
export async function groupMemberIds(db: D1Database, group: string | null, unset: boolean): Promise<number[]> {
  const { results } = await db.prepare("SELECT id, name, school_type, training_group FROM users WHERE role = 'member' ORDER BY name, id").all() as any
  const key = normGroup(group)
  const rows = (results || []).filter((m: any) => {
    const g = normGroup(m.training_group)
    return unset ? !g : (!!key && g === key)
  })
  if (unset) {
    const rank = (st: string) => { const i = UNSET_SECTION_ORDER.indexOf(st || ''); return i < 0 ? 99 : i }
    rows.sort((a: any, b: any) => rank(a.school_type) - rank(b.school_type)) // 安定ソート：同じ校種の中は名前順のまま
  }
  return rows.map((m: any) => m.id)
}

function parseIds(v: any): number[] {
  const out: number[] = []
  for (const p of String(v || '').split(',')) {
    const n = parseInt(p, 10)
    if (Number.isFinite(n) && n > 0 && out.indexOf(n) < 0) out.push(n)
  }
  return out
}

export function registerSheet(app: any, deps: Deps) {
  const { authMiddleware, adminMiddleware, commonHead } = deps

  // 1人〜10人分のシート（管理者のみ）
  app.get('/api/admin/sheets', authMiddleware, adminMiddleware, async (c: any) => {
    const db = c.env.DB as D1Database
    const ids = parseIds(c.req.query('uids'))
    if (!ids.length) return c.json({ error: '会員が指定されていません' }, 400)
    if (ids.length > SHEET_MAX_IDS) return c.json({ error: '一度に読み込めるのは' + SHEET_MAX_IDS + '人までです' }, 400)
    const fy = parseFY(c.req.query('fy'))
    const ctx = await loadCtx(db, fy, deps.stepKeywords)
    const sheets: any[] = []
    for (const id of ids) {
      const s = await buildSheet(db, id, ctx)
      sheets.push(s || { id, missing: true })
    }
    return c.json({ fy, rule_note: TARGET_RULE_NOTE, sheets })
  })

  // まとめ印刷する会員IDの一覧（グループ指定。グループ別画面と同じ並び）
  app.get('/api/admin/sheet-ids', authMiddleware, adminMiddleware, async (c: any) => {
    const db = c.env.DB as D1Database
    const unset = c.req.query('unset') === '1'
    const group = c.req.query('group') || ''
    if (!unset && !normGroup(group)) return c.json({ error: 'グループが指定されていません' }, 400)
    const ids = await groupMemberIds(db, group, unset)
    return c.json({ label: unset ? 'グループ未設定' : normGroup(group), ids, chunk: SHEET_MAX_IDS })
  })

  app.get('/admin/sheet', (c: any) => c.html(sheetPage(commonHead)))
}

// ---------------- 画面 ----------------
function sheetPage(commonHead: string): string {
  return `<!DOCTYPE html><html lang="ja"><head>${commonHead}
<meta name="robots" content="noindex, nofollow">
<title>個人まとめシート - 社会科同好会</title>
<style>
body { background:#eceff1; margin:0 }
.top-bar { background:#1a237e; color:#fff; padding:10px 16px; display:flex; justify-content:space-between; align-items:center; position:sticky; top:0; z-index:100; gap:8px; flex-wrap:wrap }
.top-bar .logo { font-family:'Zen Maru Gothic',sans-serif; font-size:17px; font-weight:700 }
.top-bar a.back { padding:6px 12px; border-radius:8px; background:rgba(255,255,255,0.2); color:#fff; font-size:12px; font-weight:700; text-decoration:none; white-space:nowrap }
.toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; justify-content:center; padding:12px 10px 4px }
.toolbar select { font-family:inherit; font-size:14px; padding:6px 10px; border:2px solid #c5cae9; border-radius:8px; background:#fff }
.tbtn { padding:9px 18px; border-radius:10px; border:none; font-size:14px; font-weight:700; cursor:pointer; font-family:inherit; background:#1a237e; color:#fff; display:inline-flex; align-items:center; gap:6px }
.tbtn:disabled { opacity:.45; cursor:default }
.hint { font-size:12px; color:#607d8b; text-align:center; padding:0 12px 10px; line-height:1.7 }
#status { font-size:13px; color:#37474f; text-align:center; min-height:1.4em }
#pages { padding:6px 0 40px }
.pwrap { margin:0 auto 14px; position:relative; overflow:hidden; box-shadow:0 2px 10px rgba(0,0,0,0.18); background:#fff }
.page { width:210mm; height:297mm; box-sizing:border-box; padding:9mm 10mm; background:#fff; overflow:hidden; transform-origin:0 0; position:absolute; left:0; top:0;
  font-family:'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif; color:#111; line-height:1.45 }
.page * { box-sizing:border-box }
.pin { width:100% }
.hd { display:flex; justify-content:space-between; align-items:flex-start; gap:4mm; border-bottom:0.6mm solid #1a237e; padding-bottom:2mm; margin-bottom:2.5mm }
.hd .ttl { font-size:0.9em; color:#1a237e; font-weight:700; letter-spacing:0.05em }
.hd .nm { font-family:'Zen Maru Gothic','Noto Sans JP',sans-serif; font-size:1.9em; font-weight:700; line-height:1.2 }
.hd .meta { font-size:0.95em; color:#333; margin-top:0.5mm }
.hd .meta span { display:inline-block; margin-right:3mm; white-space:nowrap }
.hd .meta b { color:#555; font-weight:700; font-size:0.85em; margin-right:1mm }
.rate { border:0.4mm solid #1a237e; border-radius:2mm; padding:1.5mm 3mm; text-align:center; min-width:38mm; flex:none }
.rate .big { font-size:1.9em; font-weight:700; color:#1a237e; line-height:1.15 }
.rate .big small { font-size:0.5em; font-weight:700; color:#333 }
.rate .sm { font-size:0.8em; color:#333 }
.grid { display:grid; grid-template-columns: 1fr 1fr; gap:2.5mm 4mm; margin-bottom:2.5mm }
.sec { break-inside:avoid; min-width:0 }
.sec h3 { font-size:1.02em; margin:0 0 1mm; padding:0.3mm 0 0.3mm 2mm; border-left:1.2mm solid #1a237e; color:#1a237e; font-weight:700; display:flex; justify-content:space-between; align-items:baseline; gap:2mm }
.sec h3 .sub { font-size:0.78em; color:#555; font-weight:400 }
table.s { border-collapse:collapse; width:100%; font-size:0.92em; table-layout:fixed }
table.s th, table.s td { border:0.2mm solid #9e9e9e; padding:0.6mm 1.2mm; vertical-align:top; text-align:left; word-break:break-all; overflow-wrap:anywhere }
table.s th { background:#e8eaf6; color:#1a237e; font-size:0.88em; font-weight:700 }
table.s td.c, table.s th.c { text-align:center }
table.s tr.no td { color:#666 }
.mk { font-weight:700; font-size:1.05em }
table.s .nw { white-space:nowrap; word-break:normal; overflow-wrap:normal }
.box { border:0.2mm solid #9e9e9e; border-radius:1.2mm; padding:1mm 1.8mm; font-size:0.95em; white-space:pre-wrap; word-break:break-all; overflow-wrap:anywhere; min-height:6mm }
.lbl { font-size:0.82em; font-weight:700; color:#1a237e; margin:0.6mm 0 0.3mm }
.muted { color:#777 }
.bar-row { display:flex; align-items:center; gap:1.5mm; margin:0.6mm 0; font-size:0.92em }
.bar-row .n1 { width:24mm; flex:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
.bar-row .bt { flex:1; height:3mm; border:0.2mm solid #9e9e9e; background:#fff }
.bar-row .bf { height:100%; background:#3949ab }
.bar-row .n2 { width:9mm; flex:none; text-align:right; white-space:nowrap }
.stp { font-weight:700; white-space:nowrap }
.kw { border-left:0.8mm solid #555; padding:0.3mm 0 0.3mm 1.8mm; margin:0.8mm 0; font-size:0.95em }
.kw .src { font-size:0.8em; color:#555 }
.foot { font-size:0.72em; color:#555; border-top:0.2mm solid #bbb; padding-top:1mm; margin-top:2mm; line-height:1.45 }
.omit { font-size:0.8em; color:#555; margin-top:0.5mm }
.clipnote { position:absolute; right:10mm; bottom:3mm; font-size:7pt; color:#555; background:#fff; padding:0 1mm }
.msg { text-align:center; color:#666; padding:40px 10px; font-size:14px }
@page { size: A4 portrait; margin: 0 }
@media print {
  html, body { background:#fff !important; margin:0 !important }
  .top-bar, .toolbar, .hint, #status, .no-print { display:none !important }
  #pages { padding:0 }
  .pwrap { margin:0 !important; box-shadow:none !important; width:210mm !important; height:296.5mm !important; overflow:hidden; break-after:page; page-break-after:always }
  .pwrap:last-child { break-after:auto; page-break-after:auto }
  .page { transform:none !important }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact }
}
</style>
</head><body>
<div class="top-bar">
  <div class="logo"><i class="fas fa-id-card"></i> 個人まとめシート（管理者用）</div>
  <a class="back" href="/admin"><i class="fas fa-arrow-left"></i> 管理画面</a>
</div>
<div class="toolbar">
  <select id="fySel" aria-label="年度"></select>
  <button class="tbtn" type="button" id="printBtn" disabled><i class="fas fa-print"></i> 印刷・PDFで保存</button>
</div>
<div class="hint">1人分をA4縦1枚にまとめています（入りきらないときは文字を小さくし、古い回などを省略します）。<br>「印刷・PDFで保存」→ 用紙A4・縦、余白「なし」または「デフォルト」、倍率100%で印刷できます。PDFにするときは送信先で「PDFに保存」を選びます。</div>
<div id="status"></div>
<div id="pages"><div class="msg"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div></div>
<script>
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');
if (!token || !user || user.role !== 'admin') { window.location.href = '/admin'; throw new Error('redirect'); }
const params = new URLSearchParams(location.search);
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
function cut(s, n) { s = String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
function md(ds) { const m = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(ds || ''); return m ? (+m[2]) + '/' + (+m[3]) : (ds || ''); }
async function api(path) {
  const r = await fetch(path, { headers: { 'Authorization': 'Bearer ' + token } });
  if (r.status === 401) { window.location.href = '/login'; throw new Error('auth'); }
  let d = null; try { d = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((d && d.error) || ('エラー (' + r.status + ')'));
  return d;
}
function curFY() { const n = new Date(Date.now() + 9 * 3600 * 1000); const y = n.getUTCFullYear(), m = n.getUTCMonth() + 1; return m >= 4 ? y : y - 1; }
const FY = parseInt(params.get('fy') || '', 10) || curFY();
(function() {
  const fs = document.getElementById('fySel'); const c = curFY(); let h = '';
  for (let f = c; f >= Math.min(2026, c) && f >= c - 3; f--) h += '<option value="' + f + '"' + (f === FY ? ' selected' : '') + '>' + f + '年度（令和' + (f - 2018) + '年度）</option>';
  if (FY < c - 3 || FY > c) h += '<option value="' + FY + '" selected>' + FY + '年度</option>';
  fs.innerHTML = h;
  fs.addEventListener('change', function() { params.set('fy', fs.value); location.search = params.toString(); });
})();

// 入りきらないときに順に試す設定（文字の大きさ・省略の長さ・載せる件数）
// ① 全部のせたまま文字を小さく → ② 7.5ptで古い回から1件ずつ省く → ③ さらに小さく・短く
const FONT_STEPS = [
  { fs: 10,  t: 110, g: 420, m: 60, k: 5, kc: 130 },
  { fs: 9.5, t: 100, g: 380, m: 52, k: 5, kc: 120 },
  { fs: 9,   t: 90,  g: 320, m: 46, k: 5, kc: 110 },
  { fs: 8.5, t: 76,  g: 270, m: 40, k: 4, kc: 100 },
  { fs: 8,   t: 64,  g: 220, m: 34, k: 4, kc: 90 },
  { fs: 7.75, t: 58, g: 200, m: 30, k: 3, kc: 85 },
  { fs: 7.5, t: 54,  g: 180, m: 28, k: 3, kc: 80 }
];
const SMALL_STEPS = [
  { fs: 7,   t: 44, g: 140, m: 22, k: 2, kc: 60 },
  { fs: 6.5, t: 34, g: 100, m: 16, k: 1, kc: 50 }
];
function levelsFor(d) {
  const out = [];
  FONT_STEPS.forEach(function(f) { out.push(Object.assign({ h: 999, a: 999 }, f)); });
  const last = FONT_STEPS[FONT_STEPS.length - 1];
  const nh = d.history.length;
  for (let h = nh - 1; h >= 4; h--) out.push(Object.assign({}, last, { h: h, a: 999 }));
  SMALL_STEPS.forEach(function(f) {
    out.push(Object.assign({ h: Math.min(nh, 4), a: 999 }, f));
    out.push(Object.assign({ h: Math.min(nh, 3), a: 18 }, f));
  });
  return out;
}
let RULE = '';

function build(d, L) {
  const u = d.user, A = d.attendance;
  let h = '<div class="pin">';
  // 1. 名前・学校など ＋ 2. 参加率
  h += '<div class="hd"><div style="min-width:0"><div class="ttl">個人まとめシート　' + d.fy + '年度（令和' + (d.fy - 2018) + '年度）</div>';
  h += '<div class="nm">' + esc(u.name) + '</div><div class="meta">';
  h += '<span><b>学校</b>' + (u.school ? esc(u.school) : '<span class="muted">未登録</span>') + '</span>';
  h += '<span><b>地区</b>' + (u.district ? esc(u.district) : '<span class="muted">未登録</span>') + '</span>';
  h += '<span><b>グループ</b>' + (u.group ? esc(u.group) : '<span class="muted">未設定</span>') + '</span>';
  h += '<span><b>校種</b>' + esc(u.school_type_label) + (u.school_type_inferred ? '<span class="muted">（道しるべから推定）</span>' : '') + '</span>';
  if (u.experience_years != null) h += '<span><b>経験</b>' + esc(u.experience_years) + '年目</span>';
  h += '</div></div>';
  h += '<div class="rate"><div class="sm">研修会への参加</div><div class="big">' + A.attended + '<small> 回 ／ 対象 </small>' + A.target + '<small> 回</small></div><div class="sm">参加率 <b>' + (A.rate == null ? '―' : A.rate + '%') + '</b></div></div></div>';

  h += '<div class="grid">';
  // 2. 参加した会の一覧（左）
  let rows = A.rows, omitted = 0;
  if (rows.length > L.a) { omitted = rows.length - L.a; rows = rows.slice(rows.length - L.a); }
  h += '<div class="sec"><h3>参加状況 <span class="sub">○＝出席　－＝欠席</span></h3>';
  if (!A.rows.length) h += '<div class="box muted">この年度の対象回はまだありません。</div>';
  else {
    h += '<table class="s"><colgroup><col style="width:3.9em"><col><col style="width:3.2em"></colgroup><tr><th>日付</th><th>会名</th><th class="c nw">出席</th></tr>';
    rows.forEach(function(r) { h += '<tr' + (r.attended ? '' : ' class="no"') + '><td class="nw">' + esc(md(r.date)) + '</td><td>' + esc(cut(r.title, 30)) + '</td><td class="c mk">' + (r.attended ? '○' : '－') + '</td></tr>'; });
    h += '</table>';
    if (omitted) h += '<div class="omit">※ 古い回 ' + omitted + '回分は表から省略（回数には含む）</div>';
  }
  h += '</div>';
  // 3. 今年度の目標・振り返り ＋ 5. 選んだ成長の視点（右）
  h += '<div><div class="sec"><h3>今年度の目標・振り返り <span class="sub">マイページの記入</span></h3>';
  h += '<div class="lbl">今年度の目標</div><div class="box">' + (d.annual.goal ? esc(cut(d.annual.goal, L.g)) : '<span class="muted">（未記入）</span>') + '</div>';
  h += '<div class="lbl">今年度の振り返り</div><div class="box">' + (d.annual.reflection ? esc(cut(d.annual.reflection, L.g)) : '<span class="muted">（未記入）</span>') + '</div>';
  h += '</div>';
  h += '<div class="sec" style="margin-top:2.5mm"><h3>選んだ成長の視点 <span class="sub">アンケートで選んだ回数</span></h3>';
  if (!d.counts.length) h += '<div class="box muted">まだ回答はありません。</div>';
  else {
    let mx = 0; d.counts.forEach(function(c) { mx = Math.max(mx, c.n); });
    d.counts.forEach(function(c) { h += '<div class="bar-row"><span class="n1">' + esc(c.name) + '</span><span class="bt"><span class="bf" style="display:block;width:' + Math.round(c.n / mx * 100) + '%"></span></span><span class="n2">' + c.n + '回</span></div>'; });
    h += '<div class="omit">成長の視点を答えた ' + d.growth_events + '回のうち、その視点を選んだ回数（1回に複数選べます）。</div>';
  }
  h += '</div></div>';
  h += '</div>';
  // 4. 成長の道しるべ（全幅）
  h += '<div class="sec" style="margin-bottom:2.5mm"><h3>成長の道しるべ <span class="sub">本人が選んでいるSTEPとメモ</span></h3><table class="s"><colgroup><col style="width:9em"><col style="width:38%"><col></colgroup><tr><th>視点</th><th>STEP</th><th>メモ</th></tr>';
  d.rubric.forEach(function(r) {
    h += '<tr><td>' + esc(r.label) + '</td><td>' + (r.step ? '<span class="stp">STEP' + r.step + '</span>' + (r.keyword ? '　' + esc(r.keyword) : '') : '<span class="muted">未選択</span>') + '</td><td>' + esc(cut(r.memo, L.m)) + '</td></tr>';
  });
  h += '</table></div>';
  // 6. 振り返りのあゆみ
  let hist = d.history, hOm = 0;
  if (hist.length > L.h) { hOm = hist.length - L.h; hist = hist.slice(hist.length - L.h); }
  h += '<div class="sec" style="margin-bottom:2.5mm"><h3>振り返りのあゆみ <span class="sub">回ごとのアンケートと前回の学びカード（古い順）</span></h3>';
  if (!d.history.length) h += '<div class="box muted">この年度のアンケートの記録はありません。</div>';
  else {
    h += '<table class="s"><colgroup><col style="width:6.4em"><col style="width:7.2em"><col><col><col style="width:10em"></colgroup><tr><th>日付・会</th><th>選んだ視点</th><th>選んだ理由</th><th>明日以降試してみたいこと</th><th>前回の学びカード</th></tr>';
    hist.forEach(function(e) {
      const rc = e.recall ? ((e.recall.label ? '<b>' + esc(e.recall.label) + '</b>' : '') + (e.recall.note ? (e.recall.label ? '<br>' : '') + esc(cut(e.recall.note, Math.max(12, Math.round(L.t / 2)))) : '')) : '';
      h += '<tr><td><span class="nw">' + esc(md(e.date)) + '</span><br><span class="muted" style="font-size:0.85em">' + esc(cut(e.title, 18)) + '</span></td><td style="font-size:0.9em">' + esc(e.growth.join('・')) + '</td><td>' + esc(cut(e.reason, L.t)) + '</td><td>' + esc(cut(e.try, L.t)) + '</td><td>' + rc + '</td></tr>';
    });
    h += '</table>';
    if (hOm) h += '<div class="omit">※ 古い回 ' + hOm + '回分は省略しています（学びの記録で全部見られます）。</div>';
  }
  h += '</div>';
  // 7. 印象に残った言葉（☆）
  if (d.kept && d.kept.length) {
    const ks = d.kept.slice(-L.k);
    h += '<div class="sec"><h3>印象に残った言葉 <span class="sub">本人が☆をつけたもの' + (d.kept.length > ks.length ? '（新しい ' + ks.length + '件／全' + d.kept.length + '件）' : '') + '</span></h3>';
    ks.forEach(function(k) { h += '<div class="kw">' + esc(cut(k.body, L.kc)) + ' <span class="src">（' + esc(md(k.date)) + ' ' + esc(cut(k.title, 16)) + '）</span></div>'; });
    h += '</div>';
  }
  h += '<div class="foot">' + esc(RULE) + '<br>本人の記録・記入をそのまままとめたものです（点数・順位・評価ではありません）。管理者だけが見られます。取り扱いに注意してください。</div>';
  h += '</div>';
  return h;
}

const MM = 96 / 25.4;
function fit(page, d) {
  const avail = page.clientHeight - 18 * MM; // 上下の余白（9mm×2）を除いた高さ
  let ok = false;
  const LEVELS = levelsFor(d);
  for (let i = 0; i < LEVELS.length; i++) {
    const L = LEVELS[i];
    page.style.fontSize = L.fs + 'pt';
    page.innerHTML = build(d, L);
    const pin = page.querySelector('.pin');
    if (pin.offsetHeight <= avail - 1) { ok = true; break; }
  }
  if (!ok) page.insertAdjacentHTML('beforeend', '<div class="clipnote">※ 入りきらない部分は省略しています</div>');
}
function scaleOne(w) {
  const pw = 210 * MM, ph = 297 * MM;
  const avail = Math.min(document.documentElement.clientWidth - 12, pw);
  const s = Math.min(1, avail / pw);
  w.style.width = (pw * s) + 'px'; w.style.height = (ph * s) + 'px';
  w.firstChild.style.transform = s < 1 ? 'scale(' + s + ')' : 'none';
}
const DATA = [];
function addPage(d) {
  const w = document.createElement('div'); w.className = 'pwrap';
  const p = document.createElement('div'); p.className = 'page';
  w.appendChild(p); document.getElementById('pages').appendChild(w);
  if (d.missing) { p.innerHTML = '<div class="msg">会員が見つかりませんでした（ID ' + esc(d.id) + '）</div>'; }
  else fit(p, d);
  scaleOne(w);
  DATA.push({ w: w, p: p, d: d });
}
function refitAll() { DATA.forEach(function(x) { if (!x.d.missing) fit(x.p, x.d); scaleOne(x.w); }); }
window.addEventListener('resize', function() { DATA.forEach(function(x) { scaleOne(x.w); }); });
window.addEventListener('beforeprint', function() { DATA.forEach(function(x) { x.p.style.transform = 'none'; }); });
window.addEventListener('afterprint', function() { DATA.forEach(function(x) { scaleOne(x.w); }); });
document.getElementById('printBtn').addEventListener('click', function() { window.print(); });

async function main() {
  const st = document.getElementById('status');
  let ids = [], chunk = 10, label = '';
  try {
    if (params.get('group') || params.get('unset') === '1') {
      const q = params.get('unset') === '1' ? 'unset=1' : 'group=' + encodeURIComponent(params.get('group'));
      const r = await api('/api/admin/sheet-ids?' + q);
      ids = r.ids; chunk = r.chunk || 10; label = r.label;
    } else {
      ids = String(params.get('uids') || params.get('uid') || '').split(',').map(function(x) { return parseInt(x, 10); }).filter(function(x) { return x > 0; });
    }
  } catch (e) { document.getElementById('pages').innerHTML = '<div class="msg" style="color:#c62828">' + esc(e.message) + '</div>'; return; }
  if (!ids.length) { document.getElementById('pages').innerHTML = '<div class="msg">' + (label ? esc(label) + 'に会員がいません。' : '会員が指定されていません。') + '</div>'; return; }
  document.getElementById('pages').innerHTML = '';
  if (ids.length > 1) document.title = '個人まとめシート（' + (label ? label + '・' : '') + ids.length + '名）';
  const head = (label ? label + '：' : '') ;
  for (let i = 0; i < ids.length; i += chunk) {
    st.textContent = head + '読み込み中… ' + i + ' / ' + ids.length + '人';
    let r;
    try { r = await api('/api/admin/sheets?fy=' + FY + '&uids=' + ids.slice(i, i + chunk).join(',')); }
    catch (e) { st.innerHTML = '<span style="color:#c62828">' + esc(e.message) + '（' + i + '人目まで表示）</span>'; return; }
    RULE = r.rule_note || RULE;
    r.sheets.forEach(addPage);
    if (DATA.length === 1 && !DATA[0].d.missing) document.title = '個人まとめシート ' + DATA[0].d.user.name;
  }
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} refitAll(); }
  st.textContent = head + ids.length + '人分（' + ids.length + 'ページ）を表示しています。';
  document.getElementById('printBtn').disabled = false;
}
main();
</script>
</body></html>`
}
