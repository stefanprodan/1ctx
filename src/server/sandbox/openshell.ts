// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The gateway port over OpenShell's SDK: Connect gRPC over node:http2
// with mutual TLS. Exec goes through the raw RPC, since the SDK's
// curated stream retries on a transport error before response headers
// and a command must launch once or not at all.

import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import {
  fromConnect,
  SandboxClient,
  type SandboxPhaseName,
  SdkError,
} from "openshell-sdk";
import { PolicyStatus, ServiceStatus } from "openshell-sdk/raw";
import type {
  Connect,
  CreateSpec,
  ExecEvent,
  ExecRequest,
  Gateway,
  SandboxPhase,
  SandboxPolicy,
} from "./gateway.ts";

// 1ctx keeps every sandbox and provider in the gateway's default
// workspace; the instance label tells its own apart
const WORKSPACE = "default";
const SCOPE = { selection: { case: "workspace" as const, value: WORKSPACE } };
// the SDK's waits take a timeout too; the caller's signal ends them first
const WAIT_SECONDS = 24 * 3600;
// how often a policy's load is asked: push delivery loads in about 60 ms
const POLICY_POLL_MS = 50;

const PHASES: Partial<Record<SandboxPhaseName, SandboxPhase>> = {
  provisioning: "provisioning",
  starting: "provisioning",
  ready: "ready",
  error: "error",
  deleting: "deleting",
  stopping: "stopped",
  stopped: "stopped",
};

const notFound = (error: unknown) =>
  (error instanceof SdkError ? error : fromConnect(error)).code === "not_found";

const selector = (labels: Record<string, string>) =>
  Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");

// the create-time policy as the proto takes it; Landlock must hold, as
// it skips a root the image lacks in best effort
export function protoPolicy(
  policy: SandboxPolicy,
  network: Record<string, unknown> = {},
) {
  return {
    version: 1,
    filesystem: {
      includeWorkdir: false,
      readOnly: policy.readOnly,
      readWrite: policy.readWrite,
    },
    landlock: { compatibility: "hard_requirement" },
    networkPolicies: network,
  };
}

// the template the create's rawSpec carries: rawSpec replaces the
// curated template, so the image goes here with the mounts
export function template(spec: CreateSpec) {
  return {
    image: spec.image,
    resources: {
      limits: { cpu: String(spec.cpus), memory: `${spec.memoryMiB}Mi` },
    },
    driverConfig: {
      docker: {
        mounts: spec.mounts.map((mount) =>
          mount.type === "tmpfs"
            ? {
                type: "tmpfs",
                target: mount.target,
                size_bytes: mount.sizeBytes,
                mode: 0o1777,
                // the driver's tmpfs is noexec without it
                ...(mount.exec ? { options: ["exec"] } : {}),
              }
            : {
                type: "bind",
                source: mount.source,
                target: mount.target,
                read_only: true,
              },
        ),
      },
    },
  };
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

// a call whose RPC takes no signal: the caller stops waiting at the
// signal, and what the gateway still does is the sweep's to find
function unless<T>(call: Promise<T>, signal: AbortSignal): Promise<T> {
  call.catch(() => {});
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    call.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", stop);
    });
  });
}

