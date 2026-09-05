# Chickadee app developer tasks. Run `make setup` once after cloning to enable
# the pre-push hook (build + tests via preflight.sh).
.DEFAULT_GOAL := help
.PHONY: help setup install build test dev

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

setup: ## Enable the git pre-push hook (run once after cloning)
	git config core.hooksPath .githooks
	@echo "OK: pre-push hook enabled (core.hooksPath=.githooks)"

install: ## Install dependencies
	npm install

build: ## Build the app bundle
	npm run build

test: ## Run tests
	npm test

dev: ## Run the local dev server
	npm run dev
