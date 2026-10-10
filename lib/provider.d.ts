/**
 * DuckDuckGo HTML scrape provider for the `ctx.web` search seam. It fetches the
 * static `html.duckduckgo.com` results page (no JS, no API key), parses the
 * `#links .result` markup, and normalizes each row into a `WebSearchSource`.
 *
 * The DDG result links are protocol-relative redirect URLs
 * (`//duckduckgo.com/l/?uddg=<encoded>&rut=...`); this provider decodes the
 * redirect parameter — `uddg` on the organic `/l/` carrier, `u3` on the
 * sponsored `y.js` carrier — back to the real destination so the tool
 * consumer displays and cites the actual page, not the intermediate hop.
 * Sponsored rows are filtered out during parsing; row mapping, URL handling,
 * and the fetch-and-error path are separated so parsing can be unit tested
 * without a network.
 * @module @deepseek-ai/dsh-web-search-ddg/provider
 */
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web';
import type { DdgScrapeEntry } from './types.ts';
/** Stable id this provider registers under. */
export declare const DDG_PROVIDER_ID = "ddg";
/** Default results endpoint; the static HTML mirror, not the JS app. */
export declare const DDG_DEFAULT_ENDPOINT = "https://html.duckduckgo.com/html/";
/**
 * Default request user agent — desktop Chrome, the shape the static endpoint
 * serves richest results to (and the UA the live endpoint was verified with).
 * A deployment can override it with the `userAgent` config key; a stale or
 * unusual UA is itself a bot signal, so the knob matters operationally.
 */
export declare const DDG_DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
/**
 * Default per-request deadline in milliseconds. The slow-but-served responses
 * observed live (DDG tarpits) ran 9–20s, so a 30s bound lets every served
 * response through while a hung connection cannot outlive the call.
 */
export declare const DDG_DEFAULT_TIMEOUT_MS = 30000;
/** Resolved provider options (the plugin's `apply` supplies defaults). */
export interface DdgSearchProviderOptions {
    /** Results endpoint; `?q=` is appended. Must be an absolute http/https URL. */
    endpoint: string;
    /** Default result limit when a request carries no `maxResults`. */
    maxResults?: number;
    /** Request user agent; defaults to {@link DDG_DEFAULT_USER_AGENT}. */
    userAgent?: string;
    /** `accept-language` header value; unset = the header is not sent. */
    acceptLanguage?: string;
    /** Per-request deadline in milliseconds; a timeout is a transient failure. */
    timeoutMs?: number;
    /** Consecutive transient failures before the provider goes on cooldown. */
    failureThreshold?: number;
    /** Cooldown length in milliseconds once the threshold is reached. */
    cooldownMs?: number;
}
/**
 * Extract the real destination from a DDG link, or `undefined` when the value
 * is not a usable `http(s)` URL. Accepts protocol-relative (`//host/…`) and
 * absolute targets, plain absolute URLs, and DDG's two redirect carriers: the
 * organic result hop (`duckduckgo.com/l/?uddg=<encoded>`) and the sponsored
 * hop (`duckduckgo.com/y.js?…&u3=<encoded>`, the link shape sponsored rows
 * carry when the endpoint serves ads). A hop whose decoded target is itself a
 * DDG redirect is unwrapped too, up to {@link MAX_REDIRECT_HOPS} levels; a
 * deeper chain surfaces as `undefined`. The surviving destination is returned
 * canonicalized — re-parsed through `URL` — so the consumer always receives a
 * valid absolute URL.
 *
 * @param rawHref - the raw `href` from a result row.
 * @returns the destination, or `undefined` when nothing usable is present.
 */
export declare function resolveDestination(rawHref: string): string | undefined;
/**
 * Normalize one scraped row into a portable `WebSearchSource`. `title` and
 * `snippet` are omitted when blank rather than set empty, matching the other
 * web providers (the seam must not invent values).
 *
 * @param entry - the scraped row.
 * @returns the normalized source, or `undefined` when the URL cannot be used.
 */
export declare function toSource(entry: DdgScrapeEntry): WebSearchSource | undefined;
/**
 * Map parsed HTML rows to a normalized search result: decode destinations,
 * drop rows without a title or usable URL, and dedupe by URL while preserving
 * first-seen order. `limit`, when present, caps the number of *usable*
 * sources — applied after dropping and dedupe, so junk rows never consume
 * the bound. The result reports `truncated: false` — the seam owns the final
 * `maxResults` truncation and sets `truncated` itself.
 *
 * @param entries - the parsed rows, in page order.
 * @param limit - optional cap on usable sources; `undefined` = no cap.
 * @returns the normalized, deduped, capped result.
 */
export declare function mapEntries(entries: readonly DdgScrapeEntry[], limit?: number): WebSearchResult;
/**
 * The DuckDuckGo scrape search provider. HTTP redirects are followed by the
 * native fetch (the endpoint 301s between the bare domain and the `html/`
 * path); a result hop is never followed — it is decoded from the markup instead
 * of fetched.
 *
 * Failures are split in two. Transport failures, unreadable bodies, HTTP 429 /
 * 403 / 5xx, and an anomaly page (HTTP 202 carrying no result markup) are
 * *transient*: they count toward a failure budget, and once the budget is spent
 * the provider reports itself unavailable for a cooldown so the seam can pick
 * another backend instead of failing every call. Any other 4xx is a
 * configuration error, fails identically on every retry, and is never counted.
 *
 * Every request carries a deadline (`timeoutMs`, default 30s) composed with the
 * caller's abort signal through `AbortSignal.any`: a caller abort still maps to
 * `WEB_ABORTED`, while a timed-out request surfaces as a transient failure.
 */
export declare class DdgSearchProvider implements WebSearchProvider {
    readonly id = "ddg";
    private readonly options;
    private readonly failureThreshold;
    private readonly cooldownMs;
    private failures;
    private cooldownUntil;
    constructor(options: DdgSearchProviderOptions);
    /**
     * Cheap local usability check; must not make network calls. False while the
     * failure-budget cooldown is open, so the seam can select another provider.
     * String knobs must be non-empty and numeric knobs positive whole numbers —
     * the same rules the schema applies at load time, re-checked here because
     * `search()` may also be called through a direct provider reference.
     */
    available(): boolean;
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
    /**
     * Record a transient failure and throw the provider error for it. Once the
     * configured threshold of consecutive failures is reached the provider goes
     * on cooldown and reports itself unavailable until it elapses.
     */
    private transientFailure;
}
/**
 * Parse the DDG static results page into rows. Rows live under `#links` with
 * class `result`; the title is `a.result__a` and the snippet `a.result__snippet`.
 * Sponsored placements — rows carrying any `result--ad*` class — are skipped:
 * they are paid positions rather than organic results, and their links point
 * at a `y.js` tracking hop instead of a citation target. Every row is parsed;
 * bounding to `maxResults` happens after normalization (see `mapEntries`), so
 * dropped junk rows cannot push usable ones past the cut.
 *
 * @param html - the response body.
 * @returns the scraped rows, in page order.
 */
export declare function parseResults(html: string): DdgScrapeEntry[];
