-- ============================================================
--  REMOVE SEEDED SUPER ADMIN
--  Location: migrations/sql/20260919-remove-seeded-super-admin.sql
--
--  Purpose:
--   Deletes the auto-seeded super admin row that was created by
--   20260918-super-admin-seed.sql, so that the operator can
--   register the first super admin manually at /admin.html.
--
--  Safety:
--   - Only deletes the exact seeded account, identified by the
--     combination of email and role. If the operator already
--     changed the email or created a real super admin, this
--     migration does nothing.
--   - Idempotent: running it a second time is a no-op because
--     the row is already gone.
--   - Never deletes any other super_admin that might exist.
-- ============================================================

DO $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM admin_users
    WHERE role = 'super_admin'
      AND email = 'admin@bidhaalink.com'
      AND username = 'superadmin';

    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    IF deleted_count > 0 THEN
        RAISE NOTICE 'Removed seeded super admin (% row(s)). You can now register at /admin.html.', deleted_count;
    ELSE
        RAISE NOTICE 'Seeded super admin not found. Nothing to remove.';
    END IF;
END $$;

-- Verify.
DO $$
DECLARE
    super_admin_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO super_admin_count
    FROM admin_users
    WHERE role = 'super_admin';

    RAISE NOTICE 'super_admin accounts remaining: %', super_admin_count;

    IF super_admin_count = 0 THEN
        RAISE NOTICE 'No super admin exists. Open /admin.html to register one.';
    ELSE
        RAISE NOTICE 'A super admin still exists. If it is not the seeded one, it will not be deleted.';
    END IF;
END $$;