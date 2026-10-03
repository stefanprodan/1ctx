# Helm chart for 1ctx

## Introduction

[1ctx](https://1ctx.dev) is a self-hosted server where users chat with AI
agents in projects and run them on schedules. This chart deploys 1ctx on
Kubernetes.

## Prerequisites

- Helm 3.8.0 or later
- A persistent volume provisioner in the cluster, unless using an existing
  claim
- A Secret named `onectx` in the release namespace, see
  [Configure passwords and API keys](#configure-passwords-and-api-keys)

## Installing the chart

Create the namespace and the Secret with the admin password, then
install the chart with the release name `onectx`:

```sh
kubectl create namespace onectx
kubectl -n onectx create secret generic onectx \
  --from-literal=user-admin.key='<password>'
helm install onectx oci://ghcr.io/stefanprodan/charts/onectx \
  --namespace onectx
```

## Uninstalling the chart

```sh
helm uninstall onectx --namespace onectx
```

The chart-created database claim is kept by default. See
[Persistence](#persistence).

## Configuration and installation details

### Configure passwords and API keys

Passwords and API keys are read from an existing Secret, named by
`secrets.existingSecret` and mounted at `/secrets`. Each key is one file:

- `user-admin.key`: the `admin` password, 8 characters or more. It
  creates the admin when the database has no users. With provisioning
  on, every start signs in with it, so it must match the admin's current
  password.
- `<kind>-<name>.key`: kinds are `user`, `provider`, `search`, `mcp` and
  `http`. The name is 1 to 48 lowercase letters, digits or hyphens, and
  starts with a letter or digit.

Provider, search, MCP and HTTP keys are picked up without a restart.

### Provision objects at start

Use `provision.files` to create a ConfigMap from values, or
`provision.existingConfigMap` to mount a ConfigMap created outside the chart.
Do not set both. Only files ending in `.yaml` or `.yml` are read.

Provisioning runs at every start before the server listens. A failed apply
prevents the server from starting. A change to `provision.files` changes the
pod template checksum and rolls the pod. A change to an existing ConfigMap is
applied on the next rollout.

### Configure Ingress or Gateway API

Set `ingress.enabled` and `ingress.host` to create an Ingress.

Set `httpRoute.enabled` to create a Gateway API `HTTPRoute`.
It attaches to the Gateways in `httpRoute.parentRefs`. Configure TLS on
the Gateway.

### Graceful shutdown

On termination, 1ctx waits up to `drain` seconds for running chats and runs to
finish. The pod termination grace period is `drain` plus 15 seconds.
During the drain, readiness fails and liveness stays up.

The startup probe allows 10 minutes for database migrations and
provisioning.

### Resource requests and limits

The defaults request 1 CPU and 1 GiB of memory, with limits of 4 CPUs and 4 GiB.
Increase resources as concurrent agent work grows. A memory limit can terminate
the pod during a turn, while CPU throttling slows running work.

## Persistence

1ctx stores its SQLite database on a ReadWriteOnce persistent volume claim. The
Deployment uses one replica and the `Recreate` strategy.

By default, the chart-created claim has the Helm `keep` policy. It remains after
uninstall and is reused when the same release name is installed again in the
same namespace. To remove the claim with the release, upgrade with
`persistence.keep` set to `false`, then uninstall. Set
`persistence.existingClaim` to use a claim that the chart does not
create or manage.

Repository checkouts use an `emptyDir` mounted at `/cache`, not the database
claim. The server trims it to the `repoCacheBytes` limit (10 GiB by
default, set in Admin > Limits), but repositories used by running turns
can temporarily exceed it. If
`cache.sizeLimit` or a pod `ephemeral-storage` limit is exceeded, the kubelet
can evict the pod. Leave enough headroom for active turns.

## Parameters

### Image parameters

| Name | Description | Value |
|---|---|---|
| `image.repository` | Container image repository | `ghcr.io/stefanprodan/1ctx` |
| `image.tag` | Container image tag. Empty uses the chart's `appVersion` | `""` |
| `image.digest` | Container image digest in `sha256:<digest>` form. Overrides the tag | `""` |
| `image.pullPolicy` | Container image pull policy | `IfNotPresent` |
| `imagePullSecrets` | References to image pull Secrets | `[]` |

### Server parameters

| Name | Description | Value |
|---|---|---|
| `drain` | Seconds to wait for running chats and runs during shutdown. Valid range is 0 to 3600 | `10` |
| `trustProxy` | Read the client address and scheme from `X-Forwarded-*` headers | `true` |
| `secureCookie` | Mark the login cookie as `Secure`. Disable only when serving plain HTTP | `true` |
| `secrets.existingSecret` | Existing Secret mounted at `/secrets` | `onectx` |
| `provision.existingConfigMap` | Existing ConfigMap containing YAML objects applied at start | `""` |
| `provision.files` | Map of `.yaml` or `.yml` file names to YAML text applied at start | `{}` |
| `extraArgs` | Additional arguments appended to the server arguments | `[]` |

### Deployment parameters

| Name | Description | Value |
|---|---|---|
| `resources.requests` | Container resource requests | `{"cpu": "1", "memory": "1Gi"}` |
| `resources.limits` | Container resource limits | `{"cpu": "4", "memory": "4Gi"}` |
| `serviceAccount.create` | Create a ServiceAccount | `true` |
| `serviceAccount.name` | ServiceAccount name. Empty uses `<fullname>` when created, or `default` when not created | `""` |
| `serviceAccount.annotations` | Annotations for the created ServiceAccount | `{}` |
| `podAnnotations` | Annotations for the pod template | `{}` |
| `nodeSelector` | Node labels used for pod assignment | `{}` |
| `tolerations` | Pod tolerations | `[]` |
| `affinity` | Pod affinity rules | `{}` |

### Traffic exposure parameters

| Name | Description | Value |
|---|---|---|
| `service.type` | Kubernetes Service type | `ClusterIP` |
| `service.port` | Kubernetes Service port | `80` |
| `ingress.enabled` | Create an Ingress | `false` |
| `ingress.className` | Ingress class name. Empty uses the cluster default | `""` |
| `ingress.host` | Ingress host. Required when the Ingress is enabled | `""` |
| `ingress.annotations` | Ingress annotations | `{}` |
| `ingress.tls.enabled` | Add TLS configuration to the Ingress | `false` |
| `ingress.tls.secretName` | TLS Secret name. Empty uses `<fullname>-tls` | `""` |
| `httpRoute.enabled` | Create a Gateway API `HTTPRoute` | `false` |
| `httpRoute.parentRefs` | Gateway parent references. Required when the route is enabled | `[]` |
| `httpRoute.hostnames` | Hostnames matched by the route | `[]` |
| `httpRoute.annotations` | HTTPRoute annotations | `{}` |
| `httpRoute.labels` | Additional HTTPRoute labels | `{}` |

### Persistence parameters

| Name | Description | Value |
|---|---|---|
| `persistence.size` | Requested size of the database volume | `100Gi` |
| `persistence.storageClass` | Storage class for the database claim. Empty uses the cluster default | `""` |
| `persistence.existingClaim` | Existing database claim. When set, the chart does not create a claim | `""` |
| `persistence.keep` | Keep the chart-created claim after uninstall | `true` |
| `cache.sizeLimit` | Size limit for the `/cache` `emptyDir`. Empty uses available node ephemeral storage | `""` |

The values schema rejects unknown keys.
