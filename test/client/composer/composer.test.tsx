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

// the box's key handler, from a render of the composer over a draft
function keysOver(text: string): (key: string) => boolean {
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
  try {
    render(
      <Composer
        scope={SCOPE}
        filesProjectId="p1"
        agents={null}
        agentId={null}
        running={false}
        busy={false}
        onSend={async () => {}}
        onStop={async () => {}}
      />,
    );
  } finally {
    options.vnode = previous;
  }
  if (onKeyDown === undefined) throw new Error("no message box");
  const handler = onKeyDown;
  return (key) => {
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

describe("the composer's agent", () => {
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
    default: id === "a1",
    createdAt: 0,
  });
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
