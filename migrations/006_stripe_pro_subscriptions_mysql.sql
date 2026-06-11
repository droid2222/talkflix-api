CREATE TABLE IF NOT EXISTS stripe_pro_subscriptions (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  plan_id VARCHAR(160) NOT NULL,
  stripe_customer_id VARCHAR(255) NULL,
  stripe_subscription_id VARCHAR(255) NULL,
  stripe_session_id VARCHAR(255) NULL,
  status VARCHAR(80) NOT NULL DEFAULT 'active',
  current_period_end TIMESTAMP NULL DEFAULT NULL,
  last_event_json LONGTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_stripe_pro_subscription (stripe_subscription_id),
  UNIQUE KEY uniq_stripe_pro_session (stripe_session_id),
  KEY idx_stripe_pro_user_period (user_id, current_period_end),
  KEY idx_stripe_pro_plan_period (plan_id, current_period_end),
  CONSTRAINT fk_stripe_pro_subscriptions_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
