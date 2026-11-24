# syntax=docker/dockerfile:1
# check=error=true

# The base of the 1ctx shell images, every step that runs a command:
#
# base:  Python and uv, bash, coreutils, findutils, procps, tar, curl,
#        git, make, jq, yq, ripgrep, pdftotext (the python variant)
# cc:    the base and gcc, for cgo and Rust's linker

# git and ripgrep are built from source at these pins
ARG GIT_VERSION=2.56.1
ARG GIT_SHA256=f0b0bf89264b9bd2e1c640363e7529643989da76281600473c50745cd34a607f
ARG RG_VERSION=16.0.0
ARG RG_SHA256=bc0622e53bb9c097500ebbd2db7f00e4ec332cd1a2432cad3f127ee21655f41b

# jq and yq come from their official images, pinned by digest, so
# Dependabot bumps them. They are static binaries, so they run on any
# base.
FROM ghcr.io/jqlang/jq:1.8.2@sha256:b9c68867e5766576263a222e91db3de422d802069c7af70440e667a95344e486 AS jqdist
FROM mikefarah/yq:4.54.3@sha256:7834187596ad56fd5a81436114e0b0b9dd54c91bb43946d1f7145b2be5f9c3d2 AS yqdist

# the variants Dockerfile's Rust, so Dependabot moves both
FROM rust:1.100.0-slim-trixie@sha256:3b199fd6db7d709274df56565b8f4003f9e30d7bfcff9d53148c86053b7855e2 AS rgbuild
ARG RG_VERSION
ARG RG_SHA256
ADD --checksum=sha256:${RG_SHA256} \
    https://static.crates.io/crates/ripgrep/ripgrep-${RG_VERSION}.crate /src/rg.tar.gz
# PCRE2 linked in statically, so rg needs only libc
RUN cd /src \
 && tar -xzf rg.tar.gz \
 && cd "ripgrep-${RG_VERSION}" \
 && PCRE2_SYS_STATIC=1 cargo build --release --locked --features pcre2 \
 && strip -o /src/rg target/release/rg

# one pin for the base and git's build, so git links the libraries the
# base ships
FROM ghcr.io/astral-sh/uv:python3.15-trixie-slim@sha256:980d6aa868431fd4ef2b32481e934ef5ee3b662c5decade3aa2d7e7ffb8075e4 AS trixie

FROM trixie AS gitbuild
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      gcc libc6-dev make xz-utils \
      libcurl4-openssl-dev libpcre2-dev libssl-dev zlib1g-dev
ARG GIT_VERSION
ARG GIT_SHA256
ADD --checksum=sha256:${GIT_SHA256} \
    https://www.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.xz /src/git.tar.xz
# https through libcurl, grep -P through PCRE2; no Perl, Python, Tcl/Tk,
# gettext, WebDAV push or the optional Rust code, which the image never
# had a use for. Dashed built-ins are skipped and the rest are
# symlinks, not hardlinks, so the install holds one git binary;
# /etc/gitconfig is read, as by Debian's git.
RUN cd /src \
 && tar -xJf git.tar.xz \
 && cd "git-${GIT_VERSION}" \
 && make -j"$(nproc)" prefix=/usr/local sysconfdir=/etc \
      USE_LIBPCRE2=1 NO_PERL=1 NO_PYTHON=1 NO_TCLTK=1 NO_GETTEXT=1 \
      NO_EXPAT=1 NO_RUST=1 NO_INSTALL_HARDLINKS=1 INSTALL_SYMLINKS=1 \
      SKIP_DASHED_BUILT_INS=1 \
      all strip install DESTDIR=/out

FROM trixie AS base

# the libraries git links, named so a change to curl's dependencies
# never drops one
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl findutils make \
      poppler-utils procps tar \
      libcurl4t64 libpcre2-8-0 libssl3t64 zlib1g \
 && rm -rf /var/lib/apt/lists/*

COPY --from=jqdist /jq /usr/local/bin/jq
COPY --from=yqdist /usr/bin/yq /usr/local/bin/yq
COPY --from=gitbuild /out/usr/local/ /usr/local/
COPY --from=rgbuild /src/rg /usr/local/bin/rg

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
