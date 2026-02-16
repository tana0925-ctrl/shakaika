import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
}

type Variables = {
  user: { id: number; name: string; email: string; role: string }
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

// Simple token store (in-memory per instance, fine for local dev; for prod use KV or D1)
const tokenStore = new Map<string, { userId: number; expires: number }>()

function setToken(token: string, userId: number) {
  tokenStore.set(token, { userId, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 })
}

function getUserIdFromToken(token: string): number | null {
  const entry = tokenStore.get(token)
  if (!entry) return null
  if (Date.now() > entry.expires) {
    tokenStore.delete(token)
    return null
  }
  return entry.userId
}

// ========== Auth Middleware ==========
async function authMiddleware(c: any, next: any) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'ログインが必要です' }, 401)
  }
  const token = authHeader.replace('Bearer ', '')
  const userId = getUserIdFromToken(token)
  if (!userId) {
    return c.json({ error: 'セッションが無効です。再ログインしてください' }, 401)
  }
  const user = await c.env.DB.prepare('SELECT id, name, email, role FROM users WHERE id = ?').bind(userId).first()
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
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member', 'admin')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`).run()

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

  // Create default admin if not exists
  const adminHash = await hashPassword('admin123')
  await db.prepare(
    'INSERT OR IGNORE INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)'
  ).bind('管理者', 'admin@example.com', adminHash, 'admin').run()

  return c.json({ message: 'データベースを初期化しました' })
})

// ========== Auth API ==========
app.post('/api/auth/register', async (c) => {
  const { name, email, password } = await c.req.json()
  if (!name || !email || !password) {
    return c.json({ error: '名前・メールアドレス・パスワードは必須です' }, 400)
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
    'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)'
  ).bind(name, email, passwordHash, 'member').run()

  const userId = result.meta.last_row_id as number
  const token = generateToken()
  setToken(token, userId)

  return c.json({ token, user: { id: userId, name, email, role: 'member' } })
})

app.post('/api/auth/login', async (c) => {
  const { email, password } = await c.req.json()
  if (!email || !password) {
    return c.json({ error: 'メールアドレスとパスワードを入力してください' }, 400)
  }
  const passwordHash = await hashPassword(password)
  const user = await c.env.DB.prepare(
    'SELECT id, name, email, role FROM users WHERE email = ? AND password_hash = ?'
  ).bind(email, passwordHash).first()
  if (!user) {
    return c.json({ error: 'メールアドレスまたはパスワードが正しくありません' }, 401)
  }
  const token = generateToken()
  setToken(token, user.id as number)

  return c.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } })
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
    `SELECT u.id, u.name, u.email, u.role, u.created_at,
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
    'SELECT id, name, email, role, created_at FROM users ORDER BY created_at'
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
  const headers = ['名前', 'メールアドレス', '役割', '登録日']
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
      body: JSON.stringify({ name: document.getElementById('regName').value, email: document.getElementById('regEmail').value, password: document.getElementById('regPassword').value })
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

  .container { max-width: 1250px; margin: 0 auto; background-color: #fff; padding: 20px 24px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); border-radius: 12px; border: 2px solid #f0e6d2; }
  .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px dashed var(--header-line); padding-bottom: 8px; margin-bottom: 15px; }
  .title-block h1 { font-family: 'Zen Maru Gothic', sans-serif; font-size: 22px; margin: 0; line-height: 1.2; color: var(--header-line); }
  .title-block .subtitle { font-size: 12px; color: #666; margin-top: 4px; font-weight: 500; }

  table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 10.5pt; table-layout: fixed; border-radius: 8px; overflow: hidden; border: 1px solid #ddd; }
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

  @media print {
    .top-bar, .guide, .save-area, .memo-input { display: none !important; }
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

document.getElementById('userName').textContent = user ? user.name + ' さん' : '';
if (user && user.role === 'admin') {
  document.getElementById('adminLink').innerHTML = '<a href="/admin" class="btn-sm btn-admin" style="text-decoration:none"><i class="fas fa-cog"></i> 管理者</a>';
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
      '<td class="member-name" style="cursor:pointer" onclick=\\'showDetail('+m.id+')\\'>' + m.name + '</td>' +
      '<td>' + roleBadge + '</td>' +
      vpKeys.map(vp => '<td>' + stepBadge(m.selections[vp]) + '</td>').join('') +
      '<td>' +
        (m.role !== 'admin' ? '<button class="btn-sm btn-role" onclick="toggleRole('+m.id+',\\''+m.role+'\\')"><i class="fas fa-user-shield"></i></button> ' : '') +
        (m.id !== user.id ? '<button class="btn-sm btn-danger" onclick="deleteMember('+m.id+',\\''+m.name+'\\')"><i class="fas fa-trash"></i></button>' : '') +
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
  const filtered = allMembers.filter(m => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
  renderMembers(filtered);
}

function showDetail(id) {
  const m = allMembers.find(x => x.id === id);
  if (!m) return;
  let html = '<h2><i class="fas fa-user"></i> ' + m.name + '</h2>';
  html += '<p style="color:#888;font-size:13px;margin-bottom:20px">' + m.email + ' | 登録日: ' + (m.created_at || '-') + '</p>';
  for (const vp of vpKeys) {
    const sel = m.selections[vp];
    html += '<div class="detail-item"><div><div class="vp-name">' + vpLabels[vp] + '</div>';
    if (sel && sel.memo) html += '<div class="memo">' + sel.memo + '</div>';
    html += '</div>' + stepBadge(sel) + '</div>';
  }
  html += '<div style="text-align:center;margin-top:24px"><button class="btn-sm" style="background:#eee;color:#555;padding:8px 24px" onclick="document.getElementById(\\'detailModal\\').classList.remove(\\'show\\')">閉じる</button></div>';
  document.getElementById('detailContent').innerHTML = html;
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

function logout() { localStorage.clear(); window.location.href = '/login'; }

loadMembers();
</script>
</body></html>`)
})

// --- Root redirect ---
app.get('/', (c) => {
  return c.redirect('/login')
})

export default app
