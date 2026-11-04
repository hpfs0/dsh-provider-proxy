/**
 * Mount the Host half into a REAL cordis runtime.
 *
 * Why this file exists: the unit tests mock `ctx`, and a mock cannot reproduce
 * the failure that killed the desktop app — cordis answers an un-injected
 * service read by THROWING from the context proxy
 * (`cannot get property "timer" without inject`, reflect.ts), and the Loader
 * turns that throw into `fatal load failure` + Host exit 1. Reading
 * `ctx.setInterval` for the heartbeat timer did exactly that, so enabling the
 * switch crashed DSH (crash-2026-11-03T09-13-15-493Z-host.log).
 *
 * A real `new Context()` makes that guard live: if the plugin ever goes back to
 * reading `ctx.setInterval`/`ctx.clearInterval`/`ctx.timer`, this test fails
 * instead of the user's app.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { Context, Service } from '@deepseek-ai/cordis'

import { apply } from '../lib/index.js'

class Llm extends Service {
  constructor(ctx: any) {
    super(ctx, 'llm')
  }

  listProviders() {
    return [{ id: 'p1', name: 'Provider 1' }]
  }

  listConfigurableProviders() {
    return []
  }
}

/**
 * Stand-in for the Host's timer plugin.
 *
 * The Host exposes `ctx.setInterval`/`ctx.clearInterval` as MIXINS over a
 * `timer` service (`ctx.mixin('timer', [...])`, reflect.ts:364-388). Their
 * getter reads `ctx['timer']`, so a fiber that does not inject `timer` throws
 * `cannot get property "timer" without inject` — the exact stack frame
 * (`at getTarget ... at Object.get`) recorded in the crash log.
 */
class Timer extends Service {
  constructor(ctx: any) {
    super(ctx, 'timer')
  }

  setInterval(fn: Function, ms: number) {
    return globalThis.setInterval(fn as any, ms)
  }

  clearInterval(timer: any) {
    globalThis.clearInterval(timer)
  }
}

/**
 * Mount a fresh cordis app with the plugin, heartbeat ENABLED.
 *
 * `heartbeatEnabled: true` is the persisted state that used to crash on boot,
 * because `apply` calls `startHeartbeat` synchronously — before any settings
 * write could arrive.
 */
async function mountWithHeartbeat(): Promise<{ root: any; ctx: any; fiber: any }> {
  const root: any = new Context()
  await root.plugin(Llm)
  await root.plugin(Timer)
  root.mixin('timer', ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'])

  let pluginCtx: any
  const fiber = root.plugin({
    apply: (ctx: any) => {
      pluginCtx = ctx
      apply(ctx, {
        heartbeatEnabled: { get: () => true },
        heartbeatInterval: { get: () => 60 },
        heartbeatConsecutiveFails: { get: () => 2 },
        providers: {
          get: () => ({ p1: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 7890 } }),
        },
      } as any)
    },
    // Identical to the shipped `inject`: only `llm`, never `timer`.
    inject: ['llm'],
  })
  await fiber
  // The fiber activates asynchronously, so read the captured ctx only now.
  return { root, ctx: pluginCtx, fiber }
}

test('N23: Host half mounts in a real cordis runtime with heartbeat enabled (no un-injected timer read)', async () => {
  const { root, ctx, fiber } = await mountWithHeartbeat()

  assert.ok(ctx, 'apply ran')
  // `timer` is NOT in the plugin's inject list, so the mixin guard is live in
  // this composition. The mount above surviving proves the plugin no longer
  // reads ctx timer members.
  assert.throws(
    () => (ctx as any).setInterval,
    /cannot get property "timer" without inject/,
    'composition has no timer service, so ctx.setInterval must throw — proving the mount above survived without it',
  )
  assert.deepEqual(ctx.providerProxyState.heartbeat, {}, 'heartbeat state starts empty and the mount did not throw')

  await fiber.dispose()
  await root.fiber.dispose()
})

test('N23: Disposing a mounted heartbeat fiber settles without throwing', async () => {
  const { root, ctx, fiber } = await mountWithHeartbeat()

  assert.equal(ctx.providerProxyState.routes.length, 1, 'route table built before dispose')

  await fiber.dispose()
  await root.fiber.dispose()
})