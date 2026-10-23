// ========== 成長の視点：共通部品（読みかえ表・回答の読み取り） ==========
// 元の回答は書き換えない。集計・表示のときだけ「読みかえ表」(viewpoint_aliases) で共通の視点名にまとめる。

// 共通の視点名（表示順）と、成長の道しるべ（STEP表）の視点キーとの対応
export const GV_CANON: { name: string; group: string; keys: string[] }[] = [
  { name: '授業をつくる', group: '共通', keys: ['lesson_plan', 'j_lesson_plan'] },
  { name: '授業をする', group: '共通', keys: ['lesson_practice'] },
  { name: '子どもを見る', group: '共通', keys: ['student_eval', 'j_student_eval'] },
  { name: 'つながる', group: '共通', keys: ['connection', 'j_connection'] },
  { name: '深める', group: '共通', keys: ['research', 'j_research'] },
  { name: '資料', group: '中学校', keys: ['j_material'] },
  { name: '対話', group: '中学校', keys: ['j_dialogue'] },
  { name: '探究', group: '中学校', keys: ['j_inquiry'] },
  { name: '校内支援', group: '主幹・管理職', keys: ['a_school_support'] },
  { name: '学校経営', group: '主幹・管理職', keys: ['a_school_mgmt'] },
  { name: '会員支援', group: '主幹・管理職', keys: ['a_member_support'] },
  { name: '後進育成', group: '主幹・管理職', keys: ['a_leader_dev'] },
  { name: '運営貢献', group: '主幹・管理職', keys: ['a_org_mgmt'] },
  { name: '対外連携', group: '主幹・管理職', keys: ['a_outreach'] }
]

// 読みかえ表が無いとき（migration前）の初期値。migration 0008 の INSERT と同じ内容。
export const GV_DEFAULT_ALIASES: Record<string, string> = {
  '授業をつくる': '授業をつくる', '授業を作る': '授業をつくる',
  '授業をする': '授業をする', '授業をする・磨く': '授業をする',
  '子どもを見る': '子どもを見る', '子どもを見る・評価する': '子どもを見る', '生徒を見る': '子どもを見る',
  'つながる': 'つながる', '仲間とつながる': 'つながる',
  '深める': '深める', '研究・発信する': '深める',
  '資料': '資料', '対話': '対話', '探究': '探究',
  '校内支援': '校内支援', '学校経営': '学校経営', '会員支援': '会員支援',
  '後進育成': '後進育成', '運営貢献': '運営貢献', '対外連携': '対外連携'
}

export const GV_Q_SQL = "q.question_text LIKE '%成長の視点%'"

export function fyRange(fy: number): [string, string] {
  return [`${fy}-04-01`, `${fy + 1}-03-31`]
}
export function fyOfDate(ds: string): number | null {
  const m = /^(\d{4})-(\d{2})/.exec(ds || '')
  if (!m) return null
  const y = +m[1], mo = +m[2]
  return mo >= 4 ? y : y - 1
}
export function currentFY(): number {
  const now = new Date(Date.now() + 9 * 3600 * 1000) // 日本時間
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1
  return m >= 4 ? y : y - 1
}
export function parseFY(v: any): number {
  const n = parseInt(String(v || ''), 10)
  return Number.isFinite(n) && n >= 2000 && n <= 3000 ? n : currentFY()
}

// 複数選択の回答（「、」区切り）を選択肢に分ける
export function splitChoices(text: any): string[] {
  const out: string[] = []
  for (const p of String(text == null ? '' : text).split(/[、,，]/)) {
    const t = p.trim()
    if (t && out.indexOf(t) < 0) out.push(t)
  }
  return out
}

// 質問の種類（文面から判定。回によって言い回しが少し違う）
export type QKind = 'growth' | 'reason' | 'try' | 'impression' | 'other' | 'choice'
export function questionKind(q: { question_text?: string; question_type?: string }): QKind {
  const t = String(q.question_text || '')
  if (t.indexOf('成長の視点') >= 0) return 'growth'
  if (q.question_type && q.question_type !== 'text') return 'choice'
  if (t.indexOf('選んだ理由') >= 0) return 'reason'
  if (t.indexOf('試してみたい') >= 0) return 'try'
  if (t.indexOf('感想') >= 0 || t.indexOf('学びになった') >= 0 || t.indexOf('自由記述') >= 0) return 'impression'
  return 'other'
}
export const QKIND_LABEL: Record<string, string> = {
  reason: '選んだ理由', try: '試してみたいこと', impression: '感想・学び', other: 'その他の記述'
}

