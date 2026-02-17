import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
}

type Variables = {
  user: { id: number; name: string; email: string; school: string; role: string }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

app.use('/api/*', cors())

// ========== Utility ==========
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password + '_shakaika_salt_2026')
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

function generateToken(): string {
  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Token store using D1 for production persistence
async function setToken(db: D1Database, token: string, userId: number) {
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  await db.prepare(
    'INSERT OR REPLACE INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(token, userId, expires).run()
}

async function getUserIdFromToken(db: D1Database, token: string): Promise<number | null> {
  const row = await db.prepare(
    'SELECT user_id, expires_at FROM sessions WHERE token = ?'
  ).bind(token).first() as any
  if (!row) return null
  if (new Date(row.expires_at) < new Date()) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
    return null
  }
  return row.user_id
}

// ========== Auth Middleware ==========
async function authMiddleware(c: any, next: any) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'ログインが必要です' }, 401)
  }
  const token = authHeader.replace('Bearer ', '')
  const userId = await getUserIdFromToken(c.env.DB, token)
  if (!userId) {
    return c.json({ error: 'セッションが無効です。再ログインしてください' }, 401)
  }
  const user = await c.env.DB.prepare('SELECT id, name, email, school, role FROM users WHERE id = ?').bind(userId).first()
  if (!user) {
    return c.json({ error: 'ユーザーが見つかりません' }, 401)
  }
  c.set('user', user)
  await next()
}

async function adminMiddleware(c: any, next: any) {
  const user = c.get('user')
  if (user.role !== 'admin') {
    return c.json({ error: '管理者権限が必要です' }, 403)
  }
  await next()
}

// ========== DB Init ==========
app.get('/api/init', async (c) => {
  const db = c.env.DB
  await db.prepare(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    school TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member', 'admin')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`).run()

  // Add 'school' column if missing (for existing DBs)
  try {
    const { results: cols } = (await db.prepare("PRAGMA table_info(users)").all()) as any
    const hasSchool = Array.isArray(cols) && cols.some((c: any) => c.name === 'school')
    if (!hasSchool) {
      await db.prepare("ALTER TABLE users ADD COLUMN school TEXT NOT NULL DEFAULT ''").run()
    }
  } catch (e) {
    // ignore
  }

  await db.prepare(`CREATE TABLE IF NOT EXISTS selections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    viewpoint TEXT NOT NULL,
    step INTEGER NOT NULL CHECK(step BETWEEN 1 AND 4),
    memo TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, viewpoint)
  )`).run()

  await db.prepare('CREATE INDEX IF NOT EXISTS idx_selections_user_id ON selections(user_id)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)').run()

  // Event tables
  await db.prepare(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '',
    event_date TEXT NOT NULL, event_code TEXT UNIQUE NOT NULL, is_active INTEGER DEFAULT 1,
    created_by INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS attendances (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    attended_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, UNIQUE(event_id, user_id)
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS survey_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, question_text TEXT NOT NULL,
    question_type TEXT NOT NULL CHECK(question_type IN ('text','radio','rating')),
    options TEXT DEFAULT '', sort_order INTEGER DEFAULT 0,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS survey_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    satisfaction INTEGER CHECK(satisfaction BETWEEN 1 AND 5), comment TEXT DEFAULT '',
    answered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, UNIQUE(event_id, user_id)
  )`).run()
  await db.prepare(`CREATE TABLE IF NOT EXISTS custom_answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL, answer_text TEXT DEFAULT '',
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (question_id) REFERENCES survey_questions(id) ON DELETE CASCADE,
    UNIQUE(event_id, user_id, question_id)
  )`).run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_attendances_event ON attendances(event_id)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_events_code ON events(event_code)').run()

  // Sessions table for persistent auth tokens
  await db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`).run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)').run()
  // Clean up expired sessions
  await db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run()

  // Create default admin if not exists
  const adminHash = await hashPassword('admin123')
  await db.prepare(
    'INSERT OR IGNORE INTO users (name, email, school, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).bind('管理者', 'admin@example.com', '（管理者）', adminHash, 'admin').run()

  return c.json({ message: 'データベースを初期化しました' })
})

// ========== Auth API ==========
app.post('/api/auth/register', async (c) => {
  const { name, school, email, password } = await c.req.json()
  if (!name || !school || !email || !password) {
    return c.json({ error: '名前・学校名・メールアドレス・パスワードは必須です' }, 400)
  }
  if (password.length < 4) {
    return c.json({ error: 'パスワードは4文字以上にしてください' }, 400)
  }
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
  if (existing) {
    return c.json({ error: 'このメールアドレスは既に登録されています' }, 400)
  }
  const passwordHash = await hashPassword(password)
  const result = await c.env.DB.prepare(
    'INSERT INTO users (name, email, school, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).bind(name, email, school, passwordHash, 'member').run()

  const userId = result.meta.last_row_id as number
  const token = generateToken()
  await setToken(c.env.DB, token, userId)

  return c.json({ token, user: { id: userId, name, school, email, role: 'member' } })
})

app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json()
  if (!email || !password) {
    return c.json({ error: 'メールアドレスとパスワードを入力してください' }, 400)
  }
  const passwordHash = await hashPassword(password)
  const user = await c.env.DB.prepare(
    'SELECT id, name, email, school, role FROM users WHERE email = ? AND password_hash = ?'
  ).bind(email, passwordHash).first()
  if (!user) {
    return c.json({ error: 'メールアドレスまたはパスワードが正しくありません' }, 401)
  }
  const token = generateToken()
  await setToken(c.env.DB, token, user.id as number)

  return c.json({ token, user: { id: user.id, name: user.name, school: (user as any).school || '', email: user.email, role: user.role } })
})

app.get('/api/auth/me', authMiddleware, async (c) => {
  return c.json({ user: c.get('user') })
})

// ========== Selections API ==========
app.get('/api/selections', authMiddleware, async (c) => {
  const user = c.get('user')
  const { results } = await c.env.DB.prepare(
    'SELECT viewpoint, step, memo, updated_at FROM selections WHERE user_id = ?'
  ).bind(user.id).all()
  return c.json({ selections: results })
})

app.post('/api/selections', authMiddleware, async (c) => {
  const user = c.get('user')
  const { viewpoint, step, memo } = await c.req.json()

  if (!viewpoint || !step || step < 1 || step > 4) {
    return c.json({ error: '不正な選択です' }, 400)
  }

  const validViewpoints = ['lesson_plan', 'lesson_practice', 'student_eval', 'connection', 'research']
  if (!validViewpoints.includes(viewpoint)) {
    return c.json({ error: '不正な視点です' }, 400)
  }

  await c.env.DB.prepare(`
    INSERT INTO selections (user_id, viewpoint, step, memo, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, viewpoint) DO UPDATE SET
      step = excluded.step,
      memo = excluded.memo,
      updated_at = datetime('now')
  `).bind(user.id, viewpoint, step, memo || '').run()

  return c.json({ success: true })
})

app.delete('/api/selections/:viewpoint', authMiddleware, async (c) => {
  const user = c.get('user')
  const viewpoint = c.req.param('viewpoint')
  await c.env.DB.prepare(
    'DELETE FROM selections WHERE user_id = ? AND viewpoint = ?'
  ).bind(user.id, viewpoint).run()
  return c.json({ success: true })
})

