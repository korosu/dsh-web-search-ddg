import { describe, it } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import { DdgSearchProvider, DDG_DEFAULT_ENDPOINT } from '../src/provider.ts'

/**
 * Real-network smoke for the DuckDuckGo scrape provider. Self-skips unless
 * `DDG_E2E=1` so ordinary `pnpm test` never depends on the network or on DDG's
 * rate limiting. The cases cover the query shapes the endpoint sees in
 * practice: plain ASCII, Cyrillic (non-ASCII percent-encoding), operators and
 * special characters, the `site:` filter, a provider-side result cap, and a
 * no-results query that must stay a well-formed answer rather than an error.
 *
 * DDG challenges rapid bursts from one IP with an HTTP 202 anomaly page, so
 * the live queries are paced 10s apart, exercising result parsing rather
 * than the throttle path. The challenge is also issued intermittently to a
 * single request while its neighbors are served, so a lone anomaly is
 * retried once after a full gap. When the retry draws the anomaly again the
 * endpoint is persistently challenging this client — an environment
 * condition (throttling, datacenter filtering, or query-language policy),
 * not a provider defect — and the case self-skips with that reason; the
 * anomaly contract itself is pinned by the unit tests. Any other error,
 * and any assertion over a served page, still fails the run.
 */
const maybe = process.env.DDG_E2E === '1' ? describe : describe.skip

/**
 * Courtesy pacing between live queries; DDG tolerates a few requests per
 * minute from one IP and challenges anything faster with the anomaly page.
 */
const PACING_MS = 10_000
let lastQueryAt = 0

/** Fresh provider per case, so no failure-budget state leaks between queries. */
function newProvider(): DdgSearchProvider {
  return new DdgSearchProvider({ endpoint: DDG_DEFAULT_ENDPOINT })
}

/** True for the provider's anomaly-page error — DDG's intermittent challenge. */
function isAnomalyError(error: unknown): boolean {
  return error instanceof Error
    && (error as Error & { code?: string }).code === 'WEB_PROVIDER_ERROR'
    && error.message.includes('anomaly page')
}

/** Wait out the pacing gap, then stamp the query clock. */
async function paceGap(): Promise<void> {
  const waitMs = lastQueryAt + PACING_MS - Date.now()
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
  lastQueryAt = Date.now()
}

/**
 * Run one paced live query. A lone 202 anomaly page is DDG's intermittent
 * per-request challenge, so it is retried once after a full pacing gap; a
 * second consecutive anomaly means the endpoint is persistently challenging
 * this client, and the case self-skips with the reason instead of failing —
 * the suite must assert parsing over served pages, not police DDG's
 * network-side policies (the anomaly contract is unit-tested).
 *
 * @returns the served result, or `undefined` after marking the case skipped.
 */
async function liveSearch(
  t: TestContext,
  provider: DdgSearchProvider,
  request: WebSearchRequest,
): Promise<WebSearchResult | undefined> {
  await paceGap()
  try {
    return await provider.search(request)
  } catch (error) {
    if (!isAnomalyError(error)) throw error
    // The failed attempt (possibly tarpitted for ~10s) consumed no gap;
    // restart the clock so the retry is a full PACING_MS away.
    lastQueryAt = Date.now()
  }
  await paceGap()
  try {
    return await provider.search(request)
  } catch (error) {
    if (!isAnomalyError(error)) throw error
    t.skip('DuckDuckGo answered with the anomaly page twice; the endpoint is persistently throttling or challenging this client (environment condition, not a provider defect)')
    return undefined
  }
}

/** Structural assertions every case shares: http(s) URLs and non-empty titles. */
function expectWellFormed(result: WebSearchResult): void {
  for (const source of result.sources) {
    assert.match(source.url, /^https?:\/\//)
    assert.ok(source.title.length > 0, `blank title for ${source.url}`)
  }
}

maybe('DdgSearchProvider real network', () => {
  it('returns sources for a live English query', { timeout: 60_000 }, async t => {
    const result = await liveSearch(t, newProvider(), { query: 'DeepSeek Harness', maxResults: 5 })
    if (result === undefined) return
    assert.ok(result.sources.length > 0, 'expected at least one source')
    assert.ok(result.sources.length <= 5)
    expectWellFormed(result)
  })

  it('percent-encodes a Cyrillic query and returns sources', { timeout: 60_000 }, async t => {
    const result = await liveSearch(t, newProvider(), { query: 'python учебник для начинающих', maxResults: 5 })
    if (result === undefined) return
    assert.ok(result.sources.length > 0, 'expected at least one Cyrillic-query source')
    expectWellFormed(result)
  })

  it('handles operators and special characters', { timeout: 60_000 }, async t => {
    const result = await liveSearch(t, newProvider(), { query: 'C++ "std::vector" push_back', maxResults: 5 })
    if (result === undefined) return
    assert.ok(result.sources.length > 0, 'expected at least one source')
    expectWellFormed(result)
  })

  it('honors the site: operator', { timeout: 60_000 }, async t => {
    const result = await liveSearch(t, newProvider(), { query: 'site:github.com deepseek harness', maxResults: 8 })
    if (result === undefined) return
    assert.ok(result.sources.length > 0, 'expected at least one source')
    for (const source of result.sources) {
      const host = new URL(source.url).hostname
      assert.ok(host === 'github.com' || host.endsWith('.github.com'), `non-github host: ${host}`)
    }
  })

  it('caps live results at the requested maxResults', { timeout: 60_000 }, async t => {
    const result = await liveSearch(t, newProvider(), { query: 'javascript tutorial', maxResults: 3 })
    if (result === undefined) return
    assert.ok(result.sources.length <= 3, `expected at most 3 sources, got ${result.sources.length}`)
    expectWellFormed(result)
  })

  it('answers a no-results query as a well-formed, untruncated result', { timeout: 60_000 }, async t => {
    const result = await liveSearch(t, newProvider(), { query: 'qzxwvj pkwlur 382910 nothing-to-find' })
    if (result === undefined) return
    expectWellFormed(result)
    assert.equal(result.truncated, false)
  })
})