export const openshellGateway: Connect = (config) => {
  // our own session, the SDK's transport built over it, so close() ends
  // the connection the SDK would keep open
  const session = new Http2SessionManager(config.endpoint, undefined, {
    ca: config.ca,
    cert: config.cert,
    key: config.key,
  });
  const transport = createGrpcTransport({
    baseUrl: config.endpoint,
    sessionManager: session,
  });
  const sdk = new SandboxClient(transport);
  const client = { raw: sdk.raw, sandbox: sdk };
  const gateway: Gateway = {
    async health(signal) {
      try {
        const resp = await client.raw.health({}, { signal });
        return {
          healthy: resp.status === ServiceStatus.HEALTHY,
          version: resp.version,
        };
      } catch (error) {
        throw fromConnect(error);
      }
    },
    async globalPolicy(signal) {
      try {
        const resp = await client.raw.getSandboxPolicyStatus(
          { global: true, version: 0, sandbox: "" },
          { signal },
        );
        const revision = resp.revision;
        // a deleted global policy stays as the last revision, superseded
        return (
          revision !== undefined &&
          revision.version > 0 &&
          revision.status !== PolicyStatus.SUPERSEDED
        );
      } catch (error) {
        if (notFound(error)) return false;
        throw fromConnect(error);
      }
    },
    async create(spec, signal) {
      await unless(
        client.sandbox.create({
          name: spec.name,
          labels: spec.labels,
          command: spec.command,
          // network rules are plain objects here; the proto checks them
          policy: protoPolicy(spec.policy) as never,
          rawSpec: { template: template(spec) as never },
        }),
        signal,
      );
    },
    async waitReady(name, signal) {
      await client.sandbox.waitReady(name, WAIT_SECONDS, {
        signal,
        workspace: WORKSPACE,
      });
    },
    exec: (request) => execOnce(sdk, request),
    async delete(name, signal) {
      try {
        await client.raw.deleteSandbox(
          { name, workspaceScope: SCOPE, allowMissing: true },
          { signal },
        );
      } catch (error) {
        throw fromConnect(error);
      }
    },
    async waitDeleted(name, signal) {
      await client.sandbox.waitDeleted(name, WAIT_SECONDS, {
        signal,
        workspace: WORKSPACE,
      });
    },
    async phase(name, signal) {
      try {
        const ref = await client.sandbox.get(name, {
          signal,
          workspace: WORKSPACE,
        });
        return PHASES[ref.phase] ?? "other";
      } catch (error) {
        if (notFound(error)) return "gone";
        throw error;
      }
    },
    async list(labels, signal) {
      const refs = await unless(
        client.sandbox.listAll({
          labelSelector: selector(labels),
          workspace: WORKSPACE,
        }),
        signal,
      );
      return refs.map((ref) => ({
        name: ref.name,
        phase: PHASES[ref.phase] ?? "other",
        labels: ref.labels,
      }));
    },
    async setPolicy(name, policy, network, signal) {
      const saved = await unless(
        client.sandbox.setPolicy(name, protoPolicy(policy, network) as never, {
          workspace: WORKSPACE,
        }),
        signal,
      );
      // saved is not loaded: the sandbox's own report of this version
      // as active is
      for (;;) {
        signal.throwIfAborted();
        let status: Awaited<
          ReturnType<typeof client.raw.getSandboxPolicyStatus>
        >;
        try {
          status = await client.raw.getSandboxPolicyStatus(
            { sandbox: name, version: saved.version, workspaceScope: SCOPE },
            { signal },
          );
        } catch (error) {
          throw fromConnect(error);
        }
        if (status.activeVersion === saved.version) return;
        if (status.revision?.status === PolicyStatus.FAILED) {
          throw new Error(
            `the sandbox policy did not load: ${status.revision.loadError}`,
          );
        }
        await pause(POLICY_POLL_MS, signal);
      }
    },
    providers: {
      async list(labels, signal) {
        const names: string[] = [];
        let pageToken = "";
        try {
          do {
            const page = await client.raw.listProviders(
              {
                workspaceScope: SCOPE,
                labelSelector: selector(labels),
                pageSize: 0,
                pageToken,
              },
              { signal },
            );
            for (const provider of page.providers) {
              if (provider.metadata?.name) names.push(provider.metadata.name);
            }
            pageToken = page.nextPageToken;
          } while (pageToken !== "");
        } catch (error) {
          throw fromConnect(error);
        }
        return names;
      },
      async delete(name, signal) {
        try {
          await client.raw.deleteProvider(
            { name, workspaceScope: SCOPE, allowMissing: true },
            { signal },
          );
        } catch (error) {
          throw fromConnect(error);
        }
      },
    },
    close() {
      session.abort();
    },
  };
  return gateway;
};

async function* execOnce(
  client: SandboxClient,
  request: ExecRequest,
): AsyncGenerator<ExecEvent> {
  let exited = false;
  try {
    const stream = client.raw.execSandbox(
      {
        sandbox: request.sandbox,
        workspaceScope: SCOPE,
        command: request.command,
        workdir: request.workdir ?? "",
        environment: request.environment ?? {},
        stdin: request.stdin ?? new Uint8Array(),
        noLoginShell: true,
        requestId: crypto.randomUUID(),
      },
      { signal: request.signal },
    );
    for await (const event of stream) {
      const payload = event.payload;
      if (payload.case === "stdout" || payload.case === "stderr") {
        yield { stream: payload.case, data: payload.value.data };
      } else if (payload.case === "exit") {
        exited = true;
        yield { exit: payload.value.exitCode };
      }
    }
  } catch (error) {
    throw error instanceof SdkError ? error : fromConnect(error);
  }
  if (!exited) throw new SdkError("rpc", "exec ended without an exit");
}
