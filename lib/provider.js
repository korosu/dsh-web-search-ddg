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
import { WebError } from '@deepseek-ai/dsh-web';
import { load } from 'cheerio';
/** Stable id this provider registers under. */
export const DDG_PROVIDER_ID = 'ddg';
/** Default results endpoint; the static HTML mirror, not the JS app. */
export const DDG_DEFAULT_ENDPOINT = 'https://html.duckduckgo.com/html/';
/** Desktop Chrome user agent — the static endpoint serves richer results to it. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
/**
 * Consecutive transient failures after which the provider declares itself
 * unavailable, and how long that cooldown lasts. Both are config keys; these
 * are the defaults.
 */
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 5 * 60 * 1000;
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
 * Redirect hops unwrapped when a decoded target is itself a DDG redirect.
 * A chain deeper than this is reported unusable rather than chased.
 */
const MAX_REDIRECT_HOPS = 3;
/** True for a usable `http(s)` URL string (the only schemes a citation needs). */
function isHttpUrl(value) {
    return value.startsWith('http://') || value.startsWith('https://');
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
export function resolveDestination(rawHref) {
    let candidate = rawHref;
    // Protocol-relative href: `//host/path`.
    if (candidate.startsWith('//'))
        candidate = `https:${candidate}`;
    if (!isHttpUrl(candidate))
        return undefined;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
        let url;
        try {
            url = new URL(candidate);
        }
        catch {
            return undefined;
        }
        if (url.hostname !== 'duckduckgo.com')
            return url.toString();
        if (url.pathname.startsWith('/l/')) {
            const redirect = url.searchParams.get('uddg');
            if (redirect === null || !isHttpUrl(redirect))
                return undefined;
            candidate = redirect;
            continue;
        }
        if (url.pathname.startsWith('/y.js')) {
            const destination = url.searchParams.get('u3');
            if (destination === null || !isHttpUrl(destination))
                return undefined;
            candidate = destination;
            continue;
        }
        return url.toString();
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
 * True for an HTTP status a retry could plausibly survive: rate limiting,
 * blocking, server errors. Every other 4xx is a configuration mistake that
 * would fail identically on each retry, so it must not consume the failure
 * budget (see {@link DdgSearchProvider}).
 */
function isTransientStatus(status) {
    return status === 403 || status === 429 || status >= 500;
}
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
 */
export class DdgSearchProvider {
    id = DDG_PROVIDER_ID;
    options;
    failureThreshold;
    cooldownMs;
    failures = 0;
    cooldownUntil = 0;
    constructor(options) {
        this.options = options;
        this.failureThreshold = options.failureThreshold ?? FAILURE_THRESHOLD;
        this.cooldownMs = options.cooldownMs ?? COOLDOWN_MS;
    }
    /**
     * Cheap local usability check; must not make network calls. False while the
     * failure-budget cooldown is open, so the seam can select another provider.
     */
    available() {
        if (this.cooldownUntil !== 0) {
            if (Date.now() < this.cooldownUntil)
                return false;
            // Cooldown elapsed: start a fresh window rather than staying tripped.
            this.failures = 0;
            this.cooldownUntil = 0;
        }
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
            throw this.transientFailure(`DuckDuckGo search request failed: ${String(error)}`, error);
        }
        if (!response.ok) {
            const message = `DuckDuckGo returned an error response (HTTP ${response.status})`;
            if (!isTransientStatus(response.status)) {
                // A configuration error: same outcome on every retry, so it must not
                // consume the failure budget and trip the breaker.
                throw new WebError(`${message}; this status is not retried and does not count toward the failure budget`, 'WEB_PROVIDER_ERROR');
            }
            throw this.transientFailure(message);
        }
        let html;
        try {
            html = await response.text();
        }
        catch (error) {
            if (signal?.aborted === true || isAbortError(error))
                throw webAborted(signal, error);
            throw this.transientFailure(`DuckDuckGo returned an unreadable response body: ${String(error)}`, error);
        }
        // provider-side bound: wins as a cost optimization; the seam caps regardless.
        const limit = request.maxResults ?? this.options.maxResults;
        const entries = parseResults(html, limit);
        // An anomaly page is a 2xx carrying no result markup. A 200 with no rows is
        // a genuinely empty query and stays an empty result; only the anomaly
        // signature counts as a failure, so throttling is distinguishable.
        if (entries.length === 0 && response.status === 202) {
            throw this.transientFailure('DuckDuckGo answered with an anomaly page (HTTP 202) carrying no result markup; the endpoint is likely rate-limiting or challenging this client');
        }
        this.failures = 0;
        return mapEntries(entries);
    }
    /**
     * Record a transient failure and throw the provider error for it. Once the
     * configured threshold of consecutive failures is reached the provider goes
     * on cooldown and reports itself unavailable until it elapses.
     */
    transientFailure(message, cause) {
        this.failures += 1;
        if (this.failures >= this.failureThreshold) {
            this.cooldownUntil = Date.now() + this.cooldownMs;
        }
        return new WebError(message, 'WEB_PROVIDER_ERROR', cause === undefined ? undefined : { cause });
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
 * Sponsored placements — rows carrying any `result--ad*` class — are skipped:
 * they are paid positions rather than organic results, and their links point
 * at a `y.js` tracking hop instead of a citation target. `limit` bounds the
 * number of parsed rows as a provider-side optimization when present (the seam
 * enforces the request bound regardless).
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
        const classes = (($(elem).attr('class')) ?? '').split(/\s+/).filter(cls => cls.length > 0);
        if (classes.some(cls => cls.startsWith('result--ad')))
            return true;
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
