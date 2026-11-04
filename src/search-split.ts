/**
 * Search / reasoning traffic splitting (N24).
 *
 * `ctx.web.search` (the `web_search` tool) reaches the network with a bare
 * global `fetch`, so DSH offers no per-tool transport. The Host wraps the
 * service method — the only seam — and decides there which chain carries the
 * call. This module owns that DECISION, in one place, for three consumers:
 *
 * - the Host, which builds the dispatcher the plan names;
 * - the settings page, which shows what a draft setting would resolve to;
 * - the tests, which pin the matrix without a network or a fiber.
 *
 * It is deliberately free of Node.js imports (no `node:module`, no
 * `schemastery`), because the browser bundle imports it too. `config.ts` takes
 * the schema constants from here rather than the other way round, which is what
 * keeps the two halves reading the same strategy list.
 *
 * Fail-closed note: a strategy that names an endpoint which cannot be used is
 * `blocked`, never a silent direct call. Falling back to `direct` would leak
 * the search's real exit address onto a network the user deliberately routed
 * around, and that is exactly what `'direct'` is for — as an explicit choice.
 */

/** The four supported split strategies, in menu order. */
export const SEARCH_PROXY_STRATEGIES = ['inherit', 'dedicated', 'direct', 'custom'] as const

export type SearchProxyStrategy = (typeof SEARCH_PROXY_STRATEGIES)[number]

/** The strategy a 1.0.0 configuration implicitly had, and therefore the default. */
export const DEFAULT_SEARCH_PROXY_STRATEGY: SearchProxyStrategy = 'inherit'

/** The two config fields that decide search traffic, after normalization. */
export interface SearchSplitConfig {
  /** Which chain carries `web_search` traffic. */
  searchProxyStrategy: SearchProxyStrategy
  /**
   * The named preset bound by `'dedicated'`. Empty means "the web-search card's
   * own endpoint", i.e. the independent custom endpoint.
   */
  searchProxyProfileId: string
}

/**
 * Normalize the two split fields.
 *
 * An unknown strategy is `'inherit'`, never a throw: a value written by a newer
 * version (or hand-edited) must degrade to the behavior this version already
 * had, and keep every other setting in the file working. `profileId` is trimmed
 * but kept even for a strategy that does not use it, so toggling
 * dedicated → inherit → dedicated does not lose the binding.
 */
export function normalizeSearchSplitConfig(
  raw?: {
    searchProxyStrategy?: unknown
    searchProxyProfileId?: unknown
  } | null,
): SearchSplitConfig {
  const candidate = raw?.searchProxyStrategy
  const strategy = SEARCH_PROXY_STRATEGIES.includes(candidate as SearchProxyStrategy)
    ? (candidate as SearchProxyStrategy)
    : DEFAULT_SEARCH_PROXY_STRATEGY
  const profileRaw = raw?.searchProxyProfileId
  return {
    searchProxyStrategy: strategy,
    searchProxyProfileId: typeof profileRaw === 'string' ? profileRaw.trim() : '',
  }
}

/**
 * Where one search request goes.
 *
 * `reason` is carried for diagnostics and for the settings page's explanation;
 * `kind` is the only thing routing reads.
 */
export type SearchPlan =
  /** The reserved `web-search` card carries it (its own endpoint and host rules). */
  | { kind: 'card'; reason: 'inherit' | 'custom' | 'dedicated-card' }
  /** A dispatcher built from the bound preset carries it. */
  | { kind: 'dedicated'; reason: 'dedicated'; profileId: string }
  /** Native `fetch`, no proxy at all. */
  | { kind: 'direct'; reason: 'strategy' | 'bypass-all' | 'no-route' }
  /** Refuse the call: the configured endpoint cannot be used (fail-closed). */
  | { kind: 'blocked'; reason: 'missing-preset' | 'invalid-preset' }

export interface SearchPlanInput {
  strategy: SearchProxyStrategy | string | undefined
  /** Trimmed `searchProxyProfileId`. */
  profileId?: string | undefined
  /** Whether the live proxy table carries a route for the `web-search` card. */
  cardAvailable: boolean
  /** Whether the bound preset exists in `proxyProfiles` at all. */
  presetExists: boolean
  /** Whether the bound preset built into a usable dispatcher. */
  presetReady: boolean
  /** Emergency bypass: everything is direct, so search is too. */
  bypassAll?: boolean
}

/**
 * Resolve the chain for one search call.
 *
 * Order matters:
 * 1. `bypassAll` wins over everything — it is the emergency switch, and a
 *    blocked plan under it would break searches for no benefit.
 * 2. `'direct'` is the user's explicit "no proxy" answer.
 * 3. `'dedicated'` with a preset id needs a usable preset; a missing or broken
 *    one is `blocked` (see the fail-closed note above). With NO preset id it
 *    uses the web-search card's own endpoint, which is the "independent custom
 *    endpoint" the plan describes — and is not an error.
 * 4. `'custom'` hands the web-search card complete control (including its
 *    advanced domain rules).
 * 5. `'inherit'` — and any unknown value — keeps the pre-1.1.0 behaviour: the
 *    card if it is enabled, otherwise direct.
 */
export function resolveSearchPlan(input: SearchPlanInput): SearchPlan {
  const strategy = SEARCH_PROXY_STRATEGIES.includes(input.strategy as SearchProxyStrategy)
    ? (input.strategy as SearchProxyStrategy)
    : DEFAULT_SEARCH_PROXY_STRATEGY
  const profileId = (input.profileId ?? '').trim()

  if (input.bypassAll === true) return { kind: 'direct', reason: 'bypass-all' }
  if (strategy === 'direct') return { kind: 'direct', reason: 'strategy' }

  if (strategy === 'dedicated') {
    if (profileId.length === 0) {
      return input.cardAvailable
        ? { kind: 'card', reason: 'dedicated-card' }
        : { kind: 'direct', reason: 'no-route' }
    }
    if (!input.presetExists) return { kind: 'blocked', reason: 'missing-preset' }
    if (!input.presetReady) return { kind: 'blocked', reason: 'invalid-preset' }
    return { kind: 'dedicated', reason: 'dedicated', profileId }
  }

  if (strategy === 'custom') {
    return input.cardAvailable ? { kind: 'card', reason: 'custom' } : { kind: 'direct', reason: 'no-route' }
  }

  return input.cardAvailable ? { kind: 'card', reason: 'inherit' } : { kind: 'direct', reason: 'no-route' }
}

/**
 * The operator-facing reason a plan cannot be used, or `undefined`.
 *
 * Shared so the Host's diagnostics payload and the settings page's inline
 * warning cannot drift into two different explanations of one state.
 */
export function searchSplitProblem(input: {
  strategy: SearchProxyStrategy | string | undefined
  profileId?: string | undefined
  presetExists: boolean
  presetReady: boolean
}): string | undefined {
  const plan = resolveSearchPlan({
    strategy: input.strategy,
    profileId: input.profileId,
    cardAvailable: true,
    presetExists: input.presetExists,
    presetReady: input.presetReady,
  })
  if (plan.kind !== 'blocked') return undefined
  const name = (input.profileId ?? '').trim()
  return plan.reason === 'missing-preset'
    ? `搜索分流绑定的预设「${name}」不存在，搜索请求已被拒绝（不会改走直连）`
    : `搜索分流绑定的预设「${name}」配置不完整，搜索请求已被拒绝（不会改走直连）`
}
