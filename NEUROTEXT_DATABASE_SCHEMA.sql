-- ═══════════════════════════════════════════════════════════════════════════════════
-- NEUROTEXT COMPLETE DATABASE SCHEMA
-- Generated: January 8, 2026
-- Total Tables: 29
-- ═══════════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════════
-- SECTION 1: CORE USER & DOCUMENT TABLES
-- ═══════════════════════════════════════════════════════════════════════════════════

-- Users table - authentication and identity
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Documents - stores all uploaded/analyzed documents
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

-- Analyses - document intelligence analysis results
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

-- ═══════════════════════════════════════════════════════════════════════════════════
-- SECTION 2: REWRITE & COMPARISON TABLES
-- ═══════════════════════════════════════════════════════════════════════════════════

-- Intelligent rewrites - MAXINTEL rewrite results
CREATE TABLE intelligent_rewrites (
  id SERIAL PRIMARY KEY,
  original_document_id INTEGER REFERENCES documents(id) NOT NULL,
  rewritten_document_id INTEGER REFERENCES documents(id) NOT NULL,
  original_analysis_id INTEGER REFERENCES analyses(id) NOT NULL,
  rewritten_analysis_id INTEGER REFERENCES analyses(id) NOT NULL,
  user_id INTEGER REFERENCES users(id),
  provider TEXT NOT NULL,
  custom_instructions TEXT,
  original_score INTEGER NOT NULL,
  rewritten_score INTEGER NOT NULL,
  score_improvement INTEGER NOT NULL,
  rewrite_report TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Comparisons - document comparison results
CREATE TABLE comparisons (
  id SERIAL PRIMARY KEY,
  document_a_id INTEGER REFERENCES documents(id) NOT NULL,
  document_b_id INTEGER REFERENCES documents(id) NOT NULL,
  analysis_a_id INTEGER REFERENCES analyses(id) NOT NULL,
  analysis_b_id INTEGER REFERENCES analyses(id) NOT NULL,
  user_id INTEGER REFERENCES users(id),
  comparison_results JSONB NOT NULL,
  improvement_suggestions JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Case assessments - argument strength evaluation
CREATE TABLE case_assessments (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id) NOT NULL,
  user_id INTEGER REFERENCES users(id),
  proof_effectiveness INTEGER NOT NULL,
  claim_credibility INTEGER NOT NULL,
  non_triviality INTEGER NOT NULL,
  proof_quality INTEGER NOT NULL,
  functional_writing INTEGER NOT NULL,
  overall_case_score INTEGER NOT NULL,
  detailed_assessment TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- GPT Bypass Humanizer rewrite jobs
CREATE TABLE rewrite_jobs (
  id SERIAL PRIMARY KEY,
  input_text TEXT NOT NULL,
  style_text TEXT,
  content_mix_text TEXT,
  custom_instructions TEXT,
  selected_presets JSONB,
  provider TEXT NOT NULL,
  chunks JSONB,
  selected_chunk_ids JSONB,
  mixing_mode TEXT,
  output_text TEXT,
  input_ai_score INTEGER,
  output_ai_score INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════════
-- SECTION 3: USER ANALYTICS & COGNITIVE PROFILES
-- ═══════════════════════════════════════════════════════════════════════════════════

-- User activities - activity tracking
CREATE TABLE user_activities (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  activity_type TEXT NOT NULL,
  activity_data JSONB,
  document_id INTEGER REFERENCES documents(id),
  session_duration INTEGER,
  timestamp TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Cognitive profiles - comprehensive user analytics
CREATE TABLE cognitive_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) UNIQUE,
  writing_patterns JSONB,
  intellectual_interests JSONB,
  cognitive_style JSONB,
  learning_behavior JSONB,
  document_preferences JSONB,
  collaboration_style JSONB,
  conceptual_complexity TEXT,
  attention_to_detail INTEGER,
  creativity_index INTEGER,
  systematic_thinking INTEGER,
  average_session_length INTEGER,
  total_documents_processed INTEGER,
  preferred_ai_provider TEXT,
  productivity_pattern JSONB,
  last_updated TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════════
-- SECTION 4: CREDIT SYSTEM (STRIPE INTEGRATION)
-- ═══════════════════════════════════════════════════════════════════════════════════

-- User credits per provider
CREATE TABLE user_credits (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) NOT NULL,
  provider TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 0,
  last_updated TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Credit transactions - purchase and usage tracking
CREATE TABLE credit_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) NOT NULL,
  provider TEXT NOT NULL,
  amount INTEGER NOT NULL,
  credits INTEGER NOT NULL,
  transaction_type TEXT NOT NULL,
  stripe_session_id TEXT,
  stripe_payment_intent_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════════
-- SECTION 5: COHERENCE METER TABLES
-- ═══════════════════════════════════════════════════════════════════════════════════

-- Coherence documents - document-level coherence tracking
CREATE TABLE coherence_documents (
  id SERIAL PRIMARY KEY,
  document_id TEXT NOT NULL,
  coherence_mode TEXT NOT NULL,
  global_state JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Coherence chunks - per-chunk coherence evaluation
CREATE TABLE coherence_chunks (
  id SERIAL PRIMARY KEY,
  document_id TEXT NOT NULL,
  coherence_mode TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT,
  evaluation_result JSONB,
  state_after JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- System instructions storage
CREATE TABLE system_instructions (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  subcategory TEXT,
  version TEXT DEFAULT '1.0',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════════
-- SECTION 6: CROSS-CHUNK COHERENCE (CC) RECONSTRUCTION TABLES
-- Multi-pass reconstruction pipeline for maintaining coherence
-- ═══════════════════════════════════════════════════════════════════════════════════

-- Reconstruction documents - top-level document tracking
CREATE TABLE reconstruction_documents (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  title TEXT,
  original_text TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  global_skeleton JSONB,
  final_output TEXT,
  final_word_count INTEGER,
  validation_result JSONB,
  status TEXT DEFAULT 'pending',
  
  -- Length enforcement parameters
  target_min_words INTEGER,
  target_max_words INTEGER,
  target_mid_words INTEGER,
  length_ratio REAL,
  length_mode TEXT,
  chunk_target_words INTEGER,
  num_chunks INTEGER,
  current_chunk INTEGER DEFAULT 0,
  
  -- User parameters
  audience_parameters TEXT,
  rigor_level TEXT,
  custom_instructions TEXT,
  error_message TEXT,
  aborted_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Reconstruction chunks - per-chunk processing state
CREATE TABLE reconstruction_chunks (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES reconstruction_documents(id) NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_input_text TEXT NOT NULL,
  chunk_input_words INTEGER,
  chunk_output_text TEXT,
  actual_words INTEGER,
  
  -- Per-chunk length targets
  target_words INTEGER,
  min_words INTEGER,
  max_words INTEGER,
  
  -- Coherence tracking
  chunk_delta JSONB,
  conflicts_detected JSONB,
  status TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Reconstruction runs - audit trail for processing steps
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

-- Stitch results - Pass 3 global coherence validation
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

-- ═══════════════════════════════════════════════════════════════════════════════════
-- SECTION 7: HIERARCHICAL CROSS-CHUNK COHERENCE (HCC) TABLES
-- For book-length documents (100,000+ words)
-- ═══════════════════════════════════════════════════════════════════════════════════

-- HCC documents - top-level book/document
CREATE TABLE hcc_documents (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  title TEXT,
  original_text TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  structure_map JSONB,
  book_skeleton JSONB,
  final_output TEXT,
  target_min_words INTEGER,
  target_max_words INTEGER,
  length_ratio TEXT,
  length_mode TEXT,
  status TEXT DEFAULT 'pending',
  custom_instructions TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- HCC parts (or virtual parts ~25,000 words each)
CREATE TABLE hcc_parts (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES hcc_documents(id) NOT NULL,
  part_index INTEGER NOT NULL,
  part_title TEXT,
  original_text TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  part_skeleton JSONB,
  compressed_book_skeleton JSONB,
  part_output TEXT,
  part_delta JSONB,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- HCC chapters (or virtual chapters ~5,000 words each)
CREATE TABLE hcc_chapters (
  id SERIAL PRIMARY KEY,
  part_id INTEGER REFERENCES hcc_parts(id) NOT NULL,
  document_id INTEGER REFERENCES hcc_documents(id) NOT NULL,
  chapter_index INTEGER NOT NULL,
  chapter_title TEXT,
  original_text TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  chapter_skeleton JSONB,
  compressed_part_skeleton JSONB,
  chapter_output TEXT,
  chapter_delta JSONB,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- HCC chunks (with length enforcement)
CREATE TABLE hcc_chunks (
  id SERIAL PRIMARY KEY,
  chapter_id INTEGER REFERENCES hcc_chapters(id) NOT NULL,
  document_id INTEGER REFERENCES hcc_documents(id) NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_input_text TEXT NOT NULL,
  chunk_input_words INTEGER NOT NULL,
  chunk_output_text TEXT,
  chunk_output_words INTEGER,
  target_words INTEGER,
  min_words INTEGER,
  max_words INTEGER,
  chunk_delta JSONB,
  conflicts_detected JSONB,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════════
-- SECTION 8: FULL PIPELINE CROSS-CHUNK COHERENCE (FPCC) TABLES
-- 4-Stage Pipeline: Reconstruction -> Objections -> Responses -> Bullet-proof
-- ═══════════════════════════════════════════════════════════════════════════════════

-- Pipeline jobs - orchestrates the 4-stage pipeline
CREATE TABLE pipeline_jobs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  
  -- Original input
  original_text TEXT NOT NULL,
  original_word_count INTEGER NOT NULL,
  
  -- User parameters
  custom_instructions TEXT,
  target_audience TEXT,
  objective TEXT,
  
  -- Stage outputs
  reconstruction_output TEXT,
  objections_output TEXT,
  responses_output TEXT,
  bulletproof_output TEXT,
  
  -- Skeletons (JSONB for flexibility)
  skeleton_1 JSONB,
  skeleton_2 JSONB,
  skeleton_3 JSONB,
  skeleton_4 JSONB,
  
  -- Progress tracking
  current_stage INTEGER DEFAULT 1,
  stage_status TEXT DEFAULT 'pending',
  total_stages INTEGER DEFAULT 4,
  
  -- Stage word counts
  reconstruction_words INTEGER,
  objections_words INTEGER,
  responses_words INTEGER,
  bulletproof_words INTEGER,
  
  -- HC check results
  hc_check_results JSONB,
  hc_violations JSONB,
  hc_repair_attempts INTEGER DEFAULT 0,
  
  -- Timing
  stage1_start_time TIMESTAMP,
  stage1_end_time TIMESTAMP,
  stage2_start_time TIMESTAMP,
  stage2_end_time TIMESTAMP,
  stage3_start_time TIMESTAMP,
  stage3_end_time TIMESTAMP,
  stage4_start_time TIMESTAMP,
  stage4_end_time TIMESTAMP,
  hc_check_time TIMESTAMP,
  
  -- Final status
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Pipeline chunks - stage-specific chunk tracking
CREATE TABLE pipeline_chunks (
  id SERIAL PRIMARY KEY,
  job_id INTEGER REFERENCES pipeline_jobs(id) NOT NULL,
  stage INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  
  chunk_input_text TEXT,
  chunk_output_text TEXT,
  chunk_delta JSONB,
  
  target_words INTEGER,
  actual_words INTEGER,
  min_words INTEGER,
  max_words INTEGER,
  
  status TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  error_message TEXT,
  
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Pipeline objections - Stage 2-4 coherence tracking
CREATE TABLE pipeline_objections (
  id SERIAL PRIMARY KEY,
  job_id INTEGER REFERENCES pipeline_jobs(id) NOT NULL,
  objection_index INTEGER NOT NULL,
  
  -- Stage 2: Objection details
  claim_targeted TEXT,
  claim_location TEXT,
  objection_type TEXT,
  objection_text TEXT,
  severity TEXT,
  
  -- Stage 2: Initial response
  initial_response TEXT,
  
  -- Stage 3: Enhanced response
  enhanced_response TEXT,
  enhancement_notes TEXT,
  
  -- Stage 4: Integration tracking
  integrated_in_section TEXT,
  integration_strategy TEXT,
  integration_verified BOOLEAN DEFAULT FALSE,
  
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════════
-- SECTION 9: COHERENT SESSIONS & CHUNKS
-- Database-enforced coherence pipeline (as specified in requirements)
-- ═══════════════════════════════════════════════════════════════════════════════════

-- Coherent sessions - user sessions for coherence pipeline
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

-- Coherent chunks - per-chunk tracking with full deltas
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

-- ═══════════════════════════════════════════════════════════════════════════════════
-- SECTION 10: MANDATORY AUDIT SYSTEM
-- Complete audit trail for EVERY operation - "If it's not in the log, it didn't happen"
-- ═══════════════════════════════════════════════════════════════════════════════════

-- Audit logs - top-level job tracking
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

-- Audit log entries - individual events within each audit log
CREATE TABLE audit_log_entries (
  id SERIAL PRIMARY KEY,
  audit_log_id INTEGER REFERENCES audit_logs(id) NOT NULL,
  sequence_num INTEGER NOT NULL,
  timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
  event_type TEXT NOT NULL,
  event_data JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════════
-- INDEXES FOR PERFORMANCE
-- ═══════════════════════════════════════════════════════════════════════════════════

CREATE INDEX idx_documents_user_id ON documents(user_id);
CREATE INDEX idx_analyses_document_id ON analyses(document_id);
CREATE INDEX idx_analyses_user_id ON analyses(user_id);
CREATE INDEX idx_user_activities_user_id ON user_activities(user_id);
CREATE INDEX idx_user_credits_user_id ON user_credits(user_id);
CREATE INDEX idx_credit_transactions_user_id ON credit_transactions(user_id);
CREATE INDEX idx_reconstruction_documents_user_id ON reconstruction_documents(user_id);
CREATE INDEX idx_reconstruction_documents_status ON reconstruction_documents(status);
CREATE INDEX idx_reconstruction_chunks_document_id ON reconstruction_chunks(document_id);
CREATE INDEX idx_reconstruction_chunks_status ON reconstruction_chunks(status);
CREATE INDEX idx_hcc_documents_user_id ON hcc_documents(user_id);
CREATE INDEX idx_hcc_parts_document_id ON hcc_parts(document_id);
CREATE INDEX idx_hcc_chapters_document_id ON hcc_chapters(document_id);
CREATE INDEX idx_hcc_chunks_chapter_id ON hcc_chunks(chapter_id);
CREATE INDEX idx_pipeline_jobs_user_id ON pipeline_jobs(user_id);
CREATE INDEX idx_pipeline_jobs_status ON pipeline_jobs(status);
CREATE INDEX idx_pipeline_chunks_job_id ON pipeline_chunks(job_id);
CREATE INDEX idx_pipeline_objections_job_id ON pipeline_objections(job_id);
CREATE INDEX idx_coherent_sessions_user_id ON coherent_sessions(user_id);
CREATE INDEX idx_coherent_chunks_session_id ON coherent_chunks(session_id);
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_job_id ON audit_logs(job_id);
CREATE INDEX idx_audit_log_entries_audit_log_id ON audit_log_entries(audit_log_id);
CREATE INDEX idx_audit_log_entries_sequence ON audit_log_entries(audit_log_id, sequence_num);

-- ═══════════════════════════════════════════════════════════════════════════════════
-- TABLE SUMMARY
-- ═══════════════════════════════════════════════════════════════════════════════════
-- 
-- CORE TABLES (6):
--   1. users
--   2. documents
--   3. analyses
--   4. intelligent_rewrites
--   5. comparisons
--   6. case_assessments
--
-- USER ANALYTICS (3):
--   7. user_activities
--   8. cognitive_profiles
--   9. rewrite_jobs
--
-- CREDIT SYSTEM (2):
--   10. user_credits
--   11. credit_transactions
--
-- COHERENCE METER (3):
--   12. coherence_documents
--   13. coherence_chunks
--   14. system_instructions
--
-- CC RECONSTRUCTION (4):
--   15. reconstruction_documents
--   16. reconstruction_chunks
--   17. reconstruction_runs
--   18. stitch_results
--
-- HCC HIERARCHICAL (4):
--   19. hcc_documents
--   20. hcc_parts
--   21. hcc_chapters
--   22. hcc_chunks
--
-- FULL PIPELINE (3):
--   23. pipeline_jobs
--   24. pipeline_chunks
--   25. pipeline_objections
--
-- COHERENT SESSIONS (2):
--   26. coherent_sessions
--   27. coherent_chunks
--
-- AUDIT SYSTEM (2):
--   28. audit_logs
--   29. audit_log_entries
--
-- TOTAL: 29 TABLES
-- ═══════════════════════════════════════════════════════════════════════════════════
