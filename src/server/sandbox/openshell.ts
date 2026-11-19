// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The gateway port over OpenShell's SDK: Connect gRPC over node:http2
// with mutual TLS. Exec goes through the raw RPC, since the SDK's
// curated stream retries on a transport error before response headers
// and a command must launch once or not at all. Create, list and policy
// go through the raw RPCs too, since only those take a signal: a wait
// that ends must end the RPC, or a gateway that never answers keeps one
// more on every probe.

import { Code, type Transport } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import { fromConnect, SandboxClient, SdkError } from "openshell-sdk";
import {
  SandboxPhase as Phase,
  PolicyStatus,
  SandboxRestartPolicy,
  ServiceStatus,
} from "openshell-sdk/raw";
import type {
  Connect,
  CreateSpec,
  ExecEvent,
  ExecRequest,
  Gateway,
  SandboxInfo,
  SandboxPhase,
  SandboxPolicy,
} from "./gateway.ts";
import { NameTaken, SandboxUnavailable } from "./gateway.ts";
import { providerCalls } from "./providers.ts";

// 1ctx keeps every sandbox and provider in the gateway's default
// workspace; the instance label tells its own apart
const WORKSPACE = "default";
const SCOPE = { selection: { case: "workspace" as const, value: WORKSPACE } };
// the SDK's waits take a timeout too; the caller's signal ends them first
const WAIT_SECONDS = 24 * 3600;
// how often a policy's load is asked: push delivery loads in about 60 ms
const POLICY_POLL_MS = 50;

const PHASES: Partial<Record<Phase, SandboxPhase>> = {
  [Phase.PROVISIONING]: "provisioning",
  [Phase.STARTING]: "provisioning",
  [Phase.READY]: "ready",
  [Phase.ERROR]: "error",
  [Phase.DELETING]: "deleting",
  [Phase.STOPPING]: "stopped",
  [Phase.STOPPED]: "stopped",
};
const phaseOf = (phase: Phase | undefined): SandboxPhase =>
  PHASES[phase ?? Phase.UNSPECIFIED] ?? "other";

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
  return gatewayOver(transport, () => session.abort());
};

// the port over a transport, which a test gives in memory
export function gatewayOver(transport: Transport, close: () => void): Gateway {
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
      try {
        await client.raw.createSandbox(
          {
            workspaceScope: SCOPE,
            name: spec.name,
            labels: spec.labels,
            spec: {
              environment: {},
              providers: [],
              command: spec.command,
              tty: false,
              restartPolicy: SandboxRestartPolicy.NEVER,
              // network rules are plain objects here; the proto checks them
              policy: protoPolicy(spec.policy) as never,
              template: template(spec) as never,
            },
            serviceExposures: [],
          },
          { signal },
        );
      } catch (error) {
        const sdk = fromConnect(error);
        // answered, so another's: never deleted by its name
        if (sdk.code === "already_exists") throw new NameTaken(sdk.message);
        throw sdk;
      }
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
        const resp = await client.raw.getSandbox(
          { name, workspaceScope: SCOPE },
          { signal },
        );
        return phaseOf(resp.sandbox?.status?.phase);
      } catch (error) {
        if (notFound(error)) return "gone";
        throw error;
      }
    },
    async list(labels, signal) {
      const found: SandboxInfo[] = [];
      let pageToken = "";
      try {
        do {
          const page = await client.raw.listSandboxes(
            {
              workspaceScope: SCOPE,
              labelSelector: selector(labels),
              pageSize: 0,
              pageToken,
            },
            { signal },
          );
          for (const box of page.sandboxes) {
            const name = box.metadata?.name;
            if (!name) continue;
            found.push({
              name,
              phase: phaseOf(box.status?.phase),
              labels: box.metadata?.labels ?? {},
            });
          }
          pageToken = page.nextPageToken;
        } while (pageToken !== "");
      } catch (error) {
        throw fromConnect(error);
      }
      return found;
    },
    async setPolicy(name, policy, network, signal) {
      let saved: { version: number };
      try {
        saved = await client.raw.updateConfig(
          {
            sandbox: name,
            workspaceScope: SCOPE,
            policy: protoPolicy(policy, network) as never,
            global: false,
          },
          { signal },
        );
      } catch (error) {
        throw fromConnect(error);
      }
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
      ...providerCalls(client.raw, SCOPE, WORKSPACE),
    },
    close,
  };
  return gateway;
}

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
        // No request id: each one is a durable admission the gateway
        // keeps a day (a cut one forever), capped per caller, so a busy
        // instance would lock itself out. One attempt with no retry is
        // already at most once.
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
    const sdk = error instanceof SdkError ? error : fromConnect(error);
    // the sandbox or its supervisor is gone, not the command
    if (
      sdk.connectCode === Code.Unavailable ||
      /sandbox is not ready/i.test(sdk.message)
    )
      throw new SandboxUnavailable(sdk.message, { cause: sdk });
    throw sdk;
  }
  if (!exited) throw new SdkError("rpc", "exec ended without an exit");
}