// ========== Admin API ==========
app.get('/api/admin/members', authMiddleware, adminMiddleware, async (c) => {
  const { results: members } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.school, u.email, u.role, u.created_at,
      GROUP_CONCAT(s.viewpoint || ':' || s.step || ':' || COALESCE(s.memo,''), '||') as selections_raw
     FROM users u
     LEFT JOIN selections s ON u.id = s.user_id
     GROUP BY u.id
     ORDER BY u.created_at DESC`
  ).all()

  const parsed = members.map((m: any) => {
    const selections: Record<string, { step: number; memo: string }> = {}
    if (m.selections_raw) {
      const parts = (m.selections_raw as string).split('||')
      for (const part of parts) {
        const [vp, stepStr, ...memoParts] = part.split(':')
        if (vp && stepStr) {
          selections[vp] = { step: parseInt(stepStr), memo: memoParts.join(':') }
        }
      }
    }
    return {
      id: m.id,
      name: m.name,
      school: m.school || '',
      email: m.email,
      role: m.role,
      created_at: m.created_at,
      selections
    }
  })

  return c.json({ members: parsed })
})

app.put('/api/admin/members/:id/role', authMiddleware, adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id'))
  const { role } = await c.req.json()
  if (!['member', 'admin'].includes(role)) {
    return c.json({ error: '不正な役割です' }, 400)
  }
  await c.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id).run()
  return c.json({ success: true })
})

app.delete('/api/admin/members/:id', authMiddleware, adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id'))
  const user = c.get('user')
  if (user.id === id) {
    return c.json({ error: '自分自身は削除できません' }, 400)
  }
  await c.env.DB.prepare('DELETE FROM selections WHERE user_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run()
  return c.json({ success: true })
})

// ========== CSV Export ==========
app.get('/api/admin/export', authMiddleware, adminMiddleware, async (c) => {
  const { results: members } = await c.env.DB.prepare(
    'SELECT id, name, school, email, role, created_at FROM users ORDER BY created_at'
  ).all()

  const { results: allSelections } = await c.env.DB.prepare(
    'SELECT user_id, viewpoint, step, memo FROM selections'
  ).all()

  const selMap = new Map<number, Record<string, { step: number; memo: string }>>()
  for (const s of allSelections as any[]) {
    if (!selMap.has(s.user_id)) selMap.set(s.user_id, {})
    selMap.get(s.user_id)![s.viewpoint] = { step: s.step, memo: s.memo || '' }
  }

  const vpLabels: Record<string, string> = {
    lesson_plan: '授業をつくる',
    lesson_practice: '授業をする',
    student_eval: '子供を見る',
    connection: 'つながる',
    research: '深める'
  }
  const stepLabels: Record<number, string> = {
    1: 'STEP1(まずはここから)',
    2: 'STEP2(自分で工夫する)',
    3: 'STEP3(みんなと高める)',
    4: 'STEP4(未来を創る)'
  }
  const vps = ['lesson_plan', 'lesson_practice', 'student_eval', 'connection', 'research']

  // BOM for Excel
  const BOM = '\uFEFF'
  let csv = BOM
  // Header
  const headers = ['名前', '学校名', 'メールアドレス', '役割', '登録日']
  for (const vp of vps) {
    headers.push(vpLabels[vp] + '(ステップ)')
    headers.push(vpLabels[vp] + '(メモ)')
  }
  csv += headers.map(h => `"${h}"`).join(',') + '\n'

  // Rows
  for (const m of members as any[]) {
    const sels = selMap.get(m.id) || {}
    const row = [
      m.name,
      m.school || '',
      m.email,
      m.role === 'admin' ? '管理者' : '会員',
      m.created_at || ''
    ]
    for (const vp of vps) {
      if (sels[vp]) {
        row.push(stepLabels[sels[vp].step] || `STEP${sels[vp].step}`)
        row.push(sels[vp].memo || '')
      } else {
        row.push('未選択')
        row.push('')
      }
    }
    csv += row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',') + '\n'
  }

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="shakaika_members_export.csv"'
    }
  })
})

// ========== Events API ==========
function generateEventCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  const arr = new Uint8Array(8)
  crypto.getRandomValues(arr)
  for (let i = 0; i < 8; i++) code += chars[arr[i] % chars.length]
  return code
}

app.post('/api/admin/events', authMiddleware, adminMiddleware, async (c) => {
  const { title, description, event_date, custom_questions } = await c.req.json()
  if (!title || !event_date) return c.json({ error: 'タイトルと日付は必須です' }, 400)
  const db = c.env.DB
  const code = generateEventCode()
  const user = c.get('user')
  const res = await db.prepare(
    'INSERT INTO events (title, description, event_date, event_code, created_by) VALUES (?,?,?,?,?)'
  ).bind(title, description || '', event_date, code, user.id).run()
  const eventId = res.meta.last_row_id as number
  if (custom_questions && Array.isArray(custom_questions)) {
    for (let i = 0; i < custom_questions.length; i++) {
      const q = custom_questions[i]
      await db.prepare(
        'INSERT INTO survey_questions (event_id, question_text, question_type, options, sort_order) VALUES (?,?,?,?,?)'
      ).bind(eventId, q.question_text, q.question_type || 'text', q.options || '', i).run()
    }
  }
  return c.json({ id: eventId, event_code: code })
})

app.get('/api/admin/events', authMiddleware, adminMiddleware, async (c) => {
  const db = c.env.DB
  const { results: events } = await db.prepare(
    'SELECT e.*, (SELECT COUNT(*) FROM attendances a WHERE a.event_id = e.id) as attendance_count, (SELECT COUNT(*) FROM survey_answers sa WHERE sa.event_id = e.id) as survey_count FROM events e ORDER BY e.event_date DESC'
  ).all()
  return c.json({ events })
})

app.get('/api/admin/events/:id', authMiddleware, adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id'))
  const db = c.env.DB
  const event = await db.prepare('SELECT * FROM events WHERE id = ?').bind(id).first()
  if (!event) return c.json({ error: 'イベントが見つかりません' }, 404)
  const { results: questions } = await db.prepare(
    'SELECT * FROM survey_questions WHERE event_id = ? ORDER BY sort_order'
  ).bind(id).all()
  const { results: attendances } = await db.prepare(
    'SELECT a.*, u.name, u.email FROM attendances a JOIN users u ON a.user_id = u.id WHERE a.event_id = ? ORDER BY a.attended_at'
  ).bind(id).all()
  const { results: answers } = await db.prepare(
    'SELECT sa.*, u.name, u.email FROM survey_answers sa JOIN users u ON sa.user_id = u.id WHERE sa.event_id = ?'
  ).bind(id).all()
  const { results: customAnswers } = await db.prepare(
    'SELECT ca.*, u.name FROM custom_answers ca JOIN users u ON ca.user_id = u.id WHERE ca.event_id = ?'
  ).bind(id).all()
  return c.json({ event, questions, attendances, answers, customAnswers })
})

app.delete('/api/admin/events/:id', authMiddleware, adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id'))
  const db = c.env.DB
  await db.prepare('DELETE FROM custom_answers WHERE event_id = ?').bind(id).run()
  await db.prepare('DELETE FROM survey_answers WHERE event_id = ?').bind(id).run()
  await db.prepare('DELETE FROM survey_questions WHERE event_id = ?').bind(id).run()
  await db.prepare('DELETE FROM attendances WHERE event_id = ?').bind(id).run()
  await db.prepare('DELETE FROM events WHERE id = ?').bind(id).run()
  return c.json({ success: true })
})

app.get('/api/admin/events/:id/export', authMiddleware, adminMiddleware, async (c) => {
  const id = parseInt(c.req.param('id'))
  const db = c.env.DB
  const event = await db.prepare('SELECT * FROM events WHERE id = ?').bind(id).first() as any
  if (!event) return c.json({ error: 'イベントが見つかりません' }, 404)
  const { results: questions } = await db.prepare('SELECT * FROM survey_questions WHERE event_id = ? ORDER BY sort_order').bind(id).all() as any
  const { results: attendances } = await db.prepare('SELECT a.*, u.name, u.email FROM attendances a JOIN users u ON a.user_id = u.id WHERE a.event_id = ?').bind(id).all() as any
  const { results: answers } = await db.prepare('SELECT sa.*, u.name, u.email FROM survey_answers sa JOIN users u ON sa.user_id = u.id WHERE sa.event_id = ?').bind(id).all() as any
  const { results: customAnswers } = await db.prepare('SELECT * FROM custom_answers WHERE event_id = ?').bind(id).all() as any
  const caMap = new Map<number, Record<number, string>>()
  for (const ca of customAnswers) {
    if (!caMap.has(ca.user_id)) caMap.set(ca.user_id, {})
    caMap.get(ca.user_id)![ca.question_id] = ca.answer_text
  }
  const ansMap = new Map<number, any>()
  for (const a of answers) ansMap.set(a.user_id, a)
  const BOM = '\uFEFF'
  const headers = ['名前', 'メール', '出席時刻', '満足度', '感想']
  for (const q of questions) headers.push(q.question_text)
  let csv = BOM + headers.map((h: string) => `"${h}"`).join(',') + '\n'
  for (const att of attendances) {
    const ans = ansMap.get(att.user_id)
    const ca = caMap.get(att.user_id) || {}
    const row = [att.name, att.email, att.attended_at, ans ? ans.satisfaction : '', ans ? (ans.comment || '') : '']
    for (const q of questions) row.push(ca[q.id as number] || '')
    csv += row.map((v: any) => `"${String(v).replace(/"/g, '""')}"`).join(',') + '\n'
  }
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${event.title}_export.csv"` } })
})

// ========== Attendance & Survey (Member) ==========
app.get('/api/events/:code', authMiddleware, async (c) => {
  const code = c.req.param('code')
  const db = c.env.DB
  const event = await db.prepare('SELECT * FROM events WHERE event_code = ? AND is_active = 1').bind(code).first()
  if (!event) return c.json({ error: 'イベントが見つからないか、受付が終了しています' }, 404)
  const { results: questions } = await db.prepare('SELECT * FROM survey_questions WHERE event_id = ? ORDER BY sort_order').bind(event.id).all()
  const user = c.get('user')
  const attendance = await db.prepare('SELECT * FROM attendances WHERE event_id = ? AND user_id = ?').bind(event.id, user.id).first()
  const survey = await db.prepare('SELECT * FROM survey_answers WHERE event_id = ? AND user_id = ?').bind(event.id, user.id).first()
  const { results: myCustom } = await db.prepare('SELECT * FROM custom_answers WHERE event_id = ? AND user_id = ?').bind(event.id, user.id).all()
  return c.json({ event, questions, attendance, survey, customAnswers: myCustom })
})

app.post('/api/events/:code/attend', authMiddleware, async (c) => {
  const code = c.req.param('code')
  const db = c.env.DB
  const event = await db.prepare('SELECT * FROM events WHERE event_code = ? AND is_active = 1').bind(code).first() as any
  if (!event) return c.json({ error: 'イベントが見つかりません' }, 404)
  const user = c.get('user')
  await db.prepare("INSERT OR IGNORE INTO attendances (event_id, user_id, attended_at) VALUES (?,?,datetime('now'))").bind(event.id, user.id).run()
  return c.json({ success: true })
})

app.post('/api/events/:code/survey', authMiddleware, async (c) => {
  const code = c.req.param('code')
  const db = c.env.DB
  const event = await db.prepare('SELECT * FROM events WHERE event_code = ? AND is_active = 1').bind(code).first() as any
  if (!event) return c.json({ error: 'イベントが見つかりません' }, 404)
  const user = c.get('user')
  const { satisfaction, comment, custom_answers } = await c.req.json()
  await db.prepare(`INSERT INTO survey_answers (event_id, user_id, satisfaction, comment, answered_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(event_id, user_id) DO UPDATE SET satisfaction=excluded.satisfaction, comment=excluded.comment, answered_at=datetime('now')`).bind(event.id, user.id, satisfaction || null, comment || '').run()
  if (custom_answers && Array.isArray(custom_answers)) {
    for (const ca of custom_answers) {
      await db.prepare('INSERT INTO custom_answers (event_id, user_id, question_id, answer_text) VALUES (?,?,?,?) ON CONFLICT(event_id, user_id, question_id) DO UPDATE SET answer_text=excluded.answer_text').bind(event.id, user.id, ca.question_id, ca.answer_text || '').run()
    }
  }
  return c.json({ success: true })
})

