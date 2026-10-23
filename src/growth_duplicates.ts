// ========== 重複のまとめ（管理者のみ） ==========
// 同姓同名・表記ゆれ（スペースの有無）の会員候補と、会員と同名のゲストを一覧にする。
// 自動統合は絶対にしない。管理者が見比べて「同じ人」と確定したときだけ統合し、記録を残す（元に戻せる）。
import { GV_ADMIN_CSS, fyOfDate } from './growth_common'

type Deps = { authMiddleware: any; adminMiddleware: any; commonHead: string }

export function normName(s: any): string {
  return String(s == null ? '' : s).normalize('NFKC').replace(/[\s　]+/g, '')
}
function ints(a: any[]): number[] { return a.map((x) => parseInt(String(x), 10)).filter((n) => Number.isFinite(n) && n > 0) }
function inList(ids: number[]): string { return '(' + ints(ids).join(',') + ')' }

async function tableExists(db: D1Database, name: string): Promise<boolean> {
  const r = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").bind(name).first()
  return !!r
}

// 会員どうしの統合で付け替える表（key = 重なりを判定する列）
type MTable = { table: string; col: string; key: string[]; where?: string; label: string }
const MEMBER_TABLES: MTable[] = [
  { table: 'attendances', col: 'user_id', key: ['event_id'], label: '出席' },
  { table: 'custom_answers', col: 'user_id', key: ['event_id', 'question_id'], label: 'アンケートの回答' },
  { table: 'survey_answers', col: 'user_id', key: ['event_id'], label: 'アンケート送信の記録' },
  { table: 'points', col: 'user_id', key: ['event_id'], label: 'ポイント' },
  { table: 'recall_reflections', col: 'user_id', key: ['event_id'], label: '前回の学びカード' },
  { table: 'annual_notes', col: 'user_id', key: ['fiscal_year'], label: '今年度の目標・振り返り' },
  { table: 'selections', col: 'user_id', key: ['viewpoint'], label: '成長の道しるべ（STEP）' },
  { table: 'support_notes', col: 'user_id', key: ['fiscal_year'], label: '伴走メモ' },
  { table: 'user_points', col: 'user_id', key: ['fiscal_year'], label: '年度ポイント' },
  { table: 'kept_words', col: 'user_id', key: ['event_id', 'question_id'], label: '印象に残った言葉' },
  { table: 'share_consents', col: 'respondent_id', key: ['event_id'], where: "respondent_type = 'member'", label: '紹介の同意' },
  { table: 'shared_insights', col: 'respondent_id', key: ['event_id', 'question_id'], where: "respondent_type = 'member'", label: '採用した気づき' }
]

async function memberInfo(db: D1Database, uid: number) {
  const u = await db.prepare("SELECT id, name, email, school, school_type, district, experience_years, role, datetime(created_at,'+9 hours') created_at FROM users WHERE id = ?").bind(uid).first() as any
  if (!u) return null
  const a = await db.prepare('SELECT COUNT(*) n, MAX(e.event_date) last FROM attendances a JOIN events e ON e.id = a.event_id WHERE a.user_id = ?').bind(uid).first() as any
  const c = await db.prepare("SELECT COUNT(DISTINCT event_id) n FROM custom_answers WHERE user_id = ? AND trim(COALESCE(answer_text,'')) <> ''").bind(uid).first() as any
  const s = await db.prepare('SELECT MAX(expires_at) x FROM sessions WHERE user_id = ?').bind(uid).first() as any
  return { ...u, attend_count: a?.n || 0, last_event: a?.last || '', answered_events: c?.n || 0, has_session: !!s?.x }
}

// ---- ゲスト → 会員 の計画 ----
async function planGuest(db: D1Database, gid: number, uid: number) {
  const g = await db.prepare('SELECT * FROM guest_attendances WHERE id = ?').bind(gid).first() as any
  if (!g) return { error: 'ゲストの記録が見つかりません（すでに統合済みかもしれません）' }
  const u = await db.prepare('SELECT id, role FROM users WHERE id = ?').bind(uid).first() as any
  if (!u) return { error: '会員が見つかりません' }
  const ev = await db.prepare('SELECT id, title, event_date FROM events WHERE id = ?').bind(g.event_id).first() as any
  const { results: ga } = await db.prepare('SELECT ga.*, q.question_text, q.sort_order FROM guest_answers ga LEFT JOIN survey_questions q ON q.id = ga.question_id WHERE ga.guest_id = ? ORDER BY q.sort_order').bind(gid).all() as any
  const att = await db.prepare('SELECT id FROM attendances WHERE event_id = ? AND user_id = ?').bind(g.event_id, uid).first() as any
  const { results: ma } = await db.prepare('SELECT ca.question_id, ca.answer_text, q.question_text FROM custom_answers ca LEFT JOIN survey_questions q ON q.id = ca.question_id WHERE ca.event_id = ? AND ca.user_id = ?').bind(g.event_id, uid).all() as any
  const sa = await db.prepare('SELECT id FROM survey_answers WHERE event_id = ? AND user_id = ?').bind(g.event_id, uid).first() as any
  const pt = await db.prepare('SELECT id FROM points WHERE event_id = ? AND user_id = ?').bind(g.event_id, uid).first() as any
  let gsc: any = null, msc: any = null, insights: any[] = []
  try {
    gsc = await db.prepare("SELECT * FROM share_consents WHERE event_id = ? AND respondent_type = 'guest' AND respondent_id = ?").bind(g.event_id, gid).first()
    msc = await db.prepare("SELECT id FROM share_consents WHERE event_id = ? AND respondent_type = 'member' AND respondent_id = ?").bind(g.event_id, uid).first()
    const r = await db.prepare("SELECT id, question_id FROM shared_insights WHERE event_id = ? AND respondent_type = 'guest' AND respondent_id = ?").bind(g.event_id, gid).all() as any
    insights = r.results || []
  } catch (e) { /* 機能が無い環境 */ }
  const memberQ: Record<number, string> = {}
  for (const r of (ma || [])) memberQ[r.question_id] = r.answer_text || ''
  const conflicts = (ga || []).filter((a: any) => Object.prototype.hasOwnProperty.call(memberQ, a.question_id))
  const answers = (ga || []).filter((a: any) => !Object.prototype.hasOwnProperty.call(memberQ, a.question_id))
  const hasText = answers.some((a: any) => String(a.answer_text || '').trim())
  const blocked: string[] = []
  if (u.role === 'admin') blocked.push('管理者のアカウントには統合できません')
  if (conflicts.length) blocked.push('この会員は、同じ回の同じ質問にすでに回答しています（別の人の可能性があります）。統合できません')
  const memberInsights = insights.length ? await db.prepare("SELECT question_id FROM shared_insights WHERE event_id = ? AND respondent_type = 'member' AND respondent_id = ?").bind(g.event_id, uid).all() as any : { results: [] }
  const miq = new Set((memberInsights.results || []).map((r: any) => r.question_id))
  if (insights.some((r: any) => miq.has(r.question_id))) blocked.push('採用した気づきが重なっています。統合できません')
  return {
    guest: g, event: ev, guest_answers: ga || [], member_answers: ma || [], conflicts,
    add: {
      attendance: !att, answers: answers.map((a: any) => a.question_id),
      survey_answer: hasText && !sa, points: hasText && !pt,
      share_consent_member: !!gsc && !msc, insights: insights.map((r: any) => r.id)
    },
    member_attended: !!att, blocked
  }
}

