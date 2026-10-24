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
// 前回の学びカードを始めた日（2026-10-22 夜に公開）。この日より前の回は「記録の対象外」として斜線で表示する。
// 基準日はここ1か所だけ（記録テーブル recall_reflections の最初の記録より前に公開しているため、コード上の公開日を使う）
export const RECALL_START_DATE = '2026-10-23'
export const RECALL_NA_NOTE = '前回の学びカードは2026年10月に始めた機能のため、それより前の回は斜線（記録なし）です。'
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
export const TARGET_RULE_NOTE = '参加状況の数え方：会の種類（研修・研究・その他）は管理者がイベントごとに決めています。【研修】対象回に対する参加率を出します（全体向けの回は全員、会名に「小学校」「中学校」の部会・「小中合同」とある回はその校種、「グループ」「授業力アップ」とある回は会名のグループの会員が対象）。【研究】部会などの研究の会は、推進部員の人だけ対象回（同じく会名の校種で判定）に対する参加率を出し、それ以外の人は参加回数だけを示します。【その他】参加回数だけを示します。まだ開かれていない回・出席者が一人もいない回は数えません。本人が出席した回は必ず含めます。'

// ---- 会の種類（研修／研究／その他） ----
// training=研修（全員向け：スキルアップ研修会・授業力アップなど） / research=研究（部会など） / other=その他
export const EVENT_KINDS = ['training', 'research', 'other']
export function normEventKind(v: any): string | null {
  const k = String(v == null ? '' : v)
  return EVENT_KINDS.indexOf(k) >= 0 ? k : null
}
// 会名からの推定（新しいイベントの初期値。migration 0013 の既存の回の初期値と同じ決め方）
export function guessEventKind(title: any): string {
  const t = normGroup(title)
  if (/部会|小中合同|研究/.test(t)) return 'research'
  if (/スキルアップ|授業力アップ|研修/.test(t)) return 'training'
  return 'other'
}

type Ctx = { fy: number; start: string; end: string; events: any[]; groupNames: string[]; am: any; stepKeywords?: Record<string, string[]> }

async function loadCtx(db: D1Database, fy: number, stepKeywords?: Record<string, string[]>): Promise<Ctx> {
  const [start, end] = fyRange(fy)
  const today = todayJST()
  const last = end < today ? end : today
  let evRows: any[] = []
  try {
    const r = await db.prepare(
      `SELECT e.id, e.title, e.event_date, e.event_kind,
         (SELECT COUNT(*) FROM attendances a WHERE a.event_id = e.id) + (SELECT COUNT(*) FROM guest_attendances g WHERE g.event_id = e.id) AS n
       FROM events e WHERE e.event_date >= ? AND e.event_date <= ? ORDER BY e.event_date, e.id`
    ).bind(start, last).all() as any
    evRows = r.results || []
  } catch (e) {
    const r = await db.prepare(
      `SELECT e.id, e.title, e.event_date, e.event_kind, (SELECT COUNT(*) FROM attendances a WHERE a.event_id = e.id) AS n
       FROM events e WHERE e.event_date >= ? AND e.event_date <= ? ORDER BY e.event_date, e.id`
    ).bind(start, last).all() as any
    evRows = r.results || []
  }
  const { results: gr } = await db.prepare("SELECT DISTINCT training_group g FROM users WHERE training_group IS NOT NULL AND training_group <> ''").all() as any
  const groupNames: string[] = []
  for (const r of (gr || [])) { const g = normGroup(r.g); if (g && groupNames.indexOf(g) < 0) groupNames.push(g) }
  // 長い名前から照合（「A」より「A-1」などを先に）
  groupNames.sort((a, b) => b.length - a.length)
  const events = evRows.map((e: any) => ({ id: e.id, title: e.title, date: e.event_date, n: Number(e.n) || 0, kind: normEventKind(e.event_kind) || 'other', target: classifyEvent(e.title, groupNames) }))
  const am = await loadAliases(db)
  return { fy, start, end, events, groupNames, am, stepKeywords }
}