// ========== Health ==========
app.get('/api/health', (c) => c.json({ status: 'ok' }))

// ========== HTML Pages ==========

const commonHead = `
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&family=Zen+Maru+Gothic:wght@500;700&display=swap');
  :root {
    --bg-color: #fffaf0;
    --header-line: #d84315;
    --text-main: #444;
    --cat-class: #8d6e63;
    --cat-connect: #66bb6a;
    --cat-research: #42a5f5;
  }
  * { box-sizing: border-box; }
  body { font-family: 'Noto Sans JP', sans-serif; color: var(--text-main); background-color: var(--bg-color); padding: 0; margin: 0; line-height: 1.5; }
</style>`

// --- Login / Register Page ---
app.get('/login', (c) => {
  return c.html(`<!DOCTYPE html><html lang="ja"><head>${commonHead}
<title>ログイン - 学びのコンパス</title>
<style>
  .auth-container { max-width: 440px; margin: 60px auto; padding: 0 20px; }
  .auth-card { background: #fff; border-radius: 16px; padding: 40px 32px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); border: 2px solid #f0e6d2; }
  .auth-card h1 { font-family: 'Zen Maru Gothic', sans-serif; color: var(--header-line); font-size: 22px; text-align: center; margin: 0 0 8px; }
  .auth-card .sub { text-align: center; color: #888; font-size: 13px; margin-bottom: 28px; }
  .form-group { margin-bottom: 18px; }
  .form-group label { display: block; font-weight: 500; margin-bottom: 5px; font-size: 13px; color: #555; }
  .form-group input { width: 100%; padding: 10px 14px; border: 2px solid #e0d6c8; border-radius: 8px; font-size: 15px; font-family: inherit; transition: border-color 0.2s; outline: none; }
  .form-group input:focus { border-color: var(--header-line); }
  .btn { width: 100%; padding: 12px; border: none; border-radius: 10px; font-size: 15px; font-weight: 700; cursor: pointer; font-family: inherit; transition: all 0.2s; }
  .btn-primary { background: var(--header-line); color: #fff; }
  .btn-primary:hover { background: #bf360c; }
  .btn-secondary { background: #fff; color: var(--header-line); border: 2px solid var(--header-line); margin-top: 10px; }
  .btn-secondary:hover { background: #fff3e0; }
  .tabs { display: flex; margin-bottom: 24px; border-radius: 10px; overflow: hidden; border: 2px solid #e0d6c8; }
  .tab { flex: 1; padding: 10px; text-align: center; cursor: pointer; font-weight: 700; font-size: 14px; background: #fafafa; color: #999; transition: all 0.2s; }
  .tab.active { background: var(--header-line); color: #fff; }
  .error-msg { background: #ffebee; color: #c62828; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; display: none; }
  .success-msg { background: #e8f5e9; color: #2e7d32; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; display: none; }
  .logo { text-align: center; margin-bottom: 20px; }
  .logo span { display: block; font-size: 10px; letter-spacing: 2px; color: #999; }
  .logo strong { font-family: 'Zen Maru Gothic', sans-serif; font-size: 18px; color: var(--header-line); }
</style>
</head><body>
<div class="auth-container">
  <div class="auth-card">
    <div class="logo"><span>NAGOYA SHAKAIKA</span><strong>学びのコンパス</strong></div>
    <div class="tabs">
      <div class="tab active" onclick="switchTab('login')">ログイン</div>
      <div class="tab" onclick="switchTab('register')">新規登録</div>
    </div>
    <div id="error" class="error-msg"></div>
    <div id="success" class="success-msg"></div>

    <form id="loginForm" onsubmit="return handleLogin(event)">
      <div class="form-group">
        <label><i class="fas fa-envelope"></i> メールアドレス</label>
        <input type="email" id="loginEmail" required placeholder="example@email.com">
      </div>
      <div class="form-group">
        <label><i class="fas fa-lock"></i> パスワード</label>
        <input type="password" id="loginPassword" required placeholder="パスワードを入力">
      </div>
      <button type="submit" class="btn btn-primary"><i class="fas fa-sign-in-alt"></i> ログイン</button>
    </form>

    <form id="registerForm" style="display:none" onsubmit="return handleRegister(event)">
      <div class="form-group">
        <label><i class="fas fa-user"></i> お名前</label>
        <input type="text" id="regName" required placeholder="山田 太郎">
      </div>
      <div class="form-group">
        <label><i class="fas fa-school"></i> 学校名</label>
        <input type="text" id="regSchool" required placeholder="〇〇小学校">
      </div>
      <div class="form-group">
        <label><i class="fas fa-envelope"></i> メールアドレス</label>
        <input type="email" id="regEmail" required placeholder="example@email.com">
      </div>
      <div class="form-group">
        <label><i class="fas fa-lock"></i> パスワード</label>
        <input type="password" id="regPassword" required placeholder="4文字以上" minlength="4">
      </div>
      <button type="submit" class="btn btn-primary"><i class="fas fa-user-plus"></i> 登録する</button>
    </form>
  </div>
</div>
<script>
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((t,i) => {
    t.classList.toggle('active', (tab==='login' && i===0) || (tab==='register' && i===1));
  });
  document.getElementById('loginForm').style.display = tab==='login' ? 'block' : 'none';
  document.getElementById('registerForm').style.display = tab==='register' ? 'block' : 'none';
  document.getElementById('error').style.display = 'none';
  document.getElementById('success').style.display = 'none';
}
function showError(msg) { const e = document.getElementById('error'); e.textContent = msg; e.style.display = 'block'; document.getElementById('success').style.display='none'; }
function showSuccess(msg) { const e = document.getElementById('success'); e.textContent = msg; e.style.display = 'block'; document.getElementById('error').style.display='none'; }

async function handleLogin(e) {
  e.preventDefault();
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: document.getElementById('loginEmail').value, password: document.getElementById('loginPassword').value })
    });
    const data = await res.json();
    if (!res.ok) { showError(data.error); return false; }
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    window.location.href = data.user.role === 'admin' ? '/admin' : '/mypage';
  } catch(err) { showError('通信エラーが発生しました'); }
  return false;
}

async function handleRegister(e) {
  e.preventDefault();
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: document.getElementById('regName').value, school: document.getElementById('regSchool').value, email: document.getElementById('regEmail').value, password: document.getElementById('regPassword').value })
    });
    const data = await res.json();
    if (!res.ok) { showError(data.error); return false; }
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
    window.location.href = '/mypage';
  } catch(err) { showError('通信エラーが発生しました'); }
  return false;
}

// Redirect if already logged in
const token = localStorage.getItem('token');
if (token) {
  fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => r.json())
    .then(d => { if (d.user) window.location.href = d.user.role === 'admin' ? '/admin' : '/mypage'; });
}
</script>
</body></html>`)
})

