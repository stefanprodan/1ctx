#!/usr/bin/env bash
# The local kind cluster for chart work and the load harness. Subcommands:
#   up      create the cluster and install metrics-server (kubectl top)
#   image   build the image (make image) and load it into the cluster
#   down    delete the cluster and everything in it
# kind switches the current context on create; the previous one is put
# back, even when the create fails.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=1ctx-test
CONTEXT=kind-$NAME
IMAGE=ghcr.io/stefanprodan/1ctx:dev
METRICS_SERVER=v0.9.0

k() { kubectl --context "$CONTEXT" "$@"; }

restore() {
  if [[ -n "$1" ]]; then
    kubectl config use-context "$1" >/dev/null 2>&1 || true
  else
    kubectl config unset current-context >/dev/null 2>&1 || true
  fi
}

up() {
  if kind get clusters | grep -qx "$NAME"; then
    echo "cluster $NAME exists"
  else
    PREVIOUS=$(kubectl config current-context 2>/dev/null || true)
    trap 'restore "$PREVIOUS"' EXIT
    kind create cluster --name "$NAME" --wait 120s
  fi
  # kind's kubelets serve self-signed certificates; the flag goes in the
  # manifest, so a repeated apply leaves the deployment unchanged
  curl -fsSL "https://github.com/kubernetes-sigs/metrics-server/releases/download/$METRICS_SERVER/components.yaml" |
    perl -pe 's/^(\s+)- --secure-port=10250$/$&\n$1- --kubelet-insecure-tls/' |
    k apply -f - >/dev/null
  k -n kube-system rollout status deploy/metrics-server --timeout=180s
  echo "cluster $NAME ready, context $CONTEXT"
}

image() {
  # PLATFORMS builds into the cache only and would load a stale image
  PLATFORMS='' scripts/image.sh
  kind load docker-image "$IMAGE" --name "$NAME"
}

case ${1:-} in
up) up ;;
image) image ;;
down) kind delete cluster --name "$NAME" ;;
*)
  echo "usage: kind.sh up|image|down" >&2
  exit 2
  ;;
esac
