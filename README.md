# dsh-web-search-ddg

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

English | [中文](README.zh-CN.md)

## Summary

An out-of-tree [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) bundle that swaps the backend behind the built-in `web_search` tool for a scrape of DuckDuckGo's static `html.duckduckgo.com` results page: no API key, no auxiliary model request, no tokens billed per query. It registers as the `ddg` search provider on the `ctx.web` seam, so the model-facing `web_search` tool keeps its exact schema and presentation.

Choose it when a deployment has no search key to spend — or treats a per-query model turn as too expensive — and the target network is not routinely challenged. The model-facing tool lives in `dsh-tool-web`; this package only contributes a backend.

## Install

One command. Nothing else needs editing.

```bash
dsh plugin --profile web add github:korosu/dsh-web-search-ddg
```

A local clone installs the same way — point the command at the checkout:

```bash
dsh plugin --profile web add /path/to/dsh-web-search-ddg
```

That is all of it, because `dsh plugin add` does the whole job on its own:

1. It initializes the profile at `$DSH_HOME/profiles/web` if the profile does not exist yet.
2. It forwards to `pnpm` in the profile directory, so the package and its runtime dependencies (`cheerio`, `@deepseek-ai/schemastery`) are installed.
3. It reads this package's `dsh.bundle.patch` declaration and appends `dsh-web-search-ddg` to the profile's `dsh.profile.bundles` list.
4. The loader then applies `cordis.patch.yml` as a patch layer, which mounts the provider and flips the search pin.

You do **not** edit the profile's own `cordis.patch.yml` — that would only shadow the bundle's layer. Verify without booting, then restart the host (host-side plugin rows do not hot-reload):

```bash
dsh --profile web --dump-config | grep -A2 searchProvider
dsh web
```

You should see a layer marked `# == dsh-web-search-ddg` and `searchProvider: ddg`.

### How the bundle changes the composition

`cordis.patch.yml` carries two rows:

- an `insert` that mounts this package, registering the `ddg` search provider;
- an override of the base `web` row that pins `searchProvider: ddg`.

A patch row **replaces the target row's whole `config`** — there is no deep merge — so the override must restate every key the base row owns. The shipped base row (`@deepseek-ai/dsh-base`) owns both `searchProvider` and `fetchProvider`, which is why the row carries `fetchProvider: http` even though the fetch backend is unchanged.

### Reverting

Either way is a one-line operation.

```bash
dsh plugin --profile web remove dsh-web-search-ddg
```

or keep the bundle installed and restore the shipped backend in the profile's own `cordis.patch.yml`:

```yaml
- id: web
  config:
    searchProvider: deepseek-official
    fetchProvider: http
```

Nothing is deleted on either side of the switch: the shipped `web-search-deepseek` row stays mounted, so the DeepSeek backend remains registered and usable.

### The build-script catch

A local directory install needs no build permission: `lib/` ships prebuilt and a `link:` dependency does not run lifecycle scripts.

It does, however, need the plugin's own `node_modules`. A `link:` install is a symlink, and Node resolves a module's imports from that module's *real* path — so `cheerio` and `@deepseek-ai/schemastery` are looked up in the plugin directory, not in the profile's `node_modules`. Run `pnpm install` in the plugin directory once; `lib/` is committed so no build follows, but deleting `node_modules` and skipping the install breaks the provider at load time with `ERR_MODULE_NOT_FOUND`.

Installing from a GitHub source is the default above, and it is different from a local directory: pnpm fetches sources rather than built artifacts and then runs the package's `prepare` script to build `lib/`, but pnpm ≥ 10 refuses to run a git dependency's `prepare` until it is explicitly allowed. Add the exact key pnpm prints to the profile's `pnpm-workspace.yaml`, then re-run the `add`:

```yaml
allowBuilds:
  dsh-web-search-ddg: true
```

Treat that as permission to execute this package's code on your machine at install time, outside any sandbox the agent runs under. Prefer a local path or a tarball when you would rather not grant it; pin a commit (`github:korosu/dsh-web-search-ddg#<sha>`) if you do.

A tarball needs no allowance if it was packed after `pnpm build` — `lib/` is already inside it.

## Configuration

All keys are optional; write them in the `insert` row's `config`.

| Key | Default | Description |
| --- | --- | --- |
| `endpoint` | `https://html.duckduckgo.com/html/` | Results endpoint; `?q=` is appended. Must be an absolute `http(s)` URL; anything else makes the provider unavailable |
| `maxResults` | (unset) | Row bound applied while parsing, and only when the request carries no `maxResults`. Must be a positive integer; anything else makes the provider unavailable. It counts parsed rows, so junk rows early in the page can push valid ones past the cut |

There is no credential of any kind — the provider is inherently keyless, so there is no settings card, no API key field, and no credential-resolution step.

### What a search returns

Each row of the results page maps to a `WebSearchSource`: `url`, `title`, and, when non-blank, `snippet`. A row with a blank title or an unusable URL is dropped, and duplicates collapse to their first-seen URL, so a call can return fewer sources than requested.

