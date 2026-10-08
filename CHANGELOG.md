# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