// --- Member My Page (with interactive rubric) ---
app.get('/mypage', (c) => {
  return c.html(`<!DOCTYPE html><html lang="ja"><head>${commonHead}
<title>マイページ - 学びのコンパス</title>
<style>
  .top-bar { background: #fff; border-bottom: 3px solid var(--header-line); padding: 10px 24px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; }
  .top-bar .logo { font-family: 'Zen Maru Gothic', sans-serif; color: var(--header-line); font-size: 18px; font-weight: 700; }
  .top-bar .user-info { display: flex; align-items: center; gap: 12px; font-size: 13px; }
  .top-bar .user-info .name { font-weight: 700; color: #555; }
  .btn-sm { padding: 6px 14px; border-radius: 8px; border: none; font-size: 12px; font-weight: 700; cursor: pointer; font-family: inherit; }
  .btn-logout { background: #eee; color: #888; }
  .btn-logout:hover { background: #ddd; }
  .btn-save { background: var(--header-line); color: #fff; font-size: 14px; padding: 10px 28px; border-radius: 10px; }
  .btn-save:hover { background: #bf360c; }
  .btn-admin { background: #42a5f5; color: #fff; }
  .btn-admin:hover { background: #1e88e5; }

  .main { max-width: 1250px; margin: 20px auto; padding: 0 16px; }
  .guide { background: #fff3e0; border-left: 4px solid #ffb74d; padding: 12px 16px; border-radius: 0 8px 8px 0; margin-bottom: 20px; font-size: 13px; color: #5d4037; }
  .guide strong { color: #e65100; }

  .container { max-width: 1250px; margin: 0 auto; background-color: #fff; padding: 20px 24px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); border-radius: 12px; border: 2px solid #f0e6d2; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px dashed var(--header-line); padding-bottom: 8px; margin-bottom: 15px; }
  .title-block h1 { font-family: 'Zen Maru Gothic', sans-serif; font-size: 22px; margin: 0; line-height: 1.2; color: var(--header-line); }
  .title-block .subtitle { font-size: 12px; color: #666; margin-top: 4px; font-weight: 500; }

  table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 10.5pt; table-layout: fixed; border-radius: 8px; overflow: hidden; border: 1px solid #ddd; min-width: 900px; }
  th, td { border: 1px solid #e0e0e0; padding: 7px 9px; vertical-align: middle; word-wrap: break-word; }
  .col-category { width: 30px; text-align: center; font-weight: bold; writing-mode: vertical-rl; letter-spacing: 3px; color: #fff; border-bottom: 1px solid rgba(255,255,255,0.3); }
  .col-viewpoint { width: 85px; background-color: #fff8e1; font-weight: bold; color: #5d4037; font-family: 'Zen Maru Gothic', sans-serif; }
  .col-step { width: 22%; background-color: #fff; vertical-align: top; cursor: pointer; transition: all 0.2s; position: relative; }
  .col-step:hover { background-color: #fff8e1; }
  .col-step.selected { background-color: #fff3e0; box-shadow: inset 0 0 0 3px var(--header-line); border-radius: 2px; }
  .col-step.selected::after { content: '\\2713'; position: absolute; top: 4px; right: 6px; color: var(--header-line); font-size: 18px; font-weight: bold; }
  thead th { text-align: center; background-color: #fff; border-bottom: 3px solid var(--header-line); padding: 8px 5px; }
  .step-header { display: flex; flex-direction: column; align-items: center; }
  .step-label { font-size: 13px; font-weight: bold; color: var(--header-line); margin-bottom: 2px; font-family: 'Zen Maru Gothic', sans-serif; }
  .step-desc { font-size: 9px; font-weight: bold; color: #5d4037; background-color: #ffccbc; padding: 2px 8px; border-radius: 10px; white-space: nowrap; }
  .cell-content { display: flex; flex-direction: column; }
  .cell-content p { margin: 0 0 2px 0; font-size: 9.5pt; line-height: 1.4; }
  .keyword { font-weight: bold; color: #bf360c; display: inline-block; margin-bottom: 3px; font-size: 10.5pt; font-family: 'Zen Maru Gothic', sans-serif; border-bottom: 2px dotted #ffab91; padding-bottom: 1px; }
  .cat-class { background-color: var(--cat-class); }
  .cat-connect { background-color: var(--cat-connect); }
  .cat-research { background-color: var(--cat-research); }
  .ss-term { background: linear-gradient(transparent 70%, #fff59d 70%); font-weight: bold; color: #555; }

  .row-action td { background-color: #fff3e0; border-top: 3px solid #ffb74d; padding: 6px 8px; }
  .action-list { margin: 0; padding-left: 14px; font-size: 9pt; list-style-type: none; }
  .action-list li { margin-bottom: 2px; }
  .action-list li::before { content: '\\1F449'; font-size: 8px; margin-right: 4px; }

  .footer-note { margin-top: 15px; display: flex; justify-content: space-between; align-items: flex-start; font-size: 8.5pt; }
  .save-area { text-align: center; margin-top: 20px; }
  .save-status { font-size: 13px; color: #2e7d32; margin-top: 10px; display: none; }

  .memo-input { width: 100%; margin-top: 6px; padding: 4px 6px; border: 1px solid #ccc; border-radius: 4px; font-size: 9pt; font-family: inherit; resize: none; display: none; }
  .col-step.selected .memo-input { display: block; }

  .scroll-hint { display: none; text-align: center; color: #999; font-size: 12px; margin-bottom: 8px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:0.5} 50%{opacity:1} }

  @media (max-width: 768px) {
    .top-bar { padding: 8px 12px; flex-wrap: wrap; gap: 6px; }
    .top-bar .logo { font-size: 15px; }
    .top-bar .user-info { gap: 6px; font-size: 11px; }
    .top-bar .user-info .name { display: none; }
    .btn-sm { padding: 5px 10px; font-size: 11px; }
    .main { padding: 0 8px; margin: 12px auto; }
    .guide { font-size: 12px; padding: 10px 12px; }
    .container { padding: 12px; border-radius: 8px; }
    .header { flex-direction: column; align-items: flex-start; }
    .title-block h1 { font-size: 18px; }
    .scroll-hint { display: block; }
    .footer-note { flex-direction: column; gap: 8px; }
    .footer-note > div { max-width: 100% !important; text-align: left !important; }
    .save-area { margin-top: 16px; }
    .save-area .btn-sm { padding: 12px 20px; font-size: 15px; }
  }

  @media print {
    .top-bar, .guide, .save-area, .memo-input, .scroll-hint { display: none !important; }
    @page { size: A4 landscape; margin: 5mm; }
    body { width: 287mm; height: 200mm; margin: 0; padding: 0; background-color: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; zoom: 90%; }
    .container { max-width: none; box-shadow: none; border: none; padding: 0; margin: 0; }
    .col-step.selected { box-shadow: inset 0 0 0 2px var(--header-line); }
    .col-step.selected::after { font-size: 14px; }
    table { font-size: 8.5pt; }
    th, td { padding: 4px 6px; }
    .keyword { font-size: 9.5pt; }
    .cell-content p { font-size: 8.5pt; line-height: 1.3; }
  }
</style>
</head><body>
<div class="top-bar">
  <div class="logo"><i class="fas fa-compass"></i> 学びのコンパス</div>
  <div class="user-info">
    <span class="name" id="userName"></span>
    <span id="adminLink"></span>
    <button class="btn-sm btn-logout" onclick="logout()"><i class="fas fa-sign-out-alt"></i> ログアウト</button>
  </div>
</div>

<div class="main">
  <div class="guide">
    <strong><i class="fas fa-hand-pointer"></i> 使い方：</strong>
    今の自分に当てはまるステップのセルをクリックしてください。各視点ごとに1つ選べます。メモも書けます。最後に「保存する」を押すと記録されます。
  </div>

  <div class="container">
    <div class="header">
      <div class="title-block">
        <h1>社会科同好会 成長の道しるべ</h1>
        <div class="subtitle">授業も、つながりも。あなたのペースで歩むガイドマップ</div>
      </div>
    </div>

    <div class="scroll-hint"><i class="fas fa-arrows-alt-h"></i> 横にスクロールできます</div>
    <table>
      <thead><tr>
        <th colspan="2" style="background-color: #fff8e1; border-bottom: 3px solid #5d4037;">成長の視点</th>
        <th><div class="step-header"><span class="step-label">STEP 1</span><span class="step-desc">🔰 まずはここから</span></div></th>
        <th><div class="step-header"><span class="step-label">STEP 2</span><span class="step-desc">🏃 自分で工夫する</span></div></th>
        <th><div class="step-header"><span class="step-label">STEP 3</span><span class="step-desc">🤝 みんなと高める</span></div></th>
        <th><div class="step-header"><span class="step-label">STEP 4</span><span class="step-desc">🌏 未来を創る</span></div></th>
      </tr></thead>
      <tbody>
        <tr>
          <td class="col-category cat-class" rowspan="3">授業<br>準備</td>
          <td class="col-viewpoint"><div>授業をつくる</div><div style="font-size:9px;color:#888;margin-top:2px">準備・計画</div></td>
          <td class="col-step" data-vp="lesson_plan" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">基本型をまねる</span><p>教科書や「わたしたちのきょうど」、「あゆみ」を見て、基本的な授業の流れをつかんでみよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="lesson_plan" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">実態に合わせる</span><p>「この子たちなら？」と想像して、名古屋のネタや身近な話題を取り入れよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="lesson_plan" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">深い学びを仕掛ける</span><p>「なぜ？」といった<span class="ss-term">社会的な見方</span>を取り入れた、面白い単元を作ってみよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="lesson_plan" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">大きな学びを描く</span><p>社会科を中心に、SDGsや他教科ともつながるような、広がりのある学びをデザインしよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-viewpoint"><div>授業をする</div><div style="font-size:9px;color:#888;margin-top:2px">技術・対話</div></td>
          <td class="col-step" data-vp="lesson_practice" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">資料で惹きつける</span><p>地図や写真をドーンと見せて、子供の興味を惹きつける発問をしてみよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="lesson_practice" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">対話で盛り上げる</span><p>子供のつぶやきを拾って、意見を戦わせる場面を作ってみよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="lesson_practice" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">探究を支える</span><p>ICTを使って、子供自身が調べて、考えて、まとめる時間を充実させよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="lesson_practice" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">技を伝える</span><p>若手の授業を見て、具体的なアドバイスをし、授業力を引き上げよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-viewpoint"><div>子供を見る</div><div style="font-size:9px;color:#888;margin-top:2px">評価・改善</div></td>
          <td class="col-step" data-vp="student_eval" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">基礎を確認する</span><p>地名や用語など、基本的なことが身についたか確認してみよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="student_eval" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">思考を見取る</span><p>発言やノートから、「事実を元に考えているかな？」と頭の中をのぞいてみよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="student_eval" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">頑張りを認める</span><p>粘り強く調べる姿など、点数になりにくい良さも見つけてみよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="student_eval" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">授業をより良くする</span><p>評価規準を作り、子供の姿を元に自分の授業をアップデートしよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-category cat-connect">仲間<br>活動</td>
          <td class="col-viewpoint"><div>つながる</div><div style="font-size:9px;color:#888;margin-top:2px">同僚性・楽しさ</div></td>
          <td class="col-step" data-vp="connection" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">まずは楽しむ</span><p>イベントに参加して楽しもう。同期や先輩と顔見知りになれたらOK！</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="connection" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">弱音を吐く</span><p>悩みを相談したり、失敗談を笑い合ったりできる仲間を作ろう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="connection" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">場を盛り上げる</span><p>飲み会やFWの幹事をして、若手とベテランをつなぐ架け橋になろう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="connection" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">次世代を育てる</span><p>「この会を良くするには？」と未来を語り、次のリーダーたちを育てよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-category cat-research">研究<br>発信</td>
          <td class="col-viewpoint"><div>深める</div><div style="font-size:9px;color:#888;margin-top:2px">探究・理論</div></td>
          <td class="col-step" data-vp="research" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">「すごい！」に触れる</span><p>先輩の実践記録を読んで、「こんな授業があるんだ！」と刺激を受けよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="research" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">実践を書く</span><p>自分の授業を<span class="ss-term">「体験記録」</span>等の文章にまとめて、整理してみよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="research" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">理論を磨く</span><p>テーマを深掘りして議論したり、自分の実践を理論づけたりしてみよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="research" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">全国へ発信する</span><p>全国大会などで発表して、名古屋の社会科の魅力を外に向けて発信しよう。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr class="row-action">
          <td colspan="2" style="text-align:right;font-weight:bold;padding-right:20px;color:#e65100"><i class="fas fa-shoe-prints"></i> おすすめのアクション</td>
          <td><ul class="action-list"><li><strong>若手交流会</strong>で仲間作り</li><li><strong>授業づくり講座</strong>を聞く</li><li><strong>懇親会</strong>にとりあえず行く</li></ul></td>
          <td><ul class="action-list"><li><strong>スキルアップ研修</strong>に参加</li><li><strong>体験記録</strong>を書いてみる</li><li><strong>FW(フィールドワーク)</strong>へGO!</li></ul></td>
          <td><ul class="action-list"><li><strong>模擬授業</strong>をやってみる</li><li><strong>FW・イベント</strong>を企画する</li><li><strong>研究部</strong>で議論する</li></ul></td>
          <td><ul class="action-list"><li><strong>講師</strong>として話す</li><li><strong>研究紀要</strong>をまとめる</li><li><strong>全国大会</strong>に行く・呼ぶ</li></ul></td>
        </tr>
      </tbody>
    </table>
    <div class="footer-note">
      <div style="color:#666"><strong>カテゴリ：</strong><span style="color:#8d6e63">■ 授業・準備</span> <span style="color:#66bb6a">■ 仲間・活動</span> <span style="color:#42a5f5">■ 研究・発信</span></div>
      <div style="color:#777;text-align:right;max-width:60%">※これは「ここまでやらなきゃいけない」というノルマではありません。<br>今の自分に合った「次の一歩」を見つけるための地図として使ってください。</div>
    </div>
  </div>

  <div class="save-area">
    <button class="btn-sm btn-save" onclick="saveSelections()"><i class="fas fa-save"></i> 保存する</button>
    <button class="btn-sm" style="background:#eee;color:#666;padding:10px 20px;border:none;border-radius:10px;margin-left:8px;cursor:pointer;font-family:inherit;font-weight:700" onclick="window.print()"><i class="fas fa-print"></i> 印刷する</button>
    <div class="save-status" id="saveStatus"><i class="fas fa-check-circle"></i> 保存しました</div>
  </div>
</div>

<script>
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');
if (!token || !user) { window.location.href = '/login'; }

document.getElementById('userName').textContent = user ? (user.name + ' さん' + (user.school ? '（' + user.school + '）' : '')) : '';
if (user && user.role === 'admin') {
  document.getElementById('adminLink').innerHTML = '<a href="/admin" class="btn-sm btn-admin" style="text-decoration:none"><i class="fas fa-cog"></i> 管理者</a> <a href="/admin/events" class="btn-sm" style="text-decoration:none;background:#ff6f00;color:#fff"><i class="fas fa-calendar-alt"></i> イベント</a>';
}

function selectCell(td) {
  const vp = td.dataset.vp;
  const step = td.dataset.step;
  // Deselect same viewpoint
  document.querySelectorAll('.col-step[data-vp="'+vp+'"]').forEach(el => {
    if (el !== td) { el.classList.remove('selected'); }
  });
  td.classList.toggle('selected');
}

async function loadSelections() {
  try {
    const res = await fetch('/api/selections', { headers: { 'Authorization': 'Bearer ' + token } });
    if (res.status === 401) { localStorage.clear(); window.location.href = '/login'; return; }
    const data = await res.json();
    for (const s of data.selections) {
      const cell = document.querySelector('.col-step[data-vp="'+s.viewpoint+'"][data-step="'+s.step+'"]');
      if (cell) {
        cell.classList.add('selected');
        const memo = cell.querySelector('.memo-input');
        if (memo && s.memo) memo.value = s.memo;
      }
    }
  } catch(e) { console.error(e); }
}

async function saveSelections() {
  const selected = document.querySelectorAll('.col-step.selected');
  const promises = [];
  // Collect all viewpoints
  const viewpoints = ['lesson_plan','lesson_practice','student_eval','connection','research'];
  const selectedVps = new Set();

  for (const cell of selected) {
    const vp = cell.dataset.vp;
    const step = parseInt(cell.dataset.step);
    const memo = cell.querySelector('.memo-input')?.value || '';
    selectedVps.add(vp);
    promises.push(fetch('/api/selections', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewpoint: vp, step, memo })
    }));
  }

  // Delete unselected viewpoints
  for (const vp of viewpoints) {
    if (!selectedVps.has(vp)) {
      promises.push(fetch('/api/selections/' + vp, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token }
      }));
    }
  }

  await Promise.all(promises);
  const status = document.getElementById('saveStatus');
  status.style.display = 'block';
  setTimeout(() => status.style.display = 'none', 3000);
}

async function logout() {
  const t = localStorage.getItem('token');
  if (t) { try { await fetch('/api/auth/logout', { method:'POST', headers:{'Authorization':'Bearer '+t} }); } catch(e){} }
  localStorage.clear(); window.location.href = '/login';
}

loadSelections();
</script>
</body></html>`)
})

