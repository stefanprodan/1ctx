// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, test } from "bun:test";
import {
  accepted,
  carry,
  changeOf,
  dropFlips,
  dropKind,
  flip,
  isOff,
} from "../../../src/client/data/capabilities.ts";
import { MEMORY, WEB } from "../../../src/shared/capabilities.ts";

// the pending flips are module state
describe("pending capability flips", () => {
  beforeEach(() => {
    dropFlips(null);
    dropFlips("s1");
    dropFlips("s2");
  });

  test.serial(
    "nothing touched shows the chat's set and sends no change",
    () => {
      // so another member's envelope moves a key left alone: what shows
      // follows the session's set as it moves
      expect(isOff("s1", [], WEB)).toBe(false);
      expect(isOff("s1", [WEB], WEB)).toBe(true);
      expect(changeOf("s1")).toEqual({});
    },
  );

  test.serial("a flip lies over the set and rides as a change", () => {
    flip("s1", [], WEB);
    expect(isOff("s1", [], WEB)).toBe(true);
    expect(changeOf("s1")).toEqual({ capabilities: { disable: [WEB] } });
  });

  test.serial("the memory key flips as web access does", () => {
    flip("s1", [], MEMORY);
    expect(isOff("s1", [], MEMORY)).toBe(true);
    expect(isOff("s1", [], WEB)).toBe(false);
    expect(changeOf("s1")).toEqual({ capabilities: { disable: [MEMORY] } });
    flip("s1", [], MEMORY);
    expect(changeOf("s1")).toEqual({});
  });

  test.serial("turning on what the chat has off is an enable", () => {
    flip("s1", [WEB], WEB);
    expect(isOff("s1", [WEB], WEB)).toBe(false);
    expect(changeOf("s1")).toEqual({ capabilities: { enable: [WEB] } });
  });

  test.serial("a flip back to what the chat holds is no flip", () => {
    flip("s1", [], WEB);
    flip("s1", [], WEB);
    expect(isOff("s1", [], WEB)).toBe(false);
    expect(changeOf("s1")).toEqual({});
  });

  test.serial("a touched key keeps the person's word under an envelope", () => {
    flip("s1", [], WEB);
    // the other member turned it off too: the flip still says off, and
    // the change still disables, which the server applies as a no-op
    expect(isOff("s1", [WEB], WEB)).toBe(true);
    expect(changeOf("s1")).toEqual({ capabilities: { disable: [WEB] } });
  });

  test.serial("flips belong to one chat, a new chat's to none yet", () => {
    flip(null, [], WEB);
    expect(isOff(null, [], WEB)).toBe(true);
    expect(isOff("s1", [], WEB)).toBe(false);
    expect(changeOf("s1")).toEqual({});
    // moving to a chat and flipping there lets go of the new chat's
    flip("s1", [], WEB);
    expect(changeOf(null)).toEqual({});
  });

  test.serial(
    "an accepted send forgets what it carried, another chat's stay",
    () => {
      flip("s1", [], WEB);
      const sent = changeOf("s1");
      accepted("s2", sent);
      expect(changeOf("s1")).toEqual({ capabilities: { disable: [WEB] } });
      accepted("s1", sent);
      expect(changeOf("s1")).toEqual({});
      expect(isOff("s1", [], WEB)).toBe(false);
    },
  );

  test.serial(
    "a flip made while a send is on its way outlives that send",
    () => {
      // the message left with nothing touched, then the person turned it off
      const sent = changeOf("s1");
      flip("s1", [], WEB);
      accepted("s1", sent);
      expect(changeOf("s1")).toEqual({ capabilities: { disable: [WEB] } });
      // and a send that carried the opposite word does not clear it either
      accepted("s1", { capabilities: { enable: [WEB] } });
      expect(isOff("s1", [], WEB)).toBe(true);
    },
  );

  // bug: off, sent, then on again before the answer: the flip back matched
  // the set the chat still held, was forgotten, and the chat stayed off
  test.serial(
    "a flip reversed while its send is on its way is kept",
    async () => {
      flip("s1", [], WEB);
      const sent = changeOf("s1");
      let answer = () => {};
      const request = carry(
        "s1",
        sent,
        () => new Promise<void>((r) => (answer = r)),
      );
      flip("s1", [], WEB);
      expect(isOff("s1", [], WEB)).toBe(false);
      answer();
      await request;
      // the chat now holds it off, and the next send turns it on again
      expect(isOff("s1", [WEB], WEB)).toBe(false);
      expect(changeOf("s1")).toEqual({ capabilities: { enable: [WEB] } });
      dropFlips("s1");
    },
  );

  test.serial("a refused send keeps a flip made there and back", async () => {
    flip("s1", [], WEB);
    const sent = changeOf("s1");
    let refuse = (_: Error) => {};
    const request = carry(
      "s1",
      sent,
      () => new Promise<void>((_, reject) => (refuse = reject)),
    );
    flip("s1", [], WEB);
    flip("s1", [], WEB);
    refuse(new Error("409"));
    await expect(request).rejects.toThrow("409");
    expect(changeOf("s1")).toEqual({ capabilities: { disable: [WEB] } });
    dropFlips("s1");
  });

  test.serial("another agent's pick drops the server flips alone", () => {
    flip(null, [], WEB);
    flip(null, [], "mcp:a1");
    dropKind(null, "mcp");
    expect(changeOf(null)).toEqual({ capabilities: { disable: [WEB] } });
    // the flips of another chat are not this composer's to drop
    dropKind("s1", "mcp");
    expect(isOff(null, [], WEB)).toBe(true);
  });

  test.serial("another agent's pick keeps the credential flips", () => {
    flip(null, [], "credential:c1");
    flip(null, [], "skill:s1");
    dropKind(null, "mcp");
    dropKind(null, "skill");
    expect(changeOf(null)).toEqual({
      capabilities: { disable: ["credential:c1"] },
    });
    // another project on Home has other credentials
    dropKind(null, "credential");
    expect(changeOf(null)).toEqual({});
  });

  test.serial("a credential flip rides a send as any key does", async () => {
    flip("s1", [], "credential:c1");
    const sent = changeOf("s1");
    expect(sent).toEqual({ capabilities: { disable: ["credential:c1"] } });
    await carry("s1", sent, async () => {
      // flipped back while the send is on its way: kept for the next
      flip("s1", [], "credential:c1");
    });
    expect(changeOf("s1")).toEqual({
      capabilities: { enable: ["credential:c1"] },
    });
  });

  test.serial("leaving the chat gives up what was never sent", () => {
    flip("s1", [], WEB);
    // another chat's composer leaving changes nothing here
    dropFlips("s2");
    expect(isOff("s1", [], WEB)).toBe(true);
    dropFlips("s1");
    expect(isOff("s1", [], WEB)).toBe(false);
    expect(changeOf("s1")).toEqual({});
  });
});