// ---- 会員 → 会員 の計画 ----
async function planMember(db: D1Database, src: number, dst: number) {
  if (src === dst) return { error: '同じ会員です' }
  const a = await db.prepare('SELECT id, name, role FROM users WHERE id = ?').bind(src).first() as any
  const b = await db.prepare('SELECT id, name, role FROM users WHERE id = ?').bind(dst).first() as any
  if (!a || !b) return { error: '会員が見つかりません' }
  const blocked: string[] = []
  if (a.role === 'admin' || b.role === 'admin') blocked.push('管理者のアカウントは統合できません')
  const prev = await db.prepare("SELECT id FROM merge_logs WHERE kind = 'member_to_member' AND (source_id = ? OR source_id = ?) AND undone_at IS NULL").bind(src, dst).first()
  if (prev) blocked.push('どちらかのアカウントは、すでに別の会員に統合されています（統合の記録から元に戻してから行ってください）')
  const tables: any[] = []
  for (const t of MEMBER_TABLES) {
    if (!(await tableExists(db, t.table))) continue
    const w = t.where ? ' AND ' + t.where : ''
    const keySql = t.key.map((k) => "COALESCE(CAST(" + k + " AS TEXT),'-')").join(" || ':' || ")
    const { results: ar } = await db.prepare(`SELECT id, ${keySql} AS k FROM ${t.table} WHERE ${t.col} = ?${w}`).bind(src).all() as any
    const { results: br } = await db.prepare(`SELECT ${keySql} AS k FROM ${t.table} WHERE ${t.col} = ?${w}`).bind(dst).all() as any
    const bk = new Set((br || []).map((r: any) => r.k))
    const move = (ar || []).filter((r: any) => !bk.has(r.k)).map((r: any) => r.id)
    const keep = (ar || []).filter((r: any) => bk.has(r.k)).map((r: any) => r.id)
    if (move.length || keep.length) tables.push({ table: t.table, col: t.col, where: t.where || '', label: t.label, move, keep })
  }
  // 両方が出席している回（重なり）
  const { results: both } = await db.prepare('SELECT e.title, e.event_date FROM attendances a1 JOIN attendances a2 ON a2.event_id = a1.event_id AND a2.user_id = ? JOIN events e ON e.id = a1.event_id WHERE a1.user_id = ? ORDER BY e.event_date').bind(dst, src).all() as any
  return { source: a, target: b, tables, both_events: both || [], blocked }
}

