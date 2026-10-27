/**
 * One-click endpoints for proxy clients people actually run locally.
 *
 * The values are the SHIPPED defaults of each client, not guesses: Clash and
 * Mihomo default to 7890, Clash Verge / Meta to 7897, and V2Ray / Xray exports
 * 10809 for HTTP and 10808 for SOCKS5. A user who changed the port obviously
 * still edits the field afterwards — the button only saves the typing, it does
 * not pretend to know the configuration.
 *
 * This module has no Node or React imports so the settings page can use the
 * exact list its tests assert on.
 */

import type { Protocol } from './config.js'

export interface ProxyClientPreset {
  /** Stable id, also used as the `<option>` value. */
  id: string
  /** Shown in the picker. */
  label: string
  protocol: Protocol
  host: string
  port: number
}

export const PROXY_CLIENT_PRESETS: readonly ProxyClientPreset[] = [
  { id: 'clash', label: 'Clash / Mihomo (127.0.0.1:7890)', protocol: 'http', host: '127.0.0.1', port: 7890 },
  { id: 'clash-verge', label: 'Clash Verge / Meta (127.0.0.1:7897)', protocol: 'http', host: '127.0.0.1', port: 7897 },
  { id: 'v2ray-http', label: 'V2Ray / Xray HTTP (127.0.0.1:10809)', protocol: 'http', host: '127.0.0.1', port: 10809 },
  { id: 'v2ray-socks', label: 'V2Ray / Xray SOCKS5 (127.0.0.1:10808)', protocol: 'socks5', host: '127.0.0.1', port: 10808 },
] as const

/** One preset by id, or `undefined` for an id this build does not offer. */
export function proxyClientPreset(id: string): ProxyClientPreset | undefined {
  return PROXY_CLIENT_PRESETS.find(preset => preset.id === id)
}
