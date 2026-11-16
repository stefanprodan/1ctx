// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  MAX_VALIDATORS,
  validateArguments,
} from "../../../src/server/mcp/validate.ts";
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

  // Ajv's RegExp backtracks, so a pattern anywhere is the server's
  test("leaves a schema with a pattern to the server", () => {
    const text = `${"a".repeat(40)}!`;
    const nested = {
      type: "object",
      properties: { q: { type: "string", pattern: "^(a|a)*$" } },
    };
    expect(validateArguments(nested, { q: text })).toBeNull();
    expect(validateArguments(nested, { q: 5, other: 1 })).toBeNull();
    const deep = {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: [{ anyOf: [{ patternProperties: { "^(a|a)*$": {} } }] }],
        },
      },
      additionalProperties: false,
    };
    expect(validateArguments(deep, { list: [{ [text]: 1 }] })).toBeNull();
    expect(validateArguments(deep, { unknown: 1 })).toBeNull();
  });

  test("leaves a property named pattern to the server", () => {
    const named = {
      type: "object",
      properties: { pattern: { type: "string" } },
      additionalProperties: false,
    };
    expect(validateArguments(named, { pattern: 5, other: 1 })).toBeNull();
  });

  test("checks a schema without a pattern", () => {
    const plain = {
      type: "object",
      properties: { q: { type: "string", format: "date" } },
    };
    expect(validateArguments(plain, { q: "2026-11-17" })).toBeNull();
    expect(validateArguments(plain, { q: 5 })).toStartWith(
      "arguments/q must be string",
    );
  });

  // each send parses its offer afresh, so a schema object lives one send
  test.serial("keeps no schema object past its check", async () => {
    const check = (schemas: Record<string, unknown>[]) =>
      schemas.map((copy) => {
        validateArguments(copy, { limit: 5 });
        return new WeakRef(copy);
      });
    const same = check(
      Array.from({ length: 20 }, () =>
        structuredClone(schema("get_kubernetes_events")),
      ),
    );
    // three times the cache, so a leak keeps them all
    const distinct = check(
      Array.from({ length: 3 * MAX_VALIDATORS + 20 }, (_, i) => ({
        ...schema("get_kubernetes_events"),
        description: `copy ${i}`,
      })),
    );
    // a WeakRef made in this job holds its target until the job ends
    await new Promise((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);
    const alive = (refs: WeakRef<object>[]) =>
      refs.filter((ref) => ref.deref() !== undefined).length;
    expect(alive(same)).toBeLessThanOrEqual(1);
    // a dropped engine can outlive its drop, held by a stale stack word
    // or jitted code, and keeps every schema it compiled: the bound is
    // the live engine and one dropped, never every one
    expect(alive(distinct)).toBeLessThanOrEqual(2 * MAX_VALIDATORS);
  });
});