// --- Admin Dashboard ---
app.get('/admin', (c) => {
  return c.html(`<!DOCTYPE html><html lang="ja"><head>${commonHead}
<title>管理者ダッシュボード - 学びのコンパス</title>
<style>
  .top-bar { background: #1a237e; color: #fff; padding: 10px 24px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; }
  .top-bar .logo { font-family: 'Zen Maru Gothic', sans-serif; font-size: 18px; font-weight: 700; }
  .top-bar .user-info { display: flex; align-items: center; gap: 12px; font-size: 13px; }
  .btn-sm { padding: 6px 14px; border-radius: 8px; border: none; font-size: 12px; font-weight: 700; cursor: pointer; font-family: inherit; }
  .btn-back { background: rgba(255,255,255,0.2); color: #fff; }
  .btn-back:hover { background: rgba(255,255,255,0.3); }
  .btn-logout { background: rgba(255,255,255,0.15); color: #fff; }
  .btn-export { background: #2e7d32; color: #fff; padding: 10px 24px; font-size: 14px; border-radius: 10px; }
  .btn-export:hover { background: #1b5e20; }
  .btn-danger { background: #c62828; color: #fff; font-size: 11px; padding: 4px 10px; }
  .btn-danger:hover { background: #b71c1c; }
  .btn-role { background: #1565c0; color: #fff; font-size: 11px; padding: 4px 10px; }
  .btn-role:hover { background: #0d47a1; }

  .main { max-width: 1400px; margin: 20px auto; padding: 0 16px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.06); border-left: 4px solid; text-align: center; }
  .stat-card .num { font-size: 36px; font-weight: 700; font-family: 'Zen Maru Gothic', sans-serif; }
  .stat-card .label { font-size: 12px; color: #888; margin-top: 4px; }
  .stat-card.total { border-color: #1a237e; }
  .stat-card.total .num { color: #1a237e; }
  .stat-card.active { border-color: #2e7d32; }
  .stat-card.active .num { color: #2e7d32; }
  .stat-card.partial { border-color: #f57f17; }
  .stat-card.partial .num { color: #f57f17; }
  .stat-card.none { border-color: #bbb; }
  .stat-card.none .num { color: #bbb; }

  .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 10px; }
  .search-box { padding: 8px 14px; border: 2px solid #ddd; border-radius: 8px; font-size: 14px; width: 280px; font-family: inherit; }
  .search-box:focus { outline: none; border-color: #1a237e; }

  .member-table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.06); font-size: 13px; }
  .member-table thead th { background: #f5f5f5; padding: 12px 10px; text-align: center; font-weight: 700; color: #555; border-bottom: 2px solid #ddd; white-space: nowrap; }
  .member-table tbody td { padding: 10px; border-bottom: 1px solid #eee; text-align: center; vertical-align: middle; }
  .member-table tbody tr:hover { background: #f5f5f5; }

  .step-badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 700; color: #fff; white-space: nowrap; }
  .step-1 { background: #78909c; }
  .step-2 { background: #42a5f5; }
  .step-3 { background: #66bb6a; }
  .step-4 { background: #ff7043; }
  .step-none { background: #e0e0e0; color: #999; }

  .role-badge { display: inline-block; padding: 2px 8px; border-radius: 8px; font-size: 10px; font-weight: 700; }
  .role-admin { background: #e3f2fd; color: #1565c0; }
  .role-member { background: #f5f5f5; color: #888; }

  .member-name { font-weight: 700; text-align: left !important; }

  .detail-modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 200; align-items: center; justify-content: center; }
  .detail-modal.show { display: flex; }
  .detail-content { background: #fff; border-radius: 16px; padding: 32px; max-width: 600px; width: 90%; max-height: 80vh; overflow-y: auto; }
  .detail-content h2 { font-family: 'Zen Maru Gothic', sans-serif; color: #1a237e; margin: 0 0 20px; }
  .detail-item { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #eee; }
  .detail-item .vp-name { font-weight: 700; color: #555; }
  .detail-item .memo { font-size: 12px; color: #888; margin-top: 4px; }
</style>
</head><body>
<div class="top-bar">
  <div class="logo"><i class="fas fa-shield-alt"></i> 管理者ダッシュボード</div>
  <div class="user-info">
    <a href="/mypage" class="btn-sm btn-back" style="text-decoration:none"><i class="fas fa-map"></i> マイページ</a>
    <a href="/admin/events" class="btn-sm" style="text-decoration:none;background:rgba(255,255,255,0.2);color:#fff"><i class="fas fa-calendar-alt"></i> イベント</a>
    <button class="btn-sm btn-logout" onclick="logout()"><i class="fas fa-sign-out-alt"></i> ログアウト</button>
  </div>
</div>

<div class="main">
  <div class="stats">
    <div class="stat-card total"><div class="num" id="totalCount">-</div><div class="label">総会員数</div></div>
    <div class="stat-card active"><div class="num" id="completeCount">-</div><div class="label">全項目記入済み</div></div>
    <div class="stat-card partial"><div class="num" id="partialCount">-</div><div class="label">一部記入</div></div>
    <div class="stat-card none"><div class="num" id="noneCount">-</div><div class="label">未記入</div></div>
  </div>

  <div class="toolbar">
    <input type="text" class="search-box" id="searchBox" placeholder="🔍 名前・メールで検索..." oninput="filterMembers()">
    <div style="display:flex;gap:8px">
      <button class="btn-sm btn-export" onclick="exportCSV()"><i class="fas fa-file-excel"></i> Excel (CSV) ダウンロード</button>
    </div>
  </div>

  <table class="member-table">
    <thead><tr>
      <th style="width:30px">#</th>
      <th style="width:140px">名前</th>
      <th style="width:100px">役割</th>
      <th>授業をつくる</th>
      <th>授業をする</th>
      <th>子供を見る</th>
      <th>つながる</th>
      <th>深める</th>
      <th style="width:130px">操作</th>
    </tr></thead>
    <tbody id="memberBody"></tbody>
  </table>
</div>

<div class="detail-modal" id="detailModal" onclick="if(event.target===this)this.classList.remove('show')">
  <div class="detail-content" id="detailContent"></div>
</div>

<script>
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');
if (!token || !user || user.role !== 'admin') { window.location.href = '/login'; }

let allMembers = [];
const vpKeys = ['lesson_plan','lesson_practice','student_eval','connection','research'];
const vpLabels = { lesson_plan:'授業をつくる', lesson_practice:'授業をする', student_eval:'子供を見る', connection:'つながる', research:'深める' };
const stepLabels = { 1:'STEP1', 2:'STEP2', 3:'STEP3', 4:'STEP4' };

function stepBadge(sel) {
  if (!sel) return '<span class="step-badge step-none">未選択</span>';
  return '<span class="step-badge step-'+sel.step+'">STEP'+sel.step+'</span>';
}

function renderMembers(members) {
  const body = document.getElementById('memberBody');
  body.innerHTML = members.map((m, i) => {
    const roleBadge = m.role === 'admin'
      ? '<span class="role-badge role-admin">管理者</span>'
      : '<span class="role-badge role-member">会員</span>';
    return '<tr>' +
      '<td>'+(i+1)+'</td>' +
      '<td class="member-name" style="cursor:pointer" data-action="detail" data-id="'+m.id+'">' + m.name + '</td>' +
      '<td>' + roleBadge + '</td>' +
      vpKeys.map(vp => '<td>' + stepBadge(m.selections[vp]) + '</td>').join('') +
      '<td>' +
        (m.role !== 'admin' ? '<button class="btn-sm btn-role" data-action="role" data-id="'+m.id+'" data-role="'+m.role+'"><i class="fas fa-user-shield"></i></button> ' : '') +
        (m.id !== user.id ? '<button class="btn-sm btn-danger" data-action="delete" data-id="'+m.id+'" data-name="'+m.name+'"><i class="fas fa-trash"></i></button>' : '') +
      '</td>' +
    '</tr>';
  }).join('');
}

function updateStats(members) {
  const total = members.filter(m => m.role !== 'admin').length;
  let complete = 0, partial = 0, none = 0;
  members.filter(m => m.role !== 'admin').forEach(m => {
    const count = vpKeys.filter(vp => m.selections[vp]).length;
    if (count === 5) complete++;
    else if (count > 0) partial++;
    else none++;
  });
  document.getElementById('totalCount').textContent = total;
  document.getElementById('completeCount').textContent = complete;
  document.getElementById('partialCount').textContent = partial;
  document.getElementById('noneCount').textContent = none;
}

async function loadMembers() {
  const res = await fetch('/api/admin/members', { headers: { 'Authorization': 'Bearer ' + token } });
  if (res.status === 401 || res.status === 403) { localStorage.clear(); window.location.href = '/login'; return; }
  const data = await res.json();
  allMembers = data.members;
  renderMembers(allMembers);
  updateStats(allMembers);
}

function filterMembers() {
  const q = document.getElementById('searchBox').value.toLowerCase();
  const filtered = allMembers.filter(m => m.name.toLowerCase().includes(q) || (m.school || '').toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
  renderMembers(filtered);
}

function showDetail(id) {
  const m = allMembers.find(x => x.id === id);
  if (!m) return;
  let html = '<h2><i class="fas fa-user"></i> ' + m.name + '</h2>';
  html += '<p style="color:#888;font-size:13px;margin-bottom:20px">' + (m.school ? ('学校名: ' + m.school + ' | ') : '') + m.email + ' | 登録日: ' + (m.created_at || '-') + '</p>';
  for (const vp of vpKeys) {
    const sel = m.selections[vp];
    html += '<div class="detail-item"><div><div class="vp-name">' + vpLabels[vp] + '</div>';
    if (sel && sel.memo) html += '<div class="memo">' + sel.memo + '</div>';
    html += '</div>' + stepBadge(sel) + '</div>';
  }
  html += '<div style="text-align:center;margin-top:24px"><button class="btn-sm" style="background:#eee;color:#555;padding:8px 24px" id="closeDetailBtn">閉じる</button></div>';
  document.getElementById('detailContent').innerHTML = html;
  document.getElementById('closeDetailBtn').addEventListener('click', function() { document.getElementById('detailModal').classList.remove('show'); });
  document.getElementById('detailModal').classList.add('show');
}

async function toggleRole(id, currentRole) {
  const newRole = currentRole === 'admin' ? 'member' : 'admin';
  const label = newRole === 'admin' ? '管理者に変更' : '会員に変更';
  if (!confirm(label + 'しますか？')) return;
  await fetch('/api/admin/members/'+id+'/role', {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: newRole })
  });
  loadMembers();
}

async function deleteMember(id, name) {
  if (!confirm(name + ' さんを削除しますか？この操作は取り消せません。')) return;
  await fetch('/api/admin/members/'+id, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + token }
  });
  loadMembers();
}

async function exportCSV() {
  const res = await fetch('/api/admin/export', { headers: { 'Authorization': 'Bearer ' + token } });
  if (!res.ok) { alert('エクスポートに失敗しました'); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'shakaika_members_export.csv';
  a.click();
  URL.revokeObjectURL(url);
}

async function logout() {
  const t = localStorage.getItem('token');
  if (t) { try { await fetch('/api/auth/logout', { method:'POST', headers:{'Authorization':'Bearer '+t} }); } catch(e){} }
  localStorage.clear(); window.location.href = '/login';
}

// Event delegation for member table
document.addEventListener('click', function(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = parseInt(btn.dataset.id);
  if (action === 'detail') showDetail(id);
  else if (action === 'role') toggleRole(id, btn.dataset.role);
  else if (action === 'delete') deleteMember(id, btn.dataset.name);
});

loadMembers();
</script>
</body></html>`)
})

