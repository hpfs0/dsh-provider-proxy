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
    ? `已代理 ${proxiedCount} / 活跃共 ${activeCount}`
    : `Proxied ${proxiedCount} / ${activeCount} Active`

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
