\set ON_ERROR_STOP on
\getenv bootstrap_password AERALYTH_BOOTSTRAP_ADMIN_PASSWORD

-- Only replaces the development seed credential, so a later deploy that still
-- carries the variable never overwrites a password the administrator chose.
UPDATE users
SET password_hash = crypt(:'bootstrap_password', gen_salt('bf')),
    updated_at = now()
WHERE id = 'usr_admingod'
  AND password_hash = crypt('admingod', password_hash);