// --- QR Attend Page (scanned by member) ---
app.get('/attend/:code', (c) => {
  const code = c.req.param('code')
  return c.html(`<!DOCTYPE html><html lang="ja"><head>${commonHead}
<title>出席・アンケート - 学びのコンパス</title>
<style>
  .attend-container { max-width: 560px; margin: 20px auto; padding: 0 16px; }
  .card { background: #fff; border-radius: 16px; padding: 28px 24px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); border: 2px solid #f0e6d2; margin-bottom: 20px; }
  .card h2 { font-family: 'Zen Maru Gothic', sans-serif; color: var(--header-line); margin: 0 0 4px; font-size: 20px; }
  .card .date { color: #888; font-size: 13px; margin-bottom: 16px; }
  .card .desc { color: #666; font-size: 13px; margin-bottom: 16px; line-height: 1.6; }
  .success-box { background: #e8f5e9; border: 2px solid #66bb6a; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 20px; }
  .success-box i { font-size: 40px; color: #2e7d32; }
  .success-box p { font-size: 15px; font-weight: 700; color: #2e7d32; margin: 8px 0 0; }
  .form-group { margin-bottom: 18px; }
  .form-group label { display: block; font-weight: 700; font-size: 14px; color: #555; margin-bottom: 6px; }
  .form-group .hint { font-size: 11px; color: #999; margin-bottom: 6px; }
  .stars { display: flex; gap: 6px; }
  .star { font-size: 32px; cursor: pointer; color: #ddd; transition: color 0.15s; }
  .star.active { color: #ffb300; }
  .star:hover { color: #ffc107; }
  textarea { width: 100%; padding: 10px; border: 2px solid #e0d6c8; border-radius: 8px; font-size: 14px; font-family: inherit; resize: vertical; min-height: 80px; }
  textarea:focus { outline: none; border-color: var(--header-line); }
  input[type="text"] { width: 100%; padding: 10px; border: 2px solid #e0d6c8; border-radius: 8px; font-size: 14px; font-family: inherit; }
  input[type="text"]:focus { outline: none; border-color: var(--header-line); }
  .radio-group { display: flex; flex-wrap: wrap; gap: 8px; }
  .radio-option { padding: 8px 16px; border: 2px solid #e0d6c8; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500; transition: all 0.15s; }
  .radio-option.selected { border-color: var(--header-line); background: #fff3e0; color: var(--header-line); font-weight: 700; }
  .rating-stars { display: flex; gap: 4px; }
  .rating-star { font-size: 26px; cursor: pointer; color: #ddd; transition: color 0.15s; }
  .rating-star.active { color: #ffb300; }
  .btn { width: 100%; padding: 14px; border: none; border-radius: 12px; font-size: 16px; font-weight: 700; cursor: pointer; font-family: inherit; }
  .btn-primary { background: var(--header-line); color: #fff; }
  .btn-primary:hover { background: #bf360c; }
  .btn-secondary { background: #f5f5f5; color: #666; margin-top: 10px; }
  .already { background: #f3e5f5; border: 2px solid #ab47bc; border-radius: 12px; padding: 16px; text-align: center; color: #6a1b9a; font-weight: 700; }
  .login-prompt { text-align: center; padding: 40px 20px; }
  .login-prompt a { color: var(--header-line); font-weight: 700; }
  #loading { text-align: center; padding: 60px; color: #888; }
</style>
</head><body>
<div class="attend-container">
  <div id="loading"><i class="fas fa-spinner fa-spin fa-2x"></i><p>読み込み中...</p></div>
  <div id="loginPrompt" style="display:none" class="card login-prompt">
    <i class="fas fa-user-circle fa-3x" style="color:#ccc;margin-bottom:12px"></i>
    <p>出席を記録するにはログインが必要です</p>
    <a href="/login?redirect=/attend/${code}" class="btn btn-primary" style="display:inline-block;width:auto;padding:12px 32px;text-decoration:none;margin-top:12px">ログインする</a>
  </div>
  <div id="content" style="display:none"></div>
</div>
<script>
const CODE = '${code}';
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');
if (!token || !user) {
  document.getElementById('loading').style.display='none';
  document.getElementById('loginPrompt').style.display='block';
} else { loadEvent(); }

async function loadEvent() {
  try {
    const res = await fetch('/api/events/'+CODE, { headers:{'Authorization':'Bearer '+token} });
    if (res.status === 401) { localStorage.clear(); document.getElementById('loading').style.display='none'; document.getElementById('loginPrompt').style.display='block'; return; }
    const data = await res.json();
    if (!res.ok) { document.getElementById('loading').innerHTML='<p style="color:#c62828">'+data.error+'</p>'; return; }
    // Auto attend
    if (!data.attendance) {
      await fetch('/api/events/'+CODE+'/attend', { method:'POST', headers:{'Authorization':'Bearer '+token} });
    }
    renderEvent(data);
  } catch(e) { document.getElementById('loading').innerHTML='<p style="color:#c62828">エラーが発生しました</p>'; }
}

let satisfaction = 0;
let customData = {};

function renderEvent(data) {
  const ev = data.event;
  const qs = data.questions || [];
  const hasSurvey = !!data.survey;
  document.getElementById('loading').style.display='none';
  const c = document.getElementById('content');
  c.style.display='block';
  let html = '<div class="success-box"><i class="fas fa-check-circle"></i><p>出席を記録しました！</p></div>';
  html += '<div class="card"><h2>'+ev.title+'</h2><div class="date"><i class="fas fa-calendar"></i> '+ev.event_date+'</div>';
  if (ev.description) html += '<div class="desc">'+ev.description+'</div>';
  if (hasSurvey) {
    html += '<div class="already"><i class="fas fa-clipboard-check"></i> アンケートは回答済みです。ありがとうございました！</div></div>';
    html += '<a href="/mypage" class="btn btn-secondary" style="display:block;text-align:center;text-decoration:none"><i class="fas fa-home"></i> マイページへ</a>';
  } else {
    html += '<hr style="border:none;border-top:2px dashed #eee;margin:16px 0"><h3 style="font-family:Zen Maru Gothic;color:#5d4037;font-size:16px;margin:0 0 16px"><i class="fas fa-clipboard-list"></i> アンケート</h3>';
    html += '<div class="form-group"><label>満足度</label><div class="hint">タップで選択してください</div><div class="stars" id="stars">';
    for (let i=1;i<=5;i++) html += '<span class="star" data-val="'+i+'" onclick="setStar('+i+')">★</span>';
    html += '</div></div>';
    html += '<div class="form-group"><label>感想・コメント</label><textarea id="comment" placeholder="自由にお書きください"></textarea></div>';
    for (const q of qs) {
      html += '<div class="form-group"><label>'+q.question_text+'</label>';
      if (q.question_type === 'text') {
        html += '<input type="text" id="cq_'+q.id+'" placeholder="回答を入力">';
      } else if (q.question_type === 'radio') {
        const opts = q.options ? q.options.split('|') : [];
        html += '<div class="radio-group" id="cq_'+q.id+'">';
        for (const o of opts) html += '<div class="radio-option" onclick="selectRadio(this,'+q.id+')">'+o+'</div>';
        html += '</div>';
      } else if (q.question_type === 'rating') {
        html += '<div class="rating-stars" id="cq_'+q.id+'">';
        for (let i=1;i<=5;i++) html += '<span class="rating-star" data-qid="'+q.id+'" data-val="'+i+'" onclick="setRating('+q.id+','+i+')">★</span>';
        html += '</div>';
      }
      html += '</div>';
    }
    html += '<button class="btn btn-primary" onclick="submitSurvey()"><i class="fas fa-paper-plane"></i> アンケートを送信</button>';
    html += '</div>';
    html += '<a href="/mypage" class="btn btn-secondary" style="display:block;text-align:center;text-decoration:none;margin-top:10px"><i class="fas fa-home"></i> マイページへ</a>';
  }
  c.innerHTML = html;
  // Restore previous answers
  if (data.survey) satisfaction = data.survey.satisfaction;
  if (data.customAnswers) {
    for (const ca of data.customAnswers) customData[ca.question_id] = ca.answer_text;
  }
}

function setStar(v) { satisfaction=v; document.querySelectorAll('#stars .star').forEach((s,i)=>s.classList.toggle('active',i<v)); }
function selectRadio(el, qid) {
  el.parentElement.querySelectorAll('.radio-option').forEach(o=>o.classList.remove('selected'));
  el.classList.add('selected'); customData[qid]=el.textContent;
}
function setRating(qid, v) {
  customData[qid]=String(v);
  document.querySelectorAll('#cq_'+qid+' .rating-star').forEach((s,i)=>s.classList.toggle('active',i<v));
}

async function submitSurvey() {
  const qs = document.querySelectorAll('[id^="cq_"]');
  const custom_answers = [];
  qs.forEach(el => {
    const qid = parseInt(el.id.replace('cq_',''));
    if (el.tagName === 'INPUT') { customData[qid] = el.value; }
    if (customData[qid]) custom_answers.push({ question_id: qid, answer_text: customData[qid] });
  });
  const comment = document.getElementById('comment')?.value || '';
  const res = await fetch('/api/events/'+CODE+'/survey', {
    method:'POST', headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
    body: JSON.stringify({ satisfaction, comment, custom_answers })
  });
  if (res.ok) {
    document.getElementById('content').innerHTML = '<div class="success-box"><i class="fas fa-heart"></i><p>回答ありがとうございました！</p></div><a href="/mypage" class="btn btn-secondary" style="display:block;text-align:center;text-decoration:none"><i class="fas fa-home"></i> マイページへ</a>';
  } else { alert('送信に失敗しました'); }
}
</script>
</body></html>`)
})

