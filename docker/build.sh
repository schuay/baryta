#!/bin/sh
# Builds the site, moves it into a new release directory, then switches the
# `current` symlink atomically so the web server never serves a partial build.
set -eu
SITE=${SITE:-/site}
KEEP=${KEEP:-3}
release="$SITE/releases/$(date -u +%Y%m%dT%H%M%SZ)"
# Astro renames files into its output directory, which fails across
# filesystems; build inside the app directory and move the result.
rm -rf dist
npm run build
mkdir -p "$SITE/releases"
mv dist "$release"
ln -sfn "$release" "$SITE/current.tmp"
mv -T "$SITE/current.tmp" "$SITE/current"
ls -1d "$SITE"/releases/* | sort | head -n "-$KEEP" | xargs -r rm -rf
echo "published $release"
