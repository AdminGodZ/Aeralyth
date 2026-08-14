BEGIN;

INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at)
VALUES (
  'ses_auth_principal_benchmark',
  'usr_admingod',
  '\xdf464c2995ef29c10a3b69bfaf1ff6081f4dc55511c2d0af0e373b196fac8b7e'::bytea,
  'auth-principal-benchmark-csrf',
  now() + interval '1 hour'
);

CREATE TEMP TABLE auth_principal_timings (
  query_kind TEXT NOT NULL,
  elapsed_microseconds DOUBLE PRECISION NOT NULL
) ON COMMIT DROP;

DO $benchmark$
DECLARE
  iteration INTEGER;
  started_at TIMESTAMPTZ;
BEGIN
  FOR iteration IN 1..500 LOOP
    PERFORM sessions.id, sessions.csrf_token, users.id, users.role, users.status
    FROM sessions
    INNER JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = '\xdf464c2995ef29c10a3b69bfaf1ff6081f4dc55511c2d0af0e373b196fac8b7e'::bytea
      AND sessions.expires_at > now()
      AND users.status = 'active'
    LIMIT 1;

    PERFORM
      sessions.id,
      sessions.csrf_token,
      users.id,
      users.username,
      users.role,
      users.status,
      users.display_name,
      COALESCE(users.theme_preference, 'system'),
      COALESCE(users.accent_color, '#3088f0'),
      COALESCE(users.folder_zip_prompt_enabled, TRUE),
      COALESCE(users.vault_auto_lock_minutes, 15),
      users.profile_image_bytes IS NOT NULL,
      to_char(
        COALESCE(users.profile_image_updated_at, users.updated_at) AT TIME ZONE 'UTC',
        'YYYYMMDDHH24MISSMS'
      ),
      EXISTS (SELECT 1 FROM user_vaults WHERE user_id = users.id)
    FROM sessions
    INNER JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = '\xdf464c2995ef29c10a3b69bfaf1ff6081f4dc55511c2d0af0e373b196fac8b7e'::bytea
      AND sessions.expires_at > now()
      AND users.status = 'active'
    LIMIT 1;
  END LOOP;

  FOR iteration IN 1..10000 LOOP
    IF iteration % 2 = 0 THEN
      started_at := clock_timestamp();
      PERFORM
        sessions.id,
        sessions.csrf_token,
        users.id,
        users.username,
        users.role,
        users.status,
        users.display_name,
        COALESCE(users.theme_preference, 'system'),
        COALESCE(users.accent_color, '#3088f0'),
        COALESCE(users.folder_zip_prompt_enabled, TRUE),
        COALESCE(users.vault_auto_lock_minutes, 15),
        users.profile_image_bytes IS NOT NULL,
        to_char(
          COALESCE(users.profile_image_updated_at, users.updated_at) AT TIME ZONE 'UTC',
          'YYYYMMDDHH24MISSMS'
        ),
        EXISTS (SELECT 1 FROM user_vaults WHERE user_id = users.id)
      FROM sessions
      INNER JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = '\xdf464c2995ef29c10a3b69bfaf1ff6081f4dc55511c2d0af0e373b196fac8b7e'::bytea
        AND sessions.expires_at > now()
        AND users.status = 'active'
      LIMIT 1;
      INSERT INTO auth_principal_timings
      VALUES (
        'full_profile',
        extract(epoch FROM clock_timestamp() - started_at) * 1000000
      );
    END IF;

    started_at := clock_timestamp();
    PERFORM sessions.id, sessions.csrf_token, users.id, users.role, users.status
    FROM sessions
    INNER JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = '\xdf464c2995ef29c10a3b69bfaf1ff6081f4dc55511c2d0af0e373b196fac8b7e'::bytea
      AND sessions.expires_at > now()
      AND users.status = 'active'
    LIMIT 1;
    INSERT INTO auth_principal_timings
    VALUES (
      'session_principal',
      extract(epoch FROM clock_timestamp() - started_at) * 1000000
    );

    IF iteration % 2 = 1 THEN
      started_at := clock_timestamp();
      PERFORM
        sessions.id,
        sessions.csrf_token,
        users.id,
        users.username,
        users.role,
        users.status,
        users.display_name,
        COALESCE(users.theme_preference, 'system'),
        COALESCE(users.accent_color, '#3088f0'),
        COALESCE(users.folder_zip_prompt_enabled, TRUE),
        COALESCE(users.vault_auto_lock_minutes, 15),
        users.profile_image_bytes IS NOT NULL,
        to_char(
          COALESCE(users.profile_image_updated_at, users.updated_at) AT TIME ZONE 'UTC',
          'YYYYMMDDHH24MISSMS'
        ),
        EXISTS (SELECT 1 FROM user_vaults WHERE user_id = users.id)
      FROM sessions
      INNER JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = '\xdf464c2995ef29c10a3b69bfaf1ff6081f4dc55511c2d0af0e373b196fac8b7e'::bytea
        AND sessions.expires_at > now()
        AND users.status = 'active'
      LIMIT 1;
      INSERT INTO auth_principal_timings
      VALUES (
        'full_profile',
        extract(epoch FROM clock_timestamp() - started_at) * 1000000
      );
    END IF;
  END LOOP;
END
$benchmark$;

WITH sample AS (
  SELECT
    sessions.id AS session_id,
    sessions.csrf_token,
    users.id,
    users.username,
    users.role,
    users.status,
    users.display_name,
    users.theme_preference,
    users.accent_color,
    users.folder_zip_prompt_enabled,
    users.vault_auto_lock_minutes,
    users.profile_image_bytes IS NOT NULL AS has_profile_image,
    to_char(
      COALESCE(users.profile_image_updated_at, users.updated_at) AT TIME ZONE 'UTC',
      'YYYYMMDDHH24MISSMS'
    ) AS profile_image_version,
    EXISTS (SELECT 1 FROM user_vaults WHERE user_id = users.id) AS vault_configured
  FROM sessions
  INNER JOIN users ON users.id = sessions.user_id
  WHERE sessions.id = 'ses_auth_principal_benchmark'
)
SELECT
  pg_column_size(ROW(session_id, csrf_token, id, role, status)) AS principal_row_bytes,
  pg_column_size(ROW(
    session_id,
    csrf_token,
    id,
    username,
    role,
    status,
    display_name,
    theme_preference,
    accent_color,
    folder_zip_prompt_enabled,
    vault_auto_lock_minutes,
    has_profile_image,
    profile_image_version,
    vault_configured
  )) AS full_profile_row_bytes
FROM sample;

SELECT
  query_kind,
  count(*) AS samples,
  round(avg(elapsed_microseconds)::numeric, 3) AS mean_microseconds,
  round(
    percentile_cont(0.95) WITHIN GROUP (ORDER BY elapsed_microseconds)::numeric,
    3
  ) AS p95_microseconds
FROM auth_principal_timings
GROUP BY query_kind
ORDER BY query_kind;

ROLLBACK;