// ---- 1人分を集める（すべて user_id で絞る。他の会員の情報は入らない） ----
export async function buildSheet(db: D1Database, uid: number, ctx: Ctx) {
  const { start, end } = ctx
  const [uR, attR, qaR, selR, noteR] = await db.batch([
    db.prepare('SELECT id, name, school, school_type, district, training_group, experience_years, promoter FROM users WHERE id = ?').bind(uid),
    db.prepare(`SELECT a.event_id, e.title, e.event_date, e.event_kind FROM attendances a JOIN events e ON e.id = a.event_id
                WHERE a.user_id = ? AND e.event_date >= ? AND e.event_date <= ? ORDER BY e.event_date, e.id`).bind(uid, start, end),
    db.prepare(`SELECT ca.event_id, ca.question_id, ca.answer_text, q.question_text, q.question_type, q.sort_order
                FROM custom_answers ca JOIN survey_questions q ON q.id = ca.question_id JOIN events e ON e.id = ca.event_id
                WHERE ca.user_id = ? AND e.event_date >= ? AND e.event_date <= ? ORDER BY e.event_date, q.sort_order`).bind(uid, start, end),
    db.prepare('SELECT viewpoint, step, memo FROM selections WHERE user_id = ?').bind(uid),
    db.prepare('SELECT goal, reflection FROM annual_notes WHERE user_id = ? AND fiscal_year = ?').bind(uid, ctx.fy)
  ]) as any[]
  const u = (uR && uR.results && uR.results[0]) as any
  if (!u) return null
  const [recR, keptR] = await Promise.all([
    db.prepare(
      `SELECT r.event_id, r.status, r.note, r.source_answer_text FROM recall_reflections r JOIN events e ON e.id = r.event_id
       WHERE r.user_id = ? AND e.event_date >= ? AND e.event_date <= ?`
    ).bind(uid, start, end).all().catch(() => null) as any,
    db.prepare(
      `SELECT k.body, e.title, e.event_date FROM kept_words k LEFT JOIN events e ON e.id = k.event_id
       WHERE k.user_id = ? AND (e.event_date IS NULL OR (e.event_date >= ? AND e.event_date <= ?)) ORDER BY e.event_date, k.id LIMIT 20`
    ).bind(uid, start, end).all().catch(() => null) as any
  ])
  const recalls: any[] = (recR && recR.results) || []
  const kept: any[] = (keptR && keptR.results) || []

  const sel: any[] = (selR && selR.results) || []
  const selBy: Record<string, any> = {}
  for (const s of sel) selBy[s.viewpoint] = s
  const st = inferSchoolType(String(u.school_type || ''), Object.keys(selBy))
  const group = normGroup(u.training_group)

  // 参加状況
  const attended: any[] = (attR && attR.results) || []
  const attSet = new Set<number>(attended.map((a: any) => a.event_id))
  // 種類ごと：研修＝対象回に対する率／研究＝推進部員だけ率（ほかの人は参加回数だけ）／その他＝参加回数だけ
  const promoter = !!u.promoter
  const rateKinds: Record<string, boolean> = { training: true, research: promoter, other: false }
  const rows: any[] = []
  const seen = new Set<number>()
  for (const ev of ctx.events) {
    const mine = attSet.has(ev.id)
    let target = false
    if (mine) target = true
    else if (ev.n > 0 && rateKinds[ev.kind]) {
      const tg = ev.target as EvTarget
      if (tg.kind === 'all') target = true
      else if (tg.kind === 'school') target = tg.types.indexOf(st) >= 0
      else if (tg.kind === 'group') target = !!group && tg.group === group
    }
    if (target) { rows.push({ date: ev.date, title: ev.title, attended: mine, kind: ev.kind }); seen.add(ev.id) }
  }
  // 出席したのに一覧に入っていない回（今日より後の日付の会に出席記録がある等）も必ず入れる
  for (const a of attended) {
    if (!seen.has(a.event_id)) { rows.push({ date: a.event_date, title: a.title, attended: true, kind: normEventKind(a.event_kind) || 'other' }); seen.add(a.event_id) }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const nAtt = rows.filter((r) => r.attended).length
  const byKind: Record<string, any> = {}
  for (const k of EVENT_KINDS) {
    const kr = rows.filter((r) => r.kind === k)
    const a = kr.filter((r) => r.attended).length
    byKind[k] = rateKinds[k]
      ? { attended: a, target: kr.length, rate: kr.length ? Math.round(a / kr.length * 100) : null, has_rate: true }
      : { attended: a, target: null, rate: null, has_rate: false }
  }

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
    .map((e) => ({ date: e.date, title: e.title, growth: e.growth, reason: e.reason.join(' / '), try: e.try.join(' / '), recall: e.recall, recall_na: !e.recall && String(e.date || '') < RECALL_START_DATE }))

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
    attendance: { rows, attended: nAtt, by_kind: byKind, promoter },
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
    // 人ごとの読み込みは並行して行う（1人分はすべて会員IDの索引で読む）
    const sheets: any[] = await Promise.all(ids.map(async (id) => (await buildSheet(db, id, ctx)) || { id, missing: true }))
    return c.json({ fy, rule_note: TARGET_RULE_NOTE, recall_note: RECALL_NA_NOTE, recall_start: RECALL_START_DATE, sheets })
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
<title>個人まとめシート - 学びの道しるべ</title>
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
.rate { border:0.4mm solid #1a237e; border-radius:2mm; padding:1.2mm 2.5mm; text-align:center; min-width:46mm; flex:none }
.rate table.kt { border-collapse:collapse; margin:0.6mm auto 0; font-size:0.95em }
.rate table.kt td { padding:0.1mm 1mm; text-align:left; white-space:nowrap; vertical-align:middle }
.rate .pro { margin-left:1.5mm; font-weight:700; color:#00695c; border:0.2mm solid #00897b; border-radius:0.8mm; padding:0 0.8mm }
.rate table.kt b { font-size:1.15em; color:#1a237e; margin:0 0.4mm }
.rate table.kt .pc { font-weight:700; color:#1a237e }
.kd { display:inline-block; font-size:0.78em; font-weight:700; border:0.2mm solid #777; border-radius:0.8mm; padding:0 0.8mm; line-height:1.35; white-space:nowrap }
.kd.k-training { border-color:#1565c0; color:#1565c0 }
.kd.k-research { border-color:#6a1b9a; color:#6a1b9a }
.kd.k-other { border-color:#607d8b; color:#455a64 }
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
table.s td.rc-na { background-color:#fff; background-image:repeating-linear-gradient(135deg, #b0b0b0 0, #b0b0b0 0.22mm, transparent 0.22mm, transparent 1.5mm) }
table.s td.rc-none { color:#999; text-align:center; vertical-align:middle }
.na-sw { display:inline-block; width:4.2mm; height:2.6mm; border:0.2mm solid #9e9e9e; vertical-align:-0.4mm; margin-right:0.8mm; background-image:repeating-linear-gradient(135deg, #b0b0b0 0, #b0b0b0 0.22mm, transparent 0.22mm, transparent 1.5mm) }
.bar-row { display:flex; align-items:center; gap:1.5mm; margin:0.6mm 0; font-size:0.92em }
.bar-row .n1 { width:24mm; flex:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
.bar-row .bt { flex:1; height:3mm; border:0.2mm solid #9e9e9e; background:#fff }
.bar-row .bf { height:100%; background:#3949ab }
.bar-row .n2 { width:9mm; flex:none; text-align:right; white-space:nowrap }
.stp { font-weight:700; white-space:nowrap }
.kw { border-left:0.8mm solid #555; padding:0.3mm 0 0.3mm 1.8mm; margin:0.8mm 0; font-size:0.95em }
.kw .src { font-size:0.8em; color:#555 }
.hd2 { display:flex; justify-content:space-between; align-items:baseline; gap:4mm; border-bottom:0.4mm solid #1a237e; padding-bottom:1.2mm; margin-bottom:2.5mm }
.hd2 .nm2 { font-family:'Zen Maru Gothic','Noto Sans JP',sans-serif; font-size:1.35em; font-weight:700 }
.hd2 .ttl2 { font-size:0.85em; color:#1a237e; font-weight:700 }
.backnote { text-align:center; color:#999; padding:30mm 0; font-size:1.1em }
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
  <select id="modeSel" aria-label="シートの形"><option value="single">1枚版（A4・1枚）</option><option value="duplex">両面2ページ版</option></select>
  <button class="tbtn" type="button" id="printBtn" disabled><i class="fas fa-print"></i> 印刷・PDFで保存</button>
</div>
<div class="hint" id="hint"></div>
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
let RNOTE = '';
const KIND_LABEL = { training: '研修', research: '研究', other: 'その他' };

// 1〜5（名前・参加状況・目標・視点・道しるべ）。<div class="pin"> を開いたまま返す
function buildTop(d, L) {
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
  h += '<div class="rate"><div class="sm">会への参加（種類ごと）' + (A.promoter ? '<span class="pro">推進部員</span>' : '') + '</div><table class="kt">';
  ['training', 'research', 'other'].forEach(function(k) {
    const b = (A.by_kind || {})[k] || { attended: 0, has_rate: false };
    let v;
    if (b.has_rate) v = b.target ? '<b>' + b.target + '</b>回中<b>' + b.attended + '</b>回<span class="pc">（' + (b.rate == null ? '―' : b.rate + '%') + '）</span>' : '<span class="muted">対象回なし</span>';
    else v = '参加<b>' + b.attended + '</b>回';
    h += '<tr><td><span class="kd k-' + k + '">' + KIND_LABEL[k] + '</span></td><td>' + v + '</td></tr>';
  });
  h += '</table></div></div>';

  h += '<div class="grid">';
  // 2. 参加した会の一覧（左）
  let rows = A.rows, omitted = 0;
  if (rows.length > L.a) { omitted = rows.length - L.a; rows = rows.slice(rows.length - L.a); }
  h += '<div class="sec"><h3>参加状況 <span class="sub">○＝出席　－＝欠席</span></h3>';
  if (!A.rows.length) h += '<div class="box muted">この年度の対象回・参加した回はまだありません。</div>';
  else {
    h += '<table class="s"><colgroup><col style="width:3.9em"><col style="width:3.8em"><col><col style="width:3.2em"></colgroup><tr><th>日付</th><th class="c nw">種類</th><th>会名</th><th class="c nw">出席</th></tr>';
    rows.forEach(function(r) { h += '<tr' + (r.attended ? '' : ' class="no"') + '><td class="nw">' + esc(md(r.date)) + '</td><td class="c nw"><span class="kd k-' + esc(r.kind) + '">' + (KIND_LABEL[r.kind] || 'その他') + '</span></td><td>' + esc(cut(r.title, 30)) + '</td><td class="c mk">' + (r.attended ? '○' : '－') + '</td></tr>'; });
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
  return h;
}
function build(d, L) {
  let h = buildTop(d, L);
  const hOm = d.history.length > L.h ? d.history.length - L.h : 0;
  h += histSection(d, L, d.history.slice(hOm), hOm, {});
  h += keptSection(d, L);
  h += footHtml();
  h += '</div>';
  return h;
}

// 6. 振り返りのあゆみ（rows＝載せる回、om＝省略した古い回の数）
// opt.cont：表面で「裏面へ続く」 / opt.back：裏面の続き / opt.none：表面に1行も載らず全部裏面
function histSection(d, L, rows, om, opt) {
  let h = '';
  const ttl = opt.back ? '振り返りのあゆみ（つづき）' : '振り返りのあゆみ';
  h += '<div class="sec" style="margin-bottom:2.5mm"><h3>' + ttl + ' <span class="sub">回ごとのアンケートと前回の学びカード（古い順）</span></h3>';
  if (!d.history.length) { h += '<div class="box muted">この年度のアンケートの記録はありません。</div></div>'; return h; }
  if (opt.none) { h += '<div class="omit">→ 振り返りのあゆみは裏面に載せています。</div></div>'; return h; }
  h += '<table class="s"><colgroup><col style="width:6.4em"><col style="width:7.2em"><col><col><col style="width:10em"></colgroup><tr><th>日付・会</th><th>選んだ視点</th><th>選んだ理由</th><th>明日以降試してみたいこと</th><th>前回の学びカード</th></tr>';
  rows.forEach(function(e) {
    const rc = e.recall ? ((e.recall.label ? '<b>' + esc(e.recall.label) + '</b>' : '') + (e.recall.note ? (e.recall.label ? '<br>' : '') + esc(cut(e.recall.note, Math.max(12, Math.round(L.t / 2)))) : '')) : '';
    const rcTd = e.recall ? '<td>' + rc + '</td>' : (e.recall_na ? '<td class="rc-na" title="記録の対象外（前回の学びカードを始める前の回）"></td>' : '<td class="rc-none">—</td>');
    h += '<tr class="hrow"><td><span class="nw">' + esc(md(e.date)) + '</span><br><span class="muted" style="font-size:0.85em">' + esc(cut(e.title, 18)) + '</span></td><td style="font-size:0.9em">' + esc(e.growth.join('・')) + '</td><td>' + esc(cut(e.reason, L.t)) + '</td><td>' + esc(cut(e.try, L.t)) + '</td>' + rcTd + '</tr>';
  });
  h += '</table>';
  if (om && !opt.back) h += '<div class="omit">※ 古い回 ' + om + '回分は省略しています（学びの記録で全部見られます）。</div>';
  if (opt.cont) h += '<div class="omit">→ 裏面に続きます。</div>';
  h += '</div>';
  return h;
}
// 7. 印象に残った言葉（☆）
function keptSection(d, L) {
  if (!d.kept || !d.kept.length) return '';
  let h = '';
  const ks = d.kept.slice(-L.k);
  h += '<div class="sec"><h3>印象に残った言葉 <span class="sub">本人が☆をつけたもの' + (d.kept.length > ks.length ? '（新しい ' + ks.length + '件／全' + d.kept.length + '件）' : '') + '</span></h3>';
  ks.forEach(function(k) { h += '<div class="kw">' + esc(cut(k.body, L.kc)) + ' <span class="src">（' + esc(md(k.date)) + ' ' + esc(cut(k.title, 16)) + '）</span></div>'; });
  h += '</div>';
  return h;
}
function footHtml() {
  return '<div class="foot">' + esc(RULE) + (RNOTE ? '<br><span class="na-sw"></span>' + esc(RNOTE) : '') + '<br>本人の記録・記入をそのまままとめたものです（点数・順位・評価ではありません）。管理者だけが見られます。取り扱いに注意してください。</div>';
}

// ---- 両面2ページ版 ----
// 表面：名前・参加状況・目標・視点・道しるべ・振り返りのあゆみ（入るだけ） / 裏面：あゆみの続き・印象に残った言葉・注記
// 省略しないのが基本。2ページに入らないときは文字を小さくし、それでも無理なら最古の回から省略して注記する。
const DUPLEX_STEPS = [
  { fs: 10,  t: 200, g: 600, m: 120, k: 20, kc: 160 },
  { fs: 9.5, t: 200, g: 600, m: 120, k: 20, kc: 160 },
  { fs: 9,   t: 200, g: 600, m: 120, k: 20, kc: 160 },
  { fs: 8.5, t: 200, g: 600, m: 120, k: 20, kc: 160 },
  { fs: 8,   t: 200, g: 600, m: 120, k: 20, kc: 160 },
  { fs: 7.5, t: 200, g: 600, m: 120, k: 20, kc: 160 },
  { fs: 7,   t: 150, g: 450, m: 90,  k: 12, kc: 130 },
  { fs: 6.5, t: 110, g: 320, m: 60,  k: 8,  kc: 100 }
];
function buildFront(d, L, rows, k, om) {
  let h = buildTop(d, L);
  if (k >= rows.length) h += histSection(d, L, rows, om, {});
  else if (k <= 0) h += histSection(d, L, [], om, { none: true });
  else h += histSection(d, L, rows.slice(0, k), om, { cont: true });
  return h + '</div>';
}
function buildBack(d, L, rows, k, om) {
  const u = d.user;
  let h = '<div class="pin"><div class="hd2"><div class="nm2">' + esc(u.name) + '</div><div class="ttl2">個人まとめシート　' + d.fy + '年度（令和' + (d.fy - 2018) + '年度）・裏面</div></div>';
  const rest = rows.slice(Math.max(0, k));
  const kept = keptSection(d, L);
  if (rest.length) h += histSection(d, L, rest, om, { back: true });
  if (kept) h += kept;
  if (!rest.length && !kept) h += '<div class="backnote">（このページは裏面です）</div>';
  if (om) h += '<div class="omit">※ 2ページに入りきらないため、古い回 ' + om + '回分を省略しています（学びの記録で全部見られます）。</div>';
  h += footHtml();
  return h + '</div>';
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
// 両面2ページ版：表と裏の2ページに分けて入れる
function fits(page) { return page.querySelector('.pin').offsetHeight <= page.clientHeight - 18 * MM - 1; }
function tryDuplex(p1, p2, d, L, om) {
  const rows = d.history.slice(om), n = rows.length;
  p1.style.fontSize = p2.style.fontSize = L.fs + 'pt';
  let k = n;
  p1.innerHTML = buildFront(d, L, rows, k, om);
  if (!fits(p1)) {
    // はみ出した高さぶん、表の下の回から裏面へ回す（見込みで減らしてから1回ずつ確かめる）
    const avail = p1.clientHeight - 18 * MM;
    let over = p1.querySelector('.pin').offsetHeight - avail + L.fs * 1.34 * 2.2;
    const trs = p1.querySelectorAll('tr.hrow');
    for (let t = trs.length - 1; t >= 0 && over > 0; t--) { over -= trs[t].offsetHeight; k--; }
    if (k < 0) k = 0;
    p1.innerHTML = buildFront(d, L, rows, k, om);
    while (!fits(p1) && k > 0) { k--; p1.innerHTML = buildFront(d, L, rows, k, om); }
    if (!fits(p1)) return false;
  }
  p2.innerHTML = buildBack(d, L, rows, k, om);
  return fits(p2);
}
function fit2(p1, p2, d) {
  for (let i = 0; i < DUPLEX_STEPS.length; i++) {
    if (tryDuplex(p1, p2, d, Object.assign({ h: 999, a: 999 }, DUPLEX_STEPS[i]), 0)) return;
  }
  // それでも入らないとき：いちばん小さい文字で、最古の回から省略
  const last = Object.assign({ h: 999, a: 999 }, DUPLEX_STEPS[DUPLEX_STEPS.length - 1]);
  for (let om = 1; om <= d.history.length; om++) { if (tryDuplex(p1, p2, d, last, om)) return; }
  const small = Object.assign({}, last, { a: 18 });
  if (tryDuplex(p1, p2, d, small, d.history.length)) return;
  p2.insertAdjacentHTML('beforeend', '<div class="clipnote">※ 入りきらない部分は省略しています</div>');
}

let MODE = params.get('mode') === 'duplex' ? 'duplex' : 'single';
const DATA = [];
function newWrap() {
  const w = document.createElement('div'); w.className = 'pwrap';
  const p = document.createElement('div'); p.className = 'page';
  w.appendChild(p); document.getElementById('pages').appendChild(w);
  return { w: w, p: p };
}
function layout(x) {
  // 1人分のページを作り直す（1枚版＝1ページ、両面版＝必ず2ページ）
  x.ws.forEach(function(o) { o.w.remove(); });
  const n = MODE === 'duplex' ? 2 : 1;
  x.ws = [];
  for (let i = 0; i < n; i++) x.ws.push(newWrap());
  const d = x.d;
  if (d.missing) {
    x.ws[0].p.innerHTML = '<div class="msg">会員が見つかりませんでした（ID ' + esc(d.id) + '）</div>';
    if (n === 2) x.ws[1].p.innerHTML = '<div class="msg">（このページは裏面です）</div>';
  } else if (n === 2) fit2(x.ws[0].p, x.ws[1].p, d);
  else fit(x.ws[0].p, d);
  x.ws.forEach(function(o) { scaleOne(o.w); });
}
function addPage(d) { const x = { d: d, ws: [] }; layout(x); DATA.push(x); }
function eachWrap(fn) { DATA.forEach(function(x) { x.ws.forEach(fn); }); }
function pageCount() { let n = 0; DATA.forEach(function(x) { n += x.ws.length; }); return n; }
function refitAll() { document.getElementById('pages').innerHTML = ''; DATA.forEach(function(x) { x.ws = []; layout(x); }); }
window.addEventListener('resize', function() { eachWrap(function(o) { scaleOne(o.w); }); });
window.addEventListener('beforeprint', function() { eachWrap(function(o) { o.p.style.transform = 'none'; }); });
window.addEventListener('afterprint', function() { eachWrap(function(o) { scaleOne(o.w); }); });
(function() {
  const ms = document.getElementById('modeSel');
  ms.value = MODE;
  ms.addEventListener('change', function() {
    MODE = ms.value === 'duplex' ? 'duplex' : 'single';
    if (MODE === 'duplex') params.set('mode', 'duplex'); else params.delete('mode');
    try { history.replaceState(null, '', location.pathname + '?' + params.toString()); } catch (e) {}
    showHint();
    if (DATA.length) { refitAll(); showDone(); }
  });
})();
function showHint() {
  document.getElementById('hint').innerHTML = (MODE === 'duplex'
    ? '両面2ページ版：1人分を表・裏の2ページにまとめ、振り返りの回を省略せずに載せます（入りきらないときは文字を小さくします）。1人が必ず2ページなので、まとめて印刷しても人がずれません。'
    : '1枚版：1人分をA4縦1枚にまとめています（入りきらないときは文字を小さくし、古い回などを省略します）。')
    + '<br>「印刷・PDFで保存」→ 用紙A4・縦、余白「なし」または「デフォルト」、倍率100%で印刷できます。<b>両面版は両面印刷（長辺とじ）で</b>印刷してください。PDFにするときは送信先で「PDFに保存」を選びます。';
}
showHint();
let DONE_MSG = '';
function showDone() { if (DONE_MSG) document.getElementById('status').textContent = DONE_MSG.replace('{p}', String(pageCount())); }
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
    RNOTE = r.recall_note || RNOTE;
    r.sheets.forEach(addPage);
    if (DATA.length === 1 && !DATA[0].d.missing) document.title = '個人まとめシート ' + DATA[0].d.user.name;
  }
  if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} refitAll(); }
  DONE_MSG = head + ids.length + '人分（{p}ページ）を表示しています。';
  showDone();
  document.getElementById('printBtn').disabled = false;
}
main();
</script>
</body></html>`
}
