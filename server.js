// ---- Imports & setup ----
const express = require('express');
const compression = require('compression');
const path = require('path');

// ---- DB (Heroku Postgres) ----
const { Pool } = require('pg');
const DB_URL = process.env.DATABASE_URL || ''; // Heroku 注入
let pool = null;
if (DB_URL) {
  pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
  });
}

const app = express();

// ---- Middlewares ----
app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '20mb' }));   // 眼动轨迹可能较大
app.use(express.urlencoded({ extended: false }));

// 静态资源（index.html / webgazer.js 等在项目根目录）
app.use(express.static(__dirname, { maxAge: '1h', extensions: ['html'] }));

// 健康检查
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---- Save endpoint ----
// 兼容 {summary, rounds} 或 {summary, trials}
app.post('/save', async (req, res) => {
  try {
    const summary = req.body?.summary || {};
    const rounds  = req.body?.rounds ?? req.body?.trials ?? [];
    const pid     = summary.prolific_pid || req.query.PROLIFIC_PID || null;
    const study   = req.query.STUDY_ID   || null;
    const sess    = req.query.SESSION_ID || null;

    // 从前端 payload 里也可以读一个 aborted（但以服务器最终为准）
    const abortedFromBody = !!req.body?.aborted || !!summary.aborted;

    // 在服务器侧重新数一遍真正完成的 decision trial 数
    const completedTrials = Array.isArray(rounds)
      ? rounds.filter(r => r && r.phase === 'decision').length
      : 0;

    if (!pool) {
      // 没配置数据库也不报错，方便本地调试
      return res.json({ ok: true, skip: 'no DATABASE_URL', completedTrials });
    }

    // 建表（幂等）+ 确保新增字段存在
    await pool.query(`
      CREATE TABLE IF NOT EXISTS gaze_logs (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        prolific_pid TEXT,
        prolific_study_id TEXT,
        prolific_session_id TEXT,
        user_agent TEXT,
        ip TEXT,
        summary JSONB,
        rounds JSONB,
        completed_trials INT,
        aborted BOOLEAN DEFAULT FALSE
      );
    `);

    await pool.query(`
      ALTER TABLE gaze_logs
      ADD COLUMN IF NOT EXISTS completed_trials INT;
    `);
    await pool.query(`
      ALTER TABLE gaze_logs
      ADD COLUMN IF NOT EXISTS aborted BOOLEAN DEFAULT FALSE;
    `);

    await pool.query(
      `INSERT INTO gaze_logs
       (prolific_pid,
        prolific_study_id,
        prolific_session_id,
        user_agent,
        ip,
        summary,
        rounds,
        completed_trials,
        aborted)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`,
      [
        pid,
        study,
        sess,
        req.headers['user-agent'] || null,
        (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || null,
        JSON.stringify(summary),
        JSON.stringify(rounds),
        completedTrials,
        abortedFromBody,
      ]
    );

    return res.json({ ok: true, completedTrials });
  } catch (e) {
    console.error('save error:', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// 单页兜底（命中的静态资源直接返回，其他回 index.html）
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path === '/save' || req.path === '/health') return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});
