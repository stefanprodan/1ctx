// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The composer's keys: the arrows, Tab and Escape walk the command list
// only while it has a match, so a message with none keeps them. A new
// chat starts on the agent the user last picked.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { options } from "preact";
import { render } from "preact-render-to-string";
import { Composer } from "../../../src/client/composer/Composer.tsx";
import { draftKey } from "../../../src/client/composer/draft.ts";
import type { Locate } from "../../../src/client/composer/location.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  rememberAgent,
  startingAgent,
  startsOn,
} from "../../../src/client/data/project-agents.ts";
import type { AgentSummary } from "../../../src/shared/contracts/agent.ts";

const SCOPE = { sessionId: "s1" };
const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let rows: Map<string, string>;

beforeEach(() => {
  rows = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => rows.get(key) ?? null,
      setItem: (key: string, value: string) => rows.set(key, value),
      removeItem: (key: string) => rows.delete(key),
    },
  });
  me.value = {
    id: "u1",
    username: "admin",
    fullName: "Admin",
    role: "admin",
    mustChangePassword: false,
  };
});

afterEach(() => {
  me.value = undefined;
  if (realStorage === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
  } else {
    Object.defineProperty(globalThis, "localStorage", realStorage);
  }
});

const agent = (id: string, name: string): AgentSummary => ({
  id,
  name,
  avatar: "bot",
  providerId: "pr1",
  model: {
    id: "acme/small",
    name: "Small",
    contextLength: null,
    promptPrice: null,
    completionPrice: null,
    tools: false,
    reasoning: false,
    thinkingRequired: false,
    reasoningKnown: true,
    described: true,
  },
  thinking: null,
  effort: null,
  prompt: "",
  skills: [],
  servers: [],
  mcpMode: "auto",
  upstream: null,
  skip4Bit: false,
  subagents: false,
  default: id === "a1",
  createdAt: 0,
});
// the box's key handler, from a render of the composer over a draft,
// and the page it drew
function keysOver(
  text: string,
  agents: AgentSummary[] | null = null,
  agentId: string | null = null,
  reader: Locate | null = null,
  channel?: { name: string; meter?: { tokens: number; budget: number } },
): ((key: string) => boolean) & { html: string } {
  rows.set(draftKey("u1", SCOPE), JSON.stringify({ text, uploads: [] }));
  const previous = options.vnode;
  let onKeyDown: ((event: KeyboardEvent) => void) | undefined;
  options.vnode = (node) => {
    previous?.(node);
    const props = node.props as Record<string, unknown>;
    if (node.type === "textarea" && props.name === "message") {
      onKeyDown = props.onKeyDown as (event: KeyboardEvent) => void;
    }
  };
  let html = "";
  try {
    html = render(
      <Composer
        scope={SCOPE}
        filesProjectId="p1"
        agents={agents}
        agentId={agentId}
        running={false}
        busy={false}
        onSend={async () => {}}
        onStop={async () => {}}
        reader={reader}
        channel={channel}
      />,
    );
  } finally {
    options.vnode = previous;
  }
  if (onKeyDown === undefined) throw new Error("no message box");
  const handler = onKeyDown;
  const press = (key: string) => {
    let prevented = false;
    handler({
      key,
      isComposing: false,
      shiftKey: false,
      preventDefault() {
        prevented = true;
      },
    } as unknown as KeyboardEvent);
    return prevented;
  };
  return Object.assign(press, { html });
}

describe("the composer's keys", () => {
  test.serial("an empty command list leaves the keys to the box", () => {
    const press = keysOver("hello");
    for (const key of ["ArrowDown", "ArrowUp", "Tab", "Escape"]) {
      expect(press(key)).toBe(false);
    }
  });

  test.serial("a list with a match takes the arrows", () => {
    const press = keysOver("/");
    expect(press("ArrowDown")).toBe(true);
    expect(press("ArrowUp")).toBe(true);
  });
});

describe("the / menu", () => {
  const listed = (html: string) =>
    [...html.matchAll(/composer-cmd-name">\/(?:<!-- -->)?([^<]*)</g)].map(
      (m) => m[1],
    );
  const read: Locate = async () => ({
    latitude: 0,
    longitude: 0,
    accuracy: 1,
  });

  test.serial("offers /location only where the browser can share it", () => {
    expect(listed(keysOver("/lo", null, null, read).html)).toEqual([
      "location",
    ]);
    expect(listed(keysOver("/lo").html)).toEqual([]);
  });
});

describe("the composer's words", () => {
  test("the box at rest never says send", () => {
    const { html } = keysOver("");
    expect(html).toContain('placeholder="Message"');
    expect(html).not.toMatch(/placeholder="[^"]*send/i);
  });
});

