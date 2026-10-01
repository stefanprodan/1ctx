# syntax=docker/dockerfile:1
# check=error=true

FROM --platform=$BUILDPLATFORM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY patches patches
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY vendor vendor
COPY src src
ARG TARGETARCH
ARG VERSION
# Bun cross-compiles, so every platform builds natively on the build host.
RUN case "$TARGETARCH" in \
      amd64) TARGET=bun-linux-x64 ;; \
      arm64) TARGET=bun-linux-arm64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && TARGET=$TARGET VERSION=$VERSION bun run build \
 && mkdir /data

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=build /src/bin/1ctx /usr/local/bin/1ctx
COPY LICENSE THIRD_PARTY_LICENSES.md /usr/share/doc/1ctx/
# A new named volume copies this directory with its owner.
COPY --from=build --chown=65532:65532 /data /data
USER 65532:65532
WORKDIR /data
EXPOSE 11236
ENTRYPOINT ["/usr/local/bin/1ctx"]
CMD ["--listen", "0.0.0.0:11236", "--db", "/data/1ctx.sqlite", "--secrets", "/secrets"]
