# Dryad developer tasks. Thin aliases over npm/cargo, which stay the source
# of truth. macOS/Linux only; Windows contributors use the npm/cargo commands
# directly (see README).

NPM ?= npm
NPX ?= npx
CARGO ?= cargo
CARGO_TEST = $(CARGO) test --manifest-path src-tauri/Cargo.toml

.DEFAULT_GOAL := help
.PHONY: help install dev build test typecheck check clean

help: ## Show this help
	@awk -F':.*## ' '/^[a-z-]+:.*## /{printf "  %-10s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install npm dependencies from the lockfile
	$(NPM) ci

dev: ## Run the app with hot reload (interactive)
	$(NPM) run tauri dev

build: ## Build release bundles
	$(NPM) run tauri build

test: ## Run frontend and Rust tests
	$(NPM) test
	$(CARGO_TEST)

typecheck: ## Type-check the frontend
	$(NPX) tsc --noEmit

check: test typecheck ## Run the command set of CI's test job

clean: ## Remove build outputs (keeps node_modules)
	rm -rf dist src-tauri/target
