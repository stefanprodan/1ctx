# 1ctx - Makefile
#
# Thin wrapper over the package.json scripts: each task runs the script of the
# same name, so `make <task>` and `bun run <task>` are interchangeable. The
# actual commands live in package.json, edit them there.

export VERSION

.DEFAULT_GOAL := help

.PHONY: help start dev test vendor-test build lint clean preview preview-stop preview-log preview-clean preview-provision preview-reset smoke staging-deploy staging-provision staging-status

help: ## Show available tasks
	@grep -hE '^[a-z][a-z-]*:.*## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-13s\033[0m %s\n", $$1, $$2}'

start: ## Run from source (make start ARGS="--listen 127.0.0.1:1234")
	@bun run start $(ARGS)

dev: ## Run with hot reload of the page and restart on server changes (make dev ARGS="...")
	@bun run dev $(ARGS)

test: ## Run tests
	@bun run test

vendor-test: ## Run just-bash's own suite on vendor/just-bash against its expected failures
	@bun run vendor-test

lint: ## Format and lint with Biome, then type-check with tsc
	@bun run lint

build: ## Compile a standalone binary into bin/ (release: VERSION=v1.2.3)
	@bun run build

smoke: ## Start the compiled binary, sign in and stop it
	@bun run smoke

clean: ## Stop the preview, remove its db and log, and the build artifacts
	@bun run clean

preview: ## (Re)start the local preview on 127.0.0.1:1236 (hot reload)
	@bun run preview

preview-stop: ## Stop the local preview
	@bun run preview-stop

preview-log: ## Tail the local preview's log
	@bun run preview-log

preview-clean: ## Stop the local preview and remove its db, log and pid
	@bun run preview-clean

preview-provision: ## Apply a provision file to the preview (FILE=path.yaml)
	@bun run preview-provision $(FILE)

preview-reset: ## Wipe the preview and provision it again (FILE=path.yaml SECRETS=dir)
	@bun run preview-reset $(FILE) $(SECRETS)

staging-deploy: ## Build main, back the staging db up, swap the binary and restart its service
	@bun run staging-deploy

staging-provision: ## Stop staging, apply the objects, start it (FILE=path.yaml, SECRETS=dir to copy keys first)
	@bun run staging-provision $(FILE) $(SECRETS)

staging-status: ## What the staging service says
	@bun run staging-status
