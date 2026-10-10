import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  DdgSearchProvider,
  DDG_PROVIDER_ID,
  hasResultContainer,
  mapEntries,
  parseResults,
  resolveDestination,
  toSource,
} from '../src/provider.ts'
import type { DdgRequestEvent } from '../src/provider.ts'
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

/** One numbered organic result row for ad-filter and cap tests. */
function organicRow(n: number): string {
  return `
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a class="result__a" href="https://plain.example/p${n}">Organic ${n}</a>
          </h2>
          <a class="result__snippet" href="https://plain.example/p${n}">Snippet ${n}.</a>
        </div>
      </div>`
}

/** A sponsored row in DDG's ad-markup shape: result--ad class, y.js link hop. */
function sponsoredRow(): string {
  const hop = '//duckduckgo.com/y.js?ad_provider=bing&ad_domain=example.com&u3=https%3A%2F%2Fsponsor.example%2Foffer'
  return `
      <div class="result result--ad results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a class="result__a" href="${hop}">Sponsored offer</a>
          </h2>
          <a class="result__snippet" href="${hop}">Buy now.</a>
        </div>
      </div>`
}

/** A fetch stub that never settles on its own — only the request signal aborts it (mirrors native fetch, including an already-aborted signal). */
function hangUntilAborted(): (url: string, init?: RequestInit) => Promise<Response> {
  return (_, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
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

  it('decodes an absolute DDG redirect URL, canonicalized', () => {
    assert.equal(
      resolveDestination('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%20b&rut=abc'),
      // The decoded target is re-parsed through URL, so the literal space in
      // the path surfaces percent-encoded — the consumer gets a valid URL.
      'https://example.com/a%20b',
    )
  })

  it('keeps a plain absolute URL unchanged', () => {
    assert.equal(resolveDestination('https://plain.example/direct'), 'https://plain.example/direct')
  })

  it('handles an already-decoded uddg value', () => {
    assert.equal(resolveDestination('//duckduckgo.com/l/?uddg=https://example.com/page&rut=abc'), 'https://example.com/page')
  })

  it('decodes a sponsored y.js redirect hop through u3', () => {
    assert.equal(
      resolveDestination('//duckduckgo.com/y.js?ad_provider=bing&ad_domain=example.com&u3=https%3A%2F%2Fsponsor.example%2Foffer&rut=abc'),
      'https://sponsor.example/offer',
    )
  })

  it('drops a y.js hop without a usable u3 destination', () => {
    assert.equal(resolveDestination('//duckduckgo.com/y.js?ad_provider=bing'), undefined)
    assert.equal(resolveDestination('//duckduckgo.com/y.js?u3=javascript%3Aalert(1)'), undefined)
  })

  it('unwraps a nested redirect chain to the final destination', () => {
    const inner = 'https://duckduckgo.com/l/?uddg=' + encodeURIComponent('https://example.com/final')
    const outer = 'https://duckduckgo.com/l/?uddg=' + encodeURIComponent(inner)
    assert.equal(resolveDestination(outer), 'https://example.com/final')
  })

  it('reports a chain deeper than the hop limit unusable', () => {
    let link = 'https://example.com/deepest'
    for (let i = 0; i < 4; i++) link = 'https://duckduckgo.com/l/?uddg=' + encodeURIComponent(link)
    assert.equal(resolveDestination(link), undefined)
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

  it('caps usable sources at the limit after dropping and dedupe', () => {
    const result = mapEntries([
      { rawHref: 'https://example.com/first', title: 'First', snippet: 'One' },
      { rawHref: 'https://example.com/first', title: 'First dup', snippet: 'One again' },
      { rawHref: 'https://example.com/second', title: 'Second', snippet: 'Two' },
      { rawHref: 'https://example.com/third', title: 'Third', snippet: 'Three' },
    ], 2)
    assert.deepEqual(result, {
      sources: [
        { url: 'https://example.com/first', title: 'First', snippet: 'One' },
        { url: 'https://example.com/second', title: 'Second', snippet: 'Two' },
      ],
      truncated: false,
    })
  })

  it('lets junk rows consume no part of the limit', () => {
    const result = mapEntries([
      { rawHref: 'javascript:void(0)', title: 'Bad', snippet: '' },
      { rawHref: 'https://example.com/v1', title: 'V1', snippet: 'S' },
      { rawHref: 'https://example.com/v2', title: 'V2', snippet: 'S' },
      { rawHref: 'https://example.com/v3', title: 'V3', snippet: 'S' },
    ], 3)
    assert.deepEqual(result.sources.map(source => source.title), ['V1', 'V2', 'V3'])
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

  it('returns no rows for empty HTML', () => {
    assert.deepEqual(parseResults(''), [])
  })

  it('returns no rows for a challenge page without results markup', () => {
    assert.deepEqual(parseResults('<html><body>anomaly</body></html>'), [])
  })

  it('parses every row regardless of any later cap', () => {
    // The cap moved to mapEntries; parseResults reports all rows it can.
    const page = `<div id="links">${organicRow(1)}${organicRow(2)}</div>`
    assert.equal(parseResults(page).length, 2)
  })

  it('skips sponsored rows (any result--ad class)', () => {
    const page = `<div id="links">${sponsoredRow()}${organicRow(1)}${organicRow(2)}</div>`
    const entries = parseResults(page)
    assert.deepEqual(entries.map(entry => entry.title), ['Organic 1', 'Organic 2'])
  })

  it('reads title and snippet by class, not by tag', () => {
    const page = `<div id="links">
      <div class="result web-result">
        <h2 class="result__title"><span class="result__a" href="https://plain.example/span">Non-anchor title</span></h2>
        <div class="result__snippet">Non-anchor snippet.</div>
      </div>
    </div>`
    assert.deepEqual(parseResults(page), [
      { rawHref: 'https://plain.example/span', title: 'Non-anchor title', snippet: 'Non-anchor snippet.' },
    ])
  })

  it('detects the results container independently of row count', () => {
    assert.equal(hasResultContainer('<div id="links"></div>'), true)
    assert.equal(hasResultContainer('<div class="no-results">none</div>'), false)
    assert.equal(hasResultContainer(''), false)
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

  it('is unavailable with an invalid timeoutMs', () => {
    assert.equal(new DdgSearchProvider({ ...options, timeoutMs: 0 }).available(), false)
    assert.equal(new DdgSearchProvider({ ...options, timeoutMs: 2.5 }).available(), false)
  })

  it('is available with a positive integer timeoutMs', () => {
    assert.equal(new DdgSearchProvider({ ...options, timeoutMs: 30_000 }).available(), true)
  })

  it('is unavailable with an empty userAgent or acceptLanguage', () => {
    assert.equal(new DdgSearchProvider({ ...options, userAgent: '' }).available(), false)
    assert.equal(new DdgSearchProvider({ ...options, acceptLanguage: '' }).available(), false)
  })

  it('is unavailable with an invalid minIntervalMs', () => {
    assert.equal(new DdgSearchProvider({ ...options, minIntervalMs: -1 }).available(), false)
    assert.equal(new DdgSearchProvider({ ...options, minIntervalMs: 1.5 }).available(), false)
  })

  it('is available with a non-negative integer minIntervalMs', () => {
    assert.equal(new DdgSearchProvider({ ...options, minIntervalMs: 0 }).available(), true)
    assert.equal(new DdgSearchProvider({ ...options, minIntervalMs: 10_000 }).available(), true)
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

  it('percent-encodes special characters in the query parameter', async () => {
    const calls = stubFetch(async () => htmlResponse(resultsPage()))
    await new DdgSearchProvider(options).search({ query: 'C++ "std::vector"' })
    // `+` must not degrade into a space and quotes/colons must survive the trip.
    assert.equal(calls[0]?.url, 'https://html.duckduckgo.com/html/?q=C%2B%2B+%22std%3A%3Avector%22')
  })

  it('percent-encodes a Cyrillic query as UTF-8', async () => {
    const calls = stubFetch(async () => htmlResponse(resultsPage()))
    await new DdgSearchProvider(options).search({ query: 'погода Москва' })
    assert.equal(
      calls[0]?.url,
      'https://html.duckduckgo.com/html/?q=%D0%BF%D0%BE%D0%B3%D0%BE%D0%B4%D0%B0+%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0',
    )
  })

  it('forwards the abort signal to the fetch', async () => {
    const calls = stubFetch(async () => htmlResponse(resultsPage()))
    const controller = new AbortController()
    await new DdgSearchProvider(options).search({ query: 'q' }, controller.signal)
    const fetchSignal = calls[0]?.init.signal
    assert.ok(fetchSignal instanceof AbortSignal, 'fetch must carry a signal')
    assert.equal(fetchSignal.aborted, false)
    controller.abort()
    assert.equal(fetchSignal.aborted, true, 'the caller abort must propagate into the fetch signal')
  })

  it('sends the configured user agent', async () => {
    const calls = stubFetch(async () => htmlResponse(resultsPage()))
    await new DdgSearchProvider({ ...options, userAgent: 'TestAgent/9' }).search({ query: 'q' })
    const headers = calls[0]?.init.headers as Record<string, string> | undefined
    assert.equal(headers?.['user-agent'], 'TestAgent/9')
  })

  it('sends accept-language only when configured', async () => {
    const bare = stubFetch(async () => htmlResponse(resultsPage()))
    await new DdgSearchProvider(options).search({ query: 'q' })
    let headers = bare[0]?.init.headers as Record<string, string> | undefined
    assert.equal('accept-language' in (headers ?? {}), false, 'unset accept-language must not be sent')

    const withLanguage = stubFetch(async () => htmlResponse(resultsPage()))
    await new DdgSearchProvider({ ...options, acceptLanguage: 'ru-RU,ru;q=0.9' }).search({ query: 'q' })
    headers = withLanguage[0]?.init.headers as Record<string, string> | undefined
    assert.equal(headers?.['accept-language'], 'ru-RU,ru;q=0.9')
  })

  it('arms a request deadline signal by default', async () => {
    const calls = stubFetch(async () => htmlResponse(resultsPage()))
    await new DdgSearchProvider(options).search({ query: 'q' })
    assert.ok(calls[0]?.init.signal instanceof AbortSignal, 'a deadline signal must always be armed')
  })

  it('spaces consecutive request starts by minIntervalMs', async () => {
    const starts: number[] = []
    stubFetch(async () => {
      starts.push(Date.now())
      return htmlResponse(resultsPage())
    })
    const provider = new DdgSearchProvider({ ...options, minIntervalMs: 120 })
    await Promise.all([
      provider.search({ query: 'a' }),
      provider.search({ query: 'b' }),
    ])
    assert.equal(starts.length, 2)
    assert.ok((starts[1]! - starts[0]!) >= 100, `request starts too close: ${starts.join(', ')}`)
  })

  it('reports one request event per attempt through the log hook', async () => {
    const events: DdgRequestEvent[] = []
    stubFetch(async () => htmlResponse(resultsPage()))
    await new DdgSearchProvider({ ...options, log: event => events.push(event) }).search({ query: 'q' })
    assert.equal(events.length, 1)
    assert.equal(events[0]?.status, 200)
    assert.ok(events[0]!.ms >= 0)
    assert.equal(events[0]?.bytes, resultsPage().length)
  })

  it('reports a request event with zero bytes for a non-2xx response', async () => {
    const events: DdgRequestEvent[] = []
    stubFetch(async () => new Response('nope', { status: 503 }))
    await assert.rejects(
      new DdgSearchProvider({ ...options, log: event => events.push(event) }).search({ query: 'q' }),
      rejectsWithCode('WEB_PROVIDER_ERROR'),
    )
    assert.equal(events[0]?.status, 503)
    assert.equal(events[0]?.bytes, 0)
  })

  it('returns the parsed sources for a successful page', async () => {
    stubFetch(async () => htmlResponse(resultsPage()))
    const result = await new DdgSearchProvider(options).search({ query: 'q' })
    assert.deepEqual(result.sources.map(s => s.url), ['https://example.com/page', 'https://plain.example/direct'])
    assert.equal(result.truncated, false)
  })

  it('drops sponsored rows from a served page', async () => {
    stubFetch(async () => htmlResponse(`<div id="links">${sponsoredRow()}${organicRow(1)}${organicRow(2)}</div>`))
    const result = await new DdgSearchProvider(options).search({ query: 'insurance' })
    assert.deepEqual(result.sources.map(source => source.url), ['https://plain.example/p1', 'https://plain.example/p2'])
  })

  it('caps results at the requested maxResults', async () => {
    stubFetch(async () => htmlResponse(resultsPage()))
    const result = await new DdgSearchProvider(options).search({ query: 'q', maxResults: 1 })
    assert.equal(result.sources.length, 1)
    assert.equal(result.sources[0]?.url, 'https://example.com/page')
  })

  it('caps usable sources, not parsed rows, at maxResults', async () => {
    const page = `<div id="links">
      <div class="result results_links results_links_deep web-result">
        <h2 class="result__title"><a class="result__a" href="javascript:void(0)">Junk row</a></h2>
        <a class="result__snippet" href="javascript:void(0)">Unusable.</a>
      </div>
      ${organicRow(1)}${organicRow(2)}${organicRow(3)}
    </div>`
    stubFetch(async () => htmlResponse(page))
    const result = await new DdgSearchProvider(options).search({ query: 'q', maxResults: 3 })
    // The junk row must not consume one of the three: all usable rows fit.
    assert.deepEqual(result.sources.map(source => source.url), [
      'https://plain.example/p1',
      'https://plain.example/p2',
      'https://plain.example/p3',
    ])
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

  it('keeps a 200 page with the results container but no rows an empty result', async () => {
    stubFetch(async () => new Response('<div id="links"><div class="no-results">No results</div></div>', { status: 200 }))
    const result = await new DdgSearchProvider(options).search({ query: 'q' })
    assert.deepEqual(result, { sources: [], truncated: false })
  })

  it('treats a 200 page with no results container as a transient failure', async () => {
    stubFetch(async () => new Response('<html><body>no markup</body></html>', { status: 200 }))
    await assert.rejects(
      new DdgSearchProvider(options).search({ query: 'q' }),
      rejectsWithCode('WEB_PROVIDER_ERROR', /no results markup/),
    )
  })

  it('treats an empty 200 body as a transient failure', async () => {
    stubFetch(async () => new Response('', { status: 200 }))
    await assert.rejects(
      new DdgSearchProvider(options).search({ query: 'q' }),
      rejectsWithCode('WEB_PROVIDER_ERROR', /no results markup/),
    )
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

  it('times out a hung request as a transient failure that consumes the budget', async () => {
    stubFetch(hangUntilAborted())
    const provider = new DdgSearchProvider({ ...options, timeoutMs: 1, failureThreshold: 1, cooldownMs: 60_000 })
    await assert.rejects(provider.search({ query: 'q' }), rejectsWithCode('WEB_PROVIDER_ERROR'))
    assert.equal(provider.available(), false, 'the timeout consumed the budget and opened the cooldown')
  })

  it('still maps a caller abort to WEB_ABORTED while a deadline is armed', async () => {
    stubFetch(hangUntilAborted())
    const provider = new DdgSearchProvider({ ...options, timeoutMs: 60_000 })
    const controller = new AbortController()
    const pending = provider.search({ query: 'q' }, controller.signal)
    controller.abort()
    await assert.rejects(pending, rejectsWithCode('WEB_ABORTED'))
  })

  it('fails fast without contacting the endpoint while on cooldown', async () => {
    stubFetch(async () => { throw new TypeError('connection refused') })
    const provider = new DdgSearchProvider({ ...options, failureThreshold: 1, cooldownMs: 60_000 })
    await assert.rejects(provider.search({ query: 'q' }), rejectsWithCode('WEB_PROVIDER_ERROR'))
    const calls = stubFetch(async () => htmlResponse(resultsPage()))
    await assert.rejects(
      provider.search({ query: 'q' }),
      rejectsWithCode('WEB_PROVIDER_ERROR', /on cooldown/),
    )
    assert.equal(calls.length, 0, 'a tripped breaker must not hit the endpoint')
  })

  it('rejects a direct search() call on a misconfigured endpoint with a structured error', async () => {
    stubFetch(async () => htmlResponse(resultsPage()))
    await assert.rejects(
      new DdgSearchProvider({ endpoint: 'not a url' }).search({ query: 'q' }),
      rejectsWithCode('WEB_PROVIDER_ERROR', /endpoint is not a usable/),
    )
  })

  it('returns empty sources for a served page whose rows all failed to map', async () => {
    stubFetch(async () => htmlResponse(`<div id="links">${organicRow(1)}</div>`))
    const result = await new DdgSearchProvider(options).search({ query: 'q' })
    assert.deepEqual(result.sources.map(source => source.url), ['https://plain.example/p1'])
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

  it('honors a configured maxResults through the seam', async () => {
    stubFetch(async () => htmlResponse(`<div id="links">${organicRow(1)}${organicRow(2)}${organicRow(3)}</div>`))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DDG_PROVIDER_ID })
    const fiber = await ctx.plugin(ddgPlugin, { maxResults: 2 })
    const result = await ctx.web.search({ query: 'q' })
    assert.deepEqual(result.sources.map(source => source.url), ['https://plain.example/p1', 'https://plain.example/p2'])
    await fiber.dispose()
  })

  it('has no default export (namespace plugin export shape)', () => {
    assert.equal('default' in ddgPlugin, false)
  })
})
