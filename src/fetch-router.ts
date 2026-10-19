/**
 * Provider-scoped fetch routing.
 *
 * DeepSeek Harness 0.2.0-rc.2 offers no supported seam for giving one LLM
 * provider its own transport:
 *
 * - `llm-deepseek` calls the unqualified global `fetch` with no `dispatcher`;
 * - `llm-pi-ai` delegates to the pi-ai SDK, whose HTTP layer DSH cannot
 *   configure (its own source notes a fetch/dispatcher hook does not exist);
 * - `LlmCallControls` carries only reasoningEffort/temperature/maxTokens/stop;
 * - `llm/stream` intercepts already-decoded `StreamChunk`s, i.e. after HTTP;
 * - `ctx.web` serves `web_search`/`web_fetch` only, never provider traffic;
 * - the official `@deepseek-ai/dsh-http-proxy` is a library with a private
 *   installer: one process-wide policy from env vars, no service, no Config.
 *
 * So the request is routed where the only available signal actually is: the
 * `llm/stream` waterfall, whose `options.provider` names the route. An
 * AsyncLocalStorage scope carries the chosen dispatcher over the stream, and a
 * thin `globalThis.fetch` wrapper applies it. Because every provider gets its
 * OWN dispatcher instance, one provider's proxy can never be picked up by
 * another provider's call — including two providers that resolve to the same
 * upstream host.
 *
 * IMPORTANT — one undici realm only. Node's built-in `fetch` uses an internal
 * undici and REJECTS a dispatcher built by the npm `undici` package with
 * `invalid onRequestStart method`, and vice versa. Every dispatcher here is
 * built from the npm `undici` that this module imports, so the wrapper must
 * dispatch through THAT same package's `fetch` rather than re-entering Node's.
 * The proxy therefore receives an absolute-form request line
 * (`GET http://host/path HTTP/1.1`), which is how an HTTP forward proxy is
 * addressed; an `https:` target is tunnelled with CONNECT.
 *
 * In-flight streams keep the dispatcher they started on; a configuration
 * change only affects new requests.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { fetch as undiciFetch } from 'undici'

/** Undici dispatcher, kept structurally typed so this file needs no undici types. */
export interface DispatcherLike {
  close(): Promise<void>
}

export interface RouterStore {
  dispatcher: DispatcherLike
  /** Called once per request that actually leaves through the proxy. */
  onHit?: () => void
  /**
   * Called once the request is ANSWERED — a response arrives, or it fails
   * outright.
   *
   * "Answered" is the point at which `fetch` resolves, i.e. response HEADERS,
   * NOT the end of the body. `ok` therefore means "a response below 500 came
   * back", exactly as the connection self-check reads it; it does NOT mean the
   * whole stream ran to completion. A body cut off mid-transfer still reads ok,
   * and that is deliberate: the body is a lazily-consumed stream a proxy must
   * forward without draining, so its end is not observable here. The card's
   * "last ok" carries that same meaning.
   *
   * `detail` is the response on success, or the raw error on failure — left
   * unclassified so the caller can name the failure with whatever error
   * vocabulary it already has.
   */
  onSettle?: (ok: boolean, detail: unknown) => void
  /**
   * Decide whether one request is proxied or sent directly, given its target
   * host (`undefined` when the input carries no parsable URL). Absent means
   * "always proxy within this scope".
   */
  decide?: (host: string | undefined) => 'proxy' | 'direct'
}

/** Shared across every plugin instance in one process, keyed so copies cooperate. */
const STATE_KEY = Symbol.for('dsh-provider-proxy.fetch-router.v1')

interface RouterState {
  owners: number
  storage: AsyncLocalStorage<RouterStore>
  originalFetch: typeof globalThis.fetch
  routedFetch: typeof globalThis.fetch
  descriptor?: PropertyDescriptor
}

/**
 * The host a fetch input targets, or `undefined` when it carries none.
 *
 * `new URL` THROWS on a relative or malformed input instead of returning
 * `undefined`, so every branch is guarded; an unparsable input falls through to
 * `undefined`, and the scope's `decide` decides what that means (the plugin's
 * route treats it as "keep proxying", i.e. fail-closed).
 */
function requestHost(input: unknown): string | undefined {
  try {
    if (typeof input === 'string') return new URL(input).hostname
    if (input instanceof URL) return input.hostname
    const url = (input as { url?: unknown } | null | undefined)?.url
    if (typeof url === 'string') return new URL(url).hostname
  } catch {
    return undefined
  }
  return undefined
}

