/**
 * Configuration backup and restore, shared by the settings page and its tests.
 *
 * The document mirrors the settings schema, so a backup can also be pasted back
 * into `cordis.patch.yml` by hand. Export and import are the same set of
 * functions on purpose: an export that wrote a shape the import rejects would
 * only be discovered by a user who had already lost their configuration.
 *
 * SECURITY: the password fields are the ONLY values with a redaction switch.
 * Everything else is address-like, and the plan's promise — a password lives
 * only in memory and `cordis.patch.yml` — is preserved because a redacted
 * export is the default the page offers.
 */

// Type-only, so nothing is pulled in at run time. This matters: the browser
// bundle imports this module too, and `config.ts` requires `node:module` to
// resolve schemastery, which esbuild refuses to bundle for the browser.
import type {
  DefaultProxyValue,
  Protocol,
  ProviderProxyRouteValue,
} from './config.js'
import { proxyHostProblem } from './proxy-address.js'

/** Mirrors `PROTOCOLS` in config.ts; kept here so the browser never loads it. */
const PROTOCOLS: readonly Protocol[] = ['http', 'https', 'socks5']

/**
 * Schema defaults for one endpoint.
 *
 * A local copy rather than `normalizeDefaultProxy` for the bundling reason
 * above. The schema and this function are asserted to agree by
 * `tests/backup.test.ts`, so a drift shows up as a failing test instead of a
 * backup that quietly differs from the settings it describes.
 */
function normalizeEndpoint(raw: Partial<DefaultProxyValue> | undefined): DefaultProxyValue {
  const value = raw ?? {}
  return {
    protocol: PROTOCOLS.includes(value.protocol as Protocol) ? (value.protocol as Protocol) : 'http',
    host: typeof value.host === 'string' ? value.host.trim() : '',
    port: typeof value.port === 'number' && Number.isFinite(value.port) ? value.port : 0,
    username: typeof value.username === 'string' ? value.username.trim() : '',
    password: typeof value.password === 'string' ? value.password : '',
  }
}

/** The document shape a backup carries. `version` identifies it. */
export interface BackupDocument {
  version: 1
  exportedAt: string
  providers: Record<string, ProviderProxyRouteValue>
  proxyProfiles: Record<string, DefaultProxyValue>
  defaultProxy: DefaultProxyValue
  localDirect: boolean
  testUrl: string
}

/** What the page holds, as far as export is concerned. */
export interface BackupSource {
  providers?: Readonly<Record<string, Partial<ProviderProxyRouteValue> | undefined>>
  proxyProfiles?: Readonly<Record<string, Partial<DefaultProxyValue> | undefined>>
  defaultProxy?: Partial<DefaultProxyValue>
  localDirect?: boolean
  testUrl?: string
}

/** Mirrors the schema default, so an empty export is still self-explanatory. */
const FALLBACK_TEST_URL = 'https://api.ipify.org?format=json'

/**
 * Schema defaults for one raw route, WITHOUT enforcing endpoint completeness.
 *
 * A backup of a half-configured card must still round-trip: the Host already
 * reports such a route as rejected, and refusing the whole file would strand
 * every other setting in it.
 */
function fillRoute(raw: Partial<ProviderProxyRouteValue> | undefined): ProviderProxyRouteValue {
  const value = raw ?? {}
  return {
    enabled: value.enabled === true,
    profileId: typeof value.profileId === 'string' ? value.profileId.trim() : '',
    useDefault: value.useDefault === true,
    protocol: PROTOCOLS.includes(value.protocol as Protocol)
      ? (value.protocol as Protocol)
      : 'http',
    host: typeof value.host === 'string' ? value.host.trim() : '',
    port: typeof value.port === 'number' && Number.isFinite(value.port) ? value.port : 0,
    username: typeof value.username === 'string' ? value.username.trim() : '',
    password: typeof value.password === 'string' ? value.password : '',
    onlyHosts: typeof value.onlyHosts === 'string' ? value.onlyHosts : '',
    bypassHosts: typeof value.bypassHosts === 'string' ? value.bypassHosts : '',
    testTarget: typeof value.testTarget === 'string' ? value.testTarget : '',
  }
}

/**
 * Build the document to write to disk.
 *
 * Redaction EMPTIES both password fields rather than deleting them: a missing
 * field would be re-defaulted to `''` on import anyway, and keeping the key
 * makes the redaction visible to anyone who opens the file.
 */
