-- Mobile in-app purchase ledger for Talkflix Pro.
-- Run manually against production/staging after review, or let server startup
-- create the same table through ensureTables().

CREATE TABLE IF NOT EXISTS iap_purchases (
  id BIGINT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  platform VARCHAR(20) NOT NULL,
  product_id VARCHAR(160) NOT NULL,
  transaction_id VARCHAR(255) NOT NULL,
  original_transaction_id VARCHAR(255) NULL,
  purchase_token_hash CHAR(64) NOT NULL,
  purchase_token_tail VARCHAR(16) NULL,
  store_status VARCHAR(80) NULL,
  expires_at TIMESTAMP NULL DEFAULT NULL,
  last_verified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  raw_response_json LONGTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_iap_purchases_platform_transaction (platform, transaction_id),
  UNIQUE KEY uniq_iap_purchases_platform_token (platform, purchase_token_hash),
  KEY idx_iap_purchases_user_expires (user_id, expires_at),
  KEY idx_iap_purchases_product_expires (product_id, expires_at),
  CONSTRAINT fk_iap_purchases_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
