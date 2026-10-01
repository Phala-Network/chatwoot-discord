#!/bin/sh
# Renders the README illustrations (docs/assets/*.html) to PNG at 2x device pixel ratio with the
# Playwright CLI in the official Playwright container, then compresses them losslessly with
# optipng. Run from the repository root:
#   sh docs/assets/render.sh
# Discord's typeface (gg sans) is not freely available, so the pages use Noto Sans, and Twemoji
# for emoji as Discord does. Both are fetched from npm into the container for the render only.
set -eu

PLAYWRIGHT_VERSION=1.63.0
NOTO_SANS_VERSION=0.4.2
TWEMOJI_VERSION=15.0.3
# Each page and its width in CSS pixels.
PAGES="forum:1000 ticket:1000 manage:640"

docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false \
  -e PLAYWRIGHT_VERSION="$PLAYWRIGHT_VERSION" -e NOTO_SANS_VERSION="$NOTO_SANS_VERSION" \
  -e TWEMOJI_VERSION="$TWEMOJI_VERSION" -e PAGES="$PAGES" \
  -v "$PWD/docs/assets:/assets" -w /tmp \
  "mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble" sh -eu -c '
    fonts=/tmp/.local/share/fonts
    mkdir -p "$fonts"
    npm pack --silent "@expo-google-fonts/noto-sans@$NOTO_SANS_VERSION" "twemoji-colr-font@$TWEMOJI_VERSION" >/dev/null
    tar xzf expo-google-fonts-noto-sans-*.tgz -C "$fonts" --strip-components 2 --wildcards "package/*/NotoSans_[4-7]00*.ttf"
    tar xzf twemoji-colr-font-*.tgz -C "$fonts" --strip-components 1 package/twemoji.woff2
    for spec in $PAGES; do
      page=${spec%%:*}
      npx -y "playwright@$PLAYWRIGHT_VERSION" screenshot --device "Desktop Chrome HiDPI" \
        --viewport-size "${spec#*:},100" --full-page "file:///assets/$page.html" "/assets/$page.png"
    done'

docker run --rm -e DEBIAN_FRONTEND=noninteractive -e OWNER="$(id -u):$(id -g)" -v "$PWD/docs/assets:/assets" debian:trixie-slim sh -eu -c '
  apt-get update -qq && apt-get install -y -qq --no-install-recommends optipng >/dev/null
  optipng -quiet -o5 -strip all /assets/*.png
  chown "$OWNER" /assets/*.png'