export function buildBackup(
  source: BackupSource,
  options: { includePasswords: boolean; now?: Date } = { includePasswords: false },
): BackupDocument {
  const include = options.includePasswords === true
  const hide = (password: string): string => (include ? password : '')

  const providers: Record<string, ProviderProxyRouteValue> = {}
  for (const [id, raw] of Object.entries(source.providers ?? {})) {
    const filled = fillRoute(raw)
    providers[id] = { ...filled, password: hide(filled.password) }
  }

  const proxyProfiles: Record<string, DefaultProxyValue> = {}
  for (const [name, raw] of Object.entries(source.proxyProfiles ?? {})) {
    const filled = normalizeEndpoint(raw)
    proxyProfiles[name] = { ...filled, password: hide(filled.password) }
  }

  const defaultProxy = normalizeEndpoint(source.defaultProxy)
  return {
    version: 1,
    exportedAt: (options.now ?? new Date()).toISOString(),
    providers,
    proxyProfiles,
    defaultProxy: { ...defaultProxy, password: hide(defaultProxy.password) },
    localDirect: source.localDirect !== false,
    testUrl:
      typeof source.testUrl === 'string' && source.testUrl.trim().length > 0
        ? source.testUrl
        : FALLBACK_TEST_URL,
  }
}

/** The file name the page offers, e.g. `dsh-proxy-backup-2026-10-27.json`. */
export function backupFileName(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `dsh-proxy-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`
}

