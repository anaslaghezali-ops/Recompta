-- Restrict excessive default table privileges for objects created by postgres in public.
-- Preserve CRUD and sequence/function defaults; this change targets only table privileges.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
ON TABLES
FROM anon, authenticated;
