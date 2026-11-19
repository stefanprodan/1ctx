// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The gateway port's provider calls over OpenShell's raw RPCs: one
// endpointless profile per credential shape, a provider per
// credential, its attachment to a sandbox and its readiness there.

import type { Client } from "@connectrpc/connect";
import { fromConnect } from "openshell-sdk";
import {
  type OpenShell,
  ProviderProfileCategory,
  ProviderReadinessState,
} from "openshell-sdk/raw";
import type { Gateway, ProviderState } from "./gateway.ts";

const READINESS: Partial<Record<ProviderReadinessState, ProviderState>> = {
  [ProviderReadinessState.READY]: "ready",
  [ProviderReadinessState.WITHHELD]: "withheld",
  [ProviderReadinessState.FAILED]: "failed",
  [ProviderReadinessState.REVOKED]: "revoked",
};

// No request id on any of them, as for exec: each is a durable
// admission, capped per caller
export function providerCalls(
  raw: Client<typeof OpenShell>,
  scope: { selection: { case: "workspace"; value: string } },
  workspace: string,
): Omit<Gateway["providers"], "list" | "delete"> {
  async function call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw fromConnect(error);
    }
  }
  return {
    async importProfile(profile, signal) {
      const resp = await call(() =>
        raw.importProviderProfiles(
          {
            workspaceScope: scope,
            profiles: [
              {
                source: "1ctx",
                profile: {
                  id: profile.id,
                  displayName: "1ctx credential",
                  description: "one 1ctx credential, bound by sandbox policy",
                  category: ProviderProfileCategory.OTHER,
                  annotations: profile.annotations,
                  credentials: [
                    {
                      name: "key",
                      envVars: [profile.env],
                      required: true,
                      authStyle: profile.style,
                      headerName: profile.header,
                    },
                  ],
                },
              },
            ],
          },
          { signal },
        ),
      );
      // import is create-only; the id is a hash of the profile, so one
      // already there is this one
      if (resp.imported) return;
      const there = await call(() =>
        raw.getProviderProfile(
          { id: profile.id, workspaceScope: scope },
          { signal },
        ),
      ).catch(() => null);
      if (there?.profile?.id === profile.id) return;
      throw new Error(
        `the provider profile was refused: ${resp.diagnostics.map((d) => d.message).join("; ")}`,
      );
    },
    async profiles(annotations, signal) {
      const ids: string[] = [];
      let pageToken = "";
      do {
        const page = await call(() =>
          raw.listProviderProfiles(
            { workspaceScope: scope, pageSize: 0, pageToken },
            { signal },
          ),
        );
        for (const profile of page.profiles) {
          const all = Object.entries(annotations).every(
            ([key, value]) => profile.annotations[key] === value,
          );
          if (all) ids.push(profile.id);
        }
        pageToken = page.nextPageToken;
      } while (pageToken !== "");
      return ids;
    },
    async deleteProfile(id, signal) {
      await call(() =>
        raw.deleteProviderProfile(
          { id, workspaceScope: scope, allowMissing: true },
          { signal },
        ),
      );
    },
    async put(spec, signal) {
      const provider = {
        metadata: { name: spec.name, labels: spec.labels },
        type: spec.profile,
        profileWorkspace: workspace,
        credentials: { [spec.env]: spec.key },
      };
      try {
        await raw.createProvider(
          { workspaceScope: scope, provider },
          { signal },
        );
        return;
      } catch (error) {
        if (fromConnect(error).code !== "already_exists")
          throw fromConnect(error);
      }
      // an update keeps the labels the create set
      await call(() =>
        raw.updateProvider({ workspaceScope: scope, provider }, { signal }),
      );
    },
    async attach(sandbox, provider, signal) {
      await call(() =>
        raw.attachSandboxProvider(
          { workspaceScope: scope, sandbox, provider },
          { signal },
        ),
      );
    },
    async state(sandbox, provider, signal) {
      const resp = await call(() =>
        raw.getSandboxProviderStatus(
          { workspaceScope: scope, sandbox, provider, receiptId: "" },
          { signal },
        ),
      );
      return READINESS[resp.status?.state ?? 0] ?? "pending";
    },
  };
}
