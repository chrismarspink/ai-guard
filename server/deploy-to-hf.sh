#!/usr/bin/env bash
# Assembles a standalone deploy tree (app/ + requirements.txt + the
# HF-specific Dockerfile/README) and pushes it to a Hugging Face Space's own
# git repo. Kept separate from this repo's git history on purpose: the
# Space's README.md needs HF's YAML frontmatter, which would collide with
# this directory's normal server/README.md if pushed in place.
#
# Prereqs: `hf auth login` already run once on this machine (see
# https://huggingface.co/settings/tokens for a Write-scoped token).
#
# Usage: ./deploy-to-hf.sh <hf-username>/<space-name>
set -euo pipefail

SPACE="${1:?usage: deploy-to-hf.sh <hf-username>/<space-name>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(mktemp -d)"

echo "Assembling deploy tree in $DEPLOY_DIR ..."
cp -r "$SCRIPT_DIR/app" "$DEPLOY_DIR/app"
cp "$SCRIPT_DIR/requirements.txt" "$DEPLOY_DIR/requirements.txt"
cp "$SCRIPT_DIR/Dockerfile.hf" "$DEPLOY_DIR/Dockerfile"
cp "$SCRIPT_DIR/hf-space-readme.md" "$DEPLOY_DIR/README.md"

cd "$DEPLOY_DIR"
git init -q
git add .
git commit -q -m "Deploy innoecm-ai-guard console (single-container, SQLite/no-Redis variant)"
git branch -M main
git remote add space "https://huggingface.co/spaces/$SPACE"
git push --force space main

echo "Pushed to https://huggingface.co/spaces/$SPACE"
echo "(deploy tree left at $DEPLOY_DIR for inspection; safe to delete)"
