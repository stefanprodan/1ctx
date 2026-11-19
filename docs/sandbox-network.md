# Sandbox network

Governs the sandbox shell's network and credentials:
`src/server/sandbox/netpolicy.ts`, `network.ts`, `rules.ts`,
`scrub.ts`, `shared/sandbox-net.ts` and `scripts/sandbox-net-check.ts`.
The rest of the sandbox shell is in `docs/sandbox.md` and
`docs/sandbox-commands.md`.

OpenShell's own policy and credential injection, no proxy of ours.
`netpolicy.ts` makes the policy, pure; `network.ts` applies it in
`acquire()`, after the lease and before the command; `rules.ts` holds
what the bash tool's description shares with it.

- **The policy is the sandbox setting's, read at each command.** Off:
  no endpoint. Hosts: each host, exact or wildcard, on 443 and 80. Web
  access's all or listed never applies: OpenShell cannot open every
  name, since a wildcard needs three labels and a rule without a host
  reaches raw addresses alone, so the sandbox lists its hosts. Every
  endpoint is `protocol: rest`, `enforcement: enforce` (1 in the proto; unset is
  audit) with the seven methods allowed, for `/usr/bin/bash`, which
  covers what the wrapper starts.
- **It loads only when it changed,** waited for until the sandbox
  reports its version active. A fresh sandbox's empty policy is the
  create's, so off loads nothing.
- **Commands sharing a sandbox run under one plan:** the same policy
  and credentials. A command whose plan differs (the setting, a key or
  its send's web access moved) while others whose network was set up
  hold the sandbox never changes it: it retires the sandbox and waits
  for them to end, then gets another. So no running command's network
  widens or ends, and each save's scrub holds every key the sandbox
  was given. Alone, a change applies in place or recycles (below).
- **A send without web access runs as off.** Its snapshot is null
  (Web access off, or the chat's or automation's own switch off), so
  `ShellCall.network` is false: no endpoint, no credential, a sandbox
  that had hosts recycled (`network`), and the tool description says
  "No network.", as the prompt does. With a network it names the
  admin's list by kind and the examples it holds of pypi.org,
  registry.npmjs.org and github.com, never the other hosts.
- **A credential is a provider, in hosts mode only.** One endpointless
  profile per credential shape (`1ctx-` and a hash of the instance, the
  manager, the variable and the placement, annotated with the instance
  id) and one provider per credential, prefix and key (`1ctx-` and a
  hash, with the manager, and the key's hash salted per process,
  labelled). Each gateway manager salts its names with a random value
  of its own (`owner`), so two managers never share a provider or
  profile, even on one gateway saved under two endpoints, and a delete
  of one manager's never takes another's. A provider's key is put
  once and never changed: a rotation is a new provider, so a sandbox
  bound to the old one keeps the key its send read and scrubs.
- **Its rule binds the prefix's host, port and glob** (`/v1/` as
  `/v1/**`) with `credentialBinding.provider`. OpenShell's endpoint
  glob selects `/v1` too, a rule's `/v1/**` never does, so the rules
  name both `/v1` and `/v1/**`: its methods allowed, every other
  denied. Its host joins even when not listed. Credentials come with
  Web access on, as for the built-in shell. A subagent runs in its
  parent's sandbox and is offered its parent's credentials, so one
  policy serves both. A send's offer, a chat's or a subagent's, reads
  the shell at the send's start; once the setting moved to the other
  shell, `mount.ts` runs none of its commands (`SHELL_SWITCHED`), so
  its network and credentials never meet a shell they were not offered
  for. The next send's offer names the new shell.
- **The order is attach, bind, ready.** Providers are attached first
  (withheld until bound, never an error), the policy binds them, then
  each provider's current state is polled until `ready`, at most
  `READY_MS` (10 s). An attach waits for another attach or delete of
  its provider only until the command's deadline. A failure fails the
  command and retires the lease (`retire()`): doomed, so no command
  joins it, it goes at its last release while the commands beside it
  run on. A command that waited for that setup's turn goes to another
  sandbox. The profile and key are asked again next time.
- **Placeholders are the provider's variable**, `ONECTX_CRED_<NAME>`,
  which OpenShell's supervisor puts in every new exec's environment.
  `Authorization` takes any template (bearer style); another header
  only a template that is the key alone. A `Cookie`, a template with
  words around the key in another header, a header or template holding
  `$`, a backtick, `"` or `\` (the description double-quotes it, so the
  variable expands), a prefix with a glob character or `%`, a prefix whose host is a pattern (`*`) or an IPv6
  literal, a variable two names share, and every refusal
  `commandCredentials()` makes are not attached; each send's first
  command names them in its notice.
- **What cannot be undone recycles.** A credential removed, its key
  rotated or its prefix changed deletes the sandbox before the command
  (`credentials`), since an echoed key or an old placeholder may
  outlive the send there; so does the network turned off, by the
  setting or the send's web access (`network`), since a new sandbox
  starts with none. Beside running commands it retires instead.
- **Keys are scrubbed from what leaves.** OpenShell never redacts a
  response. The mount scrubs the output before its cut; `scrub.ts`
  replaces every key the send read, with `escapedForms()`, in the
  pulled files before they commit and in open's copies. A doc or
  scratch name or an opened path holding one, in any of those forms,
  saves nothing and recycles.
- **Providers go with their last sandbox.** One no lease of any
  manager uses is deleted once its sandbox's delete is observed (it
  cannot go while attached; a failed delete is asked again after 5 and
  15 s), then its profile once no provider of any manager uses it, one
  still attaching included. The sweeps keep sandboxes, providers and
  profiles a lease of any manager uses and delete the rest of the
  instance's, whatever their names, each asked again right before its
  delete under the attach's lock: one per provider name and one per
  profile, across managers.
- **`scripts/sandbox-net-check.ts`** (`make sandbox-net-check`) runs
  the request matrix against a real gateway with made-up keys.

## Accepted differences from `commandFetch()`

- Under an attached prefix a request without the placeholder goes out
  unsigned; under a refused one too, when another rule admits it.
- A prefix `/v1/` signs `/v1` too, and a matrix parameter (`/v1;x`)
  reads as `/v1`, each with its methods alone; TLS is OpenShell's
  choice; encoded paths (`%2F`) and `Upgrade` are refused, except
  `%2F` on the hosts of `ENCODED_SLASH_HOSTS` (`netpolicy.ts`), where
  bun and npm ask for a scoped package as `@scope%2fname`. A host a
  credential of the send binds never takes the exception, so its
  prefix check keeps refusing `%2F`.
- A credential's methods hold only on servers that ignore
  method-override headers (`X-HTTP-Method-Override`), which the
  builtin refuses on a signed request.
- The sandbox reaches its own hosts alone, on ports 80 and 443, never
  Web access's all or listed: a host not in its list is refused
  whichever is set. A wildcard host reaches public addresses only.
- No routing, shaping, `Range` or 206 refusals, no redaction of
  responses, no `fetchBodyBytes` or fetch deadline.
- A redirect is a new request the client makes, checked on its own; a
  placeholder off its binding is a 403 `credential_endpoint_mismatch`,
  in another header `credential_placement_mismatch`.
- An exact listed host may reach the private addresses it resolves to;
  loopback, link-local and metadata never. The sandbox's own loopback
  is reachable.
- A key rotated or a global policy set mid-command applies until the
  command ends; refusals are OpenShell's status and words.
