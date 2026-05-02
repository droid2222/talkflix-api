-- TalkFlix API repo: creator-only video catalog + transcripts + translated subtitles (MySQL 8+)
-- Run manually against production/staging after review. FKs assume `users(id)`.

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- 1) Creator capability (recommended: column on users you already have)
-- ---------------------------------------------------------------------------
-- Run once if you do not already track this:
-- ALTER TABLE users
--   ADD COLUMN can_publish_video TINYINT(1) NOT NULL DEFAULT 0
--     COMMENT '1 = creator: may create video content items'
--   AFTER role;
-- CREATE INDEX idx_users_can_publish_video ON users (can_publish_video);

-- Optional audit of who toggled creator (if you prefer not to touch users yet):
-- user_id types match existing FKs (follows, direct_messages → users.id as INT)
CREATE TABLE IF NOT EXISTS creator_entitlements (
  user_id INT NOT NULL,
  granted_by_user_id INT NULL,
  granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMP NULL DEFAULT NULL,
  note VARCHAR(255) NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_creator_entitlements_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2) Generic content row (text / audio / image / video)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_items (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  kind ENUM('text','audio','image','video') NOT NULL,
  status ENUM('draft','processing','ready','failed','published') NOT NULL DEFAULT 'draft',
  title VARCHAR(512) NOT NULL,
  slug VARCHAR(192) NULL,
  summary TEXT NULL,
  body MEDIUMTEXT NULL COMMENT 'text posts; optional long description for video',
  visibility ENUM('public','unlisted') NOT NULL DEFAULT 'public',
  source_locale VARCHAR(16) NOT NULL DEFAULT 'und' COMMENT 'BCP-47, e.g. en-US',
  translation_targets_json JSON NULL COMMENT '["es","fr"] requested at publish time',
  published_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_content_items_user_created (user_id, created_at),
  KEY idx_content_items_kind_status_published (kind, status, published_at),
  UNIQUE KEY uq_content_items_slug (slug),
  CONSTRAINT fk_content_items_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3) Binary assets (original upload, poster, HLS master, VTT blobs, etc.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_assets (
  id BIGINT NOT NULL AUTO_INCREMENT,
  content_item_id BIGINT NOT NULL,
  role ENUM(
    'video_original',
    'video_poster',
    'video_hls_master',
    'video_hls_segment',
    'audio_track',
    'image',
    'subtitle_vtt'
  ) NOT NULL,
  locale VARCHAR(16) NULL COMMENT 'for subtitle_vtt: es, fr, ...',
  storage_provider ENUM('s3','r2','local') NOT NULL DEFAULT 's3',
  storage_key VARCHAR(1024) NOT NULL,
  public_url VARCHAR(2048) NULL COMMENT 'CDN URL when immutable',
  mime_type VARCHAR(128) NOT NULL,
  byte_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
  duration_ms INT UNSIGNED NULL,
  width SMALLINT UNSIGNED NULL,
  height SMALLINT UNSIGNED NULL,
  checksum_sha256 CHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_content_assets_item (content_item_id),
  KEY idx_content_assets_item_role_locale (content_item_id, role, locale),
  CONSTRAINT fk_content_assets_item
    FOREIGN KEY (content_item_id) REFERENCES content_items (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4) Timed transcript / captions (one row per segment per locale)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_transcript_segments (
  id BIGINT NOT NULL AUTO_INCREMENT,
  content_item_id BIGINT NOT NULL,
  locale VARCHAR(16) NOT NULL COMMENT 'source transcript locale or translation locale',
  segment_index INT UNSIGNED NOT NULL,
  start_ms INT UNSIGNED NOT NULL,
  end_ms INT UNSIGNED NOT NULL,
  text MEDIUMTEXT NOT NULL,
  provenance ENUM('asr','mt','human') NOT NULL DEFAULT 'asr',
  quality ENUM('auto','reviewed') NOT NULL DEFAULT 'auto',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_segment (content_item_id, locale, segment_index),
  KEY idx_transcript_item_locale (content_item_id, locale),
  CONSTRAINT fk_transcript_item
    FOREIGN KEY (content_item_id) REFERENCES content_items (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 5) Async pipeline jobs (idempotent workers)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_pipeline_jobs (
  id BIGINT NOT NULL AUTO_INCREMENT,
  content_item_id BIGINT NOT NULL,
  job_type ENUM('transcode','asr','translate','build_webvtt','publish') NOT NULL,
  target_locale VARCHAR(16) NULL COMMENT 'for translate / build_webvtt',
  state ENUM('queued','running','succeeded','failed','dead') NOT NULL DEFAULT 'queued',
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  idempotency_key VARCHAR(128) NOT NULL,
  last_error VARCHAR(2048) NULL,
  scheduled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL DEFAULT NULL,
  finished_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pipeline_idempotency (idempotency_key),
  KEY idx_pipeline_item_state (content_item_id, state),
  CONSTRAINT fk_pipeline_item
    FOREIGN KEY (content_item_id) REFERENCES content_items (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
