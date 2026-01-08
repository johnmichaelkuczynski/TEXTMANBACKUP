-- ═══════════════════════════════════════════════════════════════════════════
-- NEUROTEXT DATABASE SCHEMA
-- Complete list of all required tables
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- CORE USER TABLES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE user_activities (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  activity_type TEXT NOT NULL,
  activity_data JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE user_credits (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) NOT NULL,
  openai INTEGER,
  anthropic INTEGER,
  perplexity INTEGER,
  deepseek INTEGER,
  grok INTEGER
);

CREATE TABLE credit_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) NOT NULL,
  provider TEXT NOT NULL,
  amount INTEGER NOT NULL,
  transaction_type TEXT NOT NULL,
  stripe_payment_intent_id TEXT,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- DOCUMENT & ANALYSIS TABLES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  original_content TEXT,
  filename TEXT,
  mime_type TEXT,
  user_id INTEGER REFERENCES users(id),
  word_count INTEGER,
  math_notation_count INTEGER,
  complexity TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  ai_probability INTEGER,
  is_ai BOOLEAN
);

CREATE TABLE analyses (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id) NOT NULL,
  user_id INTEGER REFERENCES users(id),
  summary TEXT NOT NULL,
  overall_score INTEGER NOT NULL,
  overall_assessment TEXT NOT NULL,
  dimensions JSONB NOT NULL,
  cognitive_patterns JSONB,
  writing_style JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE intelligent_rewrites (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id) NOT NULL,
  user_id INTEGER REFERENCES users(id),
  rewritten_content TEXT NOT NULL,
  improvement_score INTEGER,
  improvements JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE comparisons (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id) NOT NULL,
  user_id INTEGER REFERENCES users(id),
  comparison_text TEXT NOT NULL,
  similarity_score INTEGER,
  analysis JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE case_assessments (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id) NOT NULL,
  user_id INTEGER REFERENCES users(id),
  case_type TEXT NOT NULL,
  assessment TEXT NOT NULL,
  recommendations JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE cognitive_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) NOT NULL,
  profile_name TEXT NOT NULL,
  cognitive_dimensions JSONB NOT NULL,
  thinking_patterns JSONB,
  strengths JSONB,
  areas_for_growth JSONB,
  historical_trend JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE rewrite_jobs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending',
  original_text TEXT NOT NULL,
  current_text TEXT,
  target_score INTEGER NOT NULL,
  custom_instructions TEXT,
  iteration INTEGER NOT NULL DEFAULT 0,
  max_iterations INTEGER NOT NULL DEFAULT 10,
  scores JSONB,
  improvement_log JSONB,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- COHERENCE/RECONSTRUCTION TABLES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE coherence_documents (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE coherence_chunks (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES coherence_documents(id) NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE reconstruction_documents (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  original_text TEXT NOT NULL,
  global_skeleton JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  input_words INTEGER,
  target_min_words INTEGER,
  target_max_words INTEGER,
  target_mid_words INTEGER,
  length_ratio REAL,
  length_mode TEXT,
  chunk_target_words INTEGER,
  num_chunks INTEGER,
  current_chunk INTEGER DEFAULT 0,
  audience_parameters TEXT,
  rigor_level TEXT,
  custom_instructions TEXT,
  error_message TEXT,
  aborted_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE reconstruction_chunks (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES reconstruction_documents(id) NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_input_text TEXT NOT NULL,
  chunk_input_words INTEGER,
  chunk_output_text TEXT,
  actual_words INTEGER,
  target_words INTEGER,
  min_words INTEGER,
  max_words INTEGER,
  chunk_delta JSONB,
  conflicts_detected JSONB,
  status TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE reconstruction_runs (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES reconstruction_documents(id) NOT NULL,
  run_type TEXT NOT NULL,
  chunk_index INTEGER,
  run_input JSONB,
  run_output JSONB,
  duration_ms INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE stitch_results (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES reconstruction_documents(id) NOT NULL,
  conflicts JSONB,
  term_drift JSONB,
  missing_premises JSONB,
  redundancies JSONB,
  repair_plan JSONB,
  coherence_score TEXT,
  final_validation JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- HCC (HIERARCHICAL CROSS-CHUNK) TABLES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE hcc_documents (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  original_text TEXT NOT NULL,
  word_count INTEGER,
  global_skeleton JSONB,
  final_output TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE hcc_parts (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES hcc_documents(id) NOT NULL,
  part_index INTEGER NOT NULL,
  part_content TEXT NOT NULL,
  part_output TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE hcc_chapters (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES hcc_documents(id) NOT NULL,
  part_id INTEGER REFERENCES hcc_parts(id),
  chapter_index INTEGER NOT NULL,
  chapter_content TEXT NOT NULL,
  chapter_output TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE hcc_chunks (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES hcc_documents(id) NOT NULL,
  chapter_id INTEGER REFERENCES hcc_chapters(id),
  chunk_index INTEGER NOT NULL,
  chunk_content TEXT NOT NULL,
  chunk_output TEXT,
  chunk_delta JSONB,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- PIPELINE TABLES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE pipeline_jobs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  input_text TEXT NOT NULL,
  input_word_count INTEGER,
  target_words INTEGER,
  custom_instructions TEXT,
  audience_parameters TEXT,
  rigor_level TEXT,
  stage1_skeleton JSONB,
  stage1_output TEXT,
  stage1_word_count INTEGER,
  stage2_skeleton JSONB,
  stage2_objections JSONB,
  stage3_skeleton JSONB,
  stage3_output TEXT,
  stage3_word_count INTEGER,
  stage4_skeleton JSONB,
  stage4_output TEXT,
  stage4_word_count INTEGER,
  current_stage INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE pipeline_chunks (
  id SERIAL PRIMARY KEY,
  job_id INTEGER REFERENCES pipeline_jobs(id) NOT NULL,
  stage INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_input TEXT,
  chunk_output TEXT,
  chunk_delta JSONB,
  target_words INTEGER,
  actual_words INTEGER,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE pipeline_objections (
  id SERIAL PRIMARY KEY,
  job_id INTEGER REFERENCES pipeline_jobs(id) NOT NULL,
  objection_index INTEGER NOT NULL,
  objection_text TEXT NOT NULL,
  response_text TEXT,
  severity TEXT,
  category TEXT,
  addressed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- SYSTEM TABLES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE system_instructions (
  id SERIAL PRIMARY KEY,
  instruction_key TEXT NOT NULL UNIQUE,
  instruction_value TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- NEW: COHERENT SESSIONS & AUDIT TABLES (FROM YOUR SPEC)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE coherent_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) NOT NULL,
  session_type TEXT NOT NULL,
  user_prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  global_skeleton JSONB,
  total_chunks INTEGER DEFAULT 0,
  processed_chunks INTEGER DEFAULT 0,
  target_words INTEGER,
  actual_words INTEGER,
  final_output TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE coherent_chunks (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES coherent_sessions(id) ON DELETE CASCADE NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_type TEXT NOT NULL,
  chunk_input TEXT,
  chunk_output TEXT,
  chunk_delta JSONB,
  target_words INTEGER,
  actual_words INTEGER,
  processed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) NOT NULL,
  job_type TEXT NOT NULL,
  job_id INTEGER,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  status TEXT DEFAULT 'running',
  final_output_preview TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_log_entries (
  id SERIAL PRIMARY KEY,
  audit_log_id INTEGER REFERENCES audit_logs(id) NOT NULL,
  sequence_num INTEGER NOT NULL,
  timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  event_type TEXT NOT NULL,
  event_data JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE INDEX idx_documents_user_id ON documents(user_id);
CREATE INDEX idx_analyses_document_id ON analyses(document_id);
CREATE INDEX idx_user_activities_user_id ON user_activities(user_id);
CREATE INDEX idx_rewrite_jobs_user_id ON rewrite_jobs(user_id);
CREATE INDEX idx_reconstruction_chunks_document_id ON reconstruction_chunks(document_id);
CREATE INDEX idx_hcc_chunks_document_id ON hcc_chunks(document_id);
CREATE INDEX idx_pipeline_chunks_job_id ON pipeline_chunks(job_id);
CREATE INDEX idx_coherent_chunks_session_id ON coherent_chunks(session_id);
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_log_entries_audit_log_id ON audit_log_entries(audit_log_id);
