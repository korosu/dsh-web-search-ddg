import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DdgSearchProvider, DDG_DEFAULT_ENDPOINT } from '../src/provider.ts'

/**
 * Real-network smoke for the DuckDuckGo scrape provider. Self-skips unless
 * `DDG_E2E=1` so ordinary `pnpm test` never depends on the network or on DDG's
 * rate limiting. DDG may answer a challenge page to datacenter IPs; since the
 * failure budget landed that surfaces as a `WEB_PROVIDER_ERROR` naming the
 * anomaly page rather than an empty result — the assertion failure itself is
 * the throttle signal. Run from a residential network and, if rate-limited,
 * wait before rerunning.
 */
const maybe = process.env.DDG_E2E === '1' ? describe : describe.skip

maybe('DdgSearchProvider real network', () => {
  it('returns sources for a live query', { timeout: 30_000 }, async () => {
    const provider = new DdgSearchProvider({ endpoint: DDG_DEFAULT_ENDPOINT })
    const result = await provider.search({ query: 'DeepSeek Harness', maxResults: 5 })
    assert.ok(result.sources.length > 0, 'expected at least one source')
    assert.ok(result.sources.length <= 5)
    for (const source of result.sources) {
      assert.match(source.url, /^https?:\/\//)
      assert.ok(source.title !== undefined && source.title.length > 0)
    }
  })
})
