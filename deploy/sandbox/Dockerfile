# syntax=docker/dockerfile:1
# check=error=true

# The 1ctx shell image, one target per variant:
#
# python:  Python and uv, bash, coreutils, findutils, procps, tar, curl,
#          git, make, jq, yq, ripgrep (the base, in every variant)
# bun:     the base and Bun, with node and npx running on Bun
# go:      the base, gcc and Go with cgo
# rust:    the base, gcc and Rust stable through rustup
FROM ghcr.io/astral-sh/uv:python3.15-trixie-slim@sha256:980d6aa868431fd4ef2b32481e934ef5ee3b662c5decade3aa2d7e7ffb8075e4 AS base

ARG YQ_VERSION=v4.54.3
ARG YQ_SHA256_AMD64=129534601871538efe0ba4c5e62a34fb1d5f469bcb975c4fddeb467d82974973
ARG YQ_SHA256_ARM64=89f69310b61b68d1245065a1241d1fc843f7a36cd6103ffd77ad987613bd1b67
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl findutils git jq make \
      procps ripgrep tar \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) yq_sha=$YQ_SHA256_AMD64 ;; \
      arm64) yq_sha=$YQ_SHA256_ARM64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /usr/local/bin/yq \
      "https://github.com/mikefarah/yq/releases/download/$YQ_VERSION/yq_linux_$TARGETARCH"; \
    echo "$yq_sha  /usr/local/bin/yq" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/yq

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
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/go/bin:/opt/home/go/bin:/opt/home/.cargo/bin \
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
ARG BUN_VERSION=1.4.4
ARG BUN_SHA256_AMD64=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
ARG BUN_SHA256_ARM64=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
ARG TARGETARCH
USER root
# node and npx run on Bun, so npm CLIs and #!/usr/bin/env node scripts work
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) bun=bun-linux-x64; bun_sha=$BUN_SHA256_AMD64 ;; \
      arm64) bun=bun-linux-aarch64; bun_sha=$BUN_SHA256_ARM64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$bun.zip"; \
    echo "$bun_sha  /tmp/bun.zip" | sha256sum -c -; \
    python3 -m zipfile -e /tmp/bun.zip /tmp/bun; \
    mv "/tmp/bun/$bun/bun" /usr/local/bin/bun; \
    chmod 0755 /usr/local/bin/bun; \
    ln -s bun /usr/local/bin/bunx; \
    ln -s bun /usr/local/bin/node; \
    ln -s bunx /usr/local/bin/npx; \
    rm -r /tmp/bun.zip /tmp/bun
USER sandbox

FROM cc AS go
ARG GO_VERSION=1.27.4
ARG GO_SHA256_AMD64=7226736c2339719cda28fbf3a54d71aa63bcefe376e98cef00034268dab24840
ARG GO_SHA256_ARM64=3392582988a273a87ab5043ee1b2c9c17a2c3c00580bf9326c47a2e0aaaeac92
ARG TARGETARCH
USER root
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) go_sha=$GO_SHA256_AMD64 ;; \
      arm64) go_sha=$GO_SHA256_ARM64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/go.tar.gz \
      "https://dl.google.com/go/go$GO_VERSION.linux-$TARGETARCH.tar.gz"; \
    echo "$go_sha  /tmp/go.tar.gz" | sha256sum -c -; \
    tar -C /usr/local -xzf /tmp/go.tar.gz; \
    rm /tmp/go.tar.gz
USER sandbox

# The toolchain lives in HOME, the container's own disk, owned by the
# sandbox user: /usr is read-only in a sandbox, and rustup adds another
# toolchain or target beside this one.
FROM cc AS rust
ARG RUSTUP_VERSION=1.29.3
ARG RUSTUP_SHA256_AMD64=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
ARG RUSTUP_SHA256_ARM64=9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282
ARG RUST_VERSION=1.100.0
ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) target=x86_64-unknown-linux-gnu; sha=$RUSTUP_SHA256_AMD64 ;; \
      arm64) target=aarch64-unknown-linux-gnu; sha=$RUSTUP_SHA256_ARM64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /sandbox/tmp/rustup-init \
      "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/$target/rustup-init"; \
    echo "$sha  /sandbox/tmp/rustup-init" | sha256sum -c -; \
    chmod 0755 /sandbox/tmp/rustup-init; \
    /sandbox/tmp/rustup-init -y --no-modify-path --profile minimal \
      --default-toolchain "$RUST_VERSION"; \
    rm /sandbox/tmp/rustup-init; \
    rustc --version

FROM base AS python
