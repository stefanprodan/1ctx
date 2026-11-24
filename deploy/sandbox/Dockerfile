# syntax=docker/dockerfile:1
# check=error=true

# The 1ctx shell image, one target per variant:
#
# python:  Python and uv, bash, coreutils, findutils, procps, tar, curl,
#          git, make, jq, yq, ripgrep, pdftotext (the base, in every
#          variant)
# bun:     the base and Bun, with node and npx running on Bun
# go:      the base, gcc and Go with cgo
# rust:    the base, gcc and Rust stable through rustup

# jq, yq, Bun, Go and Rust come from their official images, pinned by
# digest, so Dependabot bumps them with the base. Bun is the root
# Dockerfile's. jq and yq are static binaries, so they run on any base.
FROM ghcr.io/jqlang/jq:1.8.2@sha256:b9c68867e5766576263a222e91db3de422d802069c7af70440e667a95344e486 AS jqdist
FROM mikefarah/yq:4.54.3@sha256:7834187596ad56fd5a81436114e0b0b9dd54c91bb43946d1f7145b2be5f9c3d2 AS yqdist
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS bundist
FROM golang:1.27.4-trixie@sha256:430985542100b871e108ccc00e8dcc5eef08ca14ee5825e98ebf563d8ffec4ee AS godist
FROM rust:1.100.0-slim-trixie@sha256:3b199fd6db7d709274df56565b8f4003f9e30d7bfcff9d53148c86053b7855e2 AS rustdist

FROM ghcr.io/astral-sh/uv:python3.15-trixie-slim@sha256:980d6aa868431fd4ef2b32481e934ef5ee3b662c5decade3aa2d7e7ffb8075e4 AS base

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl findutils git make \
      poppler-utils procps ripgrep tar \
 && rm -rf /var/lib/apt/lists/*

COPY --from=jqdist /jq /usr/local/bin/jq
COPY --from=yqdist /usr/bin/yq /usr/local/bin/yq

# Landlock skips a path that does not exist, so every root the policy
# names is made here. OpenShell refuses a mount on the image's home, so
# the home is /sandbox and the server's HOME is /opt/home.
RUN groupadd -g 1000 sandbox \
 && useradd -u 1000 -g 1000 -d /sandbox -s /bin/bash sandbox \
 && mkdir -p /knowledge /uploads /mcp /repos \
      /opt/home /sandbox/tmp /sandbox/.1ctx \
 && chown sandbox:sandbox /knowledge /uploads /mcp \
      /sandbox /opt/home /sandbox/tmp /sandbox/.1ctx \
 && chmod 1777 /tmp

# Only docker run sees these; the server sends its own with each exec,
# the same for every variant.
ENV HOME=/sandbox \
    TMPDIR=/sandbox/tmp \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/go/bin:/opt/home/go/bin:/opt/home/.cargo/bin:/opt/home/.local/bin:/opt/home/.bun/bin \
    UV_CACHE_DIR=/opt/home/.cache/uv \
    UV_LINK_MODE=copy \
    UV_TOOL_BIN_DIR=/opt/home/.local/bin \
    BUN_INSTALL=/opt/home/.bun \
    BUN_INSTALL_CACHE_DIR=/opt/home/.bun/install/cache \
    GOPATH=/opt/home/go \
    GOCACHE=/opt/home/go/cache \
    GOMODCACHE=/opt/home/go/pkg/mod \
    CGO_ENABLED=1 \
    CC=gcc \
    CARGO_HOME=/opt/home/.cargo \
    RUSTUP_HOME=/opt/home/.rustup \
    DO_NOT_TRACK=1

USER sandbox
WORKDIR /sandbox
CMD ["/bin/bash"]

# gcc for cgo and Rust's linker, one layer go and rust share
FROM base AS cc
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/*
USER sandbox

FROM base AS bun
USER root
COPY --from=bundist /usr/local/bin/bun /usr/local/bin/bun
# node and npx run on Bun, so npm CLIs and #!/usr/bin/env node scripts
# work. Bun is bunx only when called by that name, so npx is a wrapper
RUN ln -s bun /usr/local/bin/bunx \
 && ln -s bun /usr/local/bin/node \
 && printf '#!/bin/sh\nexec /usr/local/bin/bun x "$@"\n' > /usr/local/bin/npx \
 && chmod 0755 /usr/local/bin/npx
USER sandbox

FROM cc AS go
COPY --from=godist /usr/local/go /usr/local/go

# The toolchain lives in HOME, the container's own disk, owned by the
# sandbox user: /usr is read-only in a sandbox, and cargo and rustup
# write their caches and added targets beside it. rustup finds it by
# RUSTUP_HOME, so the image's /usr/local copy runs from here.
FROM cc AS rust
COPY --from=rustdist --chown=sandbox:sandbox /usr/local/rustup /opt/home/.rustup
COPY --from=rustdist --chown=sandbox:sandbox /usr/local/cargo /opt/home/.cargo

FROM base AS python
