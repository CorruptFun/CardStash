#!/usr/bin/env bash
# Build the app and publish dist/ to the gh-pages branch (the live site).
# The gh-pages branch carries build output only — never source.
set -euo pipefail

cd "$(dirname "$0")/.."

npm run build

WORKTREE=$(mktemp -d)
trap 'rm -rf "$WORKTREE"' EXIT

git fetch origin gh-pages 2>/dev/null || true

git worktree add --detach "$WORKTREE"
(
  cd "$WORKTREE"
  git checkout --orphan gh-pages-deploy
  git rm -rf --quiet . 2>/dev/null || true
  cp -r "$OLDPWD"/dist/. .
  touch .nojekyll
  cat > README.md <<'MD'
# Cardstock — deploy mirror

Built site for **Cardstock**, a camera-first TCG scanner & collection portfolio PWA
(Magic · Pokémon · Yu-Gi-Oh). Source lives on the main branch of this repository.

**Live: https://corruptfun.github.io/CardStash/**
MD
  git add -A
  git -c user.name=cardstock-deploy -c user.email=deploy@invalid \
    commit --quiet -m "deploy $(date -u +%Y-%m-%dT%H:%MZ)"
  git push origin +HEAD:gh-pages
)
git worktree remove --force "$WORKTREE" 2>/dev/null || true
echo "Deployed to gh-pages."
