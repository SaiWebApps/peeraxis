#!/usr/bin/env bash
# Builds Peeraxis.app (the Dock window) into shell/build/. Only rebuilt when this window changes.
set -euo pipefail
cd "$(dirname "$0")"
APP=build/Peeraxis.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -o "$APP/Contents/MacOS/Peeraxis" Peeraxis.swift -framework AppKit -framework WebKit
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Peeraxis</string>
  <key>CFBundleIdentifier</key><string>com.saiwebapps.peeraxis.app</string>
  <key>CFBundleExecutable</key><string>Peeraxis</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1
echo "$APP"
