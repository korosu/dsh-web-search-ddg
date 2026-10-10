# dsh-web-search-ddg

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/release/korosu/dsh-web-search-ddg?label=release)](https://github.com/korosu/dsh-web-search-ddg/releases/latest)
[![dsh tested](https://img.shields.io/badge/dsh%20tested-0.2.0--rc.1-3068a8?logo=deepseek&logoColor=white)](#version-compatibility)
![node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)

English | [中文](README.zh-CN.md)

## Summary

An out-of-tree [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) bundle that swaps the backend behind the built-in `web_search` tool for a scrape of DuckDuckGo's static `html.duckduckgo.com` results page: no API key, no auxiliary model request, no tokens billed per query. It registers as the `ddg` search provider on the `ctx.web` seam, so the model-facing `web_search` tool keeps its exact schema and presentation.

Choose it when a deployment has no search key to spend — or treats a per-query model turn as too expensive. Repeated throttling trips a failure budget that makes the provider step aside for a cooldown, so a challenged network degrades into the seam's provider selection instead of silently empty results. The model-facing tool lives in `dsh-tool-web`; this package only contributes a backend.

## Install

One command. Nothing else needs editing.

```bash
dsh plugin --profile web add github:korosu/dsh-web-search-ddg
```

A local clone installs the same way — point the command at the checkout:

```bash
dsh plugin --profile web add /path/to/dsh-web-search-ddg
```

The release tarball installs from a URL that never changes with the version, because every release attaches it under the same stable name:

```bash
dsh plugin --profile web add https://github.com/korosu/dsh-web-search-ddg/releases/latest/download/dsh-web-search-ddg.tgz
```

Swap `latest` for a tag to pin (`.../releases/download/v0.1.5/dsh-web-search-ddg.tgz`). All three forms install the same prebuilt `lib/`; only the source differs.

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

### Why no build permission is needed

`lib/` ships prebuilt in the repository — it is committed, not generated at install time — and the package declares no `prepare` script, so installing from a GitHub source, a local path, or a tarball never executes a build for this package. There is no `allowBuilds` entry to add and no lifecycle script runs on your machine at install time.

A local directory install is a `link:` dependency, which does not run lifecycle scripts either. It does, however, need the plugin's own `node_modules`: a symlink resolves a module's imports from that module's *real* path, so `cheerio` and `@deepseek-ai/schemastery` are looked up in the plugin directory, not in the profile's `node_modules`. Run `pnpm install` in the plugin directory once — `lib/` is committed, so no build follows — but deleting `node_modules` and skipping the install breaks the provider at load time with `ERR_MODULE_NOT_FOUND`.

To pin what you install, pin a commit (`github:korosu/dsh-web-search-ddg#<sha>`); the tarball attached to a GitHub release carries the same prebuilt `lib/` as that commit.

### Profile-level peer warnings

A profile is a pnpm workspace that resolves with `autoInstallPeers: false`, so `dsh plugin add` may print a warning that this plugin's peers (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-web`) are not found at the profile level. The warning is cosmetic — the running host supplies both from its own tree, and the plugin resolves them through it — but it can be silenced in the profile's `pnpm-workspace.yaml`:

```yaml
peerDependencyRules:
  ignoreMissing:
    - '@deepseek-ai/cordis'
    - '@deepseek-ai/dsh-*'
```

## Configuration

All keys are optional; write them in the `insert` row's `config`.

| Key | Default | Description |
| --- | --- | --- |
| `endpoint` | `https://html.duckduckgo.com/html/` | Results endpoint; `?q=` is appended. Must be an absolute `http(s)` URL; anything else makes the provider unavailable |
| `maxResults` | (unset) | Bound on **usable** sources, applied after rows with blank titles, unusable URLs, sponsored rows, and duplicates are dropped; only takes effect when the request carries no `maxResults`. Must be a positive integer; anything else makes the provider unavailable |
| `failureThreshold` | `3` | Consecutive transient failures after which the provider reports itself unavailable and lets the seam pick another backend. Must be a positive integer |
| `cooldownMs` | `300000` (5 min) | How long that unavailability lasts, in milliseconds. Must be a positive integer |

There is no credential of any kind — the provider is inherently keyless, so there is no settings card, no API key field, and no credential-resolution step.

### Selecting a provider

The bundle's `web` row override pins `searchProvider: ddg`, which is what makes the one-command install switch the backend. The seam also honors an environment variable with the same meaning — setting

```bash
export DSH_WEB_SEARCH_PROVIDER=ddg
```

pins the provider without touching any patch row; the config key wins when both are set. Pinning matters when more than one search backend is registered: with the pin (either form) the seam resolves to `ddg`, without it two usable backends raise `WEB_PROVIDER_AMBIGUOUS`. The same applies to fetching through `DSH_WEB_FETCH_PROVIDER`, which this bundle leaves at the shipped `http` backend.

### What a search returns

Each row of the results page maps to a `WebSearchSource`: `url`, `title`, and, when non-blank, `snippet`. A row with a blank title or an unusable URL is dropped, and duplicates collapse to their first-seen URL, so a call can return fewer sources than requested.

DDG result links are protocol-relative redirect hops (`//duckduckgo.com/l/?uddg=<encoded>&rut=...`). The provider decodes the redirect parameter back to the real destination, so the tool cites the actual page rather than the intermediate URL. This is a pure string operation — a result hop is never fetched. A hop whose decoded target is itself a DDG redirect is unwrapped too (up to three levels), and the final destination is returned canonicalized — re-parsed through `URL` — so the consumer always receives a valid absolute URL.

Sponsored rows — any row carrying a `result--ad*` class — are skipped during parsing: they are paid placements, not organic results, and their links point at a `duckduckgo.com/y.js?...&u3=<encoded>` tracking hop rather than a citation target. Should a sponsored row slip past the class filter after upstream markup drift, the hop decoder unwraps the `u3` carrier the same way as `uddg`; a `y.js` link that cannot be unwrapped to an `http(s)` destination drops the row instead of citing a tracking URL.

The provider always reports `truncated: false`. When a request carries `maxResults`, the provider caps its **usable** output at that number — junk rows and duplicates never consume the bound — so it never over-returns and the seam has nothing to truncate: the flag stays `false` even when the page held more rows than you asked for. A *configured* `maxResults` applies the same way and is invisible to the caller. DDG's static markup carries no generated answer and no publication date, so neither `content` nor `publishedAt` is ever emitted.

### Failures and recovery

| Situation | Outcome |
| --- | --- |
| Network failure, unreadable body | `WebError` `WEB_PROVIDER_ERROR`, counted toward the failure budget |
| HTTP 403 / 429 / 5xx | `WebError` `WEB_PROVIDER_ERROR`, counted toward the failure budget |
| Any other HTTP non-2xx | `WebError` `WEB_PROVIDER_ERROR`, **not counted** — a configuration-style failure retries identically |
| Challenge / anomaly page (HTTP 202, no result markup) | `WebError` `WEB_PROVIDER_ERROR` naming the anomaly page, counted toward the failure budget |
| Aborted request | `WebError` `WEB_ABORTED`, never counted |
| Failure budget spent (`failureThreshold` consecutive transient failures) | The provider reports itself unavailable for `cooldownMs`. A pinned deployment sees `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`; an unpinned one falls back to any other registered backend, or gets `WEB_PROVIDER_UNAVAILABLE` if there is none |
| `endpoint` not an absolute `http(s)` URL, or a numeric config not a positive integer | `WebError` `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` — registered, but refuses to run |
| Pin kept, bundle removed | `WebError` `WEB_PROVIDER_CONFIGURED_MISSING` |
| Pin removed while both search backends are registered | `WebError` `WEB_PROVIDER_AMBIGUOUS` |

HTTP redirects are followed by the native fetch, because the endpoint moves between the bare domain and the `html/` path. An abort — a `DOMException` named `AbortError`, or an already-aborted signal — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

**The failure budget is the throttling signal.** A challenge page, a rate limit, or a transport failure is distinguishable from a genuinely empty query: the empty query returns an empty result, throttling raises a structured error, and once the same kind of failure repeats `failureThreshold` times in a row the provider stops offering itself for `cooldownMs` so the seam can route around it. Any success — including a genuinely empty result — clears the counter, and when the cooldown elapses the provider comes back with a fresh budget rather than staying tripped.

There is **no silent fallback** *inside* the provider: it never substitutes another engine itself. Routing around a cooled-down provider is the seam's selection job, and it only happens for deployments that did not pin `ddg`. A pinned deployment gets the structured error instead — pinning is a deliberate choice to hear about every failure.

## Version compatibility

The package claims dsh releases carrying `@deepseek-ai/dsh-web` `^0.2.0-rc.1 || ^0.2.1-alpha.1` with `@deepseek-ai/cordis` `~4.0.4 || ~4.0.5-alpha.1`. dsh reads the range before any plugin code loads and skips the bundle when the running runtime does not satisfy it, so the claim is also a hard gate.

| dsh release | What was verified |
| --- | --- |
| `0.2.0-rc.1` | Full path: installed through `dsh plugin add` into a real profile, booted, and answering live queries |
| `0.2.0-rc.2` | Contract suite (typecheck + 44 offline tests) against that seam, via `pnpm compat` |
| `0.2.1-alpha.1` | Contract suite (typecheck + 44 offline tests) against that seam, via `pnpm compat` |

Two consequences of semver prerelease rules shape the declared range:

- A caret range only matches a prerelease when one of its comparators carries a prerelease on the same `[major, minor, patch]` tuple, which is why `^0.2.0-rc.1` covers `0.2.0-rc.2` but not `0.2.1-alpha.1` — the latter needs its own clause.
- The same rule splits cordis: `~4.0.4` does not match `4.0.5-alpha.1` (what the 0.2.1-alpha seam ships), so the cordis peer carries a parallel clause instead of a silent mismatch.

The 0.1.x seam lines are **not claimed**, deliberately. The provider contract itself still passes against them (`pnpm compat` runs the suite against 0.1.5-rc.3 and 0.1.7-rc.2 as canaries), but the bundle-patch path — overriding the base `web` row — depended on loader behavior that was buggy there (`duplicate loader entry id: web`, fixed in dsh 0.1.4) and is unverified end to end on any 0.1.x profile.

`package.json` also records the claimed releases under `dsh.compatibility.dshReleases` — catalog metadata for plugin registries; the runtime does not read it. Re-verify and extend the table before widening anything: `pnpm compat` (needs bash) installs each seam version in a throwaway project, runs the same contract suite, and reports whether the version is inside the declared range.

## Implementation

Three deliberate rules:

- **Cite the destination, not the hop.** Decoding `uddg` — and the sponsored `y.js`/`u3` carrier, nested up to three levels — keeps the model and the UI pointing at the real page with no extra request.
- **Never invent fields.** A blank title drops the row and a blank snippet is omitted rather than set empty, so the seam never presents a fabricated value.
- **No silent fallback.** Selection stays the seam's job; this package never substitutes another engine.

Flow: `search()` appends `q=` to the configured endpoint and issues a GET with a desktop Chrome user agent and `redirect: 'follow'`, forwarding the caller's `AbortSignal` to the fetch. The body is parsed with Cheerio — rows under `#links .result`, the title in `a.result__a`, the snippet in `a.result__snippet`, sponsored rows (`result--ad*`) skipped — and the survivors are bounded to `maxResults` after normalization, so junk rows and duplicates never consume the bound. Surviving rows are normalized, deduped by URL in page order, and returned; any failure on the way is classified by retryability and consumes — or spares — the failure budget described above.

| File | Role |
| --- | --- |
| `src/index.ts` | Plugin entry: config schema, provider registration |
| `src/provider.ts` | `DdgSearchProvider`: request dispatch, abort classification, failure budget, row parsing, redirect decoding, result mapping |
| `src/types.ts` | Scraped-row vocabulary: `DdgScrapeEntry` |
| `cordis.patch.yml` | The bundle's config layer, applied by the loader |

## Known Limitations

These limits define when the provider is a poor fit.

- **Anomaly detection is signature-based** — only the HTTP 202 + no-`#links .result` signature counts as throttling and trips the failure budget. A challenge page served over HTTP 200 with no rows still parses to zero sources and reads as a genuinely empty query.
- **No retry inside the provider** — a single transient failure surfaces to the caller as a structured error; only repetition (the budget) makes the provider step aside. Deciding whether to retry one failed query is the caller's job.
- **Scraped markup is brittle** — selector drift upstream on an HTTP 200 page degrades to empty results rather than a structured failure, so markup changes look like a poor query.
- **A row with a blank title or unusable URL is dropped** — there is no portable value to map, so fewer sources than requested can return.
- **`truncated` is never `true`** — the provider caps its usable output at `request.maxResults` (or the configured default), so the seam never sees an over-return and never flips the flag. A caller cannot tell that a page held more results than it received; request more rows if you need to know.
- **No `publishedAt`, no `content`** — the static markup carries neither, so publication-date filtering and provider answers are unavailable; the keyed backends do expose them.
- **Query shaping is not exposed** — region, safesearch, time and type filters, and paging have no provider-neutral service fields to hang on yet; the config surface covers `endpoint`, `maxResults`, and the failure-budget knobs.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError`, or an already-aborted signal, maps to `WEB_ABORTED`; an abort carrying a custom reason surfaces as `WEB_PROVIDER_ERROR`.
- **Unauthenticated scraping carries terms-of-service risk** — high-volume deployments should use a licensed or first-party backend.

## Development

Node ≥ 22 to run; the test scripts use Node's native TypeScript support (no bundler, fully in-process), so they need type stripping enabled (≥ 22.18) and run every file in one process through `--experimental-test-isolation=none` (≥ 22.8; the unprefixed name only exists on Node 24+) — Node 24 recommended.

The dev dependencies pin the seam line under test: `@deepseek-ai/dsh-web@0.2.0-rc.1` with `@deepseek-ai/cordis ~4.0.4` and `@deepseek-ai/schemastery ~3.18.4`, matching what dsh 0.2.0-rc.1 ships (see the Dev Note on the dsh peer range).

```bash
pnpm install
pnpm test          # unit + integration, offline (fetch stubbed); 44 tests
DDG_E2E=1 pnpm test:e2e   # real-network smoke; self-skips without the flag
pnpm typecheck
pnpm peers check   # peer-range sanity against the installed seam line
pnpm compat        # seam-version matrix; needs bash and registry access
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

The range covers the 0.2.x seam lines this provider is verified against: `^0.2.0-rc.1 || ^0.2.1-alpha.1` for dsh-web, `~4.0.4 || ~4.0.5-alpha.1` for cordis. The provider contract it relies on — `WebSearchProvider` (`id` / `available()` / `search()`), the `WebSearchRequest` / `WebSearchResult` / `WebSearchSource` vocabulary, `WebError`, and `ctx.web.registerSearchProvider` — is unchanged across those lines, and `pnpm compat` proves it per release: it installs each seam version in a throwaway project with the cordis that line itself wants, runs typecheck plus the offline suite, and checks the packed tarball against the declared range through `pnpm peers check` (the only reliable oracle — `pnpm add` warns instead of failing, and `--config.strict-peer-dependencies` is not honored on `add`). The dev dependency pins the line under test, so `pnpm install` after a peer-range edit is what keeps the local seam copy honest.

The 0.1.x lines are excluded on purpose. Their seam contract still passes (the matrix runs 0.1.5-rc.3 and 0.1.7-rc.2 as canaries), but this bundle's row override depends on loader behavior that was buggy there — re-defining the base `web` row produced `duplicate loader entry id: web` until dsh 0.1.4 — and no 0.1.x profile boot has been verified, so the claim would outrun the evidence.

`schemastery` is a *dependency*, not a peer, and its range must track the seam's own `schemastery` dependency rather than lag it. Every copy of schemastery merges one global `Schemastery` namespace, so when the seam's 0.2.0 copy declares a three-parameter `Schema` with volatile modes while this package's copy still declares two parameters, `pnpm typecheck` fails on the `Config` schema in `src/index.ts` under `exactOptionalPropertyTypes` — even though nothing in that line imports the seam. `~3.18.4` and `~4.0.4` for cordis are the 0.2.0-rc.1 line's own pins; the 0.2.1-alpha line ships `~3.18.5-alpha.1` schemastery (its own copy coexists through the global registry) and `~4.0.5-alpha.1` cordis, which is why the cordis peer carries a parallel clause — `~4.0.4` cannot semver-match `4.0.5-alpha.1`. `pnpm peers check` should report no issues.

When the seam ships a new line, verify against it first (`pnpm compat <version>`), then widen the range, update `dsh.compatibility.dshReleases`, and bump this package's version. The stopgap for a range you must accept without editing the declaration is the exact-version exemption: `dsh plugin --profile web allow-version dsh-web-search-ddg@<version> --dsh-version <runtime> --accept-risk` grants permission for one plugin/runtime pair instead of fixing the declaration.

### Duplicate module copies in an out-of-tree install

An out-of-tree bundle resolves its imports from the profile's `node_modules`, so the plugin ends up with its own copies of `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-web` alongside the host's vendored ones. Neither duplication breaks it, but for different reasons worth knowing:

- `schemastery` brands its objects with `Symbol.for("schemastery")`, a global-registry symbol, so a `Config` schema built by the profile's copy is still recognized as a schemastery schema by the host's copy.
- `WebError` is a runtime import (the provider throws it), so two class objects exist. Nothing consumes it with `instanceof` — the seam and `dsh-tool-web` route on the string `code` — so the split is inert today. A future consumer that does an `instanceof` check would break; if you ever need to care, rethrowing the seam's own error instead of constructing one closes it.

## License

[MIT](LICENSE)
