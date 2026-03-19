EXTENSION_NAME := kinopoisk-subtitles-overlay
VERSION := $(shell jq -r .version manifest.json)
DIST_DIR := dist
PACKAGE := $(EXTENSION_NAME)-$(VERSION).zip

CHROME := $(shell command -v google-chrome-stable 2>/dev/null || command -v google-chrome 2>/dev/null || command -v chromium 2>/dev/null)

# Extension source files (everything needed in the package)
SRC_FILES := manifest.json content.js content.css popup.html popup.js icon.png

.PHONY: all install uninstall package clean test help

all: help

help: ## Show this help
	@echo "Usage: make <target>"
	@echo ""
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

## ── Installation ──────────────────────────────────────────────

install: ## Install extension into Chrome (unpacked, dev mode)
	@echo "Installing extension into Chrome..."
	@if [ -z "$(CHROME)" ]; then \
		echo "Error: Chrome/Chromium not found in PATH"; exit 1; \
	fi
	@echo ""
	@echo "Chrome cannot load unpacked extensions from the CLI."
	@echo "Follow these steps:"
	@echo ""
	@echo "  1. Open Chrome and navigate to:  chrome://extensions/"
	@echo "  2. Enable 'Developer mode' (toggle in top-right corner)"
	@echo "  3. Click 'Load unpacked'"
	@echo "  4. Select this directory:"
	@echo "     $(CURDIR)"
	@echo ""
	@echo "Opening chrome://extensions/ ..."
	@$(CHROME) "chrome://extensions/" 2>/dev/null &

uninstall: ## Show instructions to remove the extension
	@echo "To uninstall:"
	@echo "  1. Open chrome://extensions/"
	@echo "  2. Find 'Kinopoisk Subtitle Overlay'"
	@echo "  3. Click 'Remove'"

## ── Packaging ─────────────────────────────────────────────────

package: $(PACKAGE) ## Build .zip package for distribution
	@echo "Package ready: $(PACKAGE)"

$(PACKAGE): $(SRC_FILES)
	@mkdir -p $(DIST_DIR)
	zip -j $(DIST_DIR)/$(PACKAGE) $(SRC_FILES)
	@du -h $(DIST_DIR)/$(PACKAGE) | awk '{print "Built $(DIST_DIR)/$(PACKAGE) (" $$1 ")"}'

## ── Testing ───────────────────────────────────────────────────

test: node_modules ## Run integration tests with Puppeteer
	node test.mjs

node_modules: package.json
	npm install
	@touch node_modules

## ── Release ───────────────────────────────────────────────────

release: package ## Create a GitHub release with the .zip attached
	@if [ -z "$$(command -v gh 2>/dev/null)" ]; then \
		echo "Error: gh CLI not found. Install: https://cli.github.com/"; exit 1; \
	fi
	@if ! git diff --quiet HEAD 2>/dev/null; then \
		echo "Error: uncommitted changes. Commit first."; exit 1; \
	fi
	git tag -a "v$(VERSION)" -m "Release v$(VERSION)" 2>/dev/null || true
	git push origin "v$(VERSION)" 2>/dev/null || true
	gh release create "v$(VERSION)" $(DIST_DIR)/$(PACKAGE) \
		--title "v$(VERSION)" \
		--generate-notes
	@echo "Release v$(VERSION) published."

## ── Cleanup ───────────────────────────────────────────────────

clean: ## Remove build artifacts and test screenshots
	rm -rf $(DIST_DIR) .test-chrome-profile test-screenshot-*.png
