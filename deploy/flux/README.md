# Installing 1ctx with Flux

`1ctx.yaml` installs the 1ctx Helm chart from a Flux repository: a Git
repository that Flux syncs to the cluster. Every step below is a file
committed there; nothing is applied by hand. The chart's values and notes
are in [`deploy/charts/1ctx/README.md`](../charts/1ctx/README.md).

## 1. The namespace and the Secret

Both objects live in the namespace `1ctx`. Add it to the repository if
nothing else makes it:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: 1ctx
```

The chart never makes the Secret it mounts at `/secrets`. Name it `1ctx`
in the namespace `1ctx`, one key per file:

- `user-admin.key`, the first admin's password, read once while the
  database has no users.
- The provider, search and MCP keys as `<kind>-<name>.key`, such as
  `provider-openrouter.key` or `search-exa.key`, the names the
  provisioned objects and the admin pages refer to.

Get it there in one of two ways:

- **SOPS.** Commit the Secret encrypted with SOPS (age or a cloud KMS key)
  and set `decryption.provider: sops` on the Flux `Kustomization` that
  syncs this folder, with the key in its `secretRef`. Flux decrypts it at
  apply time; Git only ever holds the ciphertext.
- **External Secrets.** Commit an `ExternalSecret` with the target name
  `1ctx` that maps each key from your vault to its `.key` file name.

To rotate a key, change it in Git or in the vault. The pod sees the new
file within a minute or two, without a restart.

## 2. The chart source

The `OCIRepository` pulls the chart from
`oci://ghcr.io/stefanprodan/charts/1ctx`, which every release pushes
beside the container image, with the version of the tag without its `v`.
`ref.semver: "0.x"` follows every 0.x release; a 1.0 release waits until
the range is changed in Git. The `layerSelector` takes the chart's layer
from the artifact.

## 3. The release

The `HelmRelease` installs the chart from that source. Its `timeout` is
15 minutes, since a start migrates the database before the pod is ready.
The values worth setting:

- `secrets.existingSecret`, when the Secret is not named `1ctx`.
- `persistence.storageClass` and `persistence.size` for the database's
  volume, 100Gi by default.
- `httpRoute` to attach 1ctx to a Gateway API Gateway, or `ingress` with
  `host` and `tls` for an Ingress controller. TLS of a route is the
  Gateway listener's.
- `provision.files` for the users, projects, providers and agents applied
  at every start, or `provision.existingConfigMap`.
- `resources`, raised with the number of agents.
- `drain`, how long a stop lets running chats and runs end.

Commit both files with the Secret, and Flux installs the release on its
next sync.

## Upgrades

A release pushes a new chart version. Flux sees it within the
`OCIRepository`'s `interval` when it is inside the semver range, and
upgrades the release: the old pod stops, draining its chats and runs,
then the new one starts and migrates the database. To hold a version,
set `ref.semver` to it, or `ref.tag`. To go past 0.x, widen the range.

## Removing the release

Remove `1ctx.yaml` from the repository. The `Kustomization` that
synced it, with `prune: true`, deletes the HelmRelease and Flux
uninstalls the release. The volume claim carries
`helm.sh/resource-policy: keep`, so the database survives, and a release
installed again under the same name and namespace reuses it.

To remove the data with the release, set `persistence.keep: false` in the
values, let Flux apply the upgrade, then remove the files. The
`Kustomization` that synced the namespace removes it too when it prunes,
so keep the namespace's file in Git while the claim is kept.
