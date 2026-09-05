#!/usr/bin/env bash
# Run before pushing: verifies the build and tests pass.
# Usage:  bash preflight.sh
# Hook:   git config core.hooksPath .githooks  (once per clone)
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── Node resolution ──────────────────────────────────────────────────────────
# A hook launched from a GUI git client (VS Code, Tower, Fork) inherits a bare
# PATH, not the login shell's — so nvm's shims are absent and `node` resolves to
# whatever sits in /usr/local/bin. On a machine that installed Node years ago
# and has used nvm since, that is a v12, which cannot run this repo's ESM build
# and dies with:
#
#   Error [ERR_REQUIRE_ESM]: Must use import to load ES Module: .../build.mjs
#
# The push then fails with a stack trace that looks like a code error and is
# not one — the same push from a terminal succeeds. So resolve a usable Node
# here rather than trusting whatever the caller happened to inherit.
MIN_NODE_MAJOR=18

usable_node() {
  [ -x "$1" ] || command -v "$1" >/dev/null 2>&1 || return 1
  "$1" -e "process.exit(+process.versions.node.split('.')[0] >= ${MIN_NODE_MAJOR} ? 0 : 1)" 2>/dev/null
}

if ! usable_node node; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # nvm.sh is a shell function, not a binary — sourcing it is the only way to
  # get the version it considers current. Homebrew installs it outside NVM_DIR,
  # which is why all three locations are probed (contacts/garden-viewer/
  # wins-celebrations each learned this the hard way and patched it locally).
  for nvm_sh in "$NVM_DIR/nvm.sh" /usr/local/opt/nvm/nvm.sh /opt/homebrew/opt/nvm/nvm.sh; do
    if [ -s "$nvm_sh" ]; then
      set +e
      # shellcheck disable=SC1090
      . "$nvm_sh" >/dev/null 2>&1
      set -e
      usable_node node && break
    fi
  done
fi

if ! usable_node node; then
  # Newest first: the glob sorts lexically, so v9 would beat v22 without the
  # reverse, and an old-but-adequate install would mask a current one.
  for dir in $(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin 2>/dev/null | sort -Vr) \
             /opt/homebrew/bin /usr/local/bin; do
    if usable_node "$dir/node"; then
      PATH="$dir:$PATH"
      export PATH
      break
    fi
  done
fi

if ! usable_node node; then
  echo "preflight: needs Node ${MIN_NODE_MAJOR}+ but found $(command -v node >/dev/null 2>&1 && node -v || echo none)" >&2
  echo "  Pushing from a GUI git client? It does not load nvm. Install a current Node on the" >&2
  echo "  default PATH, or push from a terminal where \`node -v\` already reports ${MIN_NODE_MAJOR}+." >&2
  exit 1
fi

echo ""
echo "▶ Build…"
node "$ROOT/build.mjs"
echo ""
echo "▶ Tests…"
npm test --prefix "$ROOT"

# ── The contract suite, when a hub checkout is at hand ───────────────────────
#
# The release workflow clones the hub and runs this before it will build or
# publish, so CI already gates on it. Running it here too is about WHERE the
# failure lands: the query-plan gate EXPLAINs every declared preload, and an
# ORDER BY that no index can answer is invisible to `build.mjs` and to the app's
# own tests — nothing in this repo can EXPLAIN anything, since vitest is its
# only dependency. Without this, a full table scan is a red CI run instead of a
# refused push.
#
# Skipped, loudly, when no sibling hub checkout exists: a contributor without
# one must still be able to push, and CI remains the real gate.
CONTRACT_DIR=""
for candidate in \
  "$ROOT/../../chickadeebandit/packages/hub/contract-ci" \
  "$ROOT/../../../chickadeebandit/packages/hub/contract-ci"
do
  [ -d "$candidate" ] && CONTRACT_DIR="$(cd "$candidate" && pwd)" && break
done

if [ -z "$CONTRACT_DIR" ]; then
  echo ""
  echo "• Contract suite skipped — no sibling hub checkout found."
  echo "  CI still runs it and will block the release on a failure."
elif [ ! -d "$CONTRACT_DIR/node_modules" ]; then
  echo ""
  echo "• Contract suite skipped — runner not installed."
  echo "  Install it once with:  (cd $CONTRACT_DIR && npm ci)"
else
  echo ""
  echo "▶ Contract suite (row policies, migrations, query plans)…"
  # CB_APPS_DIR is the apps checkout: the suite validates every app in it, so a
  # change here that breaks a shared expectation surfaces before the push.
  ( cd "$CONTRACT_DIR" \
    && CI=true CB_APPS_DIR="$(cd "$ROOT/.." && pwd)" npx vitest run )
fi

echo ""
echo "✓ Preflight passed"
