SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS content_saves (
  content_item_id BIGINT NOT NULL,
  user_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (content_item_id, user_id),
  KEY idx_content_saves_user_created (user_id, created_at),
  CONSTRAINT fk_content_saves_item
    FOREIGN KEY (content_item_id) REFERENCES content_items (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_content_saves_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