// --- Admin Events Page ---
app.get('/admin/events', (c) => {
  return c.html(`<!DOCTYPE html><html lang="ja"><head>${commonHead}
<title>イベント管理 - 学びのコンパス</title>
<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
<style>
  .top-bar { background: #1a237e; color: #fff; padding: 10px 24px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 100; }
  .top-bar .logo { font-family: 'Zen Maru Gothic', sans-serif; font-size: 18px; font-weight: 700; }
  .btn-sm { padding: 6px 14px; border-radius: 8px; border: none; font-size: 12px; font-weight: 700; cursor: pointer; font-family: inherit; }
  .btn-back { background: rgba(255,255,255,0.2); color: #fff; text-decoration: none; }
  .main { max-width: 900px; margin: 20px auto; padding: 0 16px; }
  .card { background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 2px 10px rgba(0,0,0,0.06); margin-bottom: 16px; }
  .card h3 { font-family: 'Zen Maru Gothic', sans-serif; margin: 0 0 12px; color: #333; }
  .form-row { display: flex; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .form-row input, .form-row textarea { flex: 1; padding: 8px 12px; border: 2px solid #e0d6c8; border-radius: 8px; font-size: 14px; font-family: inherit; min-width: 200px; }
  .form-row input:focus, .form-row textarea:focus { outline: none; border-color: #1a237e; }
  .btn-create { background: #1a237e; color: #fff; padding: 10px 24px; border: none; border-radius: 10px; font-size: 14px; font-weight: 700; cursor: pointer; font-family: inherit; }
  .btn-create:hover { background: #0d1642; }
  .btn-danger { background: #c62828; color: #fff; font-size: 11px; padding: 4px 10px; border: none; border-radius: 6px; cursor: pointer; }
  .btn-export2 { background: #2e7d32; color: #fff; font-size: 11px; padding: 4px 10px; border: none; border-radius: 6px; cursor: pointer; }
  .btn-qr { background: #ff6f00; color: #fff; font-size: 11px; padding: 4px 10px; border: none; border-radius: 6px; cursor: pointer; }
  .event-item { display: flex; justify-content: space-between; align-items: center; padding: 14px 0; border-bottom: 1px solid #eee; flex-wrap: wrap; gap: 8px; }
  .event-item:last-child { border-bottom: none; }
  .event-info .title { font-weight: 700; font-size: 15px; }
  .event-info .meta { font-size: 12px; color: #888; margin-top: 2px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 8px; font-size: 10px; font-weight: 700; }
  .badge-att { background: #e3f2fd; color: #1565c0; }
  .badge-sur { background: #f3e5f5; color: #7b1fa2; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .qr-modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 200; align-items: center; justify-content: center; }
  .qr-modal.show { display: flex; }
  .qr-content { background: #fff; border-radius: 20px; padding: 36px; text-align: center; max-width: 420px; width: 90%; }
  .qr-content h3 { font-family: 'Zen Maru Gothic', sans-serif; color: #1a237e; margin: 0 0 4px; }
  .qr-content .date { color: #888; font-size: 13px; margin-bottom: 16px; }
  .qr-content canvas { margin: 0 auto; }
  .qr-content .code-text { margin-top: 12px; font-size: 20px; font-weight: 700; color: var(--header-line); letter-spacing: 4px; font-family: monospace; }
  .qr-content .url-text { margin-top: 8px; font-size: 11px; color: #999; word-break: break-all; }
  .custom-q-area { margin-top: 16px; padding-top: 16px; border-top: 2px dashed #eee; }
  .custom-q-item { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; flex-wrap: wrap; }
  .custom-q-item input, .custom-q-item select { padding: 6px 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; font-family: inherit; }
  .custom-q-item .q-text { flex: 1; min-width: 150px; }
  .remove-q { background: none; border: none; color: #c62828; cursor: pointer; font-size: 16px; }
  .btn-add-q { background: #f5f5f5; color: #555; border: 2px dashed #ccc; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; font-family: inherit; width: 100%; margin-top: 8px; }
  @media print {
    .top-bar, .main { display: none !important; }
    .qr-modal { position: static !important; display: block !important; background: none !important; }
    .qr-content { box-shadow: none !important; max-width: none !important; padding: 20px !important; }
  }
</style>
</head><body>
<div class="top-bar">
  <div class="logo"><i class="fas fa-calendar-alt"></i> イベント管理</div>
  <div style="display:flex;gap:8px">
    <a href="/admin" class="btn-sm btn-back"><i class="fas fa-arrow-left"></i> ダッシュボード</a>
  </div>
</div>
<div class="main">
  <div class="card">
    <h3><i class="fas fa-plus-circle"></i> 新しいイベントを作成</h3>
    <div class="form-row">
      <input type="text" id="evTitle" placeholder="イベント名（例：7月定例会）">
      <input type="date" id="evDate">
    </div>
    <div class="form-row">
      <textarea id="evDesc" rows="2" placeholder="説明（任意）" style="width:100%"></textarea>
    </div>
    <div class="custom-q-area">
      <strong style="font-size:13px;color:#555"><i class="fas fa-question-circle"></i> カスタム質問（任意）</strong>
      <div id="customQuestions"></div>
      <button class="btn-add-q" onclick="addQuestion()"><i class="fas fa-plus"></i> 質問を追加</button>
    </div>
    <div style="margin-top:16px"><button class="btn-create" onclick="createEvent()"><i class="fas fa-paper-plane"></i> 作成する</button></div>
  </div>
  <div class="card">
    <h3><i class="fas fa-list"></i> イベント一覧</h3>
    <div id="eventList"><p style="color:#888;text-align:center">読み込み中...</p></div>
  </div>
</div>
<div class="qr-modal" id="qrModal" onclick="if(event.target===this)this.classList.remove('show')">
  <div class="qr-content" id="qrContent"></div>
</div>
<script>
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user')||'null');
if (!token||!user||user.role!=='admin') window.location.href='/login';

let qCount = 0;
function addQuestion() {
  qCount++;
  const div = document.getElementById('customQuestions');
  const item = document.createElement('div');
  item.className = 'custom-q-item';
  item.id = 'q_'+qCount;
  item.innerHTML = '<input class="q-text" type="text" placeholder="質問文"><select class="q-type"><option value="text">テキスト入力</option><option value="radio">選択式</option><option value="rating">5段階評価</option></select><input class="q-opts" type="text" placeholder="選択肢（|区切り）" style="display:none;min-width:120px"><button class="remove-q" onclick="this.parentElement.remove()"><i class="fas fa-times"></i></button>';
  item.querySelector('.q-type').addEventListener('change', function() {
    item.querySelector('.q-opts').style.display = this.value==='radio'?'block':'none';
  });
  div.appendChild(item);
}

async function createEvent() {
  const title = document.getElementById('evTitle').value;
  const event_date = document.getElementById('evDate').value;
  const description = document.getElementById('evDesc').value;
  if (!title||!event_date) { alert('タイトルと日付を入力してください'); return; }
  const custom_questions = [];
  document.querySelectorAll('.custom-q-item').forEach(item => {
    const text = item.querySelector('.q-text').value;
    const type = item.querySelector('.q-type').value;
    const opts = item.querySelector('.q-opts').value;
    if (text) custom_questions.push({ question_text: text, question_type: type, options: opts });
  });
  const res = await fetch('/api/admin/events', {
    method:'POST', headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
    body: JSON.stringify({ title, event_date, description, custom_questions })
  });
  if (res.ok) { document.getElementById('evTitle').value=''; document.getElementById('evDate').value=''; document.getElementById('evDesc').value=''; document.getElementById('customQuestions').innerHTML=''; loadEvents(); }
  else { const d = await res.json(); alert(d.error); }
}

let eventsData = [];

async function loadEvents() {
  const res = await fetch('/api/admin/events', { headers:{'Authorization':'Bearer '+token} });
  if (res.status === 401 || res.status === 403) { localStorage.clear(); window.location.href='/login'; return; }
  const data = await res.json();
  eventsData = data.events || [];
  const list = document.getElementById('eventList');
  if (!eventsData.length) { list.innerHTML='<p style="color:#888;text-align:center">まだイベントがありません</p>'; return; }
  list.innerHTML = eventsData.map(function(ev) {
    return '<div class="event-item"><div class="event-info"><div class="title">'+ev.title+'</div><div class="meta"><i class="fas fa-calendar"></i> '+ev.event_date+' &nbsp; <span class="badge badge-att"><i class="fas fa-users"></i> 出席 '+ev.attendance_count+'</span> <span class="badge badge-sur"><i class="fas fa-clipboard"></i> 回答 '+ev.survey_count+'</span></div></div><div class="actions"><button class="btn-qr" data-action="qr" data-id="'+ev.id+'"><i class="fas fa-qrcode"></i> QR</button><button class="btn-export2" data-action="export" data-id="'+ev.id+'"><i class="fas fa-download"></i> CSV</button><button class="btn-danger" data-action="delete-ev" data-id="'+ev.id+'" data-title="'+ev.title.replace(/"/g,'&quot;')+'"><i class="fas fa-trash"></i></button></div></div>';
  }).join('');
}

function showQR(eventId) {
  const ev = eventsData.find(function(e){ return e.id === eventId; });
  if (!ev) return;
  const url = location.origin + '/attend/' + ev.event_code;
  const cont = document.getElementById('qrContent');
  cont.innerHTML = '<h3>'+ev.title+'</h3><div class="date">'+ev.event_date+'</div><div id="qrCanvas" style="display:inline-block"></div><div class="code-text">'+ev.event_code+'</div><div class="url-text">'+url+'</div><div style="margin-top:16px"><button class="btn-sm" style="background:#1a237e;color:#fff;padding:8px 20px" onclick="window.print()"><i class="fas fa-print"></i> 印刷</button> <button class="btn-sm" id="closeQrBtn" style="background:#eee;color:#555;padding:8px 20px">閉じる</button></div>';
  document.getElementById('qrModal').classList.add('show');
  document.getElementById('closeQrBtn').addEventListener('click', function() { document.getElementById('qrModal').classList.remove('show'); });
  setTimeout(function() {
    var qrEl = document.getElementById('qrCanvas');
    if (typeof QRCode !== 'undefined' && qrEl) {
      qrEl.innerHTML = '';
      new QRCode(qrEl, { text: url, width: 240, height: 240 });
    } else {
      qrEl.innerHTML = '<p style="color:#c62828">QRコードライブラリの読み込みに失敗しました。<br>URL: '+url+'</p>';
    }
  }, 200);
}

async function exportEvent(id) {
  const res = await fetch('/api/admin/events/'+id+'/export', { headers:{'Authorization':'Bearer '+token} });
  if (!res.ok) { alert('エクスポート失敗'); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download='event_export.csv'; a.click(); URL.revokeObjectURL(url);
}

async function deleteEvent(id, title) {
  if (!confirm(title+' を削除しますか？')) return;
  await fetch('/api/admin/events/'+id, { method:'DELETE', headers:{'Authorization':'Bearer '+token} });
  loadEvents();
}

// Event delegation for event list buttons
document.addEventListener('click', function(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = parseInt(btn.dataset.id);
  if (action === 'qr') showQR(id);
  else if (action === 'export') exportEvent(id);
  else if (action === 'delete-ev') deleteEvent(id, btn.dataset.title);
});

loadEvents();
</script>
</body></html>`)
})

// --- Root redirect ---
app.get('/', (c) => {
  return c.redirect('/login')
})

// --- Logout API (clean up session from D1) ---
app.post('/api/auth/logout', async (c) => {
  const authHeader = c.req.header('Authorization')
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '')
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
  }
  return c.json({ success: true })
})

export default app
