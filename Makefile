APP_BUNDLE := dist/Relayscribe.app
APP_CONTENTS := $(APP_BUNDLE)/Contents
RESOURCES_DIR := $(APP_CONTENTS)/Resources
SIDECAR_BUNDLE := $(RESOURCES_DIR)/sidecar

.PHONY: all icons sidecar swift test clean dmg

# Build everything: sidecar JS + Swift app
all: sidecar swift

# Generate macOS app icons (.icns/.png) for the Swift app bundle
icons:
	npm run icons:macos

# Build TS sidecar; provision-sdk ensures the Recall native binary (desktop_sdk_macos_exe) is present
sidecar: provision-sdk
	cd sidecar && npm install && npm run build

# Download and extract the Recall Desktop SDK native binary (downloads ~50MB from S3 on first run)
provision-sdk:
	cd sidecar && npm install
	cd sidecar/node_modules/@recallai/desktop-sdk && node setup.js

# Typecheck sidecar only
sidecar-check:
	cd sidecar && npm run typecheck

# Build Swift .app (debug)
swift:
	cd Relayscribe && swift build

# Build Swift .app (release)
swift-release:
	cd Relayscribe && swift build -c release

# Build Swift .app bundle for distribution
swift-app: icons swift-release
	rm -rf $(APP_BUNDLE)
	mkdir -p $(APP_CONTENTS)/MacOS
	mkdir -p $(RESOURCES_DIR)
	mkdir -p $(SIDECAR_BUNDLE)/dist
	mkdir -p $(SIDECAR_BUNDLE)/node_modules
	cp Relayscribe/AppBundle/Info.plist $(APP_CONTENTS)/
	cp Relayscribe/AppBundle/Resources/icon.icns $(RESOURCES_DIR)/
	cp Relayscribe/.build/release/Relayscribe $(APP_CONTENTS)/MacOS/
	chmod +x $(APP_CONTENTS)/MacOS/Relayscribe
	cp -R sidecar/dist/. $(SIDECAR_BUNDLE)/dist/
	cp -R sidecar/node_modules/. $(SIDECAR_BUNDLE)/node_modules/
	cp sidecar/package.json $(SIDECAR_BUNDLE)/
	@echo "App bundle at $(APP_BUNDLE)"

# Run Swift tests
test:
	cd Relayscribe && swift test

# Package .app into a distributable .dmg
dmg: swift-app
	@echo "Creating Relayscribe.dmg..."
	hdiutil create -volname "Relayscribe" \
	  -srcfolder $(APP_BUNDLE) \
	  -ov -format UDZO \
	  dist/Relayscribe.dmg
	@echo "DMG at dist/Relayscribe.dmg"

# Clean build artifacts
clean:
	cd sidecar && rm -rf dist node_modules
	cd Relayscribe && swift package clean
	rm -rf dist
