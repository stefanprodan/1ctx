# Installing 1ctx with Flux

`onectx.yaml` installs the [onectx chart](../charts/onectx/README.md)
with an `OCIRepository` and a `HelmRelease` in the namespace `onectx`.
Commit it to the repository Flux syncs, with the namespace and the
Secret below, after replacing its storage class, Gateway and hostname.

## Namespace

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: onectx
```

## Passwords and API keys

Create a Secret named `onectx` in the namespace `onectx`, one key per
file:

- `user-admin.key`: the `admin` password. With `provision` set, every
  start signs in with it, so keep it equal to the admin's password.
- `<kind>-<name>.key`: provider, search, MCP and HTTP keys, such as
  `provider-openrouter.key` or `search-exa.key`.

Commit it encrypted with SOPS and set `decryption.provider: sops` on the
Flux `Kustomization`, or commit an `ExternalSecret` with the target name
`onectx`. Rotated API keys are picked up without a restart.

## Values

The values most installs set:

- `persistence.storageClass` and `persistence.size` (100Gi by default).
- `httpRoute` for a Gateway API Gateway, or `ingress` for an Ingress
  controller.
- `provision.files` for the users, projects, providers and agents applied
  at every start.
- `resources`, raised with the number of agents.

The HelmRelease `timeout` is 15 minutes, since a start runs the database
migrations before the pod is ready.

## Upgrading

`ref.semver: "0.x"` follows every 0.x release. To hold a version, set
`ref.semver` or `ref.tag` to it.

## Uninstalling

Remove `onectx.yaml` from the repository. The claim is kept, and a
release installed again with the same name and namespace reuses it. To
remove the data too, set `persistence.keep: false` and let Flux upgrade
the release before removing the file. Keep the namespace in Git while
the claim is kept.
