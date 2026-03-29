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
  const user = await c.env.DB.prepare('SELECT id, name, email, school, role, district, experience_years, grade, position FROM users WHERE id = ?').bind(userId).first()
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


  // Annual notes (goal/reflection) per fiscal year
  await db.prepare(`CREATE TABLE IF NOT EXISTS annual_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    fiscal_year INTEGER NOT NULL,
    goal TEXT DEFAULT '',
    reflection TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, fiscal_year)
  )`).run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_annual_notes_user_year ON annual_notes(user_id, fiscal_year)').run()

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
    'SELECT id, name, email, school, role, district, experience_years, grade, position FROM users WHERE email = ? AND password_hash = ?'
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

// Update my profile
app.post('/api/me/profile', authMiddleware, async (c) => {
  const u = c.get('user')
  const body = await c.req.json().catch(() => ({} as any))
  const school = typeof body.school === 'string' ? body.school.trim() : undefined
  const district = typeof body.district === 'string' ? body.district.trim() : undefined
  const experience_years = body.experience_years !== undefined ? (body.experience_years === '' || body.experience_years === null ? null : parseInt(body.experience_years, 10)) : undefined
  const grade = typeof body.grade === 'string' ? body.grade.trim() : undefined
  const position = typeof body.position === 'string' ? body.position.trim() : undefined
  const sets = []
  const params = []
  if (school !== undefined) { sets.push('school = ?'); params.push(school) }
  if (district !== undefined) { sets.push('district = ?'); params.push(district) }
  if (experience_years !== undefined) { sets.push('experience_years = ?'); params.push(experience_years) }
  if (grade !== undefined) { sets.push('grade = ?'); params.push(grade) }
  if (position !== undefined) { sets.push('position = ?'); params.push(position) }
  if (sets.length === 0) return c.json({ error: 'No fields' }, 400)
  sets.push("updated_at = datetime('now')")
  params.push(u.id)
  await c.env.DB.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?').bind(...params).run()
  const updated = await c.env.DB.prepare('SELECT id, name, email, school, role, district, experience_years, grade, position FROM users WHERE id = ?').bind(u.id).first()
  if (!updated) return c.json({ error: 'Failed' }, 500)
  return c.json({ user: updated })
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

  const validViewpoints = ['lesson_plan', 'lesson_practice', 'student_eval', 'connection', 'research', 'j_lesson_plan', 'j_material', 'j_dialogue', 'j_inquiry', 'j_student_eval', 'j_connection', 'j_research', 'a_school_support', 'a_school_mgmt', 'a_member_support', 'a_leader_dev', 'a_org_mgmt', 'a_outreach']
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


// ========== My Annual Notes & History ==========
function getCurrentFiscalYear(): number {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  return m >= 4 ? y : y - 1
}

app.get('/api/me/annual-notes', authMiddleware, async (c) => {
  const user = c.get('user')
  const qfy = c.req.query('fy')
  const fy = qfy ? parseInt(qfy) : getCurrentFiscalYear()
  const fiscalYear = Number.isFinite(fy) ? fy : getCurrentFiscalYear()

  const row = await c.env.DB.prepare(
    'SELECT fiscal_year, goal, reflection, datetime(updated_at, "+9 hours") as updated_at FROM annual_notes WHERE user_id = ? AND fiscal_year = ?'
  ).bind(user.id, fiscalYear).first() as any

  return c.json({
    fiscal_year: fiscalYear,
    goal: row?.goal || '',
    reflection: row?.reflection || '',
    updated_at: row?.updated_at || null
  })
})

app.post('/api/me/annual-notes', authMiddleware, async (c) => {
  const user = c.get('user')
  const body = await c.req.json()
  const fiscal_year = parseInt(body?.fiscal_year)
  const goal = (body?.goal ?? '').toString()
  const reflection = (body?.reflection ?? '').toString()

  if (!Number.isFinite(fiscal_year) || fiscal_year < 2000 || fiscal_year > 3000) {
    return c.json({ error: '年度が不正です' }, 400)
  }
  if (goal.length > 8000 || reflection.length > 8000) {
    return c.json({ error: '入力が長すぎます（8000文字以内）' }, 400)
  }

  await c.env.DB.prepare(`
    INSERT INTO annual_notes (user_id, fiscal_year, goal, reflection, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, fiscal_year) DO UPDATE SET
      goal = excluded.goal,
      reflection = excluded.reflection,
      updated_at = datetime('now')
  `).bind(user.id, fiscal_year, goal, reflection).run()

  return c.json({ success: true })
})

app.get('/api/me/history', authMiddleware, async (c) => {
  const user = c.get('user')
  const qfy = c.req.query('fy')
  const fy = qfy ? parseInt(qfy) : getCurrentFiscalYear()
  const fiscalYear = Number.isFinite(fy) ? fy : getCurrentFiscalYear()
  const start = `${fiscalYear}-04-01`
  const end = `${fiscalYear + 1}-03-31`

  const db = c.env.DB
  const { results: baseRows } = await db.prepare(
    `SELECT
      e.id as event_id,
      e.title,
      e.description,
      e.event_date,
      e.event_code,
      a.attended_at,
      sa.satisfaction,
      sa.comment,
      sa.answered_at
    FROM attendances a
    JOIN events e ON e.id = a.event_id
    LEFT JOIN survey_answers sa ON sa.event_id = e.id AND sa.user_id = a.user_id
    WHERE a.user_id = ? AND e.event_date >= ? AND e.event_date <= ?
    ORDER BY e.event_date DESC`
  ).bind(user.id, start, end).all() as any

  const { results: qaRows } = await db.prepare(
    `SELECT
      e.id as event_id,
      q.id as question_id,
      q.question_text,
      q.question_type,
      q.options,
      q.sort_order,
      ca.answer_text
    FROM attendances a
    JOIN events e ON e.id = a.event_id
    JOIN survey_questions q ON q.event_id = e.id
    LEFT JOIN custom_answers ca ON ca.event_id = e.id AND ca.question_id = q.id AND ca.user_id = a.user_id
    WHERE a.user_id = ? AND e.event_date >= ? AND e.event_date <= ?
    ORDER BY e.event_date DESC, q.sort_order ASC`
  ).bind(user.id, start, end).all() as any

  const map = new Map<number, any>()
  for (const r of (baseRows || [])) {
    map.set(r.event_id, {
      event_id: r.event_id,
      title: r.title,
      description: r.description || '',
      event_date: r.event_date,
      event_code: r.event_code,
      attended_at: r.attended_at,
      survey: {
        satisfaction: r.satisfaction ?? null,
        comment: r.comment || '',
        answered_at: r.answered_at ?? null
      },
      questions: [] as any[]
    })
  }
  for (const q of (qaRows || [])) {
    const ev = map.get(q.event_id)
    if (!ev) continue
    ev.questions.push({
      question_id: q.question_id,
      question_text: q.question_text,
      question_type: q.question_type,
      options: q.options || '',
      answer_text: q.answer_text || ''
    })
  }

  return c.json({ fiscal_year: fiscalYear, events: Array.from(map.values()) })
})


// ========== Admin API ==========
app.get('/api/admin/members', authMiddleware, adminMiddleware, async (c) => {
  const { results: members } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.school, u.email, u.role, u.district, u.experience_years, u.grade, u.position,
      datetime(u.created_at, '+9 hours') as created_at,
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
      district: m.district || '',
      experience_years: m.experience_years,
      grade: m.grade || '',
      position: m.position || '',
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

// Admin: Annual Notes (goal/reflection)
app.get('/api/admin/annual-notes', authMiddleware, adminMiddleware, async (c) => {
  const userId = parseInt(c.req.query('user_id') || '')
  const fy = parseInt(c.req.query('fy') || '')

  if (!Number.isFinite(userId) || userId <= 0) {
    return c.json({ error: 'user_id が不正です' }, 400)
  }

  // FY未指定なら今年度
  const fiscalYear = Number.isFinite(fy) ? fy : getCurrentFiscalYear()

  const row = await c.env.DB.prepare(
    'SELECT fiscal_year, goal, reflection, datetime(updated_at, "+9 hours") as updated_at FROM annual_notes WHERE user_id = ? AND fiscal_year = ?'
  ).bind(userId, fiscalYear).first() as any

  return c.json({
    fiscal_year: fiscalYear,
    goal: row?.goal || '',
    reflection: row?.reflection || '',
    updated_at: row?.updated_at || null
  })
})

// ========== CSV Export ==========
app.get('/api/admin/export', authMiddleware, adminMiddleware, async (c) => {
  const { results: members } = await c.env.DB.prepare(
    'SELECT id, name, school, email, role, district, experience_years, grade, position, created_at FROM users ORDER BY created_at'
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
    student_eval: '子どもを見る',
    connection: 'つながる',
    research: '深める'
  }
  const stepLabels: Record<number, string> = {
    1: 'STEP1(まずはここから)',
    2: 'STEP2(自分で工夫する)',
    3: 'STEP3(みんなと深める)',
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
  const event = await db
    .prepare('SELECT id FROM events WHERE event_code = ? AND is_active = 1')
    .bind(code)
    .first() as any
  if (!event) return c.json({ error: 'イベントが見つかりません' }, 404)

  const user = c.get('user')

  // 冪等（idempotent）：同じユーザーが何回叩いても「出席済み」なら成功扱い
  const result = await db
    .prepare("INSERT OR IGNORE INTO attendances (event_id, user_id, attended_at) VALUES (?,?,datetime('now'))")
    .bind(event.id, user.id)
    .run()

  // D1のmeta.changes: 1なら新規作成、0なら既に存在
  const attended = (result?.meta?.changes ?? 0) > 0

  return c.json({ success: true, attended })
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
    --cat-student: #5c6bc0;
  }
  * { box-sizing: border-box; }
  body { font-family: 'Noto Sans JP', sans-serif; color: var(--text-main); background-color: var(--bg-color); padding: 0; margin: 0; line-height: 1.5; }
</style>`

// --- Login / Register Page ---
app.get('/login', (c) => {
  return c.html(`<!DOCTYPE html><html lang="ja"><head>${commonHead}
<title>ログイン - 社会科同好会</title>
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
    <div class="logo"><span>NAGOYA SHAKAIKA</span><strong>社会科同好会</strong></div>
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
    .then(r => { if (!r.ok) { localStorage.clear(); return {}; } return r.json(); })
    .then(d => { if (d.user) window.location.href = d.user.role === 'admin' ? '/admin' : '/mypage'; })
    .catch(() => { localStorage.clear(); });
}
</script>
</body></html>`)
})

// --- Member My Page (with interactive rubric) ---
app.get('/mypage', (c) => {
  return c.html(`<!DOCTYPE html><html lang="ja"><head>${commonHead}
<title>マイページ - 社会科同好会</title>
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
  @media (hover: hover) and (pointer: fine) { .col-step:not(.selected):hover { background-color: #f5f5f5; } }
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
  .cat-student { background-color: var(--cat-student); }
  .ss-term { background: linear-gradient(transparent 70%, #fff59d 70%); font-weight: bold; color: #555; }

  .row-action td { background-color: #fff3e0; border-top: 3px solid #ffb74d; padding: 6px 8px; }
  .action-list { margin: 0; padding-left: 14px; font-size: 9pt; list-style-type: none; }
  .action-list li { margin-bottom: 2px; }
  .action-list li::before { content: '\\1F449'; font-size: 8px; margin-right: 4px; }

  .footer-note { margin-top: 15px; display: flex; justify-content: space-between; align-items: flex-start; font-size: 8.5pt; }
  .save-area { text-align: center; margin-top: 20px; }
  .save-status { font-size: 13px; color: #2e7d32; margin-top: 10px; display: none; }


  .notes-card { background: #fff; border: 2px dashed #ffb74d; padding: 14px 16px; border-radius: 12px; margin: 12px 0 14px; }
  .notes-card h2 { font-family: 'Zen Maru Gothic', sans-serif; font-size: 16px; margin: 0 0 8px; color: #e65100; display: flex; align-items: center; gap: 8px; }
  .notes-card textarea { width: 100%; min-height: 84px; padding: 10px 12px; border: 2px solid #e0d6c8; border-radius: 10px; font-size: 14px; font-family: inherit; resize: vertical; outline: none; }
  .notes-card textarea:focus { border-color: var(--header-line); }
  .notes-meta { font-size: 12px; color: #888; margin-top: 6px; display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }

  .history-card { background: #fff; border: 2px solid #f0e6d2; border-radius: 12px; padding: 16px; margin-top: 18px; box-shadow: 0 2px 10px rgba(0,0,0,0.04); }
  .history-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .history-header h2 { margin: 0; font-family: 'Zen Maru Gothic', sans-serif; color: #2e7d32; font-size: 16px; display: flex; align-items: center; gap: 8px; }
  .fy-select { padding: 6px 10px; border: 2px solid #ddd; border-radius: 8px; font-family: inherit; font-size: 13px; }
  .fy-select:focus { outline: none; border-color: #2e7d32; }

  .event-item { border-top: 1px solid #eee; padding: 12px 0; }
  .event-item:first-child { border-top: none; }
  .event-title { font-weight: 700; color: #444; }
  .event-meta { color: #888; font-size: 12px; margin-top: 2px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .tag-answered { background: #e8f5e9; color: #2e7d32; }
  .tag-pending { background: #fff3e0; color: #e65100; }
  .toggle-btn { background: #eee; border: none; border-radius: 8px; padding: 6px 10px; cursor: pointer; font-family: inherit; font-weight: 700; font-size: 12px; }
  .toggle-btn:hover { background: #e0e0e0; }
  .event-detail { display: none; margin-top: 10px; background: #fafafa; border: 1px solid #eee; border-radius: 10px; padding: 10px 12px; }
  .event-detail.show { display: block; }
  .qa { margin-top: 10px; }
  .qa .q { font-weight: 700; font-size: 13px; margin-top: 8px; color: #555; }
  .qa .a { color: #555; font-size: 13px; padding-left: 10px; border-left: 3px solid #ddd; margin-top: 4px; white-space: pre-wrap; }


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

    /* テーブルのスマホ最適化 */
    table { min-width: 700px; font-size: 9pt; }
    th, td { padding: 5px 6px; }
    .col-category { width: 24px; letter-spacing: 2px; font-size: 10px; }
    .col-viewpoint { width: 70px; font-size: 10px; }
    .col-step { font-size: 10px; line-height: 1.5; }
    .col-step .step-title { font-size: 11px; }
    .col-step .step-desc { font-size: 10px; line-height: 1.4; }
    .step-header { font-size: 10px; padding: 3px 6px; }
    .memo-input { font-size: 10px; padding: 3px 5px; }
    .action-row td { font-size: 10px; padding: 5px 6px; }
    .note-text { font-size: 11px; }
    .school-type-selector { font-size: 13px; }
    .school-type-selector label { padding: 6px 14px; }
    .container { padding: 8px; border-width: 1px; }
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
  <div class="logo"><i class="fas fa-map"></i> 社会科同好会</div>
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
    <div class="container" style="padding: 12px 16px;">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
        <label style="font-weight:bold; color:#1b5e20; white-space:nowrap; font-size:14px;">学校名</label>
        <input type="text" id="schoolInput" placeholder="例：橘小学校" style="flex:1; padding:6px 10px; border:1px solid #ccc; border-radius:6px; font-size:14px;">
                <span id="schoolSaveStatus" style="font-weight:700; font-size:12px;"></span>
      </div>
      <details id="profileDetails" style="margin-top:4px;">
        <summary style="cursor:pointer; font-weight:bold; color:#e65100; font-size:13px; padding:4px 0;">📋 プロフィール情報（クリックで開閉）</summary>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:8px;">
          <div>
            <label style="font-size:12px; font-weight:bold; color:#5d4037;">区</label>
            <select id="profile-district" style="width:100%; padding:5px 8px; border:1px solid #ccc; border-radius:6px; font-size:13px;">
              <option value="">選択してください</option>
              <option value="千種区">千種区</option><option value="東区">東区</option>
              <option value="北区">北区</option><option value="西区">西区</option>
              <option value="中村区">中村区</option><option value="中区">中区</option>
              <option value="昭和区">昭和区</option><option value="瑞穂区">瑞穂区</option>
              <option value="熱田区">熱田区</option><option value="中川区">中川区</option>
              <option value="港区">港区</option><option value="南区">南区</option>
              <option value="守山区">守山区</option><option value="緑区">緑区</option>
              <option value="名東区">名東区</option><option value="天白区">天白区</option>
            </select>
          </div>
          <div>
            <label style="font-size:12px; font-weight:bold; color:#5d4037;">経験年数</label>
            <div style="display:flex; align-items:center; gap:4px;">
              <input type="number" id="profile-experience" placeholder="例：5" min="1" max="50" style="flex:1; padding:5px 8px; border:1px solid #ccc; border-radius:6px; font-size:13px;">
              <span style="font-size:13px; white-space:nowrap;">年目</span>
            </div>
          </div>
          <div style="grid-column:1/3;">
            <label style="font-size:12px; font-weight:bold; color:#5d4037;">担当学年（複数選択OK）</label>
            <div id="profile-grade-checks" style="display:flex; flex-wrap:wrap; gap:4px; margin-top:4px;">
            </div>
          </div>
          <div>
            <label style="font-size:12px; font-weight:bold; color:#5d4037;">所属・役職</label>
            <select id="profile-position" style="width:100%; padding:5px 8px; border:1px solid #ccc; border-radius:6px; font-size:13px;">
              <option value="">選択してください</option>
              <option value="小学校教諭">小学校教諭</option><option value="中学校教諭">中学校教諭</option>
              <option value="主幹教諭">主幹教諭</option>
              <option value="教頭">教頭</option><option value="校長">校長</option>
              <option value="指導主事">指導主事</option><option value="その他">その他</option>
            </select>
          </div>
        </div>
        <button class="btn-save" onclick="saveProfile()" id="btn-save-profile" style="margin-top:8px; font-size:13px; padding:8px 16px;">💾 プロフィールを保存</button>
      </details>
    </div>

    <div class="notes-card" style="border-style:solid;border-color:#ffe0b2;margin-top:16px">
      <h2 style="color:#e65100"><i class="fas fa-bullseye"></i> 今年度の目標 <span style="font-size:12px;color:#888;font-weight:500" id="fyLabel"></span></h2>
      <textarea id="annualGoal" placeholder="例：月に1回は授業づくりの相談をする、FWに1回参加する など"></textarea>
      <div class="notes-meta"><span id="annualSavedAt"></span></div>
    </div>


    <div class="scroll-hint"><i class="fas fa-arrows-alt-h"></i> 横にスクロールできます</div>
    <div class="footer-note">
      <div style="color:#666"><strong>カテゴリ：</strong><span style="color:#8d6e63">■ 授業・準備</span> <span style="color:#66bb6a">■ 仲間・活動</span> <span style="color:#42a5f5">■ 研究・発信</span></div>
      <div style="color:#777;text-align:right;max-width:60%">※これは「ここまでやらなきゃいけない」というノルマではありません。特にSTEP4は「いつかチャレンジできたら」という可能性の入口です。今の自分に合った「次の一歩」を見つけるための地図として使ってください。</div>
    </div>
    <table id="tableElem">
      <thead><tr>
        <th colspan="2" style="background-color: #fff8e1; border-bottom: 3px solid #5d4037;">成長の視点</th>
        <th><div class="step-header"><span class="step-label">STEP 1</span><span class="step-desc">🔰 まずはここから</span></div></th>
        <th><div class="step-header"><span class="step-label">STEP 2</span><span class="step-desc">🏃 自分で工夫する</span></div></th>
        <th><div class="step-header"><span class="step-label">STEP 3</span><span class="step-desc">🤝 みんなと深める</span></div></th>
        <th><div class="step-header"><span class="step-label">STEP 4</span><span class="step-desc">🌏 未来を創る（挑戦できたら）</span></div></th>
      </tr></thead>
      <tbody>
        <tr>
          <td class="col-category cat-class" rowspan="3">授業<br>実践</td>
          <td class="col-viewpoint"><div>授業をつくる</div><div style="font-size:9px;color:#888;margin-top:2px">教材研究・構成</div></td>
          <td class="col-step" data-vp="lesson_plan" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">基本型をまねる</span><p>教科書や既存の資料を使って、基本的な授業を構成してみたい。まずはここから。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="lesson_plan" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">足でかせいでアレンジ</span><p>先輩の基本型を参考にしながら、名古屋の身近な話題や地域を「足でかせいで」集めた教材で、目の前の子どもに合わせてアレンジしてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="lesson_plan" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">子どもの「なぜ？」をうむ</span><p>子どもが「なぜ？」と思わず問いたくなる教材を仕掛け、<span class="ss-term">社会的な見方・考え方</span>を働かせる授業を構想してみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="lesson_plan" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">単元を自分でつくる</span><p>自分で足を使って教材や場所とつながりながら、オリジナルの単元を構想・提案してみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-viewpoint"><div>授業をする</div><div style="font-size:9px;color:#888;margin-top:2px">実践・対話</div></td>
          <td class="col-step" data-vp="lesson_practice" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">楽しい授業をする</span><p>まずは子どもが楽しめる授業をしてみたい。笑顔や「もっとやりたい！」が生まれたらOK！</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="lesson_practice" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">子どもが動く活動へ</span><p>調べ学習やグループワークなど、子どもが自ら動く「活動」を取り入れてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="lesson_practice" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">見方・考え方を働かせる</span><p>単なる活動で終わらせず、<span class="ss-term">社会的な見方・考え方</span>を働かせる授業を意識してみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="lesson_practice" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">対話で成り立つ授業を</span><p>教師からの一方通行でなく、子ども同士の対話で成り立つ授業を展開し、仲間と見合いたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-viewpoint"><div>子どもを見る</div><div style="font-size:9px;color:#888;margin-top:2px">観察・評価</div></td>
          <td class="col-step" data-vp="student_eval" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">まずザックリ観察する</span><p>最初はザックリでOK！授業中の子どもの姿や声に目を向けてみたい。「楽しそう？」「困っている？」を感じ取るところから始めたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="student_eval" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">「わかった」を言葉にさせる</span><p>ノートや発言から「この子はここまでわかっているかな？」とのぞいてみたい。「わかった」を自分の言葉で表現できる場を、気負わずに作ってみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="student_eval" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">点数にならない良さを見つける</span><p>正解・不正解だけでなく、粘り強く考えを表現しようとしている姿など、点数になりにくい良さをそっと認めてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="student_eval" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">子どもの姿で授業を問い直す</span><p>「この子たちの反応は、自分の授業への答えだ」と捉え、子どもの姿を元に授業を再構成してみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-category cat-connect">仲間<br>活動</td>
          <td class="col-viewpoint"><div>つながる</div><div style="font-size:9px;color:#888;margin-top:2px">同僚性・楽しさ</div></td>
          <td class="col-step" data-vp="connection" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">場に参加する</span><p>同好会に入会し、イベントや例会に参加してみたい。同期や先輩と顔見知りになれたらOK！</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="connection" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">横のつながりを作る</span><p>同期など、横のつながりを作り、話しやすい関係を築いてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="connection" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">縦のつながりを作る</span><p>先輩や役員など、縦のつながりを作り、授業実践について教えを請うてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="connection" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">仲間を支える側に回る</span><p>悩みや本音を語り合える仲間を持ち、時には仲間を支える側に回ってみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-category cat-research">研究<br>発信</td>
          <td class="col-viewpoint"><div>深める</div><div style="font-size:9px;color:#888;margin-top:2px">探究・理論</div></td>
          <td class="col-step" data-vp="research" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">参加を楽しむ</span><p>同好会の雰囲気を知り、まずは参加を楽しんでみたい。「こんな世界があるんだ！」と感じることから始めたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="research" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">インプット・刺激を受ける</span><p>先輩たちの実践記録を読んでインプットし、刺激を受けたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="research" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">実践をアウトプット</span><p>自分の実践を<span class="ss-term">「体験記録」</span>として書き、アウトプットしてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="research" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">理論を磨き合う</span><p>自分の実践を理論づけ、部員に向けて議論し、理論を磨き合いたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr class="row-action">
          <td colspan="2" style="text-align:right;font-weight:bold;padding-right:20px;color:#e65100"><i class="fas fa-shoe-prints"></i> おすすめのアクション</td>
          <td><ul class="action-list"><li><strong>若手交流会</strong>で仲間作り</li><li><strong>授業づくり講座</strong>を聞く</li><li><strong>懇親会</strong>にとりあえず行く</li></ul></td>
          <td><ul class="action-list"><li><strong>スキルアップ研修</strong>に参加（まずこれ！）</li><li><strong>FW（フィールドワーク）</strong>へGO!</li><li><strong>NIE・統計</strong>の資料を集める</li></ul></td>
          <td><ul class="action-list"><li><strong>模擬授業</strong>をやってみる</li><li><strong>FW・イベント</strong>を企画する</li><li><strong>研究部</strong>で議論する</li></ul></td>
          <td><ul class="action-list"><li><strong>同好会</strong>で発表する</li><li><strong>研究紀要</strong>に書いてみる</li><li><strong>全国大会</strong>に行く・呼ぶ</li></ul></td>
        </tr>
      </tbody>
    </table>

    <table id="tableJunior" style="display:none">
      <thead><tr>
        <th colspan="2" style="background-color: #fff8e1; border-bottom: 3px solid #5d4037;">成長の視点</th>
        <th><div class="step-header"><span class="step-label">STEP 1</span><span class="step-desc">🔰 まずはここから</span></div></th>
        <th><div class="step-header"><span class="step-label">STEP 2</span><span class="step-desc">🏃 自分で工夫する</span></div></th>
        <th><div class="step-header"><span class="step-label">STEP 3</span><span class="step-desc">🤝 みんなと深める</span></div></th>
        <th><div class="step-header"><span class="step-label">STEP 4</span><span class="step-desc">🌏 未来を創る（挑戦できたら）</span></div></th>
      </tr></thead>
      <tbody>
        <tr>
          <td class="col-category cat-class" rowspan="5">授業<br>実践</td>
          <td class="col-viewpoint"><div>授業をつくる</div><div style="font-size:9px;color:#888;margin-top:2px">教材研究・構成</div></td>
          <td class="col-step" data-vp="j_lesson_plan" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">基本型をまねる</span><p>教科書や既存の資料を参考にしながら、地理・歴史・公民の基本的な授業を構成してみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_lesson_plan" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">足でかせいでアレンジ</span><p>先輩の基本型を参考にしながら、身近な地域の事例や時事問題を「足でかせいで」仕入れ、生徒の実態に合わせてアレンジしてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_lesson_plan" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">生徒の「なぜ？」をうむ</span><p>生徒が「なぜ？」と自然と問いを持てるような教材を仕掛け、社会的な見方・考え方を働かせる授業を構想してみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_lesson_plan" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">単元を自分でつくる</span><p>自分で足を使って教材を発掘し、地理・歴史・公民の各分野を横断したオリジナルの単元を構想・提案してみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-viewpoint"><div>【資料】</div><div style="font-size:9px;color:#888;margin-top:2px">読み解く・提示する</div></td>
          <td class="col-step" data-vp="j_material" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">基本資料を読み解く</span><p>教科書の図版や基本資料を読み解き、授業の基本の流れに組み込んでみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_material" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">多様な資料を足で集める</span><p>新聞記事（NIE）や最新の統計データなど、多様な資料を足で稼いで集め、提示を工夫してみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_material" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">複数資料を比較・関連付ける</span><p>地図とグラフ、異なる立場の史料など複数の資料を比較・関連付けさせ、生徒の「なぜ？」を引き出してみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_material" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">生徒が主体的に資料を読む</span><p>生徒自身が目的に応じて資料を見つけ出し、多面的・多角的に読み解く力を育ててみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-viewpoint"><div>【対話】</div><div style="font-size:9px;color:#888;margin-top:2px">意見を交わす・議論する</div></td>
          <td class="col-step" data-vp="j_dialogue" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">つぶやきを拾って広げる</span><p>生徒の些細なつぶやきや疑問を丁寧に拾い、学級全体に広げることから始めてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_dialogue" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">自分の考えを言葉にする場を作る</span><p>ペアやグループワークを効果的に取り入れ、自分の考えを言葉にして伝え合う場を作ってみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_dialogue" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">意見を戦わせる議論を仕掛ける</span><p>歴史的背景や異なる立場をぶつけ合い、意見を戦わせる議論を仕掛けてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_dialogue" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">合意形成に向かう対話を支援する</span><p>生徒同士の対話から新たな価値観を生み出し、社会的な合意形成に向かう話し合いを支援してみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-viewpoint"><div>【探究】</div><div style="font-size:9px;color:#888;margin-top:2px">問いを立てる・追究する</div></td>
          <td class="col-step" data-vp="j_inquiry" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">調べる・まとめる時間を確保する</span><p>授業の中で、基礎的な知識を「調べる」「まとめる」時間をしっかり確保することから始めたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_inquiry" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">自分ごとして調べる学習を仕掛ける</span><p>ICTを活用したり、身近な地域の事象と結びつけたりして、生徒が自分ごととして調べる学習を仕掛けてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_inquiry" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">「大きな問い」で探究サイクルを作る</span><p>単元を貫く「大きな問い」を設定し、生徒が主体的に探究し続けるサイクルを作ってみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_inquiry" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">高度な探究をデザインする</span><p>教科の枠を超えた複雑な社会課題に対して、生徒が自ら問いを立てて解決策を模索する高度な探究をデザインしてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-viewpoint"><div>生徒を見る</div><div style="font-size:9px;color:#888;margin-top:2px">観察・評価</div></td>
          <td class="col-step" data-vp="j_student_eval" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">まずザックリ観察する</span><p>最初はザックリでOK！授業中の生徒の表情や発言に目を向け、「理解できてる？」「関心がある？」を感じ取るところから始めたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_student_eval" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">「わかった」を言葉にさせる</span><p>ノートや発言からの理解を確認しながら、「わかった」を自分の言葉で表現できる場を気負わずに作ってみたい。毎時間できなくてOK！</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_student_eval" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">点数にならない良さを見つける</span><p>正解・不正解だけでなく、粘り強く考えた過程や多面的な視点など、点数になりにくい良さをそっと認めてみたい。その気づきが、次の問いにつながる。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_student_eval" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">生徒の姿で授業を問い直す</span><p>「この生徒たちの反応は、自分の授業への答えだ」と捉え、生徒を元に授業を再構成してみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-category cat-connect">仲間<br>活動</td>
          <td class="col-viewpoint"><div>つながる</div><div style="font-size:9px;color:#888;margin-top:2px">仲間・同僚性</div></td>
          <td class="col-step" data-vp="j_connection" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">場に参加する</span><p>同好会に入会し、イベントや会に参加してみたい。同期や先輩と顔見知りになれたらOK！</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_connection" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">横のつながりを作る</span><p>同期など、同校・近隣校の先生と横のつながりを作り、気軽に話しやすい関係を築いてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_connection" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">縦のつながりを作る</span><p>先輩や役員など、縦のつながりを作り、授業実践について教えを請うてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_connection" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">仲間を支える側に回る</span><p>悩みや本音を語り合える仲間を持ち、時には仲間を支える側に回ってみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-category cat-research">研究<br>発信</td>
          <td class="col-viewpoint"><div>深める</div><div style="font-size:9px;color:#888;margin-top:2px">研究・発信</div></td>
          <td class="col-step" data-vp="j_research" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">参加を楽しむ</span><p>同好会の雰囲気を知り、まずは参加を楽しんでみたい。「こんな世界があるんだ！」と感じることから始めたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_research" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">インプット・刺激を受ける</span><p>中学地理・歴史・公民に関する先輩たちの実践記録を読んでインプットし、刺激を受けたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_research" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">実践をアウトプット</span><p>自分の実践を<span class="ss-term">「体験記録」</span>として書き、アウトプットしてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="j_research" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">理論を磨き合う</span><p>自分の実践を理論づけ、部員に向けて議論し、理論を磨き合いたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr class="row-action">
          <td colspan="2" style="text-align:right;font-weight:bold;padding-right:20px;color:#e65100"><i class="fas fa-shoe-prints"></i> おすすめのアクション</td>
          <td><ul class="action-list"><li><strong>若手交流会</strong>で仲間作り</li><li><strong>授業づくり講座</strong>を聞く</li><li><strong>懇親会</strong>にとりあえず行く</li></ul></td>
          <td><ul class="action-list"><li><strong>スキルアップ研修</strong>に参加（まずこれ！）</li><li><strong>NIE・統計</strong>の資料を集める</li><li><strong>体験記録</strong>を書いてみる</li></ul></td>
          <td><ul class="action-list"><li><strong>模擬授業</strong>をやってみる</li><li><strong>FW・イベント</strong>を企画する</li><li><strong>研究部</strong>で議論する</li></ul></td>
          <td><ul class="action-list"><li><strong>同好会</strong>で発表する</li><li><strong>研究紀要</strong>に書いてみる</li><li><strong>全国大会</strong>に行く・呼ぶ</li></ul></td>
        </tr>
      </tbody>
    </table>

    <table id="tableAdmin" style="display:none">
      <thead><tr>
        <th colspan="2" style="background-color: #fff8e1; border-bottom: 3px solid #5d4037;">成長の視点</th>
        <th><div class="step-header"><span class="step-label">STEP 1</span><span class="step-desc">🔰 まず関わる</span></div></th>
        <th><div class="step-header"><span class="step-label">STEP 2</span><span class="step-desc">🔧 仕組みをつくる</span></div></th>
        <th><div class="step-header"><span class="step-label">STEP 3</span><span class="step-desc">🌱 人を育てる</span></div></th>
        <th><div class="step-header"><span class="step-label">STEP 4</span><span class="step-desc">🏛️ 文化を残す</span></div></th>
      </tr></thead>
      <tbody>
        <tr>
          <td class="col-category cat-class" rowspan="2">同好会<br>支援</td>
          <td class="col-viewpoint"><div>会の活動を支える</div><div style="font-size:9px;color:#888;margin-top:2px">例会・研究会支援</div></td>
          <td class="col-step" data-vp="a_school_support" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">例会に顔を出す</span><p>まずは例会やイベントに参加して、場の雰囲気づくりに協力するところから始めてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_school_support" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">例会の学びを深める</span><p>授業検討会などで、管理職としての経験を活かした助言や問いかけで学びを深めてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_school_support" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">研究会の内容充実に関わる</span><p>授業検討会やフィールドワークの企画に関わり、会の学びの質を高めることに貢献したい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_school_support" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">会の学びの文化を守る</span><p>同好会が大切にしてきた「授業で語り合う」文化を次の世代にも伝え、学びの質を守りたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-viewpoint"><div>会員同士をつなぐ</div><div style="font-size:9px;color:#888;margin-top:2px">交流・居場所づくり</div></td>
          <td class="col-step" data-vp="a_school_mgmt" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">声をかける</span><p>例会で一人でいる会員や新しい会員に声をかけ、「来てよかった」と思える安心感を生みたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_school_mgmt" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">世代をつなぐ</span><p>ベテランと若手の橋渡し役として、会員同士が気軽に話せる関係づくりを促してみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_school_mgmt" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">学び合いの場をつくる</span><p>会員同士が実践を見合ったり、気軽に相談し合えるような関係性やグループをつくりたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_school_mgmt" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">会の一体感を育てる</span><p>会員みんなが「ここが自分の居場所だ」と思える温かい雰囲気をつくり、会の一体感を育てたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-category cat-connect" rowspan="2">人材<br>育成</td>
          <td class="col-viewpoint"><div>会員の成長を支える</div><div style="font-size:9px;color:#888;margin-top:2px">指導・助言</div></td>
          <td class="col-step" data-vp="a_member_support" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">実践記録を読んで感想を伝える</span><p>会員が書いた実践記録や体験記録を読み、「ここが面白い」と感想を伝えることから始めたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_member_support" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">論文の方向性を一緒に考える</span><p>「何を書きたいか」を一緒に整理し、論文や実践記録の方向づけを手伝ってみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_member_support" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">論文を書き上げるまで伴走する</span><p>構成から推敲まで、会員が論文を完成させるまで粘り強く伴走してみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_member_support" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">書く文化を会に根づかせる</span><p>「書いてみようかな」と思える雰囲気をつくり、会員同士が互いの原稿を読み合う文化を育てたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-viewpoint"><div>次世代リーダーを育てる</div><div style="font-size:9px;color:#888;margin-top:2px">後進育成</div></td>
          <td class="col-step" data-vp="a_leader_dev" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">若手の話を聞く</span><p>若手会員の悩みや思いに耳を傾け、「聞いてもらえる存在」になることから始めたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_leader_dev" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">役割を任せてみる</span><p>例会やイベントの一部を若手に任せ、経験を積ませる場をつくってみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_leader_dev" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">一緒に企画・運営する</span><p>大きなイベントや研究大会の企画を若手と一緒に進め、運営のノウハウを伝えたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_leader_dev" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">任せて見守る</span><p>次世代のリーダーに中心を譲り、困ったときだけ支える「見守る」立場で関わりたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-category cat-research" rowspan="2">組織<br>・発信</td>
          <td class="col-viewpoint"><div>同好会の運営に貢献する</div><div style="font-size:9px;color:#888;margin-top:2px">組織運営</div></td>
          <td class="col-step" data-vp="a_org_mgmt" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">例会に参加して助言する</span><p>例会や研究会に参加し、管理職の視点から率直な感想や助言を伝えてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_org_mgmt" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">会の方向性を一緒に考える</span><p>役員会などで会の今後の方向性やテーマについて、自分の意見を積極的に出してみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_org_mgmt" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">大会・イベントの運営を支える</span><p>研究大会やフィールドワークの運営面で、管理職としての経験や人脈を活かして調整役を担ってみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_org_mgmt" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">会の未来を描く</span><p>5年後・10年後の会の姿を構想し、持続可能な組織づくりの道筋をつくりたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr>
          <td class="col-viewpoint"><div>外とつなぐ・知見を還元する</div><div style="font-size:9px;color:#888;margin-top:2px">対外連携・還元</div></td>
          <td class="col-step" data-vp="a_outreach" data-step="1" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">他の研究会の情報を持ち帰る</span><p>管理職の集まりや他教科の研究会で得た情報を、同好会に持ち帰って共有してみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_outreach" data-step="2" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">外部講師や連携先を紹介する</span><p>大学の先生や他地区の実践家など、管理職のネットワークを活かして会に紹介してみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_outreach" data-step="3" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">自分の実践知を語る</span><p>自分がこれまで積み重ねた社会科の実践知や経営知を、講演や寄稿で次世代に伝えてみたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
          <td class="col-step" data-vp="a_outreach" data-step="4" onclick="selectCell(this)"><div class="cell-content"><span class="keyword">社会科教育の価値を広める</span><p>管理職の立場から社会科教育の重要性を周囲に発信し、名古屋の社会科の文化を守り育てたい。</p></div><textarea class="memo-input" rows="2" placeholder="メモ（任意）" onclick="event.stopPropagation()"></textarea></td>
        </tr>
        <tr class="row-action">
          <td colspan="2" style="text-align:right;font-weight:bold;padding-right:20px;color:#e65100"><i class="fas fa-shoe-prints"></i> おすすめのアクション</td>
          <td><ul class="action-list"><li><strong>例会・FWに参加して助言</strong></li><li><strong>新しい会員に声をかける</strong></li><li><strong>会員の実践記録を読む</strong></li></ul></td>
          <td><ul class="action-list"><li><strong>会場や資料の準備を手伝う</strong></li><li><strong>論文指導を引き受ける</strong></li><li><strong>外部講師を紹介する</strong></li></ul></td>
          <td><ul class="action-list"><li><strong>大会運営の調整役を担う</strong></li><li><strong>若手と一緒に企画する</strong></li><li><strong>自分の経験を語る場をつくる</strong></li></ul></td>
          <td><ul class="action-list"><li><strong>会の将来構想を描く</strong></li><li><strong>次世代リーダーに託す</strong></li><li><strong>社会科の価値を外に発信する</strong></li></ul></td>
        </tr>
      </tbody>
    </table>

    <div class="notes-card" style="border-style:solid;border-color:#bbdefb;margin-top:16px">
      <h2 style="color:#1565c0"><i class="fas fa-pen"></i> 今年度の振り返り</h2>
      <textarea id="annualReflection" placeholder="今年度の参加や学び、次につながったことなど"></textarea>
      <div class="notes-meta"><span id="annualSavedAt2"></span></div>
    </div>


  </div>

  <div class="save-area">
    <button id="btnSave" type="button" class="btn-sm btn-save"><i class="fas fa-save"></i> 保存する</button>
    <button id="btnPrint" type="button" class="btn-sm" style="background:#eee;color:#666;padding:10px 20px;border:none;border-radius:10px;margin-left:8px;cursor:pointer;font-family:inherit;font-weight:700"><i class="fas fa-print"></i> 印刷する</button>
    <div class="save-status" id="saveStatus"></div>
  </div>

  <div class="history-card">
    <div class="history-header">
      <h2><i class="fas fa-calendar-check"></i> 参加した会・アンケート（自分用）</h2>
      <select class="fy-select" id="fySelect" onchange="changeFY()"></select>
    </div>
    <div id="historyList" style="margin-top:10px;color:#666;font-size:13px">読み込み中...</div>
  </div>


</div>

<script>
const token = localStorage.getItem('token');
let user = JSON.parse(localStorage.getItem('user') || 'null');

const viewpointsElem = ['lesson_plan','lesson_practice','student_eval','connection','research'];
const viewpointsJunior = ['j_lesson_plan','j_material','j_dialogue','j_inquiry','j_student_eval','j_connection','j_research'];
const viewpointsAdmin = ['a_school_support','a_school_mgmt','a_member_support','a_leader_dev','a_org_mgmt','a_outreach'];
let viewpoints = viewpointsElem;
const selectedByVp = Object.create(null);
let selectionsLoaded = false;

function requireAuth() {
  if (!token || !user) {
    window.location.href = '/login';
    return false;
  }
  return true;
}

function currentFY() {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  return m >= 4 ? y : (y - 1);
}

// FYセレクトの表示は「2026年度以降」のみに限定（年度定義は4月始まりのまま）
const FIRST_FY = 2026;
let activeFY = Math.max(currentFY(), FIRST_FY);

function esc(s) {
  return (s ?? '').toString().replace(/[&<>"']/g, (ch) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;'
  }[ch]));
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs || 12000);
  const opts = Object.assign({}, options || {}, { signal: controller.signal });
  return fetch(url, opts).finally(() => clearTimeout(id));
}

function showSaveStatus(message, ok) {
  const el = document.getElementById('saveStatus');
  if (!el) return;
  const safe = esc(message || '');
  el.style.display = 'block';
  el.style.background = ok ? '#e8f5e9' : '#ffebee';
  el.style.color = ok ? '#2e7d32' : '#c62828';
  el.innerHTML = (ok ? '<i class="fas fa-check-circle"></i> ' : '<i class="fas fa-exclamation-triangle"></i> ') + safe;

  if (showSaveStatus._t) clearTimeout(showSaveStatus._t);
  showSaveStatus._t = setTimeout(() => { el.style.display = 'none'; }, 4000);
}

function showSchoolStatus(message, ok) {
  const el = document.getElementById('schoolSaveStatus');
  if (!el) return;
  el.style.color = ok ? '#2e7d32' : '#c62828';
  el.textContent = message ? message : '';
  if (showSchoolStatus._t) clearTimeout(showSchoolStatus._t);
  showSchoolStatus._t = setTimeout(() => { el.textContent = ''; }, 4000);
}

function updateUserBar() {
  const userName = document.getElementById('userName');
  if (userName) userName.textContent = user.name + ' さん' + (user.school ? '（' + user.school + '）' : '');
}

async function saveSchoolIfChanged(force) {
  const el = document.getElementById('schoolInput');
  if (!el) return;
  const newSchool = (el.value || '').trim();
  const oldSchool = (user && user.school) ? String(user.school) : '';
  if (!force && newSchool === oldSchool) return;

  if (!newSchool) throw new Error('学校名を入力してください');

  const res = await fetchWithTimeout('/api/me/profile', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ school: newSchool })
  }, 12000);

  if (res.status === 401) { localStorage.clear(); window.location.href = '/login'; return; }
  let data = {};
  try { data = await res.json(); } catch(e) {}
  if (!res.ok) throw new Error(data.error || ('学校名の更新に失敗しました（' + res.status + '）'));

  if (data.user) {
    user = data.user;
    localStorage.setItem('user', JSON.stringify(user));
    updateUserBar();
  }
}

  async function saveProfile() {
    const btn = document.getElementById('btn-save-profile');
    if (btn.disabled) return;
    btn.disabled = true; btn.textContent = '保存中...';
    try {
      const gradeChecks = document.querySelectorAll('#profile-grade-checks input:checked');
      const gradeVal = Array.from(gradeChecks).map(c => c.value).join(',');
      const schoolEl = document.getElementById('schoolEdit') || document.getElementById('schoolInput');
      const schoolVal = schoolEl ? schoolEl.value.trim() : '';
      const res = await fetch('/api/me/profile', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          school: schoolVal,
          district: document.getElementById('profile-district').value,
          experience_years: document.getElementById('profile-experience').value,
          grade: gradeVal,
          position: document.getElementById('profile-position').value
        })
      });
      if (!res.ok) throw new Error('保存に失敗しました');
      if (schoolVal) { user.school = schoolVal; var dispEl = document.getElementById('schoolDisplay'); if (dispEl) dispEl.textContent = schoolVal; }
      user.district = document.getElementById('profile-district').value;
      user.experience_years = document.getElementById('profile-experience').value;
      user.grade = gradeVal;
      user.position = document.getElementById('profile-position').value;
      localStorage.setItem('user', JSON.stringify(user));
      btn.textContent = '✅ 保存しました';
      setTimeout(() => { btn.textContent = '💾 プロフィールを保存'; btn.disabled = false; }, 2000);
    } catch (e) {
      alert(e.message); btn.textContent = '💾 プロフィールを保存'; btn.disabled = false;
    }
  }

function setupFYSelect() {
  const sel = document.getElementById('fySelect');
  if (!sel) return;

  const now = Math.max(currentFY(), FIRST_FY);
  activeFY = Math.max(activeFY, FIRST_FY);

  sel.innerHTML = '';
  for (let y = now; y >= FIRST_FY; y--) {
    const opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = y + '年度';
    sel.appendChild(opt);
  }

  sel.value = String(activeFY);
  const label = document.getElementById('fyLabel');
  if (label) label.textContent = '(' + activeFY + '年度)';
}

function changeFY() {
  const sel = document.getElementById('fySelect');
  if (!sel) return;
  activeFY = parseInt(sel.value, 10);
  const label = document.getElementById('fyLabel');
  if (label) label.textContent = '(' + activeFY + '年度)';
  loadAnnualNotes();
  loadHistory();
}

async function loadAnnualNotes() {
  try {
    const res = await fetchWithTimeout('/api/me/annual-notes?fy=' + activeFY, { headers: { 'Authorization': 'Bearer ' + token } }, 12000);
    if (res.status === 401) { localStorage.clear(); window.location.href = '/login'; return; }
    if (!res.ok) throw new Error('読み込みに失敗しました（' + res.status + '）');
    const data = await res.json();
    const g = document.getElementById('annualGoal');
    const r = document.getElementById('annualReflection');

    // ユーザーが入力中なら上書きしない
    if (!annualNotesDirty) {
      if (g) g.value = (data.goal || '');
      if (r) r.value = (data.reflection || '');
    }

    const at = data.updated_at ? ('最終更新：' + new Date(data.updated_at).toLocaleString('ja-JP')) : '';
    const s1 = document.getElementById('annualSavedAt');
    const s2 = document.getElementById('annualSavedAt2');
    if (s1) s1.textContent = at;
    if (s2) s2.textContent = at;
  } catch(e) {
    console.error(e);
  }
}

let annualNotesDirty = false;

function setAnnualNotesDirty() {
  annualNotesDirty = true;
}

async function saveAnnualNotes() {
  const gEl = document.getElementById('annualGoal');
  // 取り違い防止：複数手段で必ず同一IDを取得
  const rEl = document.getElementById('annualReflection') || document.querySelector('textarea#annualReflection');

  if (!gEl) throw new Error('目標欄が見つかりません。画面を再読み込みしてください。');
  if (!rEl) throw new Error('振り返り欄が見つかりません。画面を再読み込みしてください。');

  const g = (gEl.value ?? '').toString();
  const r = (rEl.value ?? '').toString();

  // 入力したつもりでも空が送られてしまう事故を防ぐ
  if (annualNotesDirty && !g.trim() && !r.trim()) {
    throw new Error('目標/振り返りが空です。入力欄をクリックして文字が入っているか確認してください。');
  }

  const res = await fetchWithTimeout('/api/me/annual-notes', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fiscal_year: activeFY, goal: g, reflection: r })
  }, 12000);

  if (res.status === 401) { localStorage.clear(); window.location.href = '/login'; return; }
  if (!res.ok) {
    let data = {};
    try { data = await res.json(); } catch(e) {}
    throw new Error(data.error || ('保存に失敗しました（' + res.status + '）'));
  }

  annualNotesDirty = false;
}


function toggleDetail(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('show');
}

function renderHistory(events) {
  const root = document.getElementById('historyList');
  if (!root) return;

  if (!events || events.length === 0) {
    root.innerHTML = '<div style="color:#888">この年度は、出席した会がまだありません。</div>';
    return;
  }

  let html = '';
  for (const ev0 of events) {
    const ev = ev0 || {};
    const answered = !!(ev.survey && ev.survey.answered_at);
    const tag = answered
      ? '<span class="tag tag-answered">回答済み</span>'
      : '<span class="tag tag-pending">未回答</span>';

    const detailId = 'detail_' + ev.event_id;
    const sat = (ev.survey && ev.survey.satisfaction) ? ('満足度：' + ev.survey.satisfaction + ' / 5') : '満足度：—';
    const comment = (ev.survey && ev.survey.comment) ? esc(ev.survey.comment) : '（自由記述なし）';

    let qaHtml = '';
    if (Array.isArray(ev.questions) && ev.questions.length > 0) {
      qaHtml += '<div class="qa"><div style="font-weight:700;color:#555;margin-top:8px">追加質問</div>';
      for (const q0 of ev.questions) {
        const q = q0 || {};
        const a = (q.answer_text && q.answer_text.trim()) ? esc(q.answer_text) : '（未回答）';
        qaHtml += '<div class="q">Q. ' + esc(q.question_text || '') + '</div><div class="a">' + a + '</div>';
      }
      qaHtml += '</div>';
    }

    html += ''
      + '<div class="event-item">'
      +   '<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap">'
      +     '<div>'
      +       '<div class="event-title">' + esc(ev.title || '') + '</div>'
      +       '<div class="event-meta">'
      +         '<span><i class="fas fa-calendar-day"></i> ' + esc(ev.event_date || '') + '</span>'
      +         tag
      +       '</div>'
      +     '</div>'
      +     '<button class="toggle-btn" type="button" data-detail="' + esc(detailId) + '"><i class="fas fa-eye"></i> 振り返りを見る</button>'
      +   '</div>'
      +   '<div class="event-detail" id="' + esc(detailId) + '">'
      +     '<div style="font-weight:700;color:#555">' + esc(sat) + '</div>'
      +     '<div style="margin-top:6px;color:#555;white-space:pre-wrap">' + comment + '</div>'
      +     qaHtml
      +   '</div>'
      + '</div>';
  }

  root.innerHTML = html;

  // Attach toggle handlers
  root.querySelectorAll('.toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-detail');
      if (id) toggleDetail(id);
    });
  });
}

async function loadHistory() {
  const root = document.getElementById('historyList');
  if (root) root.textContent = '読み込み中...';
  try {
    const res = await fetchWithTimeout('/api/me/history?fy=' + activeFY, { headers: { 'Authorization': 'Bearer ' + token } }, 12000);
    if (res.status === 401) { localStorage.clear(); window.location.href = '/login'; return; }
    if (!res.ok) throw new Error('読み込みに失敗しました（' + res.status + '）');
    const data = await res.json();
    renderHistory((data && data.events) ? data.events : []);
  } catch(e) {
    console.error(e);
    if (root) root.innerHTML = '<div style="color:#c62828">読み込みに失敗しました（通信が不安定か、サーバーが応答していません）</div>';
  }
}

function selectCell(td) {
  const vp = td.getAttribute('data-vp') || '';
  const step = parseInt(td.getAttribute('data-step') || '0', 10);
  if (!vp || !step) return;

  const wasSelected = td.classList.contains('selected');

  // radio behavior per viewpoint
  document.querySelectorAll('.col-step[data-vp="' + vp + '"]').forEach((el) => el.classList.remove('selected'));

  if (wasSelected) {
    // toggle off: deselect
    delete selectedByVp[vp];
  } else {
    // select new cell
    td.classList.add('selected');
    const memoEl = td.querySelector('.memo-input');
    selectedByVp[vp] = { step: step, memo: memoEl ? memoEl.value : '' };
  }
}

function attachMemoListeners() {
  document.querySelectorAll('.col-step').forEach((cell) => {
    const vp = cell.getAttribute('data-vp') || '';
    const step = parseInt(cell.getAttribute('data-step') || '0', 10);
    const memo = cell.querySelector('.memo-input');
    if (!vp || !step || !memo) return;
    memo.addEventListener('input', () => {
      const cur = selectedByVp[vp];
      if (cur && cur.step === step) cur.memo = memo.value;
    });
  });
}

function clearSelectionsUI() {
  document.querySelectorAll('.col-step.selected').forEach((el) => el.classList.remove('selected'));
  const allViewpoints = [...viewpointsElem, ...viewpointsJunior, ...viewpointsAdmin];
  for (const vp of allViewpoints) delete selectedByVp[vp];
}

async function loadSelections() {
  selectionsLoaded = false;
  try {
    const res = await fetchWithTimeout('/api/selections', { headers: { 'Authorization': 'Bearer ' + token } }, 12000);
    if (res.status === 401) { localStorage.clear(); window.location.href = '/login'; return; }
    if (!res.ok) throw new Error('読み込みに失敗しました（' + res.status + '）');
    const data = await res.json();
    clearSelectionsUI();

    const selections = (data && data.selections) ? data.selections : [];
    for (const s0 of selections) {
      const s = s0 || {};
      const vp = s.viewpoint || '';
      const step = parseInt(String(s.step || '0'), 10);
      if (!vp || !step) continue;

      // If multiple rows exist for the same viewpoint, the last one wins.
      selectedByVp[vp] = { step: step, memo: s.memo || '' };
    }

    // Load selections for all viewpoints (all types)
    const allViewpoints = [...viewpointsElem, ...viewpointsJunior, ...viewpointsAdmin];
    for (const vp of allViewpoints) {
      const sel = selectedByVp[vp];
      if (!sel) continue;
      const cell = document.querySelector('.col-step[data-vp="' + vp + '"][data-step="' + sel.step + '"]');
      if (cell) {
        cell.classList.add('selected');
        const memo = cell.querySelector('.memo-input');
        if (memo) memo.value = sel.memo || '';
      }
    }
  } catch(e) {
    console.error(e);
  } finally {
    selectionsLoaded = true;
  }
}

async function saveSelections() {
  if (!requireAuth()) return;
  if (!selectionsLoaded) {
    showSaveStatus('読み込み中です。少し待ってから保存してください。', false);
    return;
  }

  const btn = document.getElementById('btnSave');
  // 二重送信防止
  if (btn && btn.disabled) return;

  const prev = '<i class="fas fa-save"></i> 保存する';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 保存中...';
  }

  try {
    const tasks = [];

    for (const vp of viewpoints) {
      const sel = selectedByVp[vp];
      if (sel && sel.step) {
        // Get latest memo from DOM (in case)
        const cell = document.querySelector('.col-step[data-vp="' + vp + '"][data-step="' + sel.step + '"]');
        let memo = sel.memo || '';
        if (cell) {
          const memoEl = cell.querySelector('.memo-input');
          if (memoEl) memo = memoEl.value;
        }

        tasks.push(fetchWithTimeout('/api/selections', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ viewpoint: vp, step: sel.step, memo: memo })
        }, 12000));
      } else {
        tasks.push(fetchWithTimeout('/api/selections/' + vp, {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + token }
        }, 12000));
      }
    }

    // Save school if changed
    await saveSchoolIfChanged(false);

    // Also save annual notes
    await Promise.all(tasks);
    await saveAnnualNotes();

    showSaveStatus('保存しました', true);
  } catch(e) {
    console.error(e);
    showSaveStatus((e && e.message) ? e.message : '保存に失敗しました', false);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = prev;
    }
  }
}

function handlePrint() {
  try {
    if (typeof window.print !== 'function') {
      alert('この端末・ブラウザでは印刷が利用できない場合があります。PCブラウザをお試しください。');
      return;
    }
    window.print();
  } catch(e) {
    alert('印刷が利用できませんでした。PCブラウザでお試しください。');
  }
}

async function logout() {
  const t = localStorage.getItem('token');
  if (t) { try { await fetch('/api/auth/logout', { method:'POST', headers:{'Authorization':'Bearer '+t} }); } catch(e){} }
  localStorage.clear();
  window.location.href = '/login';
}

function switchSchoolType(type) {
  const tElem = document.getElementById('tableElem');
  const tJunior = document.getElementById('tableJunior');
  const tAdmin = document.getElementById('tableAdmin');
  if (tElem) tElem.style.display = 'none';
  if (tJunior) tJunior.style.display = 'none';
  if (tAdmin) tAdmin.style.display = 'none';
  if (type === 'elementary' && tElem) tElem.style.display = '';
  if (type === 'junior' && tJunior) tJunior.style.display = '';
  if (type === 'admin' && tAdmin) tAdmin.style.display = '';
  // Reload selections for the current type
  loadSelections();
}

async function init() {
  if (!requireAuth()) return;

  updateUserBar();

  // Fetch latest profile from API
  try {
    var meRes = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
    if (meRes.ok) {
      var meData = await meRes.json();
      if (meData.user) { Object.assign(user, meData.user); localStorage.setItem('user', JSON.stringify(user)); }
    }
  } catch(e) { /* use cached data */ }

  const schoolEdit = document.getElementById('schoolInput');
  if (schoolEdit) schoolEdit.value = user.school || '';

  const btnSchoolSave = document.getElementById('btnSchoolSave');
    // Load profile data into form
    const gradeOptions = ['1年','2年','3年','4年','5年','6年','中1','中2','中3','特別支援','専科','管理職','その他'];
    const gradeContainer = document.getElementById('profile-grade-checks');
    if (gradeContainer) {
      const savedGrades = (user.grade || '').split(',').filter(Boolean);
      gradeContainer.innerHTML = gradeOptions.map(g => '<label style="display:inline-flex;align-items:center;gap:2px;font-size:12px;background:#f5f5f5;padding:3px 8px;border-radius:12px;cursor:pointer;"><input type="checkbox" value="'+g+'"'+(savedGrades.includes(g)?' checked':'')+' style="margin:0;">'+g+'</label>').join('');
    }
    const districtEl = document.getElementById('profile-district');
    const experienceEl = document.getElementById('profile-experience');
    const positionEl = document.getElementById('profile-position');
    if (districtEl && user.district) districtEl.value = user.district;
    if (experienceEl && user.experience_years != null) experienceEl.value = user.experience_years;
    if (positionEl && user.position) positionEl.value = user.position;
    if (user.district || user.experience_years || user.grade || user.position) {
      const det = document.getElementById('profileDetails'); if (det) det.open = true;
    }

    // Auto-switch table based on position
    function positionToSchoolType(pos) {
      if (pos === '小学校教諭') return 'elementary';
      if (pos === '中学校教諭') return 'junior';
      return 'admin';
    }
    const posEl = document.getElementById('profile-position');
    if (posEl) {
      posEl.addEventListener('change', function() {
        switchSchoolType(positionToSchoolType(this.value));
      });
      if (posEl.value) switchSchoolType(positionToSchoolType(posEl.value));
    }


  // 入力の取り違い防止（入力したのに空で保存される事故を防ぐ）
  const gEl = document.getElementById('annualGoal');
  const rEl = document.getElementById('annualReflection');
  if (gEl) gEl.addEventListener('input', setAnnualNotesDirty);
  if (rEl) rEl.addEventListener('input', setAnnualNotesDirty);

  if (user.role === 'admin') {
    const adminLink = document.getElementById('adminLink');
    if (adminLink) adminLink.innerHTML = '<a href="/admin" class="btn-sm btn-admin" style="text-decoration:none"><i class="fas fa-cog"></i> 管理者</a> <a href="/admin/events" class="btn-sm" style="text-decoration:none;background:#ff6f00;color:#fff"><i class="fas fa-calendar-alt"></i> イベント</a>';
  }

  setupFYSelect();
  attachMemoListeners();


  const btnSave = document.getElementById('btnSave');
  if (btnSave) btnSave.addEventListener('click', () => saveSelections());
  const btnPrint = document.getElementById('btnPrint');
  if (btnPrint) btnPrint.addEventListener('click', () => handlePrint());

  loadSelections();
  loadAnnualNotes();
  loadHistory();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
</script>
</body></html>`)
})

// --- Admin Dashboard ---
app.get('/admin', (c) => {
  return c.html(`<!DOCTYPE html><html lang="ja"><head>${commonHead}
<title>管理者ダッシュボード - 社会科同好会</title>
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
  .member-table th[data-sort]:hover { background: rgba(0,0,0,0.05); }
.sort-icon { font-size: 10px; opacity: 0.6; }
.admin-tabs { display: flex; gap: 0; margin: 12px 0 0 0; }
.admin-tab { padding: 10px 24px; border: 2px solid #ddd; border-bottom: none; border-radius: 10px 10px 0 0; background: #f5f5f5; color: #888; font-weight: 700; font-size: 14px; cursor: pointer; font-family: inherit; transition: all 0.2s; }
.admin-tab.active { background: #fff; color: #e65100; border-color: #e65100; position: relative; z-index: 1; margin-bottom: -2px; }
.admin-tab:hover:not(.active) { background: #fff3e0; color: #e65100; }
.btn-warning { background: #ff9800; color: #fff; border: none; border-radius: 4px; cursor: pointer; padding: 4px 8px; font-size: 12px; }
  .btn-warning:hover { background: #f57c00; }
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
  </div>

  <div class="admin-tabs">
    <button class="admin-tab active" data-tab="elem" onclick="switchAdminTab('elem')">小学校</button>
    <button class="admin-tab" data-tab="junior" onclick="switchAdminTab('junior')">中学校</button>
    <button class="admin-tab" data-tab="admin" onclick="switchAdminTab('admin')">管理職</button>
  </div>
  <table class="member-table">
    <thead id="memberThead"><tr></tr></thead>
    <tbody id="memberBody"></tbody>
  </table>
</div>

<div class="detail-modal" id="detailModal" onclick="if(event.target===this)this.classList.remove('show')">
  <div class="detail-content" id="detailContent"></div>
</div>

<script>
const token = localStorage.getItem('token');
let user = JSON.parse(localStorage.getItem('user') || 'null');
if (!token || !user || user.role !== 'admin') { window.location.href = '/login'; throw new Error('redirect'); }

let allMembers = [];
const vpKeys = ['lesson_plan','lesson_practice','student_eval','connection','research'];
const vpLabels = { lesson_plan:'授業をつくる', lesson_practice:'授業をする', student_eval:'子どもを見る', connection:'つながる', research:'深める' };
const stepLabels = { 1:'STEP1', 2:'STEP2', 3:'STEP3', 4:'STEP4' };

function stepBadge(sel) {
  if (!sel) return '<span class="step-badge step-none">未選択</span>';
  return '<span class="step-badge step-'+sel.step+'">STEP'+sel.step+'</span>';
}

var _allMembers = [];
var _sortCol = '';
var _sortDir = 1;
var _activeTab = 'elem';

var _vpTabConfig = {
  elem: {
    label: '小学校',
    viewpoints: [
      { key: 'lesson_plan', label: '授業をつくる' },
      { key: 'lesson_practice', label: '授業をする' },
      { key: 'student_eval', label: '子どもを見る' },
      { key: 'connection', label: 'つながる' },
      { key: 'research', label: '深める' }
    ]
  },
  junior: {
    label: '中学校',
    viewpoints: [
      { key: 'j_lesson_plan', label: '授業をつくる' },
      { key: 'j_material', label: '【資料】' },
      { key: 'j_dialogue', label: '【対話】' },
      { key: 'j_inquiry', label: '【探究】' },
      { key: 'j_student_eval', label: '生徒を見る' },
      { key: 'j_connection', label: 'つながる' },
      { key: 'j_research', label: '深める' }
    ]
  },
  admin: {
    label: '管理職',
    viewpoints: [
      { key: 'a_school_support', label: '会の活動を支える' },
      { key: 'a_school_mgmt', label: '会員同士をつなぐ' },
      { key: 'a_member_support', label: '会員の成長を支える' },
      { key: 'a_leader_dev', label: '次世代リーダー' },
      { key: 'a_org_mgmt', label: '運営に貢献' },
      { key: 'a_outreach', label: '外とつなぐ' }
    ]
  }
};

function switchAdminTab(tab) {
  _activeTab = tab;
  _sortCol = '';
  _sortDir = 1;
  document.querySelectorAll('.admin-tab').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
  });
  renderMembers(_allMembers);
}

function updateSortHeaders() {
  document.querySelectorAll('.sort-icon').forEach(function(el) {
    var col = el.getAttribute('data-col');
    el.textContent = col === _sortCol ? (_sortDir === 1 ? '▲' : '▼') : '⇅';
  });
  document.querySelectorAll('[data-sort]').forEach(function(th) {
    th.style.background = th.getAttribute('data-sort') === _sortCol ? 'rgba(0,0,0,0.08)' : '';
  });
}

function renderMembers(members) {
  var body = document.getElementById('memberBody');
  var thead = document.getElementById('memberThead');
  _allMembers = members;

  var vps = _vpTabConfig[_activeTab].viewpoints;

  // Build thead dynamically
  var hdr = '<tr><th style="width:30px">#</th>';
  hdr += '<th style="width:120px;cursor:pointer;user-select:none" data-sort="name">名前 <span class="sort-icon" data-col="name"></span></th>';
  hdr += '<th style="width:60px;cursor:pointer;user-select:none" data-sort="district">区 <span class="sort-icon" data-col="district"></span></th>';
  hdr += '<th style="width:50px;cursor:pointer;user-select:none" data-sort="experience_years">経験 <span class="sort-icon" data-col="experience_years"></span></th>';
  hdr += '<th style="width:60px;cursor:pointer;user-select:none" data-sort="grade">学年 <span class="sort-icon" data-col="grade"></span></th>';
  hdr += '<th style="width:80px;cursor:pointer;user-select:none" data-sort="position">所属 <span class="sort-icon" data-col="position"></span></th>';
  for (var vi = 0; vi < vps.length; vi++) {
    hdr += '<th style="cursor:pointer;user-select:none" data-sort="vp_' + vps[vi].key + '">' + vps[vi].label + ' <span class="sort-icon" data-col="vp_' + vps[vi].key + '"></span></th>';
  }
  hdr += '<th>操作</th></tr>';
  thead.innerHTML = hdr;

  // Sort
  if (_sortCol) {
    var isVp = _sortCol.indexOf('vp_') === 0;
    var vpKey = isVp ? _sortCol.slice(3) : '';
    members = members.slice().sort(function(a, b) {
      var av, bv;
      if (isVp) {
        av = (a.selections && a.selections[vpKey]) ? a.selections[vpKey].step : 0;
        bv = (b.selections && b.selections[vpKey]) ? b.selections[vpKey].step : 0;
        av = Number(av) || 0; bv = Number(bv) || 0;
      } else {
        av = a[_sortCol] != null ? a[_sortCol] : '';
        bv = b[_sortCol] != null ? b[_sortCol] : '';
        if (typeof av === 'number' || typeof bv === 'number') {
          av = (av === null || av === '') ? -1 : Number(av);
          bv = (bv === null || bv === '') ? -1 : Number(bv);
        } else { av = String(av).toLowerCase(); bv = String(bv).toLowerCase(); }
      }
      return av < bv ? -_sortDir : av > bv ? _sortDir : 0;
    });
  }
  updateSortHeaders();

  // Build rows
  body.innerHTML = members.map(function(m, i) {
    var vpCells = '';
    for (var vi = 0; vi < vps.length; vi++) {
      var vpName = vps[vi].key;
      var sel = m.selections ? m.selections[vpName] : null;
      var stepLabel = sel ? 'STEP' + sel.step : '未選択';
      var stepClass = sel ? 'step' + sel.step : 'none';
      vpCells += '<td style="text-align:center"><span class="badge-' + stepClass + '">' + stepLabel + '</span></td>';
    }
    return '<tr>' +
      '<td>' + (i + 1) + '</td>' +
      '<td><strong>' + (m.name || '') + '</strong></td>' +
      '<td>' + (m.district || '-') + '</td>' +
      '<td>' + (m.experience_years != null ? m.experience_years + '年目' : '-') + '</td>' +
      '<td>' + (m.grade || '-') + '</td>' +
      '<td>' + (m.position || '-') + '</td>' +
      vpCells +
      '<td style="white-space:nowrap">' +
        '<button class="btn-sm btn-warning" data-action="role" data-id="' + m.id + '" data-role="' + m.role + '" title="' + (m.role === 'admin' ? '管理者を解除' : '管理者にする') + '"><i class="fas ' + (m.role === 'admin' ? 'fa-user-minus' : 'fa-user-plus') + '"></i></button> ' +
        '<button class="btn-sm btn-danger" data-action="delete" data-id="' + m.id + '" title="削除"><i class="fas fa-trash"></i></button>' +
      '</td></tr>';
  }).join('');

  updateStats(members);

  // Setup sort click handler
  if (!thead._sortReady) {
    thead._sortReady = true;
    thead.addEventListener('click', function(e) {
      var th = e.target.closest('[data-sort]');
      if (!th) return;
      var col = th.getAttribute('data-sort');
      if (_sortCol === col) { _sortDir = -_sortDir; } else { _sortCol = col; _sortDir = 1; }
      renderMembers(_allMembers);
    });
  }
}

function updateStats(members) {
  var total = members.length;
  var all = 0, partial = 0, none = 0;
  var vps = _vpTabConfig[_activeTab].viewpoints;
  members.forEach(function(m) {
    var filled = 0;
    for (var vi = 0; vi < vps.length; vi++) {
      if (m.selections && m.selections[vps[vi].key]) filled++;
    }
    if (filled === vps.length) all++;
    else if (filled > 0) partial++;
    else none++;
  });
  document.getElementById('totalCount').textContent = total;
  document.getElementById('allCount').textContent = all;
  document.getElementById('partialCount').textContent = partial;
  document.getElementById('noneCount').textContent = none;
}

async function loadMembers() {
  var token = localStorage.getItem('token');
  var res = await fetch('/api/admin/members', { headers: { 'Authorization': 'Bearer ' + token } });
  if (res.status === 401 || res.status === 403) { localStorage.clear(); window.location.href = '/login'; return; }
  var data = await res.json();
  _allMembers = data.members || [];
  renderMembers(_allMembers);
}

loadMembers();
function filterMembers() {
  const q = document.getElementById('searchBox').value.toLowerCase();
  const filtered = allMembers.filter(m => m.name.toLowerCase().includes(q) || (m.school || '').toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
  renderMembers(filtered);
}

const ADMIN_FIRST_FY = 2026;
function getCurrentFiscalYearClient() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const fy = m >= 4 ? y : y - 1;
  return Math.max(fy, ADMIN_FIRST_FY);
}

// XSS対策（管理画面でも一応）
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function loadAnnualNotesForMember(userId) {
  const box = document.getElementById('annualNotesContent');
  if (!box) return;
  box.textContent = '読み込み中...';

  const fy = getCurrentFiscalYearClient();

  try {
    const res = await fetch('/api/admin/annual-notes?user_id=' + encodeURIComponent(userId) + '&fy=' + encodeURIComponent(fy), {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) {
      box.textContent = '読み込みに失敗しました';
      return;
    }
    const data = await res.json();
    const goal = (data.goal || '').trim();
    const reflection = (data.reflection || '').trim();
    const updated = data.updated_at ? ('最終更新: ' + new Date(data.updated_at).toLocaleString('ja-JP')) : '';

    box.innerHTML =
      '<div style="margin-bottom:10px"><div style="font-weight:700;color:#555;margin-bottom:4px">目標</div>' +
      '<div style="white-space:pre-wrap;background:#fff;border:1px solid #eee;border-radius:10px;padding:10px">' +
        (goal ? escapeHtml(goal) : '<span style="color:#999">未入力</span>') +
      '</div></div>' +
      '<div><div style="font-weight:700;color:#555;margin-bottom:4px">振り返り</div>' +
      '<div style="white-space:pre-wrap;background:#fff;border:1px solid #eee;border-radius:10px;padding:10px">' +
        (reflection ? escapeHtml(reflection) : '<span style="color:#999">未入力</span>') +
      '</div></div>' +
      (updated ? '<div style="margin-top:8px;color:#999;font-size:11px">' + escapeHtml(updated) + '</div>' : '');
  } catch (e) {
    box.textContent = '読み込みに失敗しました';
  }
}

function showDetail(id) {
  const m = allMembers.find(x => x.id === id);
  if (!m) return;

  const fy = getCurrentFiscalYearClient();

  let html = '<h2><i class="fas fa-user"></i> ' + escapeHtml(m.name) + '</h2>';
  html += '<p style="color:#888;font-size:13px;margin-bottom:14px">'
    + (m.school ? ('学校名: ' + escapeHtml(m.school) + ' | ') : '')
    + escapeHtml(m.email)
    + ' | 登録日: ' + escapeHtml(m.created_at || '-')
    + '</p>';

  // 年度目標・振り返り（今年度のみ）
  html += '<div style="margin:18px 0 18px;padding:14px;border:2px solid #f0f0f0;border-radius:12px;background:#fafafa">'
    + '<div style="font-weight:700;color:#1a237e;margin-bottom:10px"><i class="fas fa-bullseye"></i> 年度の目標・振り返り（' + fy + '年度）</div>'
    + '<div id="annualNotesContent" style="font-size:13px;color:#555">読み込み中...</div>'
    + '</div>';

  for (const vp of vpKeys) {
    const sel = m.selections[vp];
    html += '<div class="detail-item"><div><div class="vp-name">' + escapeHtml(vpLabels[vp]) + '</div>';
    if (sel && sel.memo) html += '<div class="memo">' + escapeHtml(sel.memo) + '</div>';
    html += '</div>' + stepBadge(sel) + '</div>';
  }

  html += '<div style="text-align:center;margin-top:24px"><button class="btn-sm" style="background:#eee;color:#555;padding:8px 24px" id="closeDetailBtn">閉じる</button></div>';
  document.getElementById('detailContent').innerHTML = html;
  document.getElementById('closeDetailBtn').addEventListener('click', function() { document.getElementById('detailModal').classList.remove('show'); });
  document.getElementById('detailModal').classList.add('show');

  loadAnnualNotesForMember(id);
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
<title>出席・アンケート - 社会科同好会</title>
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
let user = JSON.parse(localStorage.getItem('user') || 'null');
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
    // Auto attend（落ちにくくするため軽いリトライ付き）
    if (!data.attendance) {
      await postAttendWithRetry(3);
    }
    renderEvent(data);

  } catch(e) { document.getElementById('loading').innerHTML='<p style="color:#c62828">エラーが発生しました</p>'; }
}

async function postAttendWithRetry(maxTry) {
  let lastErr = null;
  for (let i = 1; i <= (maxTry || 1); i++) {
    try {
      const res = await fetch('/api/events/'+CODE+'/attend', { method:'POST', headers:{'Authorization':'Bearer '+token} });
      if (res.ok) return true;
      // 4xx はリトライしても意味が薄い
      if (res.status >= 400 && res.status < 500) {
        lastErr = new Error('HTTP ' + res.status);
        break;
      }
      lastErr = new Error('HTTP ' + res.status);
    } catch (e) {
      lastErr = e;
    }
    // 少し待って再試行（0.2s, 0.4s, 0.8s...）
    await new Promise(r => setTimeout(r, 200 * Math.pow(2, i - 1)));
  }
  console.warn('attendance post failed', lastErr);
  return false;
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
<title>イベント管理 - 社会科同好会</title>
<script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js"></script>
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
    <div style="margin-top:16px"><button class="btn-create" onclick="submitCreateEvent()"><i class="fas fa-paper-plane"></i> 作成する</button></div>
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
if (!token||!user||user.role!=='admin') { window.location.href='/login'; throw new Error('redirect'); }

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

async function submitCreateEvent() {
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
    if (!qrEl) return;
    qrEl.innerHTML = '';
    if (typeof QRCode !== 'undefined') {
      var canvas = document.createElement('canvas');
      qrEl.appendChild(canvas);
      QRCode.toCanvas(canvas, url, { width: 240, margin: 2 }, function(err) {
        if (err) qrEl.innerHTML = '<p style="color:#c62828">QR生成エラー: ' + err.message + '<br>URL: ' + url + '</p>';
      });
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
