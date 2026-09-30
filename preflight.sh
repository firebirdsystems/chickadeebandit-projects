#!/usr/bin/env bash
# Run before pushing: verifies the build and tests pass, then — when a hub
# checkout sits beside the apps folder — runs the hub's contract suite and
# runtime exercise against this app.
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

# ── Hub checks ───────────────────────────────────────────────────────────────
# Both steps below run the hub's own validators against this working tree, and
# both need a hub checkout beside the apps folder. Without one they skip,
# loudly: a contributor without the hub must still be able to push, and release
# CI remains the real gate for the contract suite.
#
# CB_APPS_DIR is the WHOLE apps folder, not this app: cross-app checks resolve
# emitters, export targets and duplicates from the sibling apps. CB_ONLY_APP
# narrows what is judged to this app, so another app's broken contract never
# refuses this push.
APP="$(basename "$ROOT")"
APPS_DIR="$(cd "$ROOT/.." && pwd)"
HUB=""
for candidate in \
  "$ROOT/../../chickadeebandit/packages/hub" \
  "$ROOT/../../../chickadeebandit/packages/hub"
do
  [ -d "$candidate" ] && HUB="$(cd "$candidate" && pwd)" && break
done
HUB_NODE_MAJOR=22
node_major="$(node -p 'process.versions.node.split(".")[0]')"

# ── Contract suite (row policies, migrations, query plans) ───────────────────
# The release workflow runs this before it will build or publish. Running it
# here too moves the failure from a red release to a refused push — and some of
# it nothing in this repo can check: the query-plan gate EXPLAINs every declared
# preload, and an ORDER BY no index can answer is invisible to build.mjs and to
# this app's own tests.
CONTRACT="$HUB/contract-ci"
echo ""
if [ -z "$HUB" ]; then
  echo "• Contract suite skipped — no sibling hub checkout found."
  echo "  CI still runs it and will block the release on a failure."
elif [ "$node_major" -lt "$HUB_NODE_MAJOR" ]; then
  echo "• Contract suite skipped — it needs Node ${HUB_NODE_MAJOR}+, found $(node -v)."
  echo "  CI still runs it and will block the release on a failure."
elif [ ! -f "$CONTRACT/node_modules/.package-lock.json" ]; then
  echo "• Contract suite skipped — runner not installed."
  echo "  Install it once with:  (cd $CONTRACT && npm ci)"
elif [ "$CONTRACT/package-lock.json" -nt "$CONTRACT/node_modules/.package-lock.json" ]; then
  # A pull that moves the lockfile leaves the old install in place, and an old
  # runner can pass what CI's fresh install refuses.
  echo "• Contract suite skipped — runner is older than its lockfile."
  echo "  Refresh it with:  (cd $CONTRACT && npm ci)"
else
  echo "▶ Contract suite…"
  ( cd "$CONTRACT" && CI=true CB_APPS_DIR="$APPS_DIR" CB_ONLY_APP="$APP" npx vitest run )
fi

# ── Hub runtime exercise ─────────────────────────────────────────────────────
# App release CI runs only the contract suite; the hub's runtime lanes
# (scenarios.json, surfaces, automations, member removal, upgrades) otherwise
# run only in the hub repo's CI, so a broken scenario surfaces on the next hub
# PR instead of on this push.
echo ""
if [ -z "$HUB" ] || [ ! -d "$HUB/node_modules" ]; then
  echo "• Runtime exercise skipped — no installed hub checkout found."
elif [ "$node_major" -lt "$HUB_NODE_MAJOR" ]; then
  echo "• Runtime exercise skipped — it needs Node ${HUB_NODE_MAJOR}+, found $(node -v)."
else
  echo "▶ Hub runtime exercise…"
  ( cd "$HUB" && CB_APPS_DIR="$APPS_DIR" CB_ONLY_APP="$APP" npx vitest run __tests__/app-exercise )
fi

echo ""
echo "✓ Preflight passed"