export function registerDuplicates(app: any, deps: Deps) {
  const { authMiddleware, adminMiddleware, commonHead } = deps

  // 候補一覧
  app.get('/api/admin/duplicates', authMiddleware, adminMiddleware, async (c: any) => {
    const db = c.env.DB as D1Database
    const { results: users } = await db.prepare(
      `SELECT u.id, u.name, u.email, u.school, u.school_type, u.district, u.experience_years, u.role, datetime(u.created_at,'+9 hours') created_at,
        (SELECT COUNT(*) FROM attendances a WHERE a.user_id = u.id) attend_count,
        (SELECT MAX(e.event_date) FROM attendances a JOIN events e ON e.id = a.event_id WHERE a.user_id = u.id) last_event,
        (SELECT COUNT(DISTINCT ca.event_id) FROM custom_answers ca WHERE ca.user_id = u.id AND trim(COALESCE(ca.answer_text,'')) <> '') answered_events
       FROM users u ORDER BY u.id`
    ).all() as any
    const { results: dis } = await db.prepare('SELECT kind, a_id, b_id FROM duplicate_dismissals').all() as any
    const disSet = new Set((dis || []).map((d: any) => d.kind + ':' + d.a_id + ':' + d.b_id))
    const { results: logs } = await db.prepare("SELECT source_id, target_id FROM merge_logs WHERE kind = 'member_to_member' AND undone_at IS NULL").all() as any
    const mergedInto: Record<number, number> = {}
    for (const l of (logs || [])) mergedInto[l.source_id] = l.target_id

    const byNorm: Record<string, any[]> = {}
    for (const u of (users || [])) { const k = normName(u.name); if (!k) continue; (byNorm[k] = byNorm[k] || []).push({ ...u, merged_into: mergedInto[u.id] || null }) }
    const memberGroups: any[] = []
    for (const k of Object.keys(byNorm)) {
      const list = byNorm[k]
      if (list.length < 2) continue
      const active = list.filter((u) => !u.merged_into)
      const pairs: any[] = []
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const x = Math.min(list[i].id, list[j].id), y = Math.max(list[i].id, list[j].id)
        pairs.push({ a: x, b: y, dismissed: disSet.has('member_member:' + x + ':' + y) })
      }
      const open = active.length >= 2 && pairs.some((p) => !p.dismissed && !mergedInto[p.a] && !mergedInto[p.b])
      const sameRaw = list.every((u) => u.name === list[0].name)
      memberGroups.push({ key: k, type: sameRaw ? '同姓同名' : '表記ゆれ（スペースなど）', members: list, pairs, open })
    }
    memberGroups.sort((x, y) => (x.open === y.open ? 0 : x.open ? -1 : 1))

    const { results: guests } = await db.prepare(
      `SELECT g.id, g.event_id, g.name, g.school, g.district, g.experience_years, datetime(g.attended_at,'+9 hours') attended_at, e.title, e.event_date,
        (SELECT COUNT(*) FROM guest_answers ga WHERE ga.guest_id = g.id AND trim(COALESCE(ga.answer_text,'')) <> '') answer_count
       FROM guest_attendances g LEFT JOIN events e ON e.id = g.event_id ORDER BY e.event_date, g.id`
    ).all() as any
    const { results: attRows } = await db.prepare('SELECT event_id, user_id FROM attendances').all() as any
    const attSet = new Set((attRows || []).map((r: any) => r.event_id + ':' + r.user_id))
    const guestMatches: any[] = []
    for (const g of (guests || [])) {
      const cands = (byNorm[normName(g.name)] || []).filter((u) => u.role !== 'admin' && !u.merged_into)
      if (!cands.length) continue
      const cl = cands.map((u) => ({
        id: u.id, name: u.name, school: u.school, district: u.district, experience_years: u.experience_years, school_type: u.school_type,
        same_school: !!(g.school && u.school && normName(g.school) === normName(u.school)),
        attended_same_event: attSet.has(g.event_id + ':' + u.id),
        dismissed: disSet.has('guest_member:' + g.id + ':' + u.id)
      }))
      guestMatches.push({ guest: g, candidates: cl, open: cl.some((x) => !x.dismissed) })
    }
    guestMatches.sort((x, y) => (x.open === y.open ? 0 : x.open ? -1 : 1))
    return c.json({ member_groups: memberGroups, guest_matches: guestMatches })
  })

  // 統合前の見比べ（何がどう変わるか）
  app.get('/api/admin/duplicates/preview', authMiddleware, adminMiddleware, async (c: any) => {
    const db = c.env.DB as D1Database
    const kind = c.req.query('kind')
    const source = parseInt(c.req.query('source') || '', 10), target = parseInt(c.req.query('target') || '', 10)
    if (!source || !target) return c.json({ error: '指定が不正です' }, 400)
    if (kind === 'guest') {
      const p: any = await planGuest(db, source, target)
      if (p.error) return c.json({ error: p.error }, 404)
      const g = { ...p.guest }; delete g.token; delete g.edit_token_hash
      return c.json({ ...p, guest: g, member: await memberInfo(db, target) })
    }
    if (kind === 'member') {
      const p: any = await planMember(db, source, target)
      if (p.error) return c.json({ error: p.error }, 400)
      const evq = 'SELECT e.event_date, e.title FROM attendances a JOIN events e ON e.id = a.event_id WHERE a.user_id = ? ORDER BY e.event_date'
      const se = await db.prepare(evq).bind(source).all() as any
      const te = await db.prepare(evq).bind(target).all() as any
      return c.json({
        ...p, source_info: await memberInfo(db, source), target_info: await memberInfo(db, target),
        source_events: se.results || [], target_events: te.results || [],
        tables: p.tables.map((t: any) => ({ table: t.table, label: t.label, move: t.move.length, keep: t.keep.length }))
      })
    }
    return c.json({ error: '種類が不正です' }, 400)
  })

  // 統合する（管理者が確認した時だけ）
  app.post('/api/admin/duplicates/merge', authMiddleware, adminMiddleware, async (c: any) => {
    const db = c.env.DB as D1Database
    const me = c.get('user')
    let body: any = {}
    try { body = await c.req.json() } catch (e) { return c.json({ error: '入力が不正です' }, 400) }
    if (body.confirm !== true) return c.json({ error: '「同じ人だと確認しました」にチェックしてください' }, 400)
    const source = parseInt(String(body.source || ''), 10), target = parseInt(String(body.target || ''), 10)
    if (!source || !target) return c.json({ error: '指定が不正です' }, 400)

    if (body.kind === 'guest') {
      const p: any = await planGuest(db, source, target)
      if (p.error) return c.json({ error: p.error }, 404)
      if (p.blocked.length) return c.json({ error: p.blocked.join('／') }, 409)
      const g = p.guest, eid = g.event_id
      const S: any[] = []
      if (p.add.attendance) S.push(db.prepare('INSERT INTO attendances (event_id, user_id, attended_at) VALUES (?,?,?)').bind(eid, target, g.attended_at || null))
      const addSet = new Set(p.add.answers)
      for (const a of p.guest_answers) if (addSet.has(a.question_id)) S.push(db.prepare('INSERT INTO custom_answers (event_id, user_id, question_id, answer_text) VALUES (?,?,?,?)').bind(eid, target, a.question_id, a.answer_text || ''))
      if (p.add.survey_answer) S.push(db.prepare('INSERT INTO survey_answers (event_id, user_id, satisfaction, comment, answered_at) VALUES (?,?,NULL,\'\',?)').bind(eid, target, (p.guest_answers[0] && p.guest_answers[0].answered_at) || g.attended_at || null))
      if (p.add.points) S.push(db.prepare("INSERT OR IGNORE INTO points (user_id, event_id, points, reason, fiscal_year) VALUES (?, ?, 1, 'event_survey', ?)").bind(target, eid, fyOfDate(p.event?.event_date || '') || 2000))
      let gsc: any = null
      try { gsc = await db.prepare("SELECT * FROM share_consents WHERE event_id = ? AND respondent_type = 'guest' AND respondent_id = ?").bind(eid, source).first() } catch (e) { gsc = null }
      if (gsc) {
        if (p.add.share_consent_member) S.push(db.prepare("INSERT INTO share_consents (event_id, respondent_type, respondent_id, consent, created_at, updated_at) VALUES (?, 'member', ?, ?, ?, ?)").bind(eid, target, gsc.consent, gsc.created_at, gsc.updated_at))
        S.push(db.prepare('DELETE FROM share_consents WHERE id = ?').bind(gsc.id))
      }
      if (p.add.insights.length) S.push(db.prepare(`UPDATE shared_insights SET respondent_type = 'member', respondent_id = ? WHERE id IN ${inList(p.add.insights)}`).bind(target))
      S.push(db.prepare('DELETE FROM guest_answers WHERE guest_id = ?').bind(source))
      S.push(db.prepare('DELETE FROM guest_attendances WHERE id = ?').bind(source))
      const detail = {
        guest: g, guest_answers: p.guest_answers.map((a: any) => ({ id: a.id, guest_id: a.guest_id, event_id: a.event_id, question_id: a.question_id, answer_text: a.answer_text, answered_at: a.answered_at })),
        guest_share_consent: gsc, add: p.add
      }
      const summary = 'ゲスト「' + g.name + '」（' + (p.event?.event_date || '') + ' ' + (p.event?.title || '') + '）の回答' + p.add.answers.length + '件を会員ID ' + target + ' に付け替え'
      S.push(db.prepare("INSERT INTO merge_logs (kind, source_id, target_id, summary, detail, merged_by, merged_at) VALUES ('guest_to_member', ?, ?, ?, ?, ?, datetime('now'))").bind(source, target, summary, JSON.stringify(detail), me.id))
      try { await db.batch(S) } catch (e: any) { return c.json({ error: '統合できませんでした（何も変更していません）：' + String(e?.message || e).slice(0, 120) }, 500) }
      return c.json({ success: true, summary })
    }

    if (body.kind === 'member') {
      const p: any = await planMember(db, source, target)
      if (p.error) return c.json({ error: p.error }, 400)
      if (p.blocked.length) return c.json({ error: p.blocked.join('／') }, 409)
      const S: any[] = []
      const moved: Record<string, number[]> = {}
      let n = 0
      for (const t of p.tables) {
        if (!t.move.length) continue
        moved[t.table] = t.move
        n += t.move.length
        S.push(db.prepare(`UPDATE ${t.table} SET ${t.col} = ? WHERE ${t.col} = ? AND id IN ${inList(t.move)}${t.where ? ' AND ' + t.where : ''}`).bind(target, source))
      }
      const kept: Record<string, number> = {}
      for (const t of p.tables) if (t.keep.length) kept[t.table] = t.keep.length
      const summary = '会員「' + p.source.name + '」(ID ' + source + ') の記録' + n + '件を「' + p.target.name + '」(ID ' + target + ') に付け替え' + (Object.keys(kept).length ? '（重なっていた' + Object.values(kept).reduce((s: number, x: any) => s + x, 0) + '件は元のアカウントに残しました）' : '')
      S.push(db.prepare("INSERT INTO merge_logs (kind, source_id, target_id, summary, detail, merged_by, merged_at) VALUES ('member_to_member', ?, ?, ?, ?, ?, datetime('now'))").bind(source, target, summary, JSON.stringify({ moved, kept }), me.id))
      try { await db.batch(S) } catch (e: any) { return c.json({ error: '統合できませんでした（何も変更していません）：' + String(e?.message || e).slice(0, 120) }, 500) }
      return c.json({ success: true, summary })
    }
    return c.json({ error: '種類が不正です' }, 400)
  })

  // 統合の記録
  app.get('/api/admin/duplicates/logs', authMiddleware, adminMiddleware, async (c: any) => {
    const db = c.env.DB as D1Database
    const { results } = await db.prepare(
      `SELECT l.id, l.kind, l.source_id, l.target_id, l.summary, datetime(l.merged_at,'+9 hours') merged_at, datetime(l.undone_at,'+9 hours') undone_at,
        u1.name merged_by_name, u2.name undone_by_name, t.name target_name
       FROM merge_logs l LEFT JOIN users u1 ON u1.id = l.merged_by LEFT JOIN users u2 ON u2.id = l.undone_by LEFT JOIN users t ON t.id = l.target_id
       ORDER BY l.id DESC LIMIT 200`
    ).all() as any
    return c.json({ logs: results || [] })
  })

  // 元に戻す
  app.post('/api/admin/duplicates/undo', authMiddleware, adminMiddleware, async (c: any) => {
    const db = c.env.DB as D1Database
    const me = c.get('user')
    let body: any = {}
    try { body = await c.req.json() } catch (e) { return c.json({ error: '入力が不正です' }, 400) }
    const id = parseInt(String(body.log_id || ''), 10)
    const log = id ? await db.prepare('SELECT * FROM merge_logs WHERE id = ?').bind(id).first() as any : null
    if (!log) return c.json({ error: '記録が見つかりません' }, 404)
    if (log.undone_at) return c.json({ error: 'すでに元に戻しています' }, 409)
    let d: any = {}
    try { d = JSON.parse(log.detail || '{}') } catch (e) { return c.json({ error: '記録が読めません' }, 500) }
    const S: any[] = []
    if (log.kind === 'guest_to_member') {
      const g = d.guest, uid = log.target_id, eid = g.event_id
      const exists = await db.prepare('SELECT id FROM guest_attendances WHERE id = ?').bind(g.id).first()
      if (exists) return c.json({ error: 'ゲストの記録がすでにあります。元に戻せません' }, 409)
      // 統合のあと会員が回答を書き直していたら、勝手に消さない
      const ansById: Record<number, string> = {}
      for (const a of (d.guest_answers || [])) ansById[a.question_id] = a.answer_text || ''
      const qids: number[] = ints(d.add?.answers || [])
      if (qids.length) {
        const { results: cur } = await db.prepare(`SELECT question_id, answer_text FROM custom_answers WHERE event_id = ? AND user_id = ? AND question_id IN ${inList(qids)}`).bind(eid, uid).all() as any
        const changed = (cur || []).filter((r: any) => (r.answer_text || '') !== (ansById[r.question_id] || ''))
        if (changed.length) return c.json({ error: '統合のあと、会員の側で回答が書き直されています（' + changed.length + '件）。自動では元に戻せません。運営で相談してください' }, 409)
        S.push(db.prepare(`DELETE FROM custom_answers WHERE event_id = ? AND user_id = ? AND question_id IN ${inList(qids)}`).bind(eid, uid))
      }
      if (d.add?.attendance) {
        const other = await db.prepare("SELECT COUNT(*) n FROM custom_answers WHERE event_id = ? AND user_id = ?" + (qids.length ? ` AND question_id NOT IN ${inList(qids)}` : '')).bind(eid, uid).first() as any
        if (!other || !other.n) S.push(db.prepare('DELETE FROM attendances WHERE event_id = ? AND user_id = ?').bind(eid, uid))
      }
      if (d.add?.survey_answer) S.push(db.prepare('DELETE FROM survey_answers WHERE event_id = ? AND user_id = ?').bind(eid, uid))
      if (d.add?.points) S.push(db.prepare("DELETE FROM points WHERE event_id = ? AND user_id = ? AND reason = 'event_survey'").bind(eid, uid))
      if (d.guest_share_consent) {
        const s = d.guest_share_consent
        if (d.add?.share_consent_member) S.push(db.prepare("DELETE FROM share_consents WHERE event_id = ? AND respondent_type = 'member' AND respondent_id = ?").bind(eid, uid))
        S.push(db.prepare('INSERT INTO share_consents (id, event_id, respondent_type, respondent_id, consent, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').bind(s.id, s.event_id, 'guest', s.respondent_id, s.consent, s.created_at, s.updated_at))
      }
      if ((d.add?.insights || []).length) S.push(db.prepare(`UPDATE shared_insights SET respondent_type = 'guest', respondent_id = ? WHERE id IN ${inList(d.add.insights)}`).bind(g.id))
      S.push(db.prepare('INSERT INTO guest_attendances (id, event_id, name, school, district, experience_years, attended_at, token, edit_token_hash) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(g.id, g.event_id, g.name, g.school ?? '', g.district ?? '', g.experience_years ?? null, g.attended_at ?? null, g.token ?? '', g.edit_token_hash ?? ''))
      for (const a of (d.guest_answers || [])) S.push(db.prepare('INSERT INTO guest_answers (id, guest_id, event_id, question_id, answer_text, answered_at) VALUES (?,?,?,?,?,?)').bind(a.id, a.guest_id, a.event_id, a.question_id, a.answer_text ?? '', a.answered_at ?? null))
    } else if (log.kind === 'member_to_member') {
      for (const t of MEMBER_TABLES) {
        const ids = ints((d.moved || {})[t.table] || [])
        if (!ids.length) continue
        S.push(db.prepare(`UPDATE ${t.table} SET ${t.col} = ? WHERE ${t.col} = ? AND id IN ${inList(ids)}${t.where ? ' AND ' + t.where : ''}`).bind(log.source_id, log.target_id))
      }
    } else return c.json({ error: '種類が不正です' }, 400)
    S.push(db.prepare("UPDATE merge_logs SET undone_at = datetime('now'), undone_by = ? WHERE id = ? AND undone_at IS NULL").bind(me.id, id))
    try { await db.batch(S) } catch (e: any) { return c.json({ error: '元に戻せませんでした（何も変更していません）。統合のあとに同じ回の記録が増えた可能性があります：' + String(e?.message || e).slice(0, 120) }, 409) }
    return c.json({ success: true })
  })

  // 「別人」として記録 ／ 取り消し
  app.post('/api/admin/duplicates/dismiss', authMiddleware, adminMiddleware, async (c: any) => {
    const db = c.env.DB as D1Database
    const me = c.get('user')
    let body: any = {}
    try { body = await c.req.json() } catch (e) { return c.json({ error: '入力が不正です' }, 400) }
    const kind = body.kind === 'guest_member' ? 'guest_member' : body.kind === 'member_member' ? 'member_member' : ''
    let a = parseInt(String(body.a || ''), 10), b = parseInt(String(body.b || ''), 10)
    if (!kind || !a || !b) return c.json({ error: '指定が不正です' }, 400)
    if (kind === 'member_member' && a > b) { const t = a; a = b; b = t }
    if (body.undo === true) await db.prepare('DELETE FROM duplicate_dismissals WHERE kind = ? AND a_id = ? AND b_id = ?').bind(kind, a, b).run()
    else await db.prepare("INSERT OR IGNORE INTO duplicate_dismissals (kind, a_id, b_id, created_by, created_at) VALUES (?,?,?,?,datetime('now'))").bind(kind, a, b, me.id).run()
    return c.json({ success: true })
  })

  app.get('/admin/duplicates', (c: any) => c.html(duplicatesPage(commonHead)))
}

function duplicatesPage(commonHead: string): string {
  return `<!DOCTYPE html><html lang="ja"><head>${commonHead}
<meta name="robots" content="noindex, nofollow">
<title>重複のまとめ - 学びの道しるべ</title>
<style>${GV_ADMIN_CSS}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.tab{padding:8px 14px;border-radius:18px;border:2px solid #c5cae9;background:#fff;color:#1a237e;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}
.tab.on{background:#1a237e;color:#fff;border-color:#1a237e}
.grp{border:2px solid #e8eaf6;border-radius:12px;padding:12px;margin-bottom:12px;background:#fff}
.grp.done{opacity:.6}
.grp-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;font-weight:700;color:#1a237e}
.who{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}
.pc{border:1px solid #e0e0e0;border-radius:10px;padding:8px 10px;font-size:12.5px;line-height:1.7}
.pc .nm{font-size:15px;font-weight:700;color:#222}
.pc .k{color:#999;display:inline-block;min-width:5em}
.acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;align-items:center}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:300;align-items:flex-start;justify-content:center;padding:16px;overflow:auto}
.modal.show{display:flex}
.modal .box{background:#fff;border-radius:14px;max-width:760px;width:100%;padding:16px;margin:auto}
.cf{display:flex;gap:8px;align-items:center;background:#fff3e0;border-radius:10px;padding:10px;margin:12px 0;font-weight:700;color:#8d4a00}
.cf input{width:20px;height:20px}
.blk{background:#ffebee;color:#b71c1c;border-radius:10px;padding:8px 10px;margin:8px 0;font-size:13px}
.ans{background:#fafafa;border-left:3px solid #c5cae9;padding:5px 8px;margin:4px 0;font-size:12.5px;white-space:pre-wrap;word-break:break-word}
.ans .q{font-size:11px;color:#999}
</style></head><body>
<div class="top-bar">
  <div class="logo"><i class="fas fa-user-friends"></i> 重複のまとめ</div>
  <div class="nav"><a href="/admin" class="btn-sm btn-back"><i class="fas fa-arrow-left"></i> 管理画面</a></div>
</div>
<div class="container">
  <div class="card"><div class="note">名前が同じ（スペースの有無もふくむ）会員どうしと、会員と同じ名前のゲストを並べています。<b>自動ではまとめません。</b>学校名や参加回などを見比べて「同じ人」と確かめられたときだけ統合してください。統合は記録が残り、「統合の記録」から元に戻せます。別の人なら「別人として記録」で一覧から外せます。</div></div>
  <div class="tabs" id="tabs">
    <button class="tab on" data-t="m" type="button">会員どうし</button>
    <button class="tab" data-t="g" type="button">ゲストと会員</button>
    <button class="tab" data-t="l" type="button">統合の記録</button>
  </div>
  <div id="body"><div class="msg"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div></div>
</div>
<div class="modal" id="pv"><div class="box" id="pvBox"></div></div>
<script>
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');
if (!token || !user || user.role !== 'admin') { window.location.href = '/login'; throw new Error('redirect'); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
async function api(path, opt) {
  opt = opt || {};
  opt.headers = Object.assign({ 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, opt.headers || {});
  const r = await fetch(path, opt);
  if (r.status === 401 || r.status === 403) { localStorage.clear(); window.location.href = '/login'; throw new Error('auth'); }
  let d = null; try { d = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((d && d.error) || ('エラー (' + r.status + ')'));
  return d;
}
const ST = { elementary:'小学校', junior_high:'中学校', admin_staff:'主幹・管理職' };
let tab = 'm', D = null;
function memberCard(u, extra) {
  return '<div class="pc"><div class="nm">' + esc(u.name) + ' <span class="pill gray">ID ' + u.id + '</span>' + (u.merged_into ? ' <span class="pill warn">ID ' + u.merged_into + ' に統合済み</span>' : '') + '</div>'
    + '<div><span class="k">学校</span>' + esc(u.school || '－') + '</div>'
    + '<div><span class="k">校種・区</span>' + esc((ST[u.school_type] || '未設定') + '・' + (u.district || '－')) + '</div>'
    + '<div><span class="k">経験</span>' + (u.experience_years != null ? esc(u.experience_years) + '年目' : '－') + '</div>'
    + (u.email ? '<div><span class="k">メール</span>' + esc(u.email) + '</div>' : '')
    + (u.created_at ? '<div><span class="k">登録日</span>' + esc(String(u.created_at).slice(0, 10)) + '</div>' : '')
    + (u.attend_count != null ? '<div><span class="k">参加</span>' + u.attend_count + '回' + (u.last_event ? '（最後 ' + esc(u.last_event) + '）' : '') + '・回答' + u.answered_events + '回</div>' : '')
    + (extra || '') + '</div>';
}
async function load() {
  const body = document.getElementById('body');
  body.innerHTML = '<div class="msg"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div>';
  try {
    if (tab === 'l') { const d = await api('/api/admin/duplicates/logs'); renderLogs(d.logs); return; }
    D = await api('/api/admin/duplicates');
  } catch (e) { body.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; return; }
  if (tab === 'm') renderMembers(); else renderGuests();
}
function renderMembers() {
  const gs = D.member_groups;
  if (!gs.length) { document.getElementById('body').innerHTML = '<div class="card"><div class="msg">候補はありません。</div></div>'; return; }
  let h = '<div class="note" style="margin-bottom:8px">候補 ' + gs.filter(function(g) { return g.open; }).length + '組（確認済み・統合済みをふくめて ' + gs.length + '組）</div>';
  gs.forEach(function(g, gi) {
    h += '<div class="grp' + (g.open ? '' : ' done') + '"><div class="grp-h"><span class="pill' + (g.type === '同姓同名' ? '' : ' warn') + '">' + esc(g.type) + '</span>' + esc(g.members.map(function(m) { return m.name; }).join(' ／ ')) + (g.open ? '' : ' <span class="pill gray">確認済み</span>') + '</div>';
    h += '<div class="who">' + g.members.map(function(m) { return memberCard(m); }).join('') + '</div>';
    g.pairs.forEach(function(p) {
      const A = g.members.find(function(m) { return m.id === p.a; }), B = g.members.find(function(m) { return m.id === p.b; });
      if (A.merged_into || B.merged_into) return;
      h += '<div class="acts"><span class="note">ID ' + p.a + ' と ID ' + p.b + '：</span>'
        + (p.dismissed ? '<span class="pill gray">別人として記録済み</span> <button class="btn btn-gray" type="button" data-undis="member_member:' + p.a + ':' + p.b + '">取り消す</button>'
          : '<button class="btn btn-primary" type="button" data-pm="' + p.a + ':' + p.b + '"><i class="fas fa-search"></i> 見比べて統合…</button><button class="btn btn-gray" type="button" data-dis="member_member:' + p.a + ':' + p.b + '">別人として記録</button>')
        + '</div>';
    });
    h += '</div>';
  });
  document.getElementById('body').innerHTML = h;
  bindCommon();
  document.querySelectorAll('[data-pm]').forEach(function(b) { b.addEventListener('click', function() { const x = b.getAttribute('data-pm').split(':'); previewMember(+x[1], +x[0]); }); });
}
function renderGuests() {
  const gs = D.guest_matches;
  if (!gs.length) { document.getElementById('body').innerHTML = '<div class="card"><div class="msg">候補はありません。</div></div>'; return; }
  let h = '<div class="note" style="margin-bottom:8px">会員と同じ名前のゲスト ' + gs.filter(function(g) { return g.open; }).length + '件（確認済みをふくめて ' + gs.length + '件）</div>';
  gs.forEach(function(m) {
    const g = m.guest;
    h += '<div class="grp' + (m.open ? '' : ' done') + '"><div class="grp-h"><span class="pill warn">ゲスト</span>' + esc(g.name) + '　<span style="font-weight:400;font-size:12px;color:#666">' + esc((g.event_date || '') + ' ' + (g.title || '')) + '</span></div>';
    h += '<div class="who"><div class="pc"><div class="nm">' + esc(g.name) + ' <span class="pill gray">ゲスト</span></div><div><span class="k">学校</span>' + esc(g.school || '－') + '</div><div><span class="k">区</span>' + esc(g.district || '－') + '</div><div><span class="k">経験</span>' + (g.experience_years != null ? esc(g.experience_years) + '年目' : '－') + '</div><div><span class="k">受付</span>' + esc(g.attended_at || '') + '</div><div><span class="k">回答</span>' + g.answer_count + '件</div></div>';
    m.candidates.forEach(function(cd) {
      const flags = (cd.same_school ? '<div><span class="pill">学校名が同じ</span></div>' : '<div><span class="pill gray">学校名がちがう／未入力</span></div>') + (cd.attended_same_event ? '<div><span class="pill warn">この会員も同じ回に出席しています</span></div>' : '');
      h += memberCard({ id: cd.id, name: cd.name, school: cd.school, district: cd.district, experience_years: cd.experience_years, school_type: cd.school_type }, flags);
    });
    h += '</div>';
    m.candidates.forEach(function(cd) {
      h += '<div class="acts"><span class="note">会員 ID ' + cd.id + '：</span>' + (cd.dismissed ? '<span class="pill gray">別人として記録済み</span> <button class="btn btn-gray" type="button" data-undis="guest_member:' + g.id + ':' + cd.id + '">取り消す</button>'
        : '<button class="btn btn-primary" type="button" data-pg="' + g.id + ':' + cd.id + '"><i class="fas fa-search"></i> 見比べて付け替え…</button><button class="btn btn-gray" type="button" data-dis="guest_member:' + g.id + ':' + cd.id + '">別人として記録</button>') + '</div>';
    });
    h += '</div>';
  });
  document.getElementById('body').innerHTML = h;
  bindCommon();
  document.querySelectorAll('[data-pg]').forEach(function(b) { b.addEventListener('click', function() { const x = b.getAttribute('data-pg').split(':'); previewGuest(+x[0], +x[1]); }); });
}
function bindCommon() {
  document.querySelectorAll('[data-dis],[data-undis]').forEach(function(b) {
    b.addEventListener('click', async function() {
      const undo = b.hasAttribute('data-undis');
      const x = (b.getAttribute('data-dis') || b.getAttribute('data-undis')).split(':');
      if (!undo && !confirm('別の人として記録し、候補から外しますか？（データは変わりません。あとで取り消せます）')) return;
      try { await api('/api/admin/duplicates/dismiss', { method: 'POST', body: JSON.stringify({ kind: x[0], a: +x[1], b: +x[2], undo: undo }) }); load(); } catch (e) { alert(e.message); }
    });
  });
}
function openPv(html) { document.getElementById('pvBox').innerHTML = html; document.getElementById('pv').classList.add('show'); window.scrollTo(0, 0); }
function closePv() { document.getElementById('pv').classList.remove('show'); }
async function previewGuest(gid, uid) {
  openPv('<div class="msg"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div>');
  let p; try { p = await api('/api/admin/duplicates/preview?kind=guest&source=' + gid + '&target=' + uid); } catch (e) { openPv('<div class="msg err">' + esc(e.message) + '</div><div class="acts"><button class="btn btn-gray" onclick="closePv()" type="button">閉じる</button></div>'); return; }
  let h = '<h3 style="margin:0 0 8px;color:#1a237e">ゲストの回答を会員に付け替える</h3><div class="note">研修会：' + esc((p.event ? p.event.event_date + ' ' + p.event.title : '')) + '</div>';
  h += '<div class="who" style="margin-top:8px"><div class="pc"><div class="nm">' + esc(p.guest.name) + ' <span class="pill gray">ゲスト</span></div><div><span class="k">学校</span>' + esc(p.guest.school || '－') + '</div><div><span class="k">区</span>' + esc(p.guest.district || '－') + '</div><div><span class="k">経験</span>' + (p.guest.experience_years != null ? esc(p.guest.experience_years) + '年目' : '－') + '</div></div>' + memberCard(p.member) + '</div>';
  h += '<div style="margin-top:10px;font-weight:700;font-size:13px">ゲストの回答（' + p.guest_answers.length + '件）</div>';
  p.guest_answers.forEach(function(a) { h += '<div class="ans"><div class="q">' + esc(a.question_text || '') + '</div>' + esc(a.answer_text || '（空）') + '</div>'; });
  if (p.member_answers.length) { h += '<div style="margin-top:10px;font-weight:700;font-size:13px">会員がこの回にすでに書いている回答（' + p.member_answers.length + '件）</div>'; p.member_answers.forEach(function(a) { h += '<div class="ans"><div class="q">' + esc(a.question_text || '') + '</div>' + esc(a.answer_text || '（空）') + '</div>'; }); }
  h += '<div style="margin-top:10px;font-weight:700;font-size:13px">統合すると</div><ul class="note" style="margin:4px 0 0 18px;padding:0">'
    + (p.add.attendance ? '<li>この回の出席を会員に記録します</li>' : '<li>会員はこの回の出席がすでに記録されています</li>')
    + '<li>ゲストの回答 ' + p.add.answers.length + '件を、会員の回答として記録します</li>'
    + (p.add.points ? '<li>この回のポイント（1）を会員につけます</li>' : '')
    + (p.add.share_consent_member ? '<li>紹介の同意も会員に引きつぎます</li>' : '')
    + (p.add.insights.length ? '<li>採用した気づき ' + p.add.insights.length + '件の名前を会員に付け替えます</li>' : '')
    + '<li>ゲストの記録は一覧から消えます（中身は統合の記録に保存し、元に戻せます）</li></ul>';
  p.blocked.forEach(function(b) { h += '<div class="blk"><i class="fas fa-ban"></i> ' + esc(b) + '</div>'; });
  if (!p.blocked.length) h += '<label class="cf"><input type="checkbox" id="cfChk"> 学校名などを見比べて、同じ人だと確認しました</label>';
  h += '<div class="acts" style="justify-content:flex-end">' + (p.blocked.length ? '' : '<button class="btn btn-orange" type="button" id="doMerge" disabled>付け替える</button>') + '<button class="btn btn-gray" type="button" onclick="closePv()">やめる</button></div>';
  openPv(h);
  bindMerge({ kind: 'guest', source: gid, target: uid });
}
async function previewMember(src, dst) {
  openPv('<div class="msg"><i class="fas fa-spinner fa-spin"></i> 読み込み中...</div>');
  let p; try { p = await api('/api/admin/duplicates/preview?kind=member&source=' + src + '&target=' + dst); } catch (e) { openPv('<div class="msg err">' + esc(e.message) + '</div><div class="acts"><button class="btn btn-gray" onclick="closePv()" type="button">閉じる</button></div>'); return; }
  let h = '<h3 style="margin:0 0 8px;color:#1a237e">会員どうしを統合する</h3>';
  h += '<div class="note">どちらのアカウントを残すか選べます。<button class="btn btn-gray" type="button" id="swapBtn" style="padding:4px 10px;font-size:12px"><i class="fas fa-exchange-alt"></i> 残す側を入れかえる</button></div>';
  h += '<div class="who" style="margin-top:8px">' + memberCard(p.source_info, '<div><span class="pill warn">統合される側（記録を移す）</span></div>') + memberCard(p.target_info, '<div><span class="pill">残る側</span></div>') + '</div>';
  function evList(list) { return list.length ? list.map(function(e) { return esc(e.event_date + ' ' + e.title); }).join('<br>') : '（なし）'; }
  h += '<details style="margin-top:8px"><summary class="note" style="cursor:pointer">参加した研修会を見比べる</summary><div class="who" style="margin-top:6px"><div class="pc"><b>ID ' + src + '</b><br>' + evList(p.source_events) + '</div><div class="pc"><b>ID ' + dst + '</b><br>' + evList(p.target_events) + '</div></div></details>';
  h += '<div style="margin-top:10px;font-weight:700;font-size:13px">移す記録</div><div class="tbl-wrap"><table class="t"><tr><th>記録</th><th class="num">移す</th><th class="num">重なるので元に残す</th></tr>';
  if (!p.tables.length) h += '<tr><td colspan="3" class="note">移す記録はありません</td></tr>';
  p.tables.forEach(function(t) { h += '<tr><td>' + esc(t.label) + '</td><td class="num">' + t.move + '件</td><td class="num">' + (t.keep ? t.keep + '件' : '－') + '</td></tr>'; });
  h += '</table></div>';
  if (p.both_events.length) h += '<div class="blk" style="background:#fff3e0;color:#8d4a00"><i class="fas fa-exclamation-triangle"></i> 2つのアカウントが同じ回に出席しています（' + p.both_events.map(function(e) { return esc(e.event_date + ' ' + e.title); }).join('、') + '）。同じ人なら二重受付、別の人の可能性もあります。よく確かめてください。</div>';
  h += '<div class="note" style="margin-top:6px">統合される側のアカウントは消しません（ログインもできます）。重なっている記録は、そのアカウントに残ります。</div>';
  p.blocked.forEach(function(b) { h += '<div class="blk"><i class="fas fa-ban"></i> ' + esc(b) + '</div>'; });
  if (!p.blocked.length) h += '<label class="cf"><input type="checkbox" id="cfChk"> 学校名などを見比べて、同じ人だと確認しました</label>';
  h += '<div class="acts" style="justify-content:flex-end">' + (p.blocked.length ? '' : '<button class="btn btn-orange" type="button" id="doMerge" disabled>統合する</button>') + '<button class="btn btn-gray" type="button" onclick="closePv()">やめる</button></div>';
  openPv(h);
  document.getElementById('swapBtn').addEventListener('click', function() { previewMember(dst, src); });
  bindMerge({ kind: 'member', source: src, target: dst });
}
function bindMerge(req) {
  const chk = document.getElementById('cfChk'), btn = document.getElementById('doMerge');
  if (!chk || !btn) return;
  chk.addEventListener('change', function() { btn.disabled = !chk.checked; });
  btn.addEventListener('click', async function() {
    btn.disabled = true;
    try { const r = await api('/api/admin/duplicates/merge', { method: 'POST', body: JSON.stringify(Object.assign({ confirm: true }, req)) }); closePv(); alert('統合しました。\\n' + r.summary + '\\n\\n「統合の記録」から元に戻せます。'); load(); }
    catch (e) { alert(e.message); btn.disabled = false; }
  });
}
function renderLogs(logs) {
  if (!logs.length) { document.getElementById('body').innerHTML = '<div class="card"><div class="msg">統合の記録はまだありません。</div></div>'; return; }
  let h = '<div class="card"><div class="tbl-wrap"><table class="t"><tr><th>日時</th><th>内容</th><th>した人</th><th></th></tr>';
  logs.forEach(function(l) {
    h += '<tr><td style="white-space:nowrap">' + esc(String(l.merged_at || '').slice(0, 16)) + '</td><td>' + esc(l.summary) + (l.undone_at ? '<div class="note">→ ' + esc(String(l.undone_at).slice(0, 16)) + ' に元に戻しました（' + esc(l.undone_by_name || '') + '）</div>' : '') + '</td><td>' + esc(l.merged_by_name || '') + '</td><td>' + (l.undone_at ? '' : '<button class="btn btn-gray" type="button" data-undo="' + l.id + '"><i class="fas fa-undo"></i> 元に戻す</button>') + '</td></tr>';
  });
  h += '</table></div></div>';
  document.getElementById('body').innerHTML = h;
  document.querySelectorAll('[data-undo]').forEach(function(b) {
    b.addEventListener('click', async function() {
      if (!confirm('この統合を元に戻しますか？')) return;
      b.disabled = true;
      try { await api('/api/admin/duplicates/undo', { method: 'POST', body: JSON.stringify({ log_id: +b.getAttribute('data-undo') }) }); load(); } catch (e) { alert(e.message); b.disabled = false; }
    });
  });
}
document.querySelectorAll('.tab').forEach(function(b) { b.addEventListener('click', function() { tab = b.getAttribute('data-t'); document.querySelectorAll('.tab').forEach(function(x) { x.classList.toggle('on', x === b); }); load(); }); });
load();
</script>
</body></html>`
}
