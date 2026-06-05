-- Direct call receiving should be enabled by default for new users.
-- Existing 0 values are preserved because they may be explicit user opt-outs.

ALTER TABLE users
  MODIFY COLUMN receive_voice_calls TINYINT(1) NOT NULL DEFAULT 1,
  MODIFY COLUMN receive_video_calls TINYINT(1) NOT NULL DEFAULT 1;