DDG result links are protocol-relative redirect hops (`//duckduckgo.com/l/?uddg=<encoded>&rut=...`). The provider decodes `uddg` back to the real destination, so the tool cites the actual page rather than the intermediate URL. This is a pure string operation — a result hop is never fetched.

The provider always reports `truncated: false`. When a request carries `maxResults`, the provider caps its own parse at that number, so it never over-returns and the seam has nothing to truncate — the flag stays `false` even when the page held more rows than you asked for. A *configured* `maxResults` applies the same way, while parsing, and is invisible to the caller. DDG's static markup carries no generated answer and no publication date, so neither `content` nor `publishedAt` is ever emitted.

### Failures and recovery

| Situation | Outcome |
| --- | --- |
| HTTP non-2xx | `WebError` `WEB_PROVIDER_ERROR` |
| Network failure, unreadable body | `WebError` `WEB_PROVIDER_ERROR` |
| Aborted request | `WebError` `WEB_ABORTED` |
| Challenge / anomaly page (HTTP 202, no result markup) | **empty result, not an error** |
| `endpoint` not an absolute `http(s)` URL, or `maxResults` not a positive integer | `WebError` `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` — registered, but refuses to run |
| Pin kept, bundle removed | `WebError` `WEB_PROVIDER_CONFIGURED_MISSING` |
| Pin removed while both search backends are registered | `WebError` `WEB_PROVIDER_AMBIGUOUS` |

HTTP redirects are followed by the native fetch, because the endpoint moves between the bare domain and the `html/` path. An abort — a `DOMException` named `AbortError`, or an already-aborted signal — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

There is **no silent fallback**. This provider either serves results or reports a structured error, and nothing stands behind it. A deployment that needs guaranteed coverage should pin `searchProvider` to a keyed backend instead.

## Implementation

Three deliberate rules:

- **Cite the destination, not the hop.** Decoding `uddg` keeps the model and the UI pointing at the real page with no extra request.
- **Never invent fields.** A blank title drops the row and a blank snippet is omitted rather than set empty, so the seam never presents a fabricated value.
- **No silent fallback.** Selection stays the seam's job; this package never substitutes another engine.

Flow: `search()` appends `q=` to the configured endpoint and issues a GET with a desktop Chrome user agent and `redirect: 'follow'`, forwarding the caller's `AbortSignal` to the fetch. The body is parsed with Cheerio — rows under `#links .result`, the title in `a.result__a`, the snippet in `a.result__snippet` — with an optional row cap applied while parsing as a cost optimization. Surviving rows are normalized, deduped by URL in page order, and returned.

| File | Role |
| --- | --- |
| `src/index.ts` | Plugin entry: config schema, provider registration |
| `src/provider.ts` | `DdgSearchProvider`: request dispatch, abort classification, row parsing, redirect decoding, result mapping |
| `src/types.ts` | Scraped-row vocabulary: `DdgScrapeEntry` |
| `cordis.patch.yml` | The bundle's config layer, applied by the loader |

## Known Limitations

These limits define when the provider is a poor fit.