function installSharedRouter(): RouterState {
  const current = (globalThis as Record<symbol, RouterState | undefined>)[STATE_KEY]
  if (current !== undefined) {
    current.owners += 1
    return current
  }

  if (typeof globalThis.fetch !== 'function') {
    throw new Error('dsh-provider-proxy: this Node runtime does not expose global fetch')
  }

  const storage = new AsyncLocalStorage<RouterStore>()
  const originalFetch = globalThis.fetch
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')

  const routedFetch = function routedFetch(
    this: unknown,
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): ReturnType<typeof globalThis.fetch> {
    const active = storage.getStore()
    // No scope, or a caller that already picked a dispatcher: stay out of the way.
    if (active === undefined) return originalFetch.call(globalThis, input, init)
    if (init !== undefined && init !== null && (init as { dispatcher?: unknown }).dispatcher !== undefined) {
      return originalFetch.call(globalThis, input, init)
    }
    // A `direct` verdict from the route's target-host rules keeps the native
    // path, exactly as if there were no scope at all.
    if (active.decide !== undefined && active.decide(requestHost(input)) === 'direct') {
      return originalFetch.call(globalThis, input, init)
    }
    // Counted at INITIATION: the request is about to cross the proxy. A stream
    // abandoned later still counts, which is the documented semantics.
    active.onHit?.()
    // Same undici realm as the dispatcher — Node's own fetch would reject it.
    // The init is passed through structurally: the DOM `RequestInit` and the
    // undici one disagree on `body`/`duplex`, so both are erased here.
    const inFlight = undiciFetch(input as never, {
      ...(init as Record<string, unknown> | undefined),
      dispatcher: active.dispatcher as never,
    } as never) as unknown as Promise<{ status: number }>
    if (active.onSettle !== undefined) {
      const settle = active.onSettle
      // Observe the reply without changing the caller's promise: the handlers
      // hang off a DERIVED promise, both arms are handled here so nothing can
      // surface as an unhandled rejection, and the original is returned as-is.
      // This fires when `fetch` resolves — response HEADERS — not when the body
      // ends; see `onSettle`.
      void inFlight
        .then(
          response => settle(response.status < 500, response),
          (error: unknown) => settle(false, error),
        )
        .catch(() => undefined)
    }
    return inFlight as never
  }

  Object.defineProperty(globalThis, 'fetch', {
    ...(descriptor ?? { configurable: true, enumerable: true, writable: true }),
    value: routedFetch,
  })

  const state: RouterState = { owners: 1, storage, originalFetch, routedFetch, descriptor }
  Object.defineProperty(globalThis, STATE_KEY, {
    configurable: true,
    value: state,
  })
  return state
}

/**
 * Re-apply the AsyncLocalStorage scope to every iterator operation.
 *
 * This is essential, not cosmetic: an adapter's stream is consumed lazily, so
 * the HTTP call typically happens inside a later `next()`, long after
 * `als.run(...)` returned. Without wrapping the iterator, every request would
 * silently fall back to the default dispatcher.
 */
function contextualIterable(
  storage: AsyncLocalStorage<RouterStore>,
  store: RouterStore,
  factory: () => AsyncIterable<unknown>,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let iterator: AsyncIterator<unknown> | undefined

      const ensureIterator = (): AsyncIterator<unknown> => {
        if (iterator !== undefined) return iterator
        const iterable = factory()
        if (iterable === null || typeof iterable?.[Symbol.asyncIterator] !== 'function') {
          throw new TypeError('dsh-provider-proxy: llm/stream next() did not return an AsyncIterable')
        }
        iterator = iterable[Symbol.asyncIterator]()
        return iterator
      }

      const invoke = (method: 'next' | 'return' | 'throw', value?: unknown): Promise<IteratorResult<unknown>> =>
        storage.run(store, () => {
          // A stream abandoned before its first next() must not touch the adapter.
          if (method === 'return' && iterator === undefined) return Promise.resolve({ done: true, value })
          if (method === 'throw' && iterator === undefined) return Promise.reject(value)
          const target = ensureIterator()
          const operation = target[method]
          if (typeof operation !== 'function') {
            if (method === 'return') return Promise.resolve({ done: true, value })
            return Promise.reject(value)
          }
          return Promise.resolve(Reflect.apply(operation, target, method === 'next' ? [] : [value]))
        })

      return {
        next: (value?: unknown) => invoke('next', value),
        return: (value?: unknown) => invoke('return', value),
        throw: (value?: unknown) => invoke('throw', value),
        [Symbol.asyncIterator]() {
          return this
        },
      }
    },
  }
}

export interface FetchRouter {
  /** Run one synchronous callback inside the scope. */
  run(store: RouterStore, callback: () => unknown): unknown
  /** Wrap a lazy stream so every consumption step keeps the scope. */
  wrap(store: RouterStore, factory: () => AsyncIterable<unknown>): AsyncIterable<unknown>
  /** Release this holder; the shim is removed once the last holder releases. */
  release(): void
}

/** Install (or share) the single process-wide fetch shim. */
export function acquireFetchRouter(): FetchRouter {
  const state = installSharedRouter()
  let released = false

  return {
    run(store, callback) {
      return state.storage.run(store, callback)
    },
    wrap(store, factory) {
      return contextualIterable(state.storage, store, factory)
    },
    release() {
      if (released) return
      released = true
      state.owners -= 1
      if (state.owners !== 0) return

      if (globalThis.fetch === state.routedFetch) {
        if (state.descriptor === undefined) delete (globalThis as { fetch?: unknown }).fetch
        else Object.defineProperty(globalThis, 'fetch', state.descriptor)
      }
      delete (globalThis as Record<symbol, unknown>)[STATE_KEY]
      state.storage.disable()
    },
  }
}