# syntax=docker/dockerfile:1
# check=error=true

# The image a sandbox shell runs. It holds the tools a command reaches
# for and every root the sandbox policy names: Landlock skips a path
# that does not exist. The fixed helpers are not here; the server passes
# them with each exec, so the image never drifts from the binary.
FROM ubuntu:24.04@sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8

# uv and yq are release binaries, pinned with the sha256 each release
# publishes for it
ARG UV_VERSION=0.13.9
ARG UV_SHA256_AMD64=a7fbaff2b9a271d85c1bdb540941090fd1ce011797b4abeb48e4dcd39c2471d5
ARG UV_SHA256_ARM64=0797542018e541a9288855df555c8077eed06f7a47d206362030480e8ecc9f3d
ARG YQ_VERSION=v4.54.3
ARG YQ_SHA256_AMD64=129534601871538efe0ba4c5e62a34fb1d5f469bcb975c4fddeb467d82974973
ARG YQ_SHA256_ARM64=89f69310b61b68d1245065a1241d1fc843f7a36cd6103ffd77ad987613bd1b67
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates coreutils curl findutils git jq procps \
      python3 ripgrep tar \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) arch=x86_64; uv_sha=$UV_SHA256_AMD64; yq_sha=$YQ_SHA256_AMD64 ;; \
      arm64) arch=aarch64; uv_sha=$UV_SHA256_ARM64; yq_sha=$YQ_SHA256_ARM64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    uv=uv-$arch-unknown-linux-gnu; \
    curl -fsSLo /tmp/uv.tar.gz \
      "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$uv.tar.gz"; \
    echo "$uv_sha  /tmp/uv.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tar.gz -C /usr/local/bin --strip-components=1 \
      "$uv/uv" "$uv/uvx"; \
    curl -fsSLo /usr/local/bin/yq \
      "https://github.com/mikefarah/yq/releases/download/$YQ_VERSION/yq_linux_$TARGETARCH"; \
    echo "$yq_sha  /usr/local/bin/yq" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/yq /usr/local/bin/uv /usr/local/bin/uvx; \
    rm /tmp/uv.tar.gz

# The base image's ubuntu user holds uid 1000, the workload's.
# /knowledge, /uploads and /mcp hold rows the server pushes as the
# workload, /opt/home and /sandbox/tmp the programs' own files, and
# /sandbox/.1ctx a command's records; /repos takes read-only mounts.
# OpenShell keeps the image's home and working folder for its
# workspace and refuses a mount there, so both are /sandbox, its
# workspace, and the server's HOME, /opt/home, a tmpfs it mounts and
# sets on each exec, is never either.
RUN userdel -r ubuntu \
 && groupadd -g 1000 sandbox \
 && useradd -u 1000 -g 1000 -d /sandbox -s /bin/bash sandbox \
 && mkdir -p /knowledge /uploads /mcp /repos \
      /opt/home /sandbox/tmp /sandbox/.1ctx \
 && chown sandbox:sandbox /knowledge /uploads /mcp \
      /sandbox /opt/home /sandbox/tmp /sandbox/.1ctx \
 && chmod 1777 /tmp

# For docker run only: OpenShell's execs do not see these, so the
# server passes its own. uv runs the image's python3, keeps
# its cache where the home's size caps it, and copies, since the cache
# and a project sit on different mounts
ENV HOME=/sandbox \
    TMPDIR=/sandbox/tmp \
    UV_PYTHON_DOWNLOADS=never \
    UV_CACHE_DIR=/opt/home/.cache/uv \
    UV_LINK_MODE=copy

USER sandbox
WORKDIR /sandbox
