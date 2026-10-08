/**
 * DuckDuckGo HTML scrape provider for the `ctx.web` search seam. It fetches the
 * static `html.duckduckgo.com` results page (no JS, no API key), parses the
 * `#links .result` markup, and normalizes each row into a `WebSearchSource`.
 *
 * The DDG result links are protocol-relative redirect URLs
 * (`//duckduckgo.com/l/?uddg=<encoded>&rut=...`); this provider decodes the
 * `uddg` parameter back to the real destination so the tool consumer displays
 * and cites the actual page, not the intermediate hop. Row mapping, URL
 * handling, and the fetch-and-error path are separated so parsing can be unit
 * tested without a network.
 * @module @deepseek-ai/dsh-web-search-ddg/provider
 */
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web';
import type { DdgScrapeEntry } from './types.ts';
/** Stable id this provider registers under. */
export declare const DDG_PROVIDER_ID = "ddg";
/** Default results endpoint; the static HTML mirror, not the JS app. */
export declare const DDG_DEFAULT_ENDPOINT = "https://html.duckduckgo.com/html/";
/** Resolved provider options (the plugin's `apply` supplies defaults). */
export interface DdgSearchProviderOptions {
    /** Results endpoint; `?q=` is appended. Must be an absolute http/https URL. */
    endpoint: string;
    /** Default result limit when a request carries no `maxResults`. */
    maxResults?: number;
}
/**
 * Extract the real destination from a DDG redirect URL, or `undefined` when the
 * value is not a usable `http(s)` URL. Accepts both protocol-relative
 * (`//duckduckgo.com/l/?uddg=...`) and absolute redirect targets, plus plain
 * absolute URLs (DDG may return direct links).
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
 * first-seen order. The result reports `truncated: false` — the seam owns the
 * final `maxResults` truncation and sets `truncated` itself.
 *
 * @param entries - the parsed rows, in page order.
 * @returns the normalized, deduped result.
 */
export declare function mapEntries(entries: readonly DdgScrapeEntry[]): WebSearchResult;
/**
 * The DuckDuckGo scrape search provider. HTTP redirects are followed by the
 * native fetch (the endpoint 301s between the bare domain and the `html/`
 * path); a result hop is never followed — it is decoded from the markup instead
 * of fetched. Fetch/HTTP failures surface as `WEB_PROVIDER_ERROR`.
 */
export declare class DdgSearchProvider implements WebSearchProvider {
    readonly id = "ddg";
    private readonly options;
    constructor(options: DdgSearchProviderOptions);
    /** Cheap local usability check; must not make network calls. */
    available(): boolean;
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>;
}
/**
 * Parse the DDG static results page into rows. Rows live under `#links` with
 * class `result`; the title is `a.result__a` and the snippet `a.result__snippet`.
 * `limit` bounds the number of parsed rows as a provider-side optimization when
 * present (the seam enforces the request bound regardless).
 *
 * @param html - the response body.
 * @param limit - optional row cap; `undefined` = no cap.
 * @returns the scraped rows, in page order.
 */
export declare function parseResults(html: string, limit?: number): DdgScrapeEntry[];
