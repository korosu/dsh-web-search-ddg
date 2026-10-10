# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.5] - 2026-10-09

### Added

- Live e2e case matrix (`DDG_E2E=1`): an English query, a Cyrillic query
  (non-ASCII percent-encoding through the live endpoint), operators and
  special characters, the `site:` operator, a `maxResults` cap check, and a
  no-results query that must stay a well-formed empty answer rather than an
  error. Live queries are paced 10s apart — DDG answers request bursts from
  one IP with the HTTP 202 anomaly page, and the suite must exercise result
  parsing rather than the throttle path. A lone anomaly page is retried once
  after a full gap (DDG issues the challenge intermittently to a single
  request even while serving its neighbors), and when the retry draws the
  anomaly again the case self-skips with the reason: a persistent DDG-side
  challenge is an environment condition, not a provider defect. Any other
  error, and any assertion over a served page, still fails the run.
- Unit tests for query percent-encoding (special characters such as `C++`
  quotes and colons, and Cyrillic) in the request-mapping suite, pinning the
  exact wire URL `searchParams` produces.

## [0.1.4] - 2026-10-08

### Added

- Failure budget (circuit breaker): transport failures, unreadable bodies,
  HTTP 403/429/5xx, and the DDG anomaly page (HTTP 202 with no result markup)
  now count as transient failures; after `failureThreshold` (default 3)
  consecutive ones the provider reports itself unavailable for `cooldownMs`
  (default 5 min) so the seam can route to another backend, and any success
  resets the counter. The anomaly page previously parsed to an empty result,
  which made throttling indistinguishable from a genuinely empty query — it
  now raises a `WEB_PROVIDER_ERROR` naming the anomaly page.
- Config keys `failureThreshold` and `cooldownMs` for the budget, validated as
  positive integers like the existing numeric keys.
- `dsh.compatibility.dshReleases` catalog metadata (dsh 0.2.0-rc.1, 0.2.0-rc.2,
  0.2.1-alpha.1) for plugin registries; the runtime does not read it.
- `pnpm compat` (`scripts/compat-matrix.sh`): installs each seam version in a
  throwaway project with the cordis that line itself wants, typechecks and
  runs the offline suite against it, and reports whether the version is
  inside the declared peer range.
- Release assets now carry a stable name (`dsh-web-search-ddg.tgz`), so the
  tarball installs from a version-independent URL:
  `dsh plugin add .../releases/latest/download/dsh-web-search-ddg.tgz`.
- README: selecting a provider through `$DSH_WEB_SEARCH_PROVIDER`, the
  profile-level `peerDependencyRules.ignoreMissing` recipe, and a Version
  compatibility section with the verification level of each claimed release.

### Changed

- Peer range narrowed and made evidence-based: `@deepseek-ai/dsh-web`
  `^0.2.0-rc.1 || ^0.2.1-alpha.1` (was `^0.1.2-rc.1 || ^0.2.0-rc.1`) — the
  0.1.x claim was never verified and the bundle's base-row override depended
  on loader behavior that was buggy there (`duplicate loader entry id: web`,
  fixed in dsh 0.1.4). The cordis peer gained a parallel clause
  (`~4.0.4 || ~4.0.5-alpha.1`) because `~4.0.4` cannot semver-match the
  `4.0.5-alpha.1` that the 0.2.1-alpha seam ships.

## [0.1.3] - 2026-10-08

### Changed

- Dropped the `prepare` script. `lib/` is committed rather than generated, so a
  build at install time only rebuilt identical output — and pnpm ≥ 10 blocks a
  git dependency's `prepare` until the package is added to `allowBuilds`, which
  forced every user installing from a GitHub source to edit their profile's
  `pnpm-workspace.yaml` first. Installing from a GitHub source, a local path,
  or a release tarball now runs no lifecycle script at all. `prepack` still
  builds, so packed tarballs stay self-contained.

## [0.1.2] - 2026-10-08

### Fixed

- Test scripts now pass `--experimental-test-isolation=none` instead of the
  unprefixed `--test-isolation=none`, which only exists on Node 24+ and made
  `pnpm test` abort with `bad option` on Node 22.

### Changed

- Removed the in-tree README front matter (`description` / `kind:
  "package-reference"`). It is metadata for the DeepSeek Harness in-tree doc
  pipeline; GitHub renders front matter as a table above the README body, and
  the `description` sentence duplicated `package.json`.
- Removed the "If this ever goes upstream" maintainer note from both READMEs —
  it described in-tree publication steps that do not apply to this repository.

## [0.1.1] - 2026-10-08

### Added

- `ddg` DuckDuckGo HTML-scrape `WebSearchProvider` registered on the `ctx.web`
  seam, shipped as a `dsh.bundle` patch so `dsh plugin add` switches the backend
  behind the model-facing `web_search` tool in one command.
- Optional `endpoint` and `maxResults` config keys on the bundle's insert row,
  with schema-level validation that marks the provider unavailable instead of
  failing at request time.
- Redirect-hop decoding (`uddg`) so results cite the destination page rather than
  the intermediate DuckDuckGo URL, plus URL dedupe and blank-field omission.
- Abort classification that surfaces `WEB_ABORTED` for caller cancellations and
  `WEB_PROVIDER_ERROR` for transport failures, with no silent fallback.
- Unit and integration suites — 36 tests, fully offline with `fetch` stubbed;
  the real-network smoke self-skips unless `DDG_E2E=1` is set.
- English and Simplified Chinese reference documentation covering install,
  configuration, failure modes, implementation, and known limitations.

### Changed

- Install instructions now target the GitHub source
  (`github:korosu/dsh-web-search-ddg`) with the local-clone form documented
  alongside it, replacing the machine-specific example path.

### Added (repository)

- Repository metadata (`repository`, `bugs`, `homepage`, `author`, `keywords`,
  `packageManager`) and MIT copyright attribution.
- CI on every push and pull request: `typecheck`, `peers check`, offline `test`,
  and a build that fails when the committed `lib/` drifts from `src/`.
- Release workflow that packs a self-contained tarball and attaches it to the
  GitHub release created from a `v*` tag.
