/**
 * Normalize the standby preset list (`backupProfileIds`) in ONE place.
 *
 * Trim, drop blanks, dedupe, and cap at the schema limit. Duplicates are not
 * cosmetic: the Host would build two dispatchers for the same preset and try it
 * twice, while the settings page shows the second copy as skipped. Keeping this
 * module dependency-free lets the Host, the backup parser and the browser page
 * share the exact same rule.
 */
export function uniqueBackupProfileIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (id.length === 0 || out.includes(id)) continue
    out.push(id)
    if (out.length === 3) break
  }
  return out
}
