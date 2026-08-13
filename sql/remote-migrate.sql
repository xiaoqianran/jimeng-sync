-- 远程 MySQL 结构。服务端 MODE=remote 启动时也会自动补列。
-- 可在已有 jimeng 库上手动执行。

CREATE TABLE IF NOT EXISTS jimeng_prompts (
  work_id VARCHAR(64) NOT NULL PRIMARY KEY,
  prompt MEDIUMTEXT NOT NULL,
  author VARCHAR(255) NULL,
  model VARCHAR(255) NULL,
  create_time VARCHAR(64) NULL,
  collected_at DATETIME NULL,
  collected_at_ms BIGINT NULL,
  image_url TEXT NULL,
  image_high TEXT NULL,
  aspect_ratio VARCHAR(32) NULL,
  raw_json JSON NULL,
  favorite TINYINT NOT NULL DEFAULT 0,
  tags JSON NULL,
  notes TEXT NULL,
  deleted_at BIGINT NULL,
  updated_at_ms BIGINT NOT NULL DEFAULT 0,
  device_id VARCHAR(64) NULL,
  content_hash VARCHAR(64) NULL,
  remote_rev BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_remote_rev (remote_rev)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS jimeng_sync_rev (
  k VARCHAR(16) NOT NULL PRIMARY KEY,
  v BIGINT NOT NULL
) CHARACTER SET utf8mb4;

INSERT IGNORE INTO jimeng_sync_rev (k, v) VALUES ('rev', 0);
