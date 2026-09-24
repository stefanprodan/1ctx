// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  applyChange,
  credentialKey,
  credentialOf,
  isCapabilityKey,
  MAX_CAPABILITY_KEY,
  MAX_DISABLED_CAPABILITIES,
  mcpKey,
  mcpOffLine,
  parseChange,
  parseSet,
  sameSet,
  serverOf,
  skillKey,
  skillOf,
  skillsOffLine,
  VISUALIZE,
  WEB,
} from "../../src/shared/capabilities.ts";

describe("capability keys", () => {
  test("the visualize tool is a kind alone, like web access", () => {
    expect(isCapabilityKey(VISUALIZE)).toBe(true);
    expect(serverOf(VISUALIZE)).toBeNull();
    expect(skillOf(VISUALIZE)).toBeNull();
    expect(isCapabilityKey("visualize:x")).toBe(false);
    expect(parseSet([VISUALIZE, WEB], "set")).toEqual({
      ok: true,
      set: ["visualize", "web"],
    });
  });
  test("an MCP server is a key by its id, checked by shape alone", () => {
    expect(mcpKey("k3v9a0q1z2xy")).toBe("mcp:k3v9a0q1z2xy");
    expect(isCapabilityKey("mcp:k3v9a0q1z2xy")).toBe(true);
    expect(serverOf("mcp:k3v9a0q1z2xy")).toBe("k3v9a0q1z2xy");
    expect(serverOf(WEB)).toBeNull();
    const long = `mcp:${"a".repeat(MAX_CAPABILITY_KEY)}`;
    for (const key of ["mcp", "mcp:", "mcp:A1", "mcp:a-b", "mcp:a:b", long]) {
      expect(isCapabilityKey(key)).toBe(false);
    }
  });
  test("a skill is a key by its id, apart from a server's", () => {
    expect(skillKey("k3v9a0q1z2xy")).toBe("skill:k3v9a0q1z2xy");
    expect(isCapabilityKey("skill:k3v9a0q1z2xy")).toBe(true);
    expect(skillOf("skill:k3v9a0q1z2xy")).toBe("k3v9a0q1z2xy");
    expect(skillOf("mcp:k3v9a0q1z2xy")).toBeNull();
    expect(serverOf("skill:k3v9a0q1z2xy")).toBeNull();
    for (const key of ["skill", "skill:", "skill:A1", "skills:a1"]) {
      expect(isCapabilityKey(key)).toBe(false);
    }
    expect(skillsOffLine(["plain", "gitops"])).toBe(
      "The user turned these skills off for this chat: gitops, plain. Do not load or follow them.",
    );
  });
  test("a credential is a key by its id, apart from the others", () => {
    expect(credentialKey("k3v9a0q1z2xy")).toBe("credential:k3v9a0q1z2xy");
    expect(isCapabilityKey("credential:k3v9a0q1z2xy")).toBe(true);
    expect(credentialOf("credential:k3v9a0q1z2xy")).toBe("k3v9a0q1z2xy");
    expect(credentialOf("mcp:k3v9a0q1z2xy")).toBeNull();
    expect(serverOf("credential:k3v9a0q1z2xy")).toBeNull();
    for (const key of [
      "credential",
      "credential:",
      "credential:A1",
      "credentials:a1",
    ]) {
      expect(isCapabilityKey(key)).toBe(false);
    }
  });
  test("a change may mix web and servers", () => {
    expect(
      parseChange({ disable: ["web", "mcp:b2"], enable: ["mcp:a1"] }, "c"),
    ).toEqual({
      ok: true,
      change: { disable: ["mcp:b2", "web"], enable: ["mcp:a1"] },
    });
  });
  test("the servers-off line names them sorted", () => {
    expect(mcpOffLine(["github", "flux"])).toBe(
      "The user turned these MCP servers off for this chat: flux, github. Their tools are not available. Say so if one is needed.",
    );
  });
  test("web, servers, skills and credentials are the keys this build knows", () => {
    expect(isCapabilityKey(WEB)).toBe(true);
    for (const key of ["", "Web", "web:", "visualize:x", 7, null]) {
      expect(isCapabilityKey(key)).toBe(false);
    }
  });
});

describe("parseSet", () => {
  test("sorts and dedupes", () => {
    expect(parseSet([WEB, WEB], "set")).toEqual({ ok: true, set: [WEB] });
    expect(parseSet([], "set")).toEqual({ ok: true, set: [] });
  });
  test("refuses what is not a list of known keys", () => {
    for (const value of ["web", { web: true }, [7], ["nope"], null]) {
      expect(parseSet(value, "set").ok).toBe(false);
    }
  });
  test("refuses a list over the cap", () => {
    const many = Array.from(
      { length: MAX_DISABLED_CAPABILITIES + 1 },
      () => WEB,
    );
    expect(parseSet(many, "set").ok).toBe(false);
  });
});

describe("parseChange", () => {
  test("takes either side or none", () => {
    expect(parseChange({}, "c")).toEqual({ ok: true, change: {} });
    expect(parseChange({ disable: [WEB] }, "c")).toEqual({
      ok: true,
      change: { disable: [WEB] },
    });
    expect(parseChange({ enable: [WEB] }, "c")).toEqual({
      ok: true,
      change: { enable: [WEB] },
    });
  });
  test("refuses one key on both sides, another field, another shape", () => {
    expect(parseChange({ disable: [WEB], enable: [WEB] }, "c").ok).toBe(false);
    expect(parseChange({ off: [WEB] }, "c").ok).toBe(false);
    expect(parseChange([WEB], "c").ok).toBe(false);
    expect(parseChange(null, "c").ok).toBe(false);
    expect(parseChange({ disable: WEB }, "c").ok).toBe(false);
  });
});

describe("applyChange", () => {
  test("adds and removes over the set it is given", () => {
    expect(applyChange([], { disable: [WEB] })).toEqual({
      ok: true,
      set: [WEB],
    });
    expect(applyChange([WEB], { enable: [WEB] })).toEqual({
      ok: true,
      set: [],
    });
    expect(applyChange([WEB], { disable: [WEB] })).toEqual({
      ok: true,
      set: [WEB],
    });
  });
  test("an absent or empty change keeps the set", () => {
    expect(applyChange([WEB], undefined)).toEqual({ ok: true, set: [WEB] });
    expect(applyChange([WEB], {})).toEqual({ ok: true, set: [WEB] });
  });
});

test("sameSet compares sorted sets", () => {
  expect(sameSet([], [])).toBe(true);
  expect(sameSet([WEB], [WEB])).toBe(true);
  expect(sameSet([WEB], [])).toBe(false);
});
