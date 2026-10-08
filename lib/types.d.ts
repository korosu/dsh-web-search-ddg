/**
 * Wire types for the DuckDuckGo HTML scrape provider. The upstream response body
 * is HTML, so the only typed payload is the normalized output shape consumed by
 * the `ctx.web` seam.
 * @module @deepseek-ai/dsh-web-search-ddg/types
 */
/**
 * One DDG HTML result row distilled from the static results markup. Kept as a
 * separate vocabulary from `WebSearchSource` so the parser never has to decide
 * which fields the seam will accept: it reports what DDG said, and the seam
 * mapping applies the normalization rules (HTTP-only URLs, blank-field
 * omission, dedupe).
 */
export interface DdgScrapeEntry {
    /** Raw link target before directive handling (may be a DDG redirect URL). */
    readonly rawHref: string;
    /** Heading text, already trimmed. */
    readonly title: string;
    /** Snippet text, already trimmed; may be empty. */
    readonly snippet: string;
}
