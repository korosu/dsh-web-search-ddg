import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  DdgSearchProvider,
  DDG_PROVIDER_ID,
  mapEntries,
  parseResults,
  resolveDestination,
  toSource,
} from '../src/provider.ts'
import * as ddgPlugin from '../src/index.ts'

const options = { endpoint: 'https://html.duckduckgo.com/html/' }

/** The real global fetch, restored after every test that stubs it. */
const originalFetch = globalThis.fetch

interface FetchCall {
  url: string
  init: RequestInit
}

/** Stub `globalThis.fetch` for one test, recording calls for assertion. */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} })
    return impl(String(input), init)
  }
  return calls
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

/** Realistic DDG static-results markup (structure verified against the live endpoint). */
function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init })
}

/** A minimal valid results page with the two rows used across tests. */
function resultsPage(): string {
  return `
    <div id="links">
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc">Example</a>
          </h2>
          <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc">Snippet one.</a>
        </div>
      </div>
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a class="result__a" href="https://plain.example/direct">Direct link</a>
          </h2>
          <a class="result__snippet" href="https://plain.example/direct">Snippet two.</a>
        </div>
      </div>
    </div>`
}

/** Assertion helper: the rejected error must carry a WebError code and optional message pattern. */
function rejectsWithCode(code: string, messagePattern?: RegExp): (err: unknown) => boolean {
  return (err: unknown): boolean => {
    assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`)
    assert.equal((err as Error & { code?: string }).code, code)
    if (messagePattern !== undefined) assert.match((err as Error).message, messagePattern)
    return true
  }
}

describe('resolveDestination', () => {
  it('decodes a protocol-relative DDG redirect URL', () => {
    assert.equal(
      resolveDestination('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc'),
      'https://example.com/page',
    )
  })

  it('decodes an absolute DDG redirect URL', () => {
    assert.equal(
      resolveDestination('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%20b&rut=abc'),
      'https://example.com/a b',
    )
  })

  it('keeps a plain absolute URL unchanged', () => {
    assert.equal(resolveDestination('https://plain.example/direct'), 'https://plain.example/direct')
  })

  it('handles an already-decoded uddg value', () => {
    assert.equal(resolveDestination('//duckduckgo.com/l/?uddg=https://example.com/page&rut=abc'), 'https://example.com/page')
  })

  it('returns undefined for empty href', () => {
    assert.equal(resolveDestination(''), undefined)
  })

  it('returns undefined for a redirect whose uddg is not http(s)', () => {
    assert.equal(resolveDestination('//duckduckgo.com/l/?uddg=javascript%3Aalert(1)'), undefined)
    assert.equal(resolveDestination('//duckduckgo.com/l/?uddg=ftp%3A%2F%2Fexample.com'), undefined)
  })

  it('returns undefined for a malformed absolute URL', () => {
    assert.equal(resolveDestination('https://'), undefined)
    assert.equal(resolveDestination('not a url'), undefined)
  })

  it('returns undefined for a non-http scheme', () => {
    assert.equal(resolveDestination('javascript:alert(1)'), undefined)
  })
})

describe('toSource', () => {
  it('maps a row to a source, omitting a blank snippet', () => {
    assert.deepEqual(
      toSource({ rawHref: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fp', title: '  Title  ', snippet: '   ' }),
      { url: 'https://example.com/p', title: 'Title' },
    )
  })

  it('omits the snippet field only when blank, keeps it when present', () => {
    assert.deepEqual(
      toSource({ rawHref: 'https://example.com/p', title: 'T', snippet: 'S' }),
      { url: 'https://example.com/p', title: 'T', snippet: 'S' },
    )
  })

  it('drops a row with a blank title', () => {
    assert.equal(toSource({ rawHref: 'https://example.com/p', title: '   ', snippet: 'S' }), undefined)
  })

  it('drops a row with an unusable URL', () => {
    assert.equal(toSource({ rawHref: 'javascript:void(0)', title: 'T', snippet: 'S' }), undefined)
  })
})

describe('mapEntries', () => {
  it('normalizes, dedupes by URL, and preserves order', () => {
    const result = mapEntries([
      { rawHref: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffirst&rut=a', title: 'First', snippet: 'One' },
      { rawHref: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffirst&rut=b', title: 'First dup', snippet: 'One again' },
      { rawHref: 'https://example.com/second', title: 'Second', snippet: 'Two' },
      { rawHref: 'javascript:void(0)', title: 'Bad', snippet: 'Three' },
    ])
    assert.deepEqual(result, {
      sources: [
        { url: 'https://example.com/first', title: 'First', snippet: 'One' },
        { url: 'https://example.com/second', title: 'Second', snippet: 'Two' },
      ],
      truncated: false,
    })
  })

  it('yields no sources for empty input', () => {
    assert.deepEqual(mapEntries([]), { sources: [], truncated: false })
  })
})

describe('parseResults', () => {
  it('parses title and snippet rows from the results page', () => {
    const entries = parseResults(resultsPage())
    assert.deepEqual(entries, [
      { rawHref: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc', title: 'Example', snippet: 'Snippet one.' },
      { rawHref: 'https://plain.example/direct', title: 'Direct link', snippet: 'Snippet two.' },
    ])
  })

  it('honors the row limit', () => {
    assert.equal(parseResults(resultsPage(), 1).length, 1)
  })

  it('returns no rows for empty HTML', () => {
    assert.deepEqual(parseResults(''), [])
  })

  it('returns no rows for a challenge page without results markup', () => {
    assert.deepEqual(parseResults('<html><body>anomaly</body></html>'), [])
  })
})

describe('DdgSearchProvider availability', () => {
  it('is available with a valid https endpoint and no limit', () => {
    assert.equal(new DdgSearchProvider(options).available(), true)
  })

  it('is unavailable with an unparseable endpoint', () => {
    assert.equal(new DdgSearchProvider({ endpoint: 'not a url' }).available(), false)
  })

  it('is unavailable with a non-http scheme', () => {
    assert.equal(new DdgSearchProvider({ endpoint: 'ftp://example.com/' }).available(), false)
  })

  it('is unavailable with an invalid maxResults', () => {
    assert.equal(new DdgSearchProvider({ ...options, maxResults: 0 }).available(), false)
    assert.equal(new DdgSearchProvider({ ...options, maxResults: 1.5 }).available(), false)
  })

  it('is available with a positive integer maxResults', () => {
    assert.equal(new DdgSearchProvider({ ...options, maxResults: 10 }).available(), true)
  })
})

describe('DdgSearchProvider request mapping', () => {
  it('GETs the endpoint with the query and a desktop user agent', async () => {
    const calls = stubFetch(async () => htmlResponse(resultsPage()))
    await new DdgSearchProvider(options).search({ query: 'hello world' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, 'https://html.duckduckgo.com/html/?q=hello+world')
    // method is omitted — native fetch defaults to GET; the URL carries the query.
    assert.equal(calls[0]?.init.method, undefined)
    assert.equal(calls[0]?.init.redirect, 'follow')
    const headers = calls[0]?.init.headers as Record<string, string> | undefined
    assert.ok(headers?.['user-agent']?.includes('Mozilla/5.0'), `user-agent missing: ${JSON.stringify(headers)}`)
  })

  it('forwards the abort signal', async () => {
    const calls = stubFetch(async () => htmlResponse(resultsPage()))
    const controller = new AbortController()
    await new DdgSearchProvider(options).search({ query: 'q' }, controller.signal)
    assert.equal(calls[0]?.init.signal, controller.signal)
  })

  it('returns the parsed sources for a successful page', async () => {
    stubFetch(async () => htmlResponse(resultsPage()))
    const result = await new DdgSearchProvider(options).search({ query: 'q' })
    assert.deepEqual(result.sources.map(s => s.url), ['https://example.com/page', 'https://plain.example/direct'])
    assert.equal(result.truncated, false)
  })

  it('uses the request maxResults as a parse cap', async () => {
    stubFetch(async () => htmlResponse(resultsPage()))
    const result = await new DdgSearchProvider(options).search({ query: 'q', maxResults: 1 })
    assert.equal(result.sources.length, 1)
    assert.equal(result.sources[0]?.url, 'https://example.com/page')
  })
})

describe('DdgSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR', async () => {
    stubFetch(async () => new Response('blocked', { status: 503 }))
    await assert.rejects(
      new DdgSearchProvider(options).search({ query: 'q' }),
      rejectsWithCode('WEB_PROVIDER_ERROR', /503/),
    )
  })

  it('treats a 202 anomaly page with no markup as a transient failure', async () => {
    stubFetch(async () => new Response('anomaly', { status: 202 }))
    await assert.rejects(
      new DdgSearchProvider(options).search({ query: 'q' }),
      rejectsWithCode('WEB_PROVIDER_ERROR', /anomaly page/),
    )
  })

  it('keeps a 200 page without rows an empty result rather than a failure', async () => {
    stubFetch(async () => new Response('<html><body>no rows</body></html>', { status: 200 }))
    const result = await new DdgSearchProvider(options).search({ query: 'q' })
    assert.deepEqual(result, { sources: [], truncated: false })
  })

  it('does not count a non-retriable 4xx toward the failure budget', async () => {
    stubFetch(async () => new Response('bad request', { status: 400 }))
    const provider = new DdgSearchProvider({ ...options, failureThreshold: 1, cooldownMs: 60_000 })
    for (let i = 0; i < 3; i++) {
      await assert.rejects(
        provider.search({ query: 'q' }),
        rejectsWithCode('WEB_PROVIDER_ERROR', /does not count toward the failure budget/),
      )
    }
    assert.equal(provider.available(), true)
  })

  it('counts a 403 toward the failure budget', async () => {
    stubFetch(async () => new Response('forbidden', { status: 403 }))
    const provider = new DdgSearchProvider({ ...options, failureThreshold: 2, cooldownMs: 60_000 })
    await assert.rejects(provider.search({ query: 'q' }), rejectsWithCode('WEB_PROVIDER_ERROR'))
    assert.equal(provider.available(), true)
    await assert.rejects(provider.search({ query: 'q' }), rejectsWithCode('WEB_PROVIDER_ERROR'))
    assert.equal(provider.available(), false, 'threshold reached → cooldown')
  })

  it('goes on cooldown after the configured threshold and recovers after it', async () => {
    let now = 1_000_000
    const realNow = Date.now
    Date.now = () => now
    try {
      stubFetch(async () => { throw new TypeError('connection refused') })
      const provider = new DdgSearchProvider({ ...options, failureThreshold: 3, cooldownMs: 5 * 60 * 1000 })
      for (let i = 0; i < 2; i++) {
        await assert.rejects(provider.search({ query: 'q' }), rejectsWithCode('WEB_PROVIDER_ERROR'))
        assert.equal(provider.available(), true, `still available after ${i + 1} failures`)
      }
      await assert.rejects(provider.search({ query: 'q' }), rejectsWithCode('WEB_PROVIDER_ERROR'))
      assert.equal(provider.available(), false, 'third failure opens the cooldown')

      // The seam asks available() before each search; once the cooldown elapses
      // the provider is usable again and starts a fresh window.
      now += 5 * 60 * 1000 + 1
      assert.equal(provider.available(), true)
      stubFetch(async () => htmlResponse(resultsPage()))
      const result = await provider.search({ query: 'q' })
      assert.equal(result.sources.length, 2)
    } finally {
      Date.now = realNow
    }
  })

  it('clears the failure count after a success', async () => {
    stubFetch(async () => { throw new TypeError('connection refused') })
    const provider = new DdgSearchProvider({ ...options, failureThreshold: 2, cooldownMs: 60_000 })
    await assert.rejects(provider.search({ query: 'q' }), rejectsWithCode('WEB_PROVIDER_ERROR'))
    stubFetch(async () => htmlResponse(resultsPage()))
    await provider.search({ query: 'q' })
    stubFetch(async () => { throw new TypeError('connection refused') })
    await assert.rejects(provider.search({ query: 'q' }), rejectsWithCode('WEB_PROVIDER_ERROR'))
    assert.equal(provider.available(), true, 'the earlier failure was cleared by the success')
  })

  it('does not count an abort toward the failure budget', async () => {
    stubFetch(async () => { throw new DOMException('aborted', 'AbortError') })
    const provider = new DdgSearchProvider({ ...options, failureThreshold: 1, cooldownMs: 60_000 })
    for (let i = 0; i < 3; i++) {
      await assert.rejects(provider.search({ query: 'q' }), rejectsWithCode('WEB_ABORTED'))
    }
    assert.equal(provider.available(), true)
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    stubFetch(async () => { throw new TypeError('connection refused') })
    await assert.rejects(
      new DdgSearchProvider(options).search({ query: 'q' }),
      rejectsWithCode('WEB_PROVIDER_ERROR'),
    )
  })

  it('maps an abort during fetch to WEB_ABORTED', async () => {
    stubFetch(async () => { throw new DOMException('aborted', 'AbortError') })
    await assert.rejects(
      new DdgSearchProvider(options).search({ query: 'q' }),
      rejectsWithCode('WEB_ABORTED'),
    )
  })

  it('maps an abort during body read to WEB_ABORTED', async () => {
    const body = { text: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    stubFetch(async () => body as unknown as Response)
    await assert.rejects(
      new DdgSearchProvider(options).search({ query: 'q' }),
      rejectsWithCode('WEB_ABORTED'),
    )
  })

  it('returns empty sources for a success page without parseable results', async () => {
    stubFetch(async () => htmlResponse('<html><body>anomaly</body></html>'))
    const result = await new DdgSearchProvider(options).search({ query: 'q' })
    assert.deepEqual(result.sources, [])
  })
})

describe('web-search-ddg plugin registration', () => {
  it('registers the provider into ctx.web and serves an explicit ddg selection (HMR-safe)', async () => {
    stubFetch(async () => htmlResponse(resultsPage()))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DDG_PROVIDER_ID })
    const fiber = await ctx.plugin(ddgPlugin, {})
    const result = await ctx.web.search({ query: 'q' })
    assert.deepEqual(result.sources[0], { url: 'https://example.com/page', title: 'Example', snippet: 'Snippet one.' })
    assert.equal(result.truncated, false)
    await fiber.dispose()
    await assert.rejects(
      ctx.web.search({ query: 'q' }),
      rejectsWithCode('WEB_PROVIDER_CONFIGURED_MISSING'),
    )
  })

  it('reports configured-unavailable when the endpoint is unusable', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DDG_PROVIDER_ID })
    await ctx.plugin(ddgPlugin, { endpoint: 'not a url' })
    await assert.rejects(
      ctx.web.search({ query: 'q' }),
      rejectsWithCode('WEB_PROVIDER_CONFIGURED_UNAVAILABLE'),
    )
  })

  it('has no default export (namespace plugin export shape)', () => {
    assert.equal('default' in ddgPlugin, false)
  })
})
