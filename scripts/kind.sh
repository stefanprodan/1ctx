#!/usr/bin/env bash
# The local kind cluster for chart work and the load harness. Subcommands:
#   up      create the cluster and install metrics-server (kubectl top)
#   image   build the image (make image) and load it into the cluster
#   down    delete the cluster and everything in it
# kind switches the current context on create; the previous one is kept.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=1ctx-test
CONTEXT=kind-$NAME
IMAGE=ghcr.io/stefanprodan/1ctx:dev
METRICS_SERVER=v0.9.0
K="kubectl --context $CONTEXT"

up() {
  if kind get clusters | grep -qx "$NAME"; then
    echo "cluster $NAME exists"
  else
    local previous
    previous=$(kubectl config current-context 2>/dev/null || true)
    kind create cluster --name "$NAME" --wait 120s
    if [[ -n "$previous" ]]; then
      kubectl config use-context "$previous" >/dev/null
    fi
  fi
  $K apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/$METRICS_SERVER/components.yaml" >/dev/null
  # kind's kubelets serve self-signed certificates
  if ! $K -n kube-system get deploy metrics-server -o jsonpath='{.spec.template.spec.containers[0].args}' |
    grep -q kubelet-insecure-tls; then
    $K -n kube-system patch deploy metrics-server --type json \
      -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' >/dev/null
  fi
  $K -n kube-system rollout status deploy/metrics-server --timeout=180s
  echo "cluster $NAME ready, context $CONTEXT"
}

image() {
  scripts/image.sh
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
