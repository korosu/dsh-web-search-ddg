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
/**
 * Default request user agent — desktop Chrome, the shape the static endpoint
 * serves richest results to (and the UA the live endpoint was verified with).
 * A deployment can override it with the `userAgent` config key; a stale or
 * unusual UA is itself a bot signal, so the knob matters operationally.
 */
export const DDG_DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
/**
 * Default per-request deadline in milliseconds. The slow-but-served responses
 * observed live (DDG tarpits) ran 9–20s, so a 30s bound lets every served
 * response through while a hung connection cannot outlive the call.
 */
export const DDG_DEFAULT_TIMEOUT_MS = 30_000;
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
 * True for a DDG-compatible pacing interval (zero or a positive whole number).
 * Keeping the predicate local mirrors `isPositiveInteger`.
 */
function isNonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0;
}
/**
 * True for an endpoint the provider can actually fetch: an absolute http(s)
 * URL. Shared by `available()` and the direct-call guard in `search()`, so a
 * misconfiguration surfaces as a structured error, never a raw `TypeError`.
 */
function isUsableEndpoint(endpoint) {
    return (endpoint.startsWith('http://') || endpoint.startsWith('https://')) && URL.canParse(endpoint);
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
 * first-seen order. `limit`, when present, caps the number of *usable*
 * sources — applied after dropping and dedupe, so junk rows never consume
 * the bound. The result reports `truncated: false` — the seam owns the final
 * `maxResults` truncation and sets `truncated` itself.
 *
 * @param entries - the parsed rows, in page order.
 * @param limit - optional cap on usable sources; `undefined` = no cap.
 * @returns the normalized, deduped, capped result.
 */
export function mapEntries(entries, limit) {
    const seen = new Set();
    const sources = [];
    for (const entry of entries) {
        if (limit !== undefined && sources.length >= limit)
            break;
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
 *
 * Every request carries a deadline (`timeoutMs`, default 30s) composed with the
 * caller's abort signal through `AbortSignal.any`: a caller abort still maps to
 * `WEB_ABORTED`, while a timed-out request surfaces as a transient failure.
 */
export class DdgSearchProvider {
    id = DDG_PROVIDER_ID;
    options;
    failureThreshold;
    cooldownMs;
    minIntervalMs;
    failures = 0;
    cooldownUntil = 0;
    lastRequestAt = 0;
    queueTail = Promise.resolve();
    constructor(options) {
        this.options = options;
        this.failureThreshold = options.failureThreshold ?? FAILURE_THRESHOLD;
        this.cooldownMs = options.cooldownMs ?? COOLDOWN_MS;
        this.minIntervalMs = options.minIntervalMs ?? 0;
    }
    /**
     * Cheap local usability check; must not make network calls. False while the
     * failure-budget cooldown is open, so the seam can select another provider.
     * String knobs must be non-empty and numeric knobs positive whole numbers —
     * the same rules the schema applies at load time, re-checked here because
     * `search()` may also be called through a direct provider reference.
     */
    available() {
        if (this.cooldownUntil !== 0) {
            if (Date.now() < this.cooldownUntil)
                return false;
            // Cooldown elapsed: start a fresh window rather than staying tripped.
            this.failures = 0;
            this.cooldownUntil = 0;
        }
        return isUsableEndpoint(this.options.endpoint)
            && (this.options.maxResults === undefined || isPositiveInteger(this.options.maxResults))
            && (this.options.userAgent === undefined || this.options.userAgent.length > 0)
            && (this.options.acceptLanguage === undefined || this.options.acceptLanguage.length > 0)
            && (this.options.timeoutMs === undefined || isPositiveInteger(this.options.timeoutMs))
            && (this.options.minIntervalMs === undefined || isNonNegativeInteger(this.options.minIntervalMs));
    }
    async search(request, signal) {
        // Direct calls may bypass the seam's available() gate; a misconfigured
        // endpoint would otherwise crash on `new URL` with a raw TypeError. A
        // configuration error never counts toward the failure budget.
        if (!isUsableEndpoint(this.options.endpoint)) {
            throw new WebError(`DuckDuckGo endpoint is not a usable http(s) URL: ${this.options.endpoint}`, 'WEB_PROVIDER_ERROR');
        }
        // The breaker is open: fail fast instead of feeding the throttle — a
        // query batch that trips the budget must not keep hitting the endpoint
        // while the throttle flag is live. The seam re-selects until the cooldown
        // elapses, and this throw is not another budget entry.
        if (this.cooldownUntil !== 0) {
            const now = Date.now();
            if (now < this.cooldownUntil) {
                throw new WebError(`DuckDuckGo provider is on cooldown for another ${Math.ceil((this.cooldownUntil - now) / 1000)}s after ${this.failures} consecutive transient failures`, 'WEB_PROVIDER_ERROR');
            }
            // Cooldown elapsed: start a fresh window, mirroring available().
            this.failures = 0;
            this.cooldownUntil = 0;
        }
        // Pacing is the only await before fetch; skip it entirely when disabled so
        // the fetch still starts in this call's synchronous prefix (callers may
        // abort synchronously right after invoking search()).
        if (this.minIntervalMs > 0)
            await this.pace(signal);
        const startedAt = Date.now();
        const url = new URL(this.options.endpoint);
        url.searchParams.set('q', request.query);
        // Every request carries a deadline (`timeoutMs`, default 30s) composed
        // with the caller's abort via AbortSignal.any. When the caller aborts, the
        // rejection carries the caller's reason and classifies as WEB_ABORTED;
        // when the deadline fires, it carries a TimeoutError — not an AbortError —
        // so it classifies as a transient failure and consumes the budget.
        const deadline = AbortSignal.timeout(this.options.timeoutMs ?? DDG_DEFAULT_TIMEOUT_MS);
        const fetchSignal = signal !== undefined ? AbortSignal.any([signal, deadline]) : deadline;
        let response;
        try {
            response = await fetch(url.toString(), {
                redirect: 'follow',
                headers: {
                    'user-agent': this.options.userAgent ?? DDG_DEFAULT_USER_AGENT,
                    ...this.options.acceptLanguage !== undefined ? { 'accept-language': this.options.acceptLanguage } : {},
                },
                signal: fetchSignal,
            });
        }
        catch (error) {
            this.emitRequest({ status: 0, ms: Date.now() - startedAt, bytes: 0 });
            if (signal?.aborted === true || isAbortError(error))
                throw webAborted(signal, error);
            throw this.transientFailure(`DuckDuckGo search request failed: ${String(error)}`, error);
        }
        if (!response.ok) {
            this.emitRequest({ status: response.status, ms: Date.now() - startedAt, bytes: 0 });
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
            this.emitRequest({ status: response.status, ms: Date.now() - startedAt, bytes: 0 });
            if (signal?.aborted === true || isAbortError(error))
                throw webAborted(signal, error);
            throw this.transientFailure(`DuckDuckGo returned an unreadable response body: ${String(error)}`, error);
        }
        this.emitRequest({ status: response.status, ms: Date.now() - startedAt, bytes: html.length });
        // provider-side bound on usable sources, applied after normalization so
        // junk rows cannot push usable ones past the cut; the seam caps regardless.
        const limit = request.maxResults ?? this.options.maxResults;
        const entries = parseResults(html);
        // An anomaly page is a 2xx carrying no result markup. A 200 whose page
        // still carries the results container is a genuinely empty query and
        // stays an empty result. Live-verified (2026-10-10): every served page —
        // organic results, fuzzy matches, the true no-results page — carries
        // #links; only the challenge page does not.
        if (entries.length === 0) {
            if (response.status === 202) {
                throw this.transientFailure('DuckDuckGo answered with an anomaly page (HTTP 202) carrying no result markup; the endpoint is likely rate-limiting or challenging this client');
            }
            if (!hasResultContainer(html)) {
                throw this.transientFailure('DuckDuckGo answered with a page carrying no results markup at all (no #links container); the endpoint is likely serving an anomaly or challenge page, or the markup changed');
            }
        }
        this.failures = 0;
        return mapEntries(entries, limit);
    }
    /**
     * Serialize and pace request starts when a minimum interval is configured:
     * requests through one provider instance then reach the endpoint no faster
     * than one per `minIntervalMs`, which keeps a batched burst from tripping
     * the endpoint's anomaly page. The caller's abort is honored while waiting.
     */
    async pace(signal) {
        if (this.minIntervalMs <= 0)
            return;
        const previous = this.queueTail;
        let release;
        this.queueTail = new Promise(resolve => { release = resolve; });
        await previous;
        const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
        if (wait > 0)
            await new Promise(resolve => setTimeout(resolve, wait));
        if (signal?.aborted === true) {
            release();
            throw webAborted(signal, undefined);
        }
        this.lastRequestAt = Date.now();
        release();
    }
    /** Report one request outcome to the host-logger hook, when wired. */
    emitRequest(event) {
        this.options.log?.(event);
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
 * True when the page carries the `#links` results container at all. Every
 * page the endpoint serves — organic results, fuzzy matches, the true
 * no-results page — carries it; a 2xx body without it is an anomaly or
 * challenge page, not an empty query (live-verified against the endpoint).
 *
 * @param html - the response body.
 */
export function hasResultContainer(html) {
    if (html.length === 0)
        return false;
    return load(html)('#links').length > 0;
}
/**
 * Parse the DDG static results page into rows. Rows live under `#links` with
 * class `result`; the title is `.result__a` and the snippet `.result__snippet`
 * (class-anchored, not tag-anchored, so an upstream `a`↔`td` swap survives).
 * Sponsored placements — rows carrying any `result--ad*` class — are skipped:
 * they are paid positions rather than organic results, and their links point
 * at a `y.js` tracking hop instead of a citation target. Every row is parsed;
 * bounding to `maxResults` happens after normalization (see `mapEntries`), so
 * dropped junk rows cannot push usable ones past the cut.
 *
 * @param html - the response body.
 * @returns the scraped rows, in page order.
 */
export function parseResults(html) {
    const entries = [];
    if (html.length === 0)
        return entries;
    const $ = load(html);
    $('#links .result').each((_, elem) => {
        const classes = (($(elem).attr('class')) ?? '').split(/\s+/).filter(cls => cls.length > 0);
        if (classes.some(cls => cls.startsWith('result--ad')))
            return true;
        const titleEl = $(elem).find('.result__a');
        const snippetEl = $(elem).find('.result__snippet');
        const rawHref = titleEl.attr('href') ?? '';
        const title = titleEl.text().trim();
        const snippet = snippetEl.text().trim();
        if (title.length === 0 && rawHref.length === 0)
            return true;
        entries.push({ rawHref, title, snippet });
    });
    return entries;
}
