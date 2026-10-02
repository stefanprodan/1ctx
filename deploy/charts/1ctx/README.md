# 1ctx Helm chart

Runs [1ctx](https://1ctx.dev), a self-hosted server where users chat with
AI agents in projects and run them on schedules, on Kubernetes. The chart
is published with every release at `oci://ghcr.io/stefanprodan/charts/1ctx`,
its version the release tag without the `v`, and runs the container image
`ghcr.io/stefanprodan/1ctx` of the same tag. `deploy/flux/` in the
repository installs it with Flux.

The server keeps its data in SQLite, so the chart runs one pod with the
`Recreate` strategy on a ReadWriteOnce volume: an upgrade stops the old
pod before the new one starts. The pod runs as user 65532 on a read-only
root filesystem with no Linux capabilities, and never reads the
Kubernetes API.

Objects are named after the release, or `<release>-1ctx` when the release
name does not contain `1ctx`. A Service name must start with a letter, so
a leading `1ctx` is spelled `onectx`: the release `1ctx` makes the
Deployment, Service and claim `onectx`.

## Values

| Key | Default | Description |
|---|---|---|
| `image.repository` | `ghcr.io/stefanprodan/1ctx` | The container image. |
| `image.tag` | the chart's `appVersion` | The image tag, a release tag such as `v0.0.1`. |
| `image.digest` | `""` | `sha256:...`; when set the image is referenced by digest and the tag is ignored. |
| `image.pullPolicy` | `IfNotPresent` | |
| `imagePullSecrets` | `[]` | `[{name: ...}]` for a private mirror. |
| `drain` | `10` | Seconds a stop lets running chats and runs end on their own, 0 to 3600. The pod's grace period is this plus 15. |
| `trustProxy` | `true` | Take the client address and scheme from the `X-Forwarded-*` headers of the ingress controller. |
| `secureCookie` | `true` | Mark the login cookie `Secure`. Turn it off only when 1ctx is served over plain http. |
| `secrets.existingSecret` | `1ctx` | The Secret mounted at `/secrets`. The chart never makes it. |
| `persistence.size` | `100Gi` | The claim for the database. |
| `persistence.storageClass` | `""` | Empty takes the cluster's default class. |
| `persistence.existingClaim` | `""` | A claim made outside the chart; the chart then renders none. |
| `persistence.keep` | `true` | Keep the claim when the release is removed. |
| `cache.sizeLimit` | `12Gi` | The repositories' cache, an `emptyDir` at `/cache`. Keep it above the `repoCacheBytes` limit (10 GiB by default) and room for an unpack, or the kubelet evicts the pod. |
| `resources` | requests 2 CPU and 2Gi, limits 4 CPU and 8Gi | Only `cpu`, `memory` and `ephemeral-storage`. |
| `service.type` | `ClusterIP` | |
| `service.port` | `80` | The Service port, sent to the container's 11236. |
| `ingress.enabled` | `false` | |
| `ingress.className` | `""` | The `ingressClassName`; empty takes the cluster's default. |
| `ingress.host` | `""` | Required with the ingress on. |
| `ingress.annotations` | `{}` | For the controller or cert-manager. |
| `ingress.tls.enabled` | `false` | |
| `ingress.tls.secretName` | `""` | The certificate's Secret; empty is the objects' name plus `-tls`. |
| `httpRoute.enabled` | `false` | A Gateway API `HTTPRoute` sending `/` to the Service. |
| `httpRoute.parentRefs` | `[]` | The Gateways to attach to, each with `name` and optionally `namespace`, `sectionName`, `port`, `group`, `kind`. Required with the route on. |
| `httpRoute.hostnames` | `[]` | |
| `httpRoute.annotations` | `{}` | |
| `httpRoute.labels` | `{}` | Added to the chart's labels. |
| `provision.existingConfigMap` | `""` | A ConfigMap of YAML objects applied at every start. |
| `provision.files` | `{}` | File name to YAML text, rendered into the chart's own ConfigMap. |
| `serviceAccount.create` | `true` | |
| `serviceAccount.name` | `""` | Empty is the release's name when created, `default` otherwise. |
| `serviceAccount.annotations` | `{}` | |
| `podAnnotations` | `{}` | |
| `nodeSelector` | `{}` | |
| `tolerations` | `[]` | |
| `affinity` | `{}` | |
| `extraArgs` | `[]` | Server flags appended to the chart's. |

`values.schema.json` types every key and refuses any other, so a
misspelt value fails the install instead of being ignored.

## Ingress or Gateway API

The chart can expose the Service through an Ingress, a Gateway API
`HTTPRoute`, or both; both are off by default. The Gateway belongs to the
cluster: the chart only attaches a route to it, and TLS is the Gateway
listener's. The socket at `/api/socket` is a WebSocket, which both carry
with no extra setting on most controllers.

## The Secret

The chart names a Secret, `1ctx` by default, and never makes one. It is
mounted whole and read-only at `/secrets`, one file per key:

- `user-admin.key`, the first admin's password, read once while the
  database has no users. Sign in as `admin` with it.
- The provider, search and MCP keys as `<kind>-<name>.key`, for example
  `provider-openrouter.key`, `search-exa.key` or `mcp-github.key`. The
  name is 1 to 48 lowercase letters, digits and dashes.

Keep it in Git encrypted with SOPS and let Flux decrypt it, or sync it
from a vault with External Secrets. The files are owned by the pod's
group 65532 and readable by it. The pod does not start until the Secret
exists.

A rotated key reaches the pod without a restart once the kubelet syncs
the volume, within a minute or two. The mount is never a `subPath`,
which would never see the change.

## Drain and grace period

On a stop the server stops taking new turns and runs, waits up to
`drain` seconds for running ones to end, then closes the database. The
pod's `terminationGracePeriodSeconds` is `drain` plus 15, so Kubernetes
never kills the shutdown after the drain. `/api/health` stays up while
draining and `/api/ready` goes down, so the liveness probe never cuts a
drain short and the Service stops sending traffic at once.

A start migrates the database and applies the provisioned objects before
it listens. The startup probe gives it ten minutes before the liveness
probe takes over.

## Persistence

The claim holds `1ctx.sqlite`. It carries
`helm.sh/resource-policy: keep`, so removing the release keeps it, and a
reinstall under the same release name and namespace reuses it with its
data.

The repositories' cache is an `emptyDir` at `/cache`, not on the claim:
it is refetched when lost, so a restart only costs fetches. The server's
free space check reads the node's disk, so `cache.sizeLimit` must stay
above the admin's `repoCacheBytes` limit and room for one unpack; past
the size limit the kubelet evicts the pod.

To remove the data with the release, set `persistence.keep: false`, let
the upgrade apply it, then remove the release. With
`persistence.existingClaim` the chart renders no claim and never removes
one.

## Resources

The load bench used about 4 cores and 1.3 to 1.45 GB of memory at 100
agents. A pod throttled at its CPU limit stretches every command toward
its deadline, and one at its memory limit is killed in the middle of a
turn, so raise both limits as the number of agents grows.

## Provisioning

The server applies the YAML objects (users, projects, providers, agents
and the other kinds of `1ctx provision`) at every start, before it
listens. A failed apply exits, and the pod restarts until it is fixed.
Set one of the two forms; both is an error, and neither applies nothing.

- `provision.files` renders the chart's own ConfigMap. A pod annotation
  holds its checksum, so an edit rolls the pod and the change applies.
- `provision.existingConfigMap` names a ConfigMap made outside the chart.
  The chart cannot see its content, so a change to it applies on the
  next rollout, such as the next chart upgrade.

Only `.yaml` and `.yml` files are read. A ConfigMap has no folders, so a
project's `knowledge` folder cannot be provisioned this way.
