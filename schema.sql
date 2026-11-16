-- 線上測驗後端資料表（Cloudflare D1 / SQLite）

-- 試卷（題庫）
CREATE TABLE IF NOT EXISTS quizzes (
  id          TEXT PRIMARY KEY,           -- 試卷代碼，自行定義
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- 題目與標準答案（答案只存在伺服器，不送到學生端）
CREATE TABLE IF NOT EXISTS questions (
  quiz_id     TEXT NOT NULL,
  qid         INTEGER NOT NULL,           -- 原始題號
  sort        INTEGER NOT NULL,           -- 顯示順序
  part        TEXT,                       -- 大題標題
  tag         TEXT,                       -- 主題標籤
  title       TEXT NOT NULL,              -- 題幹（可含 HTML）
  options     TEXT NOT NULL,              -- JSON 陣列，四個選項
  answer      INTEGER NOT NULL,           -- 正確選項索引 0~3
  explanation TEXT,
  PRIMARY KEY (quiz_id, qid)
);

-- 派卷：老師每派一次考卷一筆
CREATE TABLE IF NOT EXISTS assignments (
  code        TEXT PRIMARY KEY,           -- 6 碼派卷代碼
  quiz_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  modes       TEXT NOT NULL,              -- "instant" / "full" / "instant,full"
  opens_at    TEXT,                       -- ISO 時間，可空
  closes_at   TEXT,                       -- ISO 時間，可空
  is_open     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

-- 作答紀錄：學生每開始一次作答一筆；attempt_no = 1 為正式成績
CREATE TABLE IF NOT EXISTS attempts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_code TEXT NOT NULL,
  class_name      TEXT NOT NULL,
  seat            INTEGER NOT NULL,
  student_name    TEXT NOT NULL,           -- 作答代號，請勿收集真實姓名
  mode            TEXT NOT NULL,          -- instant / full
  attempt_no      INTEGER NOT NULL,
  token           TEXT NOT NULL UNIQUE,   -- 學生端作答憑證
  started_at      TEXT NOT NULL,
  submitted_at    TEXT,
  score           INTEGER,
  correct_count   INTEGER,
  UNIQUE (assignment_code, class_name, seat, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_attempts_code ON attempts (assignment_code);

-- 每題作答
CREATE TABLE IF NOT EXISTS answers (
  attempt_id  INTEGER NOT NULL,
  qid         INTEGER NOT NULL,
  choice      INTEGER,                    -- 0~3，未答為 NULL
  is_correct  INTEGER NOT NULL DEFAULT 0,
  answered_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, qid)
);
