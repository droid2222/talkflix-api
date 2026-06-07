CREATE TABLE IF NOT EXISTS user_daily_usage (
  user_id INT NOT NULL,
  usage_key VARCHAR(80) NOT NULL,
  usage_date DATE NOT NULL,
  used_amount INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, usage_key, usage_date),
  KEY idx_user_daily_usage_date_key (usage_date, usage_key),
  CONSTRAINT fk_user_daily_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Defaults are also defined in entitlements.js.
-- Admins can override them through app_settings using keys:
-- free_usage_limit.content_watch_seconds_daily
-- free_usage_limit.live_audience_seconds_daily
-- free_usage_limit.live_host_seconds_daily
-- free_usage_limit.live_stage_seconds_daily
-- free_usage_limit.direct_call_seconds_daily
-- free_usage_limit.chat_ai_actions_daily
