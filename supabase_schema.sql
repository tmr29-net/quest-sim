-- 3D水害避難シミュレーター用 Supabase (PostgreSQL) スキーマ設定

-- 1. sessions テーブル (被験者の避難結果のメタデータ)
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  name TEXT NOT NULL,
  age_group TEXT NOT NULL,
  has_hazard_map BOOLEAN NOT NULL,
  selected_destination TEXT,
  status TEXT NOT NULL, -- 'survived' (生存) | 'drowned' (溺死/失敗) | 'timeout' (時間切れ)
  duration INTEGER NOT NULL -- 避難にかかった時間（秒）
);

-- インデックス作成 (検索パフォーマンス向上用)
CREATE INDEX IF NOT EXISTS idx_sessions_has_hazard_map ON sessions(has_hazard_map);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at DESC);

-- 2. trajectories テーブル (毎秒の座標トラッキングログ)
CREATE TABLE IF NOT EXISTS trajectories (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  step_second INTEGER NOT NULL,
  pos_x REAL NOT NULL,
  pos_z REAL NOT NULL,
  pos_y REAL NOT NULL,
  water_level REAL NOT NULL
);

-- インデックス作成
CREATE INDEX IF NOT EXISTS idx_trajectories_session_id ON trajectories(session_id);
CREATE INDEX IF NOT EXISTS idx_trajectories_session_id_step ON trajectories(session_id, step_second);

-- Row Level Security (RLS) の設定 (必要に応じて)
-- 今回は研究・実験用途のプロトタイプのため、パブリックでの読み書きを一時的に許可するポリシー例を記述します。
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE trajectories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public insert to sessions" ON sessions
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public select from sessions" ON sessions
  FOR SELECT USING (true);

CREATE POLICY "Allow public insert to trajectories" ON trajectories
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public select from trajectories" ON trajectories
  FOR SELECT USING (true);
