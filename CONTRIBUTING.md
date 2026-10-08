# Contributing

Thanks for taking a look at `dsh-web-search-ddg`. This document covers the local
workflow and the conventions that keep the provider honest against the
`ctx.web` seam it plugs into.

## Ground rules

The seam is owned by the host, so this package contributes a provider and nothing
else. A few rules follow from that, and they are enforced by review:

- **No hardcoded tunables.** Anything a deployment might want to change is a
  schema field a profile can set from `cordis.yml`, never a literal in the
  source.
- **Structured errors only.** Failures surface as `WebError` with a `code` from
  the seam's taxonomy (`WEB_PROVIDER_ERROR`, `WEB_ABORTED`,
  `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`, …). Never a bare string, never a
  swallowed exception.
- **Never invent fields.** A blank title drops the row; a blank snippet is
  omitted rather than set empty. The seam must not be handed a fabricated value.
- **No silent fallback.** Selection is the seam's job. This package never
  substitutes another engine when DDG misbehaves; the failure budget's job is
  the opposite — to make the provider *step aside* (`available()` false for
  the cooldown) so the seam gets to select, never to pick anything itself.
- **Selection stays with the seam.** This package registers a provider; it does
  not pin, override, or replace `WebRuntime` or the model-facing tool beyond the
  bundle's single documented `web` row.

## Local setup

Node ≥ 22.18 is required to run the tests (they use Node's native TypeScript
support, with no bundler); Node 24 is recommended. `pnpm` 11 manages the install.

```bash
pnpm install
pnpm test                # 42 tests, offline (fetch is stubbed)
DDG_E2E=1 pnpm test:e2e  # optional real-network smoke
pnpm typecheck
pnpm peers check         # peer-range sanity against the installed seam line
pnpm compat              # seam-version matrix; needs bash + registry access
```

## The `lib/` rule

`lib/` is committed on purpose: a local path install is a symlink, and Node
resolves a module's imports from its real path, so shipping the prebuilt output
means a local install never needs a build step. CI rebuilds and fails the build
if the committed `lib/` differs from a fresh `tsc` run, so **run `pnpm build` and
commit `lib/` whenever you change `src/`**.

## Documentation

`README.md` and `README.zh-CN.md` are kept in sync section by section. When you
change behavior, update both: the install steps, the config table, the failure
table, the implementation notes, and the known-limitations list are all part of
the contract. If a change makes an existing limitation obsolete, delete the
limitation rather than leaving stale caveats behind.

## Pull requests

- One logical change per PR, with the reasoning in the description.
- Tests accompany behavior changes: parsing, error mapping, and availability
  rules are all unit-testable without a network.
- CI must be green: `typecheck`, `peers check`, `test`, and the `lib/` sync
  guard.
- Keep the peer range of `@deepseek-ai/dsh-web` honest — verify against a new
  seam line before widening the range, not after. `pnpm compat <version>` is
  the verification tool; extend the declared range, `dshReleases`, and the
  README compatibility table in the same PR as the evidence.
