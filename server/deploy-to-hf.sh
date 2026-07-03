#!/usr/bin/env bash
# Assembles a standalone deploy tree (app/ + requirements.txt + the
# HF-specific Dockerfile/README) and pushes it to a Hugging Face Space's own
# git repo. Kept separate from this repo's git history on purpose: the
# Space's README.md needs HF's YAML frontmatter, which would collide with
# this directory's normal server/README.md if pushed in place.
#
# Prereqs: a Write-scoped token from https://huggingface.co/settings/tokens,
# set as $HF_TOKEN in *your own* shell before running this script (e.g.
# `$env:HF_TOKEN = "hf_..."` in PowerShell, or `export HF_TOKEN=hf_...` in
# bash) -- `hf auth login`'s Git Credential Manager integration doesn't
# reliably hand the token to a plain `git push` (observed: GCM falls back to
# password auth, which HF rejects outright). This way the token only ever
# lives in your terminal's environment, never in this script's own output.
#
# Usage: HF_TOKEN=hf_xxx ./deploy-to-hf.sh <hf-username>/<space-name>
set -euo pipefail

SPACE="${1:?usage: deploy-to-hf.sh <hf-username>/<space-name>}"
: "${HF_TOKEN:?Set \$HF_TOKEN to a Write-scoped token first (see script header comment)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(mktemp -d)"

echo "Assembling deploy tree in $DEPLOY_DIR ..."
cp -r "$SCRIPT_DIR/app" "$DEPLOY_DIR/app"
cp "$SCRIPT_DIR/requirements.txt" "$DEPLOY_DIR/requirements.txt"
cp "$SCRIPT_DIR/Dockerfile.hf" "$DEPLOY_DIR/Dockerfile"
cp "$SCRIPT_DIR/hf-space-readme.md" "$DEPLOY_DIR/README.md"

cd "$DEPLOY_DIR"
git init -q
# No global git identity is configured on this machine (see main repo setup)
# -- set one locally in the throwaway deploy tree rather than requiring a
# machine-wide config change just to run this script.
git config user.name "chrismarspink"
git config user.email "jkkim@innotium.com"
git add .
git commit -q -m "Deploy innoecm-ai-guard console (single-container, SQLite/no-Redis variant)"
git branch -M main
# Token embedded directly in the remote URL for this one push -- this
# process's argv/config is local to your machine and isn't sent anywhere
# except to huggingface.co over HTTPS as part of normal git auth.
git remote add space "https://hf:${HF_TOKEN}@huggingface.co/spaces/$SPACE"
git push --force space main

echo "Pushed to https://huggingface.co/spaces/$SPACE"
echo "(deploy tree left at $DEPLOY_DIR for inspection; safe to delete)"
