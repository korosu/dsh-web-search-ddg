import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DdgSearchProvider,
  mapEntries,
  parseResults,
  resolveDestination,
  toSource,
} from '../src/provider.ts'
import type { DdgRequestEvent } from '../src/provider.ts'

/**
 * Coverage for Chinese-language usage of the DuckDuckGo scrape provider —
 * how a user typing Chinese actually drives the plugin. The plugin ships a
 * Chinese README, so this is a first-class audience, yet the only non-ASCII
 * coverage elsewhere is Cyrillic (see `ddg.spec.ts`). Every class of Chinese
 * text is exercised across the whole path a query travels: query
 * percent-encoding (simplified, traditional, mixed CJK+ASCII, full-width
 * punctuation, CJK Extension-B astral characters, emoji), response parsing
 * (numeric and named HTML entities, CJK titles and snippets), redirect
 * decoding (percent-encoded, raw, and IDN Chinese URLs), the
 * `accept-language` knob a Chinese deployment configures, and the byte
 * accounting of a CJK response body.
 *
 * Like `ddg.spec.ts`, everything here is offline: `globalThis.fetch` is
 * stubbed and the exact request URL is asserted, so no expectation depends
 * on the network or on DuckDuckGo's serving.
 */

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

/** A served results page in the shape a Chinese query returns. */
function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init })
}

/** One organic Chinese result row: a zh.wikipedia redirect hop with CJK text. */
function cjkResultsPage(): string {
  return `
    <div id="links">
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fzh.wikipedia.org%2Fwiki%2F%E4%B8%AD%E6%96%87&rut=abc">中文（简体）</a>
          </h2>
          <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fzh.wikipedia.org%2Fwiki%2F%E4%B8%AD%E6%96%87&rut=abc">汉语文字，使用人数最多。</a>
        </div>
      </div>
    </div>`
}

/** Run one stubbed search and return the exact URL the provider fetched. */
async function fetchedUrlFor(query: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const calls = stubFetch(async () => htmlResponse(cjkResultsPage()))
  await new DdgSearchProvider({ ...options, ...overrides }).search({ query })
  assert.equal(calls.length, 1, 'exactly one request per search')
  return calls[0]?.url ?? ''
}

describe('CJK query percent-encoding', () => {
  it('percent-encodes a simplified-Chinese query as UTF-8', async () => {
    assert.equal(
      await fetchedUrlFor('中文搜索'),
      'https://html.duckduckgo.com/html/?q=%E4%B8%AD%E6%96%87%E6%90%9C%E7%B4%A2',
    )
  })

  it('percent-encodes a traditional-Chinese query as UTF-8', async () => {
    assert.equal(
      await fetchedUrlFor('繁體中文搜尋'),
      'https://html.duckduckgo.com/html/?q=%E7%B9%81%E9%AB%94%E4%B8%AD%E6%96%87%E6%90%9C%E5%B0%8B',
    )
  })

  it('keeps ASCII intact inside a mixed CJK + ASCII query', async () => {
    assert.equal(
      await fetchedUrlFor('Python 3 中文教程'),
      'https://html.duckduckgo.com/html/?q=Python+3+%E4%B8%AD%E6%96%87%E6%95%99%E7%A8%8B',
    )
  })

  it('percent-encodes full-width punctuation distinctly from its ASCII twin', async () => {
    // Full-width ＂ (U+FF02) and ＋ (U+FF0B) are different characters from
    // " and +: they must survive as their own UTF-8 sequences, and the
    // ASCII colons still encode, so the query round-trips unambiguously.
    assert.equal(
      await fetchedUrlFor('＂std::vector＂＋'),
      'https://html.duckduckgo.com/html/?q=%EF%BC%82std%3A%3Avector%EF%BC%82%EF%BC%8B',
    )
  })

  it('percent-encodes astral CJK Extension-B characters and emoji', async () => {
    // 𠮷 (U+20BB7, a surrogate pair) and 🚀 encode as 4-byte UTF-8
    // sequences; a broken encoder would mangle the pair into surrogates.
    assert.equal(
      await fetchedUrlFor('𠮷 🚀'),
      'https://html.duckduckgo.com/html/?q=%F0%A0%AE%B7+%F0%9F%9A%80',
    )
  })

  it('encodes a query mixing every Chinese character class at once', async () => {
    assert.equal(
      await fetchedUrlFor('中文搜索 繁體中文 Python 3 教程 𠮷 🚀 ＂std＂＋'),
      'https://html.duckduckgo.com/html/?q=%E4%B8%AD%E6%96%87%E6%90%9C%E7%B4%A2+%E7%B9%81%E9%AB%94%E4%B8%AD%E6%96%87+Python+3+%E6%95%99%E7%A8%8B+%F0%A0%AE%B7+%F0%9F%9A%80+%EF%BC%82std%EF%BC%82%EF%BC%8B',
    )
  })
})

