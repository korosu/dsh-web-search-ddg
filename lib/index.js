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
import z from '@deepseek-ai/schemastery';
import { DDG_DEFAULT_ENDPOINT, DdgSearchProvider, } from "./provider.js";
export { DDG_DEFAULT_ENDPOINT, DDG_DEFAULT_TIMEOUT_MS, DDG_DEFAULT_USER_AGENT, DDG_PROVIDER_ID, DdgSearchProvider, } from "./provider.js";
/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-ddg';
/** The web seam this provider registers into. */
export const inject = ['web'];
export const Config = z.object({
    endpoint: z.string(),
    maxResults: z.number().step(1).min(1),
    userAgent: z.string(),
    acceptLanguage: z.string(),
    timeoutMs: z.number().step(1).min(1),
    minIntervalMs: z.number().step(1).min(0),
    failureThreshold: z.number().step(1).min(1),
    cooldownMs: z.number().step(1).min(1),
});
/**
 * Register the DuckDuckGo scrape provider with `ctx.web`. The connector is
 * keyless, so the provider is available as long as the endpoint is a usable
 * http(s) URL and any configured bound is a positive whole number; the seam
 * reports `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` otherwise. The request-shaping
 * and failure-budget keys are validated the same way.
 */
export function apply(ctx, config) {
    // One debug-level line per request attempt (status, latency, body size — no
    // query text) goes to the host logger, so throttling episodes are visible
    // in the host log without this plugin writing any files of its own.
    const logger = ctx.logger('web-search-ddg');
    ctx.web.registerSearchProvider(new DdgSearchProvider({
        endpoint: config.endpoint ?? DDG_DEFAULT_ENDPOINT,
        ...config.maxResults !== undefined ? { maxResults: config.maxResults } : {},
        ...config.userAgent !== undefined ? { userAgent: config.userAgent } : {},
        ...config.acceptLanguage !== undefined ? { acceptLanguage: config.acceptLanguage } : {},
        ...config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {},
        ...config.minIntervalMs !== undefined ? { minIntervalMs: config.minIntervalMs } : {},
        ...config.failureThreshold !== undefined ? { failureThreshold: config.failureThreshold } : {},
        ...config.cooldownMs !== undefined ? { cooldownMs: config.cooldownMs } : {},
        log: event => logger.debug('ddg search: HTTP %s in %d ms, %d bytes', event.status, event.ms, event.bytes),
    }));
}
