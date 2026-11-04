/** Check supplied password representations without echoing credentials in test failures. */
export function assertNoPgPassword(output: string, adminUrl: string): void {
  const encoded = new URL(adminUrl).password;
  if (!encoded) return;
  const forms = new Set([encoded]);
  try { forms.add(decodeURIComponent(encoded)); } catch { /* An invalid escape still has its literal form checked. */ }
  if ([...forms].some(value => value && output.includes(value))) {
    throw new Error("PG output contains a configured password (redacted)");
  }
}
