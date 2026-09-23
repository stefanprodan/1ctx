// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { validateArguments } from "../../../src/server/mcp/client.ts";
import flux from "../../fixtures/mcp/flux.json";

const schema = (name: string) =>
  flux.tools.tools.find((tool) => tool.name === name)!.inputSchema as Record<
    string,
    unknown
  >;

describe("validateArguments", () => {
  test("names an unknown property and lists the parameters", () => {
    expect(
      validateArguments(schema("get_kubernetes_events"), {
        involvedObject: "x",
        namespace: "flux-system",
      }),
    ).toBe(
      "unknown property 'involvedObject'. Its parameters: apiVersion, kind, name, namespace, type, since, grep, limit.",
    );
  });

  test("names a missing required property and marks it", () => {
    expect(
      validateArguments(schema("get_kubernetes_metrics"), {
        namespace: "flux-system",
      }),
    ).toBe(
      "unknown property 'namespace'; missing required property 'pod_namespace'. Its parameters: pod_name, pod_namespace (required), pod_selector, limit.",
    );
  });

  test("keeps Ajv's words for a wrong type, the path read as arguments", () => {
    expect(
      validateArguments(schema("get_kubernetes_events"), { limit: "ten" }),
    ).toStartWith("arguments/limit must be number.");
  });

  test("passes valid arguments and a schema Ajv cannot compile", () => {
    expect(
      validateArguments(schema("get_kubernetes_events"), { limit: 5 }),
    ).toBeNull();
    expect(
      validateArguments({ type: "object", required: 3 } as never, {}),
    ).toBeNull();
  });
});
