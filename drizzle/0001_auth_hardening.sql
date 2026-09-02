BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

UPDATE users
SET must_change_password = TRUE,
    updated_at = NOW()
WHERE password = '$2b$10$VhhtVy2fQx/yQxMrs3Ym7ey6aJDuL8ifRpokKCJIahASQKUhv6xAO'
   OR password !~ '^\$2[aby]\$[0-9]{2}\$';

COMMIT;
