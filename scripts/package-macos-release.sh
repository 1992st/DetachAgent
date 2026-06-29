#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Detaches Agent"
VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
RELEASE_DIR="$ROOT_DIR/release"
SIGNING_CERTIFICATE="${SIGN_IDENTITY:-}"
RUN_CHECKS="0"
RUN_NOTARIZE="${RUN_NOTARIZE:-0}"
NOTARY_PROFILE="${NOTARY_PROFILE:-}"
OPEN_OUTPUT="0"

usage() {
  cat >&2 <<USAGE
Usage: $0 [--checks] [--no-notarize] [--notarize --notary-profile PROFILE] [--signing-certificate NAME] [--open]

Environment:
  SIGN_IDENTITY     Developer ID Application identity to use.
  RUN_NOTARIZE      Set to 1 to submit DMGs for notarization.
  NOTARY_PROFILE    notarytool keychain profile name.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --checks)
      RUN_CHECKS="1"
      shift
      ;;
    --no-notarize)
      RUN_NOTARIZE="0"
      shift
      ;;
    --notarize)
      RUN_NOTARIZE="1"
      shift
      ;;
    --notary-profile)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for $1" >&2
        exit 2
      fi
      NOTARY_PROFILE="$2"
      shift 2
      ;;
    --signing-certificate)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for $1" >&2
        exit 2
      fi
      SIGNING_CERTIFICATE="$2"
      shift 2
      ;;
    --open)
      OPEN_OUTPUT="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS packaging must run on macOS." >&2
  exit 1
fi

if [[ -z "$SIGNING_CERTIFICATE" ]]; then
  SIGNING_CERTIFICATE="$(
    security find-identity -v -p codesigning |
      awk -F '"' '/Developer ID Application:/ { print $2; exit }'
  )"
fi

if [[ -z "$SIGNING_CERTIFICATE" ]]; then
  echo "No Developer ID Application signing identity found." >&2
  echo "Install a .p12 certificate or pass --signing-certificate NAME." >&2
  exit 1
fi

if [[ "$SIGNING_CERTIFICATE" != Developer\ ID\ Application:* ]]; then
  echo "Expected a Developer ID Application identity." >&2
  echo "Current signing certificate: $SIGNING_CERTIFICATE" >&2
  exit 1
fi

if [[ "$RUN_NOTARIZE" == "1" && -z "$NOTARY_PROFILE" ]]; then
  echo "Missing notary profile. Pass --notary-profile PROFILE or set NOTARY_PROFILE." >&2
  echo "Create one with: xcrun notarytool store-credentials PROFILE --apple-id APPLE_ID --team-id TEAM_ID --password APP_SPECIFIC_PASSWORD" >&2
  exit 2
fi

ELECTRON_BUILDER_IDENTITY="${SIGNING_CERTIFICATE#Developer ID Application: }"

echo "macOS package version: $VERSION"
echo "Signing identity: $SIGNING_CERTIFICATE"
if [[ "$RUN_NOTARIZE" == "1" ]]; then
  echo "Notarization profile: $NOTARY_PROFILE"
else
  echo "Notarization: disabled"
fi

if [[ "$RUN_CHECKS" == "1" ]]; then
  echo "Running release checks..."
  pnpm typecheck
  pnpm --filter @detaches/openclaw-detaches-adapter test
  pnpm --filter @detaches/server smoke
fi

echo "Building workspace..."
pnpm build

echo "Building desktop entrypoints..."
pnpm --filter @detaches/desktop build

echo "Staging desktop runtime..."
pnpm --filter @detaches/desktop stage:runtime

echo "Packaging signed macOS DMGs..."
pnpm --dir apps/desktop exec electron-builder --mac dmg --arm64 --x64 --config.mac.identity="$ELECTRON_BUILDER_IDENTITY"

for arch in x64 arm64; do
  if [[ "$arch" == "x64" ]]; then
    app_path="$RELEASE_DIR/mac/$APP_NAME.app"
  else
    app_path="$RELEASE_DIR/mac-$arch/$APP_NAME.app"
  fi
  dmg_path="$RELEASE_DIR/detaches-agent-$VERSION-mac-$arch.dmg"

  if [[ ! -d "$app_path" ]]; then
    echo "Missing packaged app: $app_path" >&2
    exit 1
  fi
  if [[ ! -f "$dmg_path" ]]; then
    echo "Missing DMG: $dmg_path" >&2
    exit 1
  fi

  echo "Verifying app signature: $app_path"
  codesign -vvv --strict "$app_path/Contents/MacOS/$APP_NAME"
  codesign -dvvv "$app_path/Contents/MacOS/$APP_NAME" 2>&1 | grep -E "Authority=|TeamIdentifier=|Timestamp=" || true

  echo "Signing DMG: $dmg_path"
  codesign --force --timestamp --sign "$SIGNING_CERTIFICATE" "$dmg_path"
  codesign --verify --verbose=2 "$dmg_path"

  if [[ "$RUN_NOTARIZE" == "1" ]]; then
    echo "Submitting DMG for Apple notarization: $dmg_path"
    xcrun notarytool submit "$dmg_path" --keychain-profile "$NOTARY_PROFILE" --wait

    echo "Stapling notarization ticket: $dmg_path"
    xcrun stapler staple "$dmg_path"
    xcrun stapler validate "$dmg_path"
    spctl --assess --type open --verbose=4 "$dmg_path"
  else
    echo "Skipping notarization for $dmg_path"
  fi
done

echo "Artifacts:"
ls -lh "$RELEASE_DIR"/detaches-agent-"$VERSION"-mac-*.dmg

echo "SHA256:"
shasum -a 256 "$RELEASE_DIR"/detaches-agent-"$VERSION"-mac-*.dmg

if [[ "$OPEN_OUTPUT" == "1" ]]; then
  open "$RELEASE_DIR"
fi
