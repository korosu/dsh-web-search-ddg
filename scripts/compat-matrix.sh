#!/usr/bin/env bash
# Compatibility matrix for @deepseek-ai/dsh-web seam versions.
#
# For every version under test this script builds a throwaway project that
# installs exactly that seam version (plus the cordis this plugin peers on),
# then runs three checks:
#
#   1. typecheck src/ against that version's type declarations,
#   2. run the offline contract suite (tests/ddg.spec.ts) against that seam,
#   3. install this plugin's packed tarball and run `pnpm peers check`,
#      which reports whether the version is inside the peer range that
#      package.json currently claims.
#
# A version outside the claimed range is informational: its contract results
# never fail the run, because nothing in this repo promises it works. A
# version inside the claimed range fails the run on any contract failure.
# Results feed the "Version compatibility" section of the README and the
# dsh.compatibility.dshReleases records in package.json.
#
# Usage:
#   pnpm compat                                   # default version list below
#   bash scripts/compat-matrix.sh 0.2.0-rc.2 ...   # explicit list
#
# Requires bash (Git Bash on Windows), pnpm, node, and registry access.

set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)

if [ "$#" -gt 0 ]; then
  # shellcheck disable=SC2124
  versions=$*
else
  versions='0.1.5-rc.3 0.1.7-rc.2 0.2.0-rc.1 0.2.0-rc.2 0.2.1-alpha.1'
fi

# Pack once; prepack builds lib/, so the tarball is what a consumer installs.
rm -f "$repo_root"/dsh-web-search-ddg-*.tgz
echo "==> packing the plugin"
pnpm --dir "$repo_root" pack >/dev/null
# shellcheck disable=SC2012
tarball=$(ls "$repo_root"/dsh-web-search-ddg-*.tgz | head -n 1)
echo "    ${tarball}"

summary=()
failed=0

for version in $versions; do
  work=$(mktemp -d)
  echo "==> dsh-web@${version}"
  cd "$work"

  contract=yes
  claimed=yes

  cat > package.json <<'EOF'
{
  "name": "dsh-web-search-ddg-compat-probe",
  "private": true,
  "type": "module"
}
EOF

  if ! pnpm add "@deepseek-ai/dsh-web@${version}" >install.log 2>&1; then
    echo "    seam install failed:" >&2
    cat install.log >&2
    exit 1
  fi
  # Install cordis at the range the seam under test itself wants, mirroring
  # what a real profile ships. Falls back to this repo's own pin when the
  # manifest carries no cordis peer.
  cordis_want=$(node -p "require('./node_modules/@deepseek-ai/dsh-web/package.json').peerDependencies['@deepseek-ai/cordis']" 2>/dev/null || echo '~4.0.4')
  if ! pnpm add "@deepseek-ai/cordis@${cordis_want}" 'cheerio@^1.0.0' \
      '@deepseek-ai/schemastery@~3.18.4' >>install.log 2>&1; then
    echo "    runtime install failed (cordis@${cordis_want}):" >&2
    cat install.log >&2
    exit 1
  fi
  pnpm add -D 'typescript@^6.0.0' '@types/node@^22' >>install.log 2>&1

  cp -r "$repo_root/src" "$repo_root/tests" .
  cp "$repo_root/tsconfig.json" .

  if ! pnpm exec tsc -p tsconfig.json --noEmit >typecheck.log 2>&1; then
    contract=no
    cat typecheck.log
  fi
  if ! pnpm exec node --experimental-test-isolation=none --test tests/ddg.spec.ts \
      >suite.log 2>&1; then
    contract=no
    tail -n 20 suite.log
  fi

  # Install the packed tarball, then let `pnpm peers check` be the semver
  # oracle for the declared range: in this probe only the plugin peers on
  # @deepseek-ai/dsh-web, so an "unmet peer" entry for it means the seam
  # version under test is outside the range package.json claims.
  if ! pnpm add "$tarball" --ignore-scripts >tarball-add.log 2>&1; then
    echo "    plugin tarball install failed:" >&2
    cat tarball-add.log >&2
    exit 1
  fi
  if pnpm peers check >peers.log 2>&1; then
    claimed=yes
  elif grep -q 'unmet peer @deepseek-ai/dsh-web' peers.log; then
    claimed=no
    grep -A4 'unmet peer @deepseek-ai/dsh-web' peers.log
  else
    # Failed for peers this plugin does not own — information about the
    # probe, not about the declared dsh-web range.
    claimed=yes
    grep 'unmet peer' peers.log || true
  fi

  verdict=PASS
  [ "$contract" = yes ] || verdict=FAIL
  [ "$claimed" = yes ] || verdict="${verdict} [outside the declared range]"

  summary+=("dsh-web@${version}: ${verdict}")
  if [ "$contract" = no ] && [ "$claimed" = yes ]; then
    failed=1
    echo "    contract failed on a claimed version; probe kept at ${work}"
  else
    rm -rf "$work"
  fi
done

rm -f "$tarball"

echo
echo "==> matrix summary"
printf '  %s\n' "${summary[@]}"
if [ "$failed" -ne 0 ]; then
  echo '    a claimed version failed its contract checks' >&2
  exit 1
fi
