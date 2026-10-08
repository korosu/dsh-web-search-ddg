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
import { WebError } from '@deepseek-ai/dsh-web';
import { load } from 'cheerio';
/** Stable id this provider registers under. */
export const DDG_PROVIDER_ID = 'ddg';
/** Default results endpoint; the static HTML mirror, not the JS app. */
export const DDG_DEFAULT_ENDPOINT = 'https://html.duckduckgo.com/html/';
/** Desktop Chrome user agent — the static endpoint serves richer results to it. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
/**
 * True for a DDG-compatible result limit (a positive whole number).
 * Keeping the predicate local mirrors the other web providers; exposing
 * generic positive-integer validation from a plugin would widen the API for no
 * consumer.
 */
function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
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
export function resolveDestination(rawHref) {
    if (rawHref.length === 0)
        return undefined;
    let candidate = rawHref;
    // Protocol-relative href: `//host/path`.
    if (candidate.startsWith('//'))
        candidate = `https:${candidate}`;
    if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
        try {
            // Already an absolute URL; use it as-is unless it is a DDG redirect hop.
            const url = new URL(candidate);
            if (url.hostname === 'duckduckgo.com' && url.pathname.startsWith('/l/')) {
                const redirect = url.searchParams.get('uddg');
                if (redirect !== null && (redirect.startsWith('http://') || redirect.startsWith('https://'))) {
                    return redirect;
                }
            }
            else {
                return url.toString();
            }
        }
        catch {
            // Fall through to the shared decode below.
        }
    }
    return undefined;
}
/**
 * Normalize one scraped row into a portable `WebSearchSource`. `title` and
 * `snippet` are omitted when blank rather than set empty, matching the other
 * web providers (the seam must not invent values).
 *
 * @param entry - the scraped row.
 * @returns the normalized source, or `undefined` when the URL cannot be used.
 */
export function toSource(entry) {
    const url = resolveDestination(entry.rawHref);
    const title = entry.title.trim();
    if (url === undefined || title.length === 0)
        return undefined;
    const snippet = entry.snippet.trim();
    return {
        url,
        title,
        ...snippet.length > 0 ? { snippet } : {},
    };
}
/**
 * Map parsed HTML rows to a normalized search result: decode destinations,
 * drop rows without a title or usable URL, and dedupe by URL while preserving
 * first-seen order. The result reports `truncated: false` — the seam owns the
 * final `maxResults` truncation and sets `truncated` itself.
 *
 * @param entries - the parsed rows, in page order.
 * @returns the normalized, deduped result.
 */
export function mapEntries(entries) {
    const seen = new Set();
    const sources = [];
    for (const entry of entries) {
        const source = toSource(entry);
        if (source === undefined || seen.has(source.url))
            continue;
        seen.add(source.url);
        sources.push(source);
    }
    return { sources, truncated: false };
}
/**
 * True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`.
 */
function isAbortError(error) {
    return error instanceof DOMException && error.name === 'AbortError';
}
/**
 * The DuckDuckGo scrape search provider. HTTP redirects are followed by the
 * native fetch (the endpoint 301s between the bare domain and the `html/`
 * path); a result hop is never followed — it is decoded from the markup instead
 * of fetched. Fetch/HTTP failures surface as `WEB_PROVIDER_ERROR`.
 */
export class DdgSearchProvider {
    id = DDG_PROVIDER_ID;
    options;
    constructor(options) {
        this.options = options;
    }
    /** Cheap local usability check; must not make network calls. */
    available() {
        return URL.canParse(this.options.endpoint)
            && (this.options.endpoint.startsWith('http://') || this.options.endpoint.startsWith('https://'))
            && (this.options.maxResults === undefined || isPositiveInteger(this.options.maxResults));
    }
    async search(request, signal) {
        const url = new URL(this.options.endpoint);
        url.searchParams.set('q', request.query);
        let response;
        try {
            response = await fetch(url.toString(), {
                redirect: 'follow',
                headers: { 'user-agent': USER_AGENT },
                ...signal !== undefined ? { signal } : {},
            });
        }
        catch (error) {
            if (signal?.aborted === true || isAbortError(error))
                throw webAborted(signal, error);
            throw new WebError(`DuckDuckGo search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
        }
        if (!response.ok) {
            throw new WebError(`DuckDuckGo returned an error response (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR');
        }
        let html;
        try {
            html = await response.text();
        }
        catch (error) {
            if (signal?.aborted === true || isAbortError(error))
                throw webAborted(signal, error);
            throw new WebError(`DuckDuckGo returned an unreadable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
        }
        // provider-side bound: wins as a cost optimization; the seam caps regardless.
        const limit = request.maxResults ?? this.options.maxResults;
        return mapEntries(parseResults(html, limit));
    }
}
/**
 * Build the provider's stable cancellation error while retaining the caller's
 * reason (mirrors the cancellation contract of the shipped web providers).
 */
function webAborted(signal, fallback) {
    return new WebError('DuckDuckGo search aborted', 'WEB_ABORTED', {
        cause: signal?.aborted === true ? signal.reason : fallback,
    });
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
export function parseResults(html, limit) {
    const entries = [];
    if (html.length === 0)
        return entries;
    const $ = load(html);
    $('#links .result').each((_, elem) => {
        if (limit !== undefined && entries.length >= limit)
            return false;
        const titleEl = $(elem).find('a.result__a');
        const snippetEl = $(elem).find('a.result__snippet');
        const rawHref = titleEl.attr('href') ?? '';
        const title = titleEl.text().trim();
        const snippet = snippetEl.text().trim();
        if (title.length === 0 && rawHref.length === 0)
            return true;
        entries.push({ rawHref, title, snippet });
    });
    return entries;
}