/** A validated restore, ready to be written. */
export type BackupParseResult =
  | { ok: true; document: BackupDocument }
  | { ok: false; error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse and validate a backup file.
 *
 * The point is to refuse BEFORE anything is written: an import that half applied
 * would leave the user with a configuration assembled from two different files.
 * Unknown keys are ignored (a newer export must not break an older page), but a
 * KNOWN key carrying the wrong type is an error — silently coercing it is how a
 * broken restore looks successful.
 */
export function parseBackup(text: string): BackupParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      error: `不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!isPlainObject(parsed)) return { ok: false, error: '备份文件的顶层必须是一个对象' }

  const root = parsed
  if (
    root.providers === undefined &&
    root.defaultProxy === undefined &&
    root.proxyProfiles === undefined
  ) {
    return {
      ok: false,
      error: '备份文件缺少 providers / proxyProfiles / defaultProxy，无法识别为代理配置',
    }
  }

  if (root.providers !== undefined && !isPlainObject(root.providers)) {
    return { ok: false, error: 'providers 必须是一个对象' }
  }
  if (root.proxyProfiles !== undefined && !isPlainObject(root.proxyProfiles)) {
    return { ok: false, error: 'proxyProfiles 必须是一个对象' }
  }
  if (root.defaultProxy !== undefined && !isPlainObject(root.defaultProxy)) {
    return { ok: false, error: 'defaultProxy 必须是一个对象' }
  }
  if (root.localDirect !== undefined && typeof root.localDirect !== 'boolean') {
    return { ok: false, error: 'localDirect 必须是布尔值' }
  }
  if (root.testUrl !== undefined && typeof root.testUrl !== 'string') {
    return { ok: false, error: 'testUrl 必须是字符串' }
  }

  /** Field-type check shared by every endpoint-shaped object. */
  const endpoint = (value: Record<string, unknown>, label: string): string | undefined => {
    if (value.protocol !== undefined && !PROTOCOLS.includes(value.protocol as Protocol)) {
      return `${label}.protocol 必须是 ${PROTOCOLS.join(' / ')}`
    }
    for (const key of ['host', 'username', 'password'] as const) {
      if (value[key] !== undefined && typeof value[key] !== 'string') {
        return `${label}.${key} 必须是字符串`
      }
    }
    if (
      value.port !== undefined &&
      (typeof value.port !== 'number' || !Number.isFinite(value.port))
    ) {
      return `${label}.port 必须是数字`
    }
    return undefined
  }

  const providers: Record<string, ProviderProxyRouteValue> = {}
  for (const [id, value] of Object.entries((root.providers ?? {}) as Record<string, unknown>)) {
    if (!isPlainObject(value)) return { ok: false, error: `providers.${id} 必须是一个对象` }
    const why = endpoint(value, `providers.${id}`)
    if (why !== undefined) return { ok: false, error: why }
    for (const key of ['enabled', 'useDefault'] as const) {
      if (value[key] !== undefined && typeof value[key] !== 'boolean') {
        return { ok: false, error: `providers.${id}.${key} 必须是布尔值` }
      }
    }
    for (const key of ['profileId', 'onlyHosts', 'bypassHosts', 'testTarget'] as const) {
      if (value[key] !== undefined && typeof value[key] !== 'string') {
        return { ok: false, error: `providers.${id}.${key} 必须是字符串` }
      }
    }
    providers[id] = fillRoute(value as Partial<ProviderProxyRouteValue>)
  }

  const proxyProfiles: Record<string, DefaultProxyValue> = {}
  for (const [name, value] of Object.entries(
    (root.proxyProfiles ?? {}) as Record<string, unknown>,
  )) {
    if (!isPlainObject(value)) return { ok: false, error: `proxyProfiles.${name} 必须是一个对象` }
    const why = endpoint(value, `proxyProfiles.${name}`)
    if (why !== undefined) return { ok: false, error: why }
    proxyProfiles[name] = normalizeEndpoint(value as Partial<DefaultProxyValue>)
  }

  if (root.defaultProxy !== undefined) {
    const why = endpoint(root.defaultProxy as Record<string, unknown>, 'defaultProxy')
    if (why !== undefined) return { ok: false, error: why }
  }

  const document: BackupDocument = {
    version: 1,
    exportedAt: typeof root.exportedAt === 'string' ? root.exportedAt : '',
    providers,
    proxyProfiles,
    defaultProxy: normalizeEndpoint((root.defaultProxy ?? {}) as Partial<DefaultProxyValue>),
    localDirect: root.localDirect !== false,
    testUrl:
      typeof root.testUrl === 'string' && root.testUrl.trim().length > 0
        ? root.testUrl
        : FALLBACK_TEST_URL,
  }
  return { ok: true, document }
}

/**
 * The settings writes that apply a document.
 *
 * Dictionaries are written WHOLE rather than per key: a restore must also
 * REMOVE entries the backup does not contain, and one `op: set` per key can only
 * add. Keeping every write in ONE array means a revision mismatch fails the
 * whole restore instead of leaving it half applied.
 */
export function backupOps(document: BackupDocument): unknown[] {
  return [
    { op: 'set', path: ['providers'], value: document.providers },
    { op: 'set', path: ['proxyProfiles'], value: document.proxyProfiles },
    { op: 'set', path: ['defaultProxy'], value: document.defaultProxy },
    { op: 'set', path: ['localDirect'], value: document.localDirect },
    { op: 'set', path: ['testUrl'], value: document.testUrl },
  ]
}

/** Counts for the confirmation dialog, so the user knows what they are replacing. */
export function backupCounts(document: BackupDocument): {
  providers: number
  profiles: number
  enabled: number
} {
  return {
    providers: Object.keys(document.providers).length,
    profiles: Object.keys(document.proxyProfiles).length,
    enabled: Object.values(document.providers).filter(route => route.enabled).length,
  }
}

/**
 * Endpoint validation for routes that are ENABLED and bound to nothing.
 *
 * Only those routes need complete fields of their own; a route bound to a preset
 * or to the default is checked by the Host against that endpoint. Kept separate
 * from `parseBackup` so a file with one broken card still restores the rest —
 * the Host reports that card as rejected, which is where it already belongs.
 */
export function validateEnabledRoutes(
  document: BackupDocument,
): { provider: string; problem: string } | undefined {
  for (const [id, route] of Object.entries(document.providers)) {
    if (!route.enabled) continue
    if (route.profileId.length > 0 || route.useDefault) continue
    // The same two checks `normalizeRoute` applies to an enabled route, in the
    // same order and with the same wording.
    const hostProblem = proxyHostProblem(route.host)
    if (hostProblem !== undefined) {
      return {
        provider: id,
        problem:
          hostProblem === '未填写代理地址'
            ? `provider "${id}" 启用了代理，但未填写代理地址`
            : `provider "${id}" 的${hostProblem}`,
      }
    }
    if (!Number.isInteger(route.port) || route.port < 1 || route.port > 65535) {
      return { provider: id, problem: `provider "${id}" 的代理端口无效（需为 1-65535 的整数）` }
    }
  }
  return undefined
}