describe('CJK response parsing', () => {
  it('decodes numeric and named HTML entities in title and snippet', () => {
    const page = `<div id="links">
      <div class="result results_links web-result">
        <h2 class="result__title"><a class="result__a" href="https://plain.example/zh">&#20013;&#25991;&#26816;&#32034;</a></h2>
        <a class="result__snippet" href="https://plain.example/zh">&#20013;&#25991;&#26159; &hellip; &amp; more</a>
      </div>
    </div>`
    assert.deepEqual(parseResults(page), [
      { rawHref: 'https://plain.example/zh', title: '中文检索', snippet: '中文是 … & more' },
    ])
  })

  it('carries a CJK title and snippet through search() to a normalized source', async () => {
    stubFetch(async () => htmlResponse(cjkResultsPage()))
    const result = await new DdgSearchProvider(options).search({ query: '中文' })
    assert.deepEqual(result.sources, [
      {
        url: 'https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87',
        title: '中文（简体）',
        snippet: '汉语文字，使用人数最多。',
      },
    ])
    assert.equal(result.truncated, false)
  })

  it('keeps a title made of a single astral character', () => {
    // 𠮷 is two UTF-16 code units; the blank-title check must not mistake
    // its length for emptiness or drop the row.
    assert.deepEqual(
      toSource({ rawHref: 'https://plain.example/astral', title: '𠮷', snippet: '' }),
      { url: 'https://plain.example/astral', title: '𠮷' },
    )
  })

  it('dedupes Chinese URLs that arrive encoded and raw', () => {
    // The percent-encoded hop and the raw-CJK hop canonicalize to the same
    // destination, so the dedupe must see them as one URL.
    const result = mapEntries([
      { rawHref: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fzh.wikipedia.org%2Fwiki%2F%E4%B8%AD%E6%96%87', title: '中文', snippet: '一' },
      { rawHref: '//duckduckgo.com/l/?uddg=https://zh.wikipedia.org/wiki/中文', title: '中文 重复', snippet: '二' },
    ])
    assert.deepEqual(result.sources.map(source => source.url), ['https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87'])
  })
})

describe('CJK redirect destinations', () => {
  it('decodes a percent-encoded Chinese destination from udfg', () => {
    assert.equal(
      resolveDestination('//duckduckgo.com/l/?uddg=https%3A%2F%2Fzh.wikipedia.org%2Fwiki%2F%E4%B8%AD%E6%96%87&rut=abc'),
      'https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87',
    )
  })

  it('canonicalizes a raw Chinese path in udfg to percent-encoded form', () => {
    assert.equal(
      resolveDestination('//duckduckgo.com/l/?uddg=https://zh.wikipedia.org/wiki/中文'),
      'https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87',
    )
  })

  it('punycodes a raw Chinese hostname and encodes its path', () => {
    assert.equal(
      resolveDestination('//duckduckgo.com/l/?uddg=http://中文.cn/路径'),
      'http://xn--fiq228c.cn/%E8%B7%AF%E5%BE%84',
    )
  })

  it('preserves Chinese characters in a destination query parameter', () => {
    assert.equal(
      resolveDestination('//duckduckgo.com/l/?uddg=https%3A%2F%2Fzh.wikipedia.org%2Fw%2Findex.php%3Fsearch%3D%E4%B8%AD%E6%96%87'),
      'https://zh.wikipedia.org/w/index.php?search=%E4%B8%AD%E6%96%87',
    )
  })
})

describe('CJK request configuration', () => {
  it('forwards a Chinese accept-language header when configured', async () => {
    const calls = stubFetch(async () => htmlResponse(cjkResultsPage()))
    await new DdgSearchProvider({ ...options, acceptLanguage: 'zh-CN,zh;q=0.9' }).search({ query: '中文搜索' })
    const headers = calls[0]?.init.headers as Record<string, string> | undefined
    assert.equal(headers?.['accept-language'], 'zh-CN,zh;q=0.9')
  })

  it('reports the UTF-8 byte size, not the string length, of a CJK page', async () => {
    // A Chinese page is ~3 UTF-8 bytes per character but 1 UTF-16 code
    // unit; the log event must report the real transfer size.
    const page = cjkResultsPage()
    const events: DdgRequestEvent[] = []
    stubFetch(async () => htmlResponse(page))
    await new DdgSearchProvider({ ...options, log: event => events.push(event) }).search({ query: '中文' })
    assert.equal(events[0]?.bytes, Buffer.byteLength(page))
    assert.ok(events[0]!.bytes > page.length, 'CJK page bytes must exceed its UTF-16 length')
  })
})
