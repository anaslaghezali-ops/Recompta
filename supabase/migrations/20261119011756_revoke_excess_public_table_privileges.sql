-- Harden exposed public tables without changing application CRUD/RLS behavior.
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
ON TABLE
  public.user_roles,
  public.cabinet_members,
  public.cabinet_vision_credits,
  public.platform_settings,
  public.invoices,
  public.invoice_lines,
  public.invoice_payments
FROM anon, authenticated;
