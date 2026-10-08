/**
 * DuckDuckGo scrape `WebSearchProvider` plugin. It contributes to the `ctx.web`
 * registry without owning the service: the plugin registers its provider and the
 * seam handles selection, so nothing here replaces `WebRuntime` or `tool-web`.
 *
 * No credentials are involved — this provider is inherently keyless, so there is
 * no settings card, no API key field, and no credential-resolution step. The
 * deployment-level knobs (endpoint, provider-side result bound) are schema
 * fields a profile can set from `cordis.yml`, per the no-hardcoded-tunables
 * convention.
 * @module @deepseek-ai/dsh-web-search-ddg
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export { DDG_DEFAULT_ENDPOINT, DDG_PROVIDER_ID, DdgSearchProvider, } from './provider.ts';
export type { DdgSearchProviderOptions } from './provider.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "web-search-ddg";
/** The web seam this provider registers into. */
export declare const inject: string[];
/** Plugin config — all keys optional; `apply` fills the defaults. */
export interface Config {
    /** Results endpoint; `?q=` is appended. Defaults to `html.duckduckgo.com`. */
    endpoint?: string;
    /** Provider-side result bound when a request carries no `maxResults`. */
    maxResults?: number;
    /** Consecutive transient failures before the provider goes on cooldown. */
    failureThreshold?: number;
    /** Cooldown length in milliseconds once the threshold is reached. */
    cooldownMs?: number;
}
export declare const Config: z<Config>;
/**
 * Register the DuckDuckGo scrape provider with `ctx.web`. The connector is
 * keyless, so the provider is available as long as the endpoint is a usable
 * http(s) URL and any configured result bound is a positive whole number; the
 * seam reports `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` otherwise. The failure
 * budget keys are validated the same way.
 */
export declare function apply(ctx: Context, config: Config): void;