export type AliasMap = { map: Record<string, string>; fromTable: boolean }

export async function loadAliases(db: D1Database): Promise<AliasMap> {
  try {
    const { results } = await db.prepare('SELECT alias, canonical FROM viewpoint_aliases').all() as any
    const map: Record<string, string> = {}
    for (const r of (results || [])) map[String(r.alias)] = String(r.canonical || '')
    return { map, fromTable: true }
  } catch (e) {
    return { map: { ...GV_DEFAULT_ALIASES }, fromTable: false }
  }
}

// 元の選択肢 → 共通の視点名。'' は「集計に入れない」、null は「読みかえ未設定」
export function canonOf(alias: string, am: AliasMap): string | null {
  if (Object.prototype.hasOwnProperty.call(am.map, alias)) return am.map[alias]
  return null
}

// 共通の視点名の並び順（既定の順 → 読みかえ表にだけある名前）
export function canonOrder(am: AliasMap): string[] {
  const names = GV_CANON.map((c) => c.name)
  for (const k of Object.keys(am.map)) {
    const v = am.map[k]
    if (v && names.indexOf(v) < 0) names.push(v)
  }
  return names
}

export function gvEsc(s: any): string {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// 名前（会員・ゲスト）を伏せるための語リスト（長い順）
export async function loadAllNameTokens(db: D1Database): Promise<string[]> {
  const tokens: string[] = []
  const add = (rawIn: any) => {
    const raw = String(rawIn || '').trim()
    if (!raw) return
    const compact = raw.replace(/[\s　]+/g, '')
    if (compact.length >= 2) tokens.push(compact)
    if (raw !== compact && raw.length >= 2) tokens.push(raw)
    for (const part of raw.split(/[\s　]+/)) if (part && part.length >= 2) tokens.push(part)
  }
  const { results: u } = await db.prepare('SELECT name FROM users').all() as any
  for (const r of (u || [])) add(r.name)
  try {
    const { results: g } = await db.prepare('SELECT DISTINCT name FROM guest_attendances').all() as any
    for (const r of (g || [])) add(r.name)
  } catch (e) { /* ignore */ }
  return Array.from(new Set(tokens)).sort((a, b) => b.length - a.length)
}

// 画面共通の見た目（今のデザインに合わせる：管理者は紺、会員はオレンジ）
export const GV_ADMIN_CSS = `
body{background:#f5f5f5;margin:0}
.top-bar{background:#1a237e;color:#fff;padding:10px 20px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:100;gap:8px;flex-wrap:wrap}
.top-bar .logo{font-family:'Zen Maru Gothic',sans-serif;font-size:18px;font-weight:700}
.top-bar .nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.btn-sm{padding:6px 12px;border-radius:8px;border:none;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:5px}
.btn-back{background:rgba(255,255,255,0.2);color:#fff}
.container{max-width:1100px;margin:0 auto;padding:20px 14px 60px}
.card{background:#fff;border-radius:14px;box-shadow:0 2px 8px rgba(0,0,0,0.08);padding:16px 18px;margin-bottom:18px}
.card h2{font-size:16px;color:#1a237e;margin:0 0 10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.note{font-size:12px;color:#777;line-height:1.7}
.btn{padding:8px 16px;border-radius:10px;border:none;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px}
.btn-primary{background:#1a237e;color:#fff}
.btn-orange{background:#e65100;color:#fff}
.btn-gray{background:#eee;color:#555}
.btn-red{background:#c62828;color:#fff}
.btn:disabled{opacity:.5;cursor:default}
select,input[type=text]{font-family:inherit;font-size:14px;padding:7px 10px;border:2px solid #e0e0e0;border-radius:8px;background:#fff}
.tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table.t{border-collapse:collapse;width:100%;font-size:13px}
table.t th,table.t td{border-bottom:1px solid #eee;padding:7px 8px;text-align:left;vertical-align:top}
table.t th{background:#f5f6fb;color:#1a237e;font-size:12px;white-space:nowrap}
table.t td.num,table.t th.num{text-align:right;white-space:nowrap}
.msg{text-align:center;color:#888;padding:30px 10px;font-size:14px}
.err{color:#c62828}
.pill{display:inline-block;font-size:11px;padding:1px 8px;border-radius:10px;background:#eef2ff;color:#1a237e;font-weight:700;white-space:nowrap}
.pill.warn{background:#fff3e0;color:#e65100}
.pill.gray{background:#eee;color:#777}
@media(max-width:600px){.container{padding:12px 8px 50px}.card{padding:12px}.top-bar .logo{font-size:16px}table.t{font-size:12px}}
`
