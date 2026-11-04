/**
 * Pure calculation functions for the Dashboard header metrics (N19).
 */

export interface LastUseLike {
  startedAt?: number
  at?: number
  ok?: boolean
  code?: string
  fallback?: boolean
}

export interface TestResultLike {
  ms?: number
  ok?: boolean
}

export interface ProviderRowLike {
  id: string
  name?: string
  live?: boolean
}

export interface HeartbeatStateLike {
  status: 'healthy' | 'unreachable'
  lastCheckAt?: number
  lastSuccessAt?: number
  latencyMs?: number | null
  error?: string
  fails?: number
}
export interface ConfiguredRouteLike {
  enabled?: boolean
}

/** Format an integer with thousands commas, e.g. 100,000. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  return Math.floor(n).toLocaleString('en-US')
}

/**
 * Calculate proxy coverage.
 * `active` is the count of live providers (or all providers if none marked live).
 * `proxied` is the count of configured enabled providers without rejecting problems.
 */
export function calculateCoverage(
  rows: readonly ProviderRowLike[],
  configured: Record<string, ConfiguredRouteLike | undefined>,
  problems: Record<string, string | undefined> = {},
  isZh = true,
): { proxied: number; active: number; formatted: string } {
  const activeCount = rows.filter(r => r.live === true).length || rows.length
  let proxiedCount = 0

  for (const row of rows) {
    const config = configured[row.id]
    const hasProblem = Boolean(problems[row.id])
    if (config?.enabled === true && !hasProblem) {
      proxiedCount += 1
    }
  }

  const formatted = isZh
    ? `${proxiedCount} / ${activeCount} 活跃`
    : `${proxiedCount} / ${activeCount} Active`

  return {
    proxied: proxiedCount,
    active: activeCount,
    formatted,
  }
}

/**
 * Calculate connection success rate based on finished requests in lastUse.
 * If no requests have completed yet, returns 100% idle success rate.
 */
export function calculateSuccessRate(
  lastUse: Record<string, LastUseLike | undefined>,
  isZh = true,
): { rate: number; formatted: string } {
  let total = 0
  let successes = 0

  for (const entry of Object.values(lastUse)) {
    if (!entry) continue
    if (typeof entry.ok === 'boolean') {
      total += 1
      if (entry.ok) successes += 1
    }
  }

  if (total === 0) {
    return {
      rate: 100,
      formatted: isZh ? '100% 成功' : '100% Success',
    }
  }

  const rate = Math.round((successes / total) * 1000) / 10
  const rateStr = Number.isInteger(rate) ? String(rate) : rate.toFixed(1)
  return {
    rate,
    formatted: isZh ? `${rateStr}% 成功` : `${rateStr}% Success`,
  }
}

/**
 * Calculate recent average latency across all tested providers.
 */
export function calculateAverageLatency(
  testResults: Record<string, TestResultLike | undefined>,
): { averageMs: number | null; formatted: string } {
  let count = 0
  let totalMs = 0

  for (const result of Object.values(testResults)) {
    if (result && typeof result.ms === 'number' && Number.isFinite(result.ms) && result.ms > 0) {
      count += 1
      totalMs += result.ms
    }
  }

  if (count === 0) {
    return {
      averageMs: null,
      formatted: '- ms',
    }
  }

  const averageMs = Math.round(totalMs / count)
  return {
    averageMs,
    formatted: `${averageMs} ms`,
  }
}

/**
 * Calculate total routed hits across all providers.
 */
export function calculateTotalHits(
  hits: Record<string, number | undefined>,
): { total: number; formatted: string } {
  let total = 0
  for (const count of Object.values(hits)) {
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
      total += count
    }
  }
  return {
    total,
    formatted: formatNumber(total),
  }
}

/**
 * Count how many enabled providers are currently marked unreachable by heartbeat monitoring.
 * Returns the count and the unique list of unreachable provider IDs.
 */
export function countUnreachableProviders(
  rows: readonly ProviderRowLike[],
  configured: Record<string, ConfiguredRouteLike | undefined>,
  heartbeat: Record<string, HeartbeatStateLike | undefined> = {},
): { count: number; unreachableIds: string[] } {
  const seen = new Set<string>()
  const unreachableIds: string[] = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const config = configured[row.id]
    if (config?.enabled === true && heartbeat[row.id]?.status === 'unreachable') {
      unreachableIds.push(row.id)
    }
  }
  return {
    count: unreachableIds.length,
    unreachableIds,
  }
}

/** The search half of the split, as the Host publishes it (N24). */
export interface SearchTrafficLike {
  hits?: number
  proxied?: number
  direct?: number
  failed?: number
}

/**
 * Classify forwarded requests as reasoning vs search (N24).
 *
 * The metric it feeds is "requests that crossed a proxy", so the two halves must
 * ADD UP to that total: a search call that went direct is reported separately as
 * `directSearch` instead of being folded into a proxied count it never earned.
 *
 * `proxiedSearch` comes from the reserved route's hit counter rather than from
 * the search payload, because that counter is the same one every other metric
 * already reads; the payload's `direct`/`failed` counts are additive detail.
 */
export function calculateTrafficSplit(
  hits: Record<string, number | undefined>,
  search: SearchTrafficLike | undefined,
  isZh = true,
  searchRowId = 'web-search',
): { total: number; reasoning: number; search: number; directSearch: number; formatted: string } {
  const total = calculateTotalHits(hits).total
  const raw = hits[searchRowId]
  const searchProxied =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
  const reasoning = Math.max(0, total - searchProxied)
  const rawDirect = search?.direct
  const directSearch =
    typeof rawDirect === 'number' && Number.isFinite(rawDirect) && rawDirect > 0
      ? Math.floor(rawDirect)
      : 0

  const reasoningText = formatNumber(reasoning)
  const searchText = formatNumber(searchProxied)
  const directText = isZh ? `（直连 ${formatNumber(directSearch)}）` : ` (direct ${formatNumber(directSearch)})`
  const formatted = isZh
    ? `推理 ${reasoningText} · 搜索 ${searchText}${directSearch > 0 ? directText : ''}`
    : `Reasoning ${reasoningText} · Search ${searchText}${directSearch > 0 ? directText : ''}`

  return { total, reasoning, search: searchProxied, directSearch, formatted }
}
