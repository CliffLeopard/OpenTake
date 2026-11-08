#!/usr/bin/env bash
# Sign the Route B macOS addons, optionally notarize a .pkg payload.
#
# Requires Apple Developer ID credentials supplied through environment secrets.
# When they are absent this script prints SKIP and exits 0 (the macOS unsigned
# fallback used for internal/dev artifacts); with --require it exits 78 instead.
#
# Required env for signing:
#   APPLE_CERTIFICATE_P12_BASE64       Developer ID Application .p12, base64
#   APPLE_CERTIFICATE_P12_PASSWORD     .p12 password
#   APPLE_KEYCHAIN_PASSWORD            temporary keychain password (CI value)
# Optional:
#   APPLE_SIGNING_IDENTITY             exact identity name (otherwise discovered)
#   APPLE_INSTALLER_IDENTITY           Developer ID Installer identity for pkg signing
#   APPLE_NOTARY_PROFILE               notarytool keychain profile (preferred)
#   APPLE_ID / APPLE_TEAM_ID / APPLE_APP_SPECIFIC_PASSWORD  (alternative)
#
# Usage:
#   ./scripts/route-b/platform/sign-macos.sh [--require] [--notarize]
#
# This script is a template for CI. It was not executed locally: this machine has
# 0 valid codesigning identities and no notarytool profile.
set -euo pipefail
cd "$(dirname "$0")/../../.." || exit 2

PLUGIN="plugins/opentake-studio-route-b"
REQUIRE=0
NOTARIZE=0
for arg in "$@"; do
  case "$arg" in
    --require) REQUIRE=1 ;;
    --notarize) NOTARIZE=1 ;;
    *) echo "sign-macos: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "${APPLE_CERTIFICATE_P12_BASE64:-}" ] || [ -z "${APPLE_CERTIFICATE_P12_PASSWORD:-}" ]; then
  if [ "$REQUIRE" = "1" ]; then
    echo "sign-macos: APPLE_CERTIFICATE_P12_BASE64 / APPLE_CERTIFICATE_P12_PASSWORD are required but unset" >&2
    exit 78
  fi
  echo "sign-macos: SKIP (no APPLE_CERTIFICATE_P12_BASE64; producing unsigned artifacts)"
  exit 0
fi
[ "$(uname -s)" = "Darwin" ] || { echo "sign-macos: macOS is required" >&2; exit 78; }
command -v codesign >/dev/null 2>&1 || { echo "sign-macos: codesign not found" >&2; exit 78; }

TMP="$(mktemp -d)"
KEYCHAIN="$TMP/route-b-signing.keychain-db"
P12="$TMP/developer-id.p12"
cleanup() {
  security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

printf '%s' "$APPLE_CERTIFICATE_P12_BASE64" | openssl base64 -d -A -out "$P12"
[ -s "$P12" ] || { echo "sign-macos: decoded .p12 is empty" >&2; exit 78; }

security create-keychain -p "${APPLE_KEYCHAIN_PASSWORD:-route-b}" "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p "${APPLE_KEYCHAIN_PASSWORD:-route-b}" "$KEYCHAIN"
security import "$P12" -k "$KEYCHAIN" -P "$APPLE_CERTIFICATE_P12_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
  -k "${APPLE_KEYCHAIN_PASSWORD:-route-b}" "$KEYCHAIN" >/dev/null

IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" \
    | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' | head -1)"
fi
[ -n "$IDENTITY" ] || { echo "sign-macos: no Developer ID Application identity found" >&2; exit 78; }
echo "sign-macos: signing with $IDENTITY"

shopt -s nullglob
binaries=("$PLUGIN"/native/*/*.node)
shopt -u nullglob
[ "${#binaries[@]}" -gt 0 ] || { echo "sign-macos: no native/*/*.node binaries" >&2; exit 1; }

for binary in "${binaries[@]}"; do
  codesign --force --options runtime --timestamp --keychain "$KEYCHAIN" \
    --sign "$IDENTITY" "$binary"
  codesign --verify --strict --verbose=2 "$binary"
  echo "sign-macos: signed $binary"
done

if [ "$NOTARIZE" = "1" ]; then
  if [ -z "${APPLE_INSTALLER_IDENTITY:-}" ]; then
    echo "sign-macos: --notarize requires APPLE_INSTALLER_IDENTITY (Developer ID Installer) to sign the .pkg" >&2
    exit 78
  fi
  command -v pkgbuild >/dev/null 2>&1 || { echo "sign-macos: pkgbuild not found" >&2; exit 78; }
  command -v productsign >/dev/null 2>&1 || { echo "sign-macos: productsign not found" >&2; exit 78; }
  command -v xcrun >/dev/null 2>&1 || { echo "sign-macos: xcrun not found" >&2; exit 78; }

  VERSION="$(node -p "require('./$PLUGIN/package.json').version")"
  STAGE="$TMP/stage"
  mkdir -p "$STAGE"
  cp -R "$PLUGIN/index.js" "$PLUGIN/client.js" "$PLUGIN/cordis.patch.yml" \
    "$PLUGIN/README.md" "$PLUGIN/package.json" "$STAGE/"
  cp -R "$PLUGIN/web" "$STAGE/web"
  mkdir -p "$STAGE/native"
  cp -R "$PLUGIN"/native/* "$STAGE/native/"

  UNSIGNED="$TMP/opentake-studio-route-b-unsigned.pkg"
  SIGNED="dist/opentake-studio-route-b-${VERSION}-darwin.pkg"
  mkdir -p dist
  pkgbuild --root "$STAGE" --identifier "com.opentake.studio-route-b" \
    --version "$VERSION" --install-location "/" "$UNSIGNED"
  productsign --sign "$APPLE_INSTALLER_IDENTITY" "$UNSIGNED" "$SIGNED"
  echo "sign-macos: wrote $SIGNED"

  if [ -n "${APPLE_NOTARY_PROFILE:-}" ]; then
    xcrun notarytool submit "$SIGNED" --keychain-profile "$APPLE_NOTARY_PROFILE" --wait
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
    xcrun notarytool submit "$SIGNED" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait
  else
    echo "sign-macos: notarization credentials missing (set APPLE_NOTARY_PROFILE or APPLE_ID/APPLE_TEAM_ID/APPLE_APP_SPECIFIC_PASSWORD)" >&2
    exit 78
  fi
  xcrun stapler staple "$SIGNED"
  spctl -a -vv -t install "$SIGNED" || { echo "sign-macos: Gatekeeper assessment failed" >&2; exit 1; }
  echo "sign-macos: notarized and stapled $SIGNED"
fi

echo "sign-macos: OK"