- **A challenge or anomaly page returns an empty result, not an error** — HTTP 202 with no `#links .result` rows parses to zero sources, so a rate-limited deployment reads "no results" and cannot distinguish throttling from a genuinely empty query. There is no fallback to another engine.
- **Scraped markup is brittle** — selector drift upstream degrades to empty results rather than a structured failure, so markup changes look like a poor query.
- **A row with a blank title or unusable URL is dropped** — there is no portable value to map, so fewer sources than requested can return.
- **`truncated` is never `true`** — the provider caps its parse at `request.maxResults` (or the configured default), so the seam never sees an over-return and never flips the flag. A caller cannot tell that a page held more results than it received; request more rows if you need to know.
- **The `uddg` redirect is decoded one level** — a hop whose decoded target is itself a DDG redirect is returned unwrapped, so a double-nested hop surfaces as an intermediate URL rather than the final page.
- **No `publishedAt`, no `content`** — the static markup carries neither, so publication-date filtering and provider answers are unavailable; the keyed backends do expose them.
- **Only `endpoint`/`maxResults` are exposed** — region, safesearch, time and type filters, and paging have no provider-neutral service fields to hang on yet.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError`, or an already-aborted signal, maps to `WEB_ABORTED`; an abort carrying a custom reason surfaces as `WEB_PROVIDER_ERROR`.
- **Unauthenticated scraping carries terms-of-service risk** — high-volume deployments should use a licensed or first-party backend.

## Development

Node ≥ 22 to run; the test scripts use Node's native TypeScript support (no bundler, fully in-process), so they need type stripping enabled (≥ 22.18) and run every file in one process through `--experimental-test-isolation=none` (≥ 22.8; the unprefixed name only exists on Node 24+) — Node 24 recommended.

The dev dependencies pin the seam line under test: `@deepseek-ai/dsh-web@0.2.0-rc.1` with `@deepseek-ai/cordis ~4.0.4` and `@deepseek-ai/schemastery ~3.18.4`, matching what dsh 0.2.0-rc.1 ships (see the Dev Note on the dsh peer range).

```bash
pnpm install
pnpm test          # unit + integration, offline (fetch stubbed); 36 tests
DDG_E2E=1 pnpm test:e2e   # real-network smoke; self-skips without the flag
pnpm typecheck
pnpm peers check   # peer-range sanity against the installed seam line
pnpm build         # emits lib/ via tsc
```

CI runs the same offline set on every push and pull request (`typecheck`, `test`, `peers check`, `build`) and fails if a rebuild makes the committed `lib/` differ from `src/`, so a stale prebuilt artifact can never land on `main`.

The integration tests mount the real plugin into a real `@deepseek-ai/cordis` `Context` with the real `@deepseek-ai/dsh-web` `WebRuntime`, stub only `globalThis.fetch`, and assert both the successful selection and the HMR-safe unregistration. `lib/` is committed so a local path install never needs to build; run `pnpm build` before repacking a tarball.

## Dev Note

Working context for maintainers. Non-authoritative — shipped behavior lives in the sections above.

### Bundled provider vs. sibling shape

The shipped web providers (`web-search-exa`, `web-search-deepseek`, `web-search-perplexity`) are plain provider packages that a composition mounts with an explicit row. This package instead ships a `dsh.bundle` patch, so `dsh plugin add` switches the search backend in one command, at the cost of being the only provider that overrides the base `web` row. Moving to the sibling shape means dropping the `dsh.bundle` declaration and `cordis.patch.yml`, then letting each deployment mount the provider row and pin `searchProvider` itself.

### Ambiguity after an explicit unpin

`dsh-base` already mounts `web-search-deepseek`, so installing this bundle registers two usable search backends. The bundle pins `searchProvider: ddg`, which avoids `WEB_PROVIDER_AMBIGUOUS`; a deployment that overrides the `web` row with an empty `config` removes that pin and hits the ambiguity error instead.

### dsh peer range and the compatibility gate

`@deepseek-ai/dsh-web` is a peer because the seam — its `WebRuntime` service and vocabulary — is owned by the host, not by this package. Before any plugin code loads, dsh reads this manifest's peer range and skips the bundle when the running runtime does not satisfy it (`evaluatePluginCompatibility` in `packages/boot/app-boot`), so a stale range disables the bundle even when the code still matches the seam. The gate looks only at `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peers, compares against the runtime's exact version, and includes prereleases in ranges — the `cordis` peer is not gated.

The range covers the two seam lines this provider works against: `^0.1.2-rc.1 || ^0.2.0-rc.1`. The provider contract it relies on — `WebSearchProvider` (`id` / `available()` / `search()`), the `WebSearchRequest` / `WebSearchResult` / `WebSearchSource` vocabulary, `WebError`, and `ctx.web.registerSearchProvider` — is unchanged across those lines, which is why the 0.2.0-rc.1 fix changed only the manifest, not a line of source. The dev dependency pins the line under test, so `pnpm install` after a peer-range edit is what keeps the local seam copy honest.

`schemastery` is a *dependency*, not a peer, and its range must track the seam's own `schemastery` dependency rather than lag it. Every copy of schemastery merges one global `Schemastery` namespace, so when the seam's 0.2.0 copy declares a three-parameter `Schema` with volatile modes while this package's copy still declares two parameters, `pnpm typecheck` fails on the `Config` schema in `src/index.ts` under `exactOptionalPropertyTypes` — even though nothing in that line imports the seam. `~3.18.4` and `~4.0.4` for cordis are the 0.2.0-rc.1 line's own pins; `pnpm peers check` should report no issues.

When the seam ships a new line, verify against it first, then widen the range, then bump this package's version. The stopgap for a range you must accept without editing the declaration is the exact-version exemption: `dsh plugin --profile web allow-version dsh-web-search-ddg@<version> --dsh-version <runtime> --accept-risk` grants permission for one plugin/runtime pair instead of fixing the declaration.

### Duplicate module copies in an out-of-tree install

An out-of-tree bundle resolves its imports from the profile's `node_modules`, so the plugin ends up with its own copies of `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-web` alongside the host's vendored ones. Neither duplication breaks it, but for different reasons worth knowing:

- `schemastery` brands its objects with `Symbol.for("schemastery")`, a global-registry symbol, so a `Config` schema built by the profile's copy is still recognized as a schemastery schema by the host's copy.
- `WebError` is a runtime import (the provider throws it), so two class objects exist. Nothing consumes it with `instanceof` — the seam and `dsh-tool-web` route on the string `code` — so the split is inert today. A future consumer that does an `instanceof` check would break; if you ever need to care, rethrowing the seam's own error instead of constructing one closes it.

## License

[MIT](LICENSE)
