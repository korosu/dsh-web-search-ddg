/**
 * DuckDuckGo scrape `WebSearchProvider` plugin. It contributes to the `ctx.web`
 * registry without owning the service: the plugin registers its provider and the
 * seam handles selection, so nothing here replaces `WebRuntime` or `tool-web`.
 *
 * No credentials are involved — this provider is inherently keyless, so there is
 * no settings card, no API key field, and no credential-resolution step. The
 * deployment-level knobs (endpoint, result bound, user agent, accept-language,
 * request timeout, failure budget) are schema fields a profile can set from
 * `cordis.yml`, per the no-hardcoded-tunables convention.
 * @module @deepseek-ai/dsh-web-search-ddg
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  DDG_DEFAULT_ENDPOINT,
  DdgSearchProvider,
} from './provider.ts'

export {
  DDG_DEFAULT_ENDPOINT,
  DDG_DEFAULT_TIMEOUT_MS,
  DDG_DEFAULT_USER_AGENT,
  DDG_PROVIDER_ID,
  DdgSearchProvider,
} from './provider.ts'
export type { DdgSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-ddg'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config — all keys optional; `apply` fills the defaults. */
export interface Config {
  /** Results endpoint; `?q=` is appended. Defaults to `html.duckduckgo.com`. */
  endpoint?: string
  /** Provider-side result bound when a request carries no `maxResults`. */
  maxResults?: number
  /** Request user agent; defaults to a verified desktop Chrome UA. */
  userAgent?: string
  /** `accept-language` header value; unset = the header is not sent. */
  acceptLanguage?: string
  /** Per-request deadline in milliseconds; a timeout is a transient failure. */
  timeoutMs?: number
  /** Consecutive transient failures before the provider goes on cooldown. */
  failureThreshold?: number
  /** Cooldown length in milliseconds once the threshold is reached. */
  cooldownMs?: number
}

export const Config: z<Config> = z.object({
  endpoint: z.string(),
  maxResults: z.number().step(1).min(1),
  userAgent: z.string(),
  acceptLanguage: z.string(),
  timeoutMs: z.number().step(1).min(1),
  failureThreshold: z.number().step(1).min(1),
  cooldownMs: z.number().step(1).min(1),
})

/**
 * Register the DuckDuckGo scrape provider with `ctx.web`. The connector is
 * keyless, so the provider is available as long as the endpoint is a usable
 * http(s) URL and any configured bound is a positive whole number; the seam
 * reports `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` otherwise. The request-shaping
 * and failure-budget keys are validated the same way.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new DdgSearchProvider({
    endpoint: config.endpoint ?? DDG_DEFAULT_ENDPOINT,
    ...config.maxResults !== undefined ? { maxResults: config.maxResults } : {},
    ...config.userAgent !== undefined ? { userAgent: config.userAgent } : {},
    ...config.acceptLanguage !== undefined ? { acceptLanguage: config.acceptLanguage } : {},
    ...config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {},
    ...config.failureThreshold !== undefined ? { failureThreshold: config.failureThreshold } : {},
    ...config.cooldownMs !== undefined ? { cooldownMs: config.cooldownMs } : {},
  }))
}