describe("the @ menu", () => {
  const agents = [agent("a1", "coder"), agent("a2", "writer")];
  const listed = (html: string) =>
    [...html.matchAll(/composer-cmd-name">@(?:<!-- -->)?([^<]*)</g)].map(
      (m) => m[1],
    );

  test.serial("a chat lists the other agents and takes the keys", () => {
    const press = keysOver("@", agents, "a1");
    expect(listed(press.html)).toEqual(["writer"]);
    expect(press.html).toContain('aria-label="Agents"');
    expect(press("ArrowDown")).toBe(true);
    expect(press("Tab")).toBe(true);
  });

  test.serial("a word no agent starts leaves the keys to the box", () => {
    const press = keysOver("@x", agents, "a1");
    expect(listed(press.html)).toEqual([]);
    expect(press("Tab")).toBe(false);
  });

  test.serial("a new chat opens no menu", () => {
    const press = keysOver("@", agents, null);
    expect(press.html).not.toContain('aria-label="Agents"');
    expect(press("ArrowDown")).toBe(false);
  });
});

describe("the composer's agent", () => {
  const agents = [agent("a1", "coder"), agent("a2", "writer")];
  const chip = (fixed: string | null = null) =>
    render(
      <Composer
        scope={{ projectId: "home" }}
        filesProjectId="p1"
        agents={agents}
        agentId={fixed}
        running={false}
        busy={false}
        onSend={async () => {}}
        onStop={async () => {}}
      />,
    ).match(/composer-chip-name cut">([^<]*)</)?.[1];

  afterEach(() => {
    startsOn.value = null;
  });

  test.serial("a new chat starts on the last pick, else the first", () => {
    startsOn.value = "a2";
    expect(chip()).toBe("writer");
    // a pick that is not one of the project's agents
    startsOn.value = "gone";
    expect(chip()).toBe("coder");
    startsOn.value = null;
    expect(chip()).toBe("coder");
    expect(startingAgent([])).toBeNull();
  });

  test.serial("a pick gone from the list falls back to the default", () => {
    startsOn.value = "gone";
    const marked = agents.map((a) => ({ ...a, default: a.id === "a2" }));
    expect(startingAgent(marked)).toBe("a2");
  });

  test.serial("a pick moves the start at once and is kept", async () => {
    const asked: [string, string | undefined, unknown][] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      asked.push([url, init?.method, JSON.parse(String(init?.body))]);
      return Response.json({ agentId: "a2" });
    }) as unknown as typeof fetch;
    try {
      await rememberAgent("a2");
      expect(startsOn.value).toBe("a2");
      expect(chip()).toBe("writer");
      expect(asked).toEqual([["/api/profile/agent", "PUT", { agentId: "a2" }]]);
      // a failed write keeps the pick in this tab
      globalThis.fetch = (async () =>
        Response.json(
          { error: "down" },
          { status: 500 },
        )) as unknown as typeof fetch;
      await rememberAgent("a1");
      expect(startsOn.value).toBe("a1");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test.serial("a chat keeps its own agent", () => {
    startsOn.value = "a2";
    expect(chip("a1")).toBe("coder");
  });
});

describe("the composer in a channel", () => {
  const CHANNEL = {
    name: "#finops",
    meter: { tokens: 48_200, budget: 100_000 },
  };
  const AGENTS = [agent("a1", "coder"), agent("a2", "writer")];
  const listed = (html: string) =>
    [...html.matchAll(/composer-cmd-name">[/@](?:<!-- -->)?([^<]*)</g)].map(
      (m) => m[1],
    );
  const read: Locate = async () => ({ latitude: 0, longitude: 0, accuracy: 1 });

  test.serial("reads Message #project and has no agent chip", () => {
    const { html } = keysOver("", AGENTS, null, null, CHANNEL);
    expect(html).toContain('placeholder="Message #finops"');
    expect(html).not.toContain("composer-chip");
  });

  test.serial("a channel with no agent still takes a post", () => {
    const { html } = keysOver("", [], null, null, CHANNEL);
    expect(html).toContain('placeholder="Message #finops"');
    expect(html).toMatch(/<textarea(?![^>]*disabled)[^>]*>/);
  });

  test.serial("its plus adds files, with no switch behind it", () => {
    const { html } = keysOver("", AGENTS, null, null, CHANNEL);
    expect(html).toContain('aria-label="Add files"');
    expect(html).not.toContain("aria-expanded");
    expect(keysOver("", AGENTS, "a1").html).toContain('aria-label="Add"');
  });

  test.serial("its @ menu summons every agent", () => {
    expect(listed(keysOver("@", AGENTS, null, null, CHANNEL).html)).toEqual([
      "coder",
      "writer",
    ]);
    // a chat leaves its own agent out
    expect(listed(keysOver("@", AGENTS, "a1").html)).toEqual(["writer"]);
  });

  test.serial("its / menu holds no chat command", () => {
    expect(listed(keysOver("/", AGENTS, null, read, CHANNEL).html)).toEqual([
      "location",
    ]);
    expect(listed(keysOver("/co", AGENTS, null, read, CHANNEL).html)).toEqual(
      [],
    );
  });

  test.serial("the meter is the stream against its budget", () => {
    const { html } = keysOver("", AGENTS, null, null, CHANNEL);
    expect(html).toContain("48K / 100K");
    expect(html).toContain("What agents read: 48,200 of 100,000 tokens");
    // no meter counted yet: none drawn
    expect(
      keysOver("", AGENTS, null, null, { name: "#finops" }).html,
    ).not.toContain("composer-ctx");
  });
});
