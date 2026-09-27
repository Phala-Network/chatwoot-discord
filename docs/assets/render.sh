#!/bin/sh
# Renders the README illustrations (docs/assets/*.html) to PNG at 2x device pixel ratio with the
# Playwright CLI in the official Playwright container. Run from the repository root:
#   sh docs/assets/render.sh
# The committed PNGs were then compressed losslessly with `optipng -o5 -strip all`.
set -eu

PLAYWRIGHT_VERSION=1.63.0

for page in forum ticket; do
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false \
    -v "$PWD/docs/assets:/assets" -w /tmp \
    "mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble" \
    npx -y "playwright@${PLAYWRIGHT_VERSION}" screenshot --device "Desktop Chrome HiDPI" \
    --viewport-size 1100,600 --full-page "file:///assets/${page}.html" "/assets/${page}.png"
done
