import { describe, it } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import { DdgSearchProvider, DDG_DEFAULT_ENDPOINT } from '../src/provider.ts'

/**
 * Real-network smoke for the DuckDuckGo scrape provider. Self-skips unless
 * `DDG_E2E=1` so ordinary `pnpm test` never depends on the network or on DDG's
 * rate limiting. The cases cover the query shapes the endpoint sees in
 * practice: plain ASCII, Cyrillic (non-ASCII percent-encoding), Chinese —
 * simplified, traditional, and mixed with ASCII, plus a Chinese
 * `accept-language` header (the plugin ships a Chinese README, so a
 * Chinese-language audience is first-class) — operators and special
 * characters, the `site:` filter, a provider-side result cap, and a
 * no-results query that must stay a well-formed answer rather than an error.
 *
 * DDG challenges clients with an HTTP 202 anomaly page, so the live queries
 * are paced 10s apart, exercising result parsing rather than the throttle
 * path. A single challenged request is **not** retried — a retried
 * bot-flagged request lowers the IP's reputation (searxng PR #2829, #3955) —
 * so the case self-skips with the reason; the anomaly contract itself is
 * pinned by the unit tests. Any other error, and any assertion over a served
 * page, still fails the run.
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

/**
 * True for the provider's challenge-page errors — the anomaly page and the
 * bot challenge form, whichever marker the live body carried.
 */
function isAnomalyError(error: unknown): boolean {
  return error instanceof Error
    && (error as Error & { code?: string }).code === 'WEB_PROVIDER_ERROR'
    && (error.message.includes('anomaly page') || error.message.includes('bot challenge page'))
}

/** Wait out the pacing gap, then stamp the query clock. */
async function paceGap(): Promise<void> {
  const waitMs = lastQueryAt + PACING_MS - Date.now()
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
  lastQueryAt = Date.now()
}

/**
 * Run one paced live query. A challenge page — the HTTP 202 anomaly or any
 * status whose body carries the challenge form — is DDG challenging this
 * client; one request, no retry. Retrying a bot-flagged request is itself a
 * bot signal that lowers the IP's reputation (searxng PR #2829 and #3955),
 * so the case self-skips with the reason instead of hammering: the suite
 * must assert parsing over served pages, not police DDG's network-side
 * policies (the anomaly contract is unit-tested).
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
    t.skip('DuckDuckGo answered with a challenge page (anomaly or challenge form, no results markup); the endpoint is throttling or challenging this client — one attempt, no retry (a retried bot-flagged request lowers IP reputation: searxng PR #2829, #3955)')
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

  it('percent-encodes a simplified-Chinese query and returns sources', { timeout: 60_000 }, async t => {
    const result = await liveSearch(t, newProvider(), { query: '中文搜索 深度学习', maxResults: 5 })
    if (result === undefined) return
    assert.ok(result.sources.length > 0, 'expected at least one simplified-Chinese-query source')
    expectWellFormed(result)
  })

  it('percent-encodes a traditional-Chinese query and returns sources', { timeout: 60_000 }, async t => {
    const result = await liveSearch(t, newProvider(), { query: '繁體中文 搜尋引擎', maxResults: 5 })
    if (result === undefined) return
    assert.ok(result.sources.length > 0, 'expected at least one traditional-Chinese-query source')
    expectWellFormed(result)
  })

  it('handles a mixed CJK + ASCII query', { timeout: 60_000 }, async t => {
    const result = await liveSearch(t, newProvider(), { query: 'Python 3 中文教程', maxResults: 5 })
    if (result === undefined) return
    assert.ok(result.sources.length > 0, 'expected at least one mixed-script-query source')
    expectWellFormed(result)
  })

  it('serves a Chinese query with a Chinese accept-language header configured', { timeout: 60_000 }, async t => {
    const provider = new DdgSearchProvider({ endpoint: DDG_DEFAULT_ENDPOINT, acceptLanguage: 'zh-CN,zh;q=0.9' })
    const result = await liveSearch(t, provider, { query: '中文搜索', maxResults: 5 })
    if (result === undefined) return
    assert.ok(result.sources.length > 0, 'expected at least one source with the Chinese accept-language header')
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
