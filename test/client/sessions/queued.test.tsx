// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A chat's queue in the client: a message to a busy chat answered 202
// shows its row at once, a queue change reads the detail again, the
// author alone edits, removes, sends again and discards, an edit that
// lost to a start keeps its text, and the composer offers Send beside
// Stop.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { options, type VNode } from "preact";
import { render } from "preact-render-to-string";
import { path, query } from "../../../src/client/app/router.ts";
import { Composer } from "../../../src/client/composer/Composer.tsx";
import { draftKey, readDraft } from "../../../src/client/composer/draft.ts";
import { saveEdit } from "../../../src/client/composer/Edit.tsx";
import {
  EDIT_LOST,
  editing,
  handoff,
  merged,
  takeHandoff,
} from "../../../src/client/composer/handoff.ts";
import { ApiError } from "../../../src/client/data/api.ts";
import { me } from "../../../src/client/data/me.ts";
import { editQueued, removeQueued } from "../../../src/client/data/queued.ts";
import { queueMoved } from "../../../src/client/data/queued-rows.ts";
import {
  leaveSession,
  loadSession,
  onSocket,
  sending,
  sendMessage,
  session,
} from "../../../src/client/data/sessions.ts";
import { QueuedRows } from "../../../src/client/transcript/Queued.tsx";
import {
  QUEUED_RUNNING,
  QUEUED_WAITING,
} from "../../../src/client/transcript/Queued.words.ts";
import type { AgentSummary } from "../../../src/shared/contracts/agent.ts";
import type {
  Message,
  QueuedMessage,
  SessionDetail,
  SessionSummary,
} from "../../../src/shared/contracts/session.ts";

function summary(changes: Partial<SessionSummary> = {}): SessionSummary {
  return {
    archived: null,
    attention: null,
    id: "s1",
    projectId: "p1",
    ownerId: "u1",
    agentId: "a1",
    origin: "chat",
    automationId: null,
    runSource: null,
    forkedFromId: null,
    title: "Chat",
    status: "running",
    revision: 1,
    createdAt: 10,
    lastActivityAt: 20,
    usage: null,
    disabledCapabilities: [],
    ...changes,
  };
}

function detail(changes: Partial<SessionDetail> = {}): SessionDetail {
  return {
    agents: [],
    archive: null,
    session: summary(),
    forkedFrom: null,
    messages: [],
    send: null,
    live: null,
    authors: [],
    queued: [],
    ...changes,
  };
}

function queued(changes: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: "q1",
    author: { id: "u1", username: "casey" },
    text: "and the logs too",
    uploads: 0,
    state: "queued",
    reason: null,
    revision: 1,
    queuedAt: 30,
    ...changes,
  };
}

const userMessage = (id: string): Message =>
  ({
    id,
    sessionId: "s1",
    seq: 5,
    kind: "user",
    sendId: "send2",
    userId: "u1",
    content: "and the logs too",
  }) as Message;

const realFetch = globalThis.fetch;
const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let calls: { url: string; method: string; body: unknown }[] = [];
let answer: (url: string, method: string) => Response | Promise<Response>;
let stored: Map<string, string>;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  me.value = {
    id: "u1",
    username: "casey",
    fullName: "Casey",
    role: "member",
    mustChangePassword: false,
  };
  path.value = "/chat/s1";
  query.value = "";
  calls = [];
  answer = (url) => {
    throw new Error(`unexpected fetch: ${url}`);
  };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return answer(url, method);
  }) as unknown as typeof fetch;
  stored = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    },
  });
});

afterEach(async () => {
  leaveSession();
  editing.value = null;
  handoff.value = null;
  me.value = undefined;
  await settle();
  globalThis.fetch = realFetch;
  if (realStorage === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
  } else Object.defineProperty(globalThis, "localStorage", realStorage);
});

describe("a message to a busy chat", () => {
  test.serial("a 202 shows the row that waits at once", async () => {
    answer = (url) =>
      url === "/api/sessions/s1"
        ? Response.json(detail())
        : Response.json({ queued: queued() }, { status: 202 });
    await loadSession("s1");
    await sendMessage("s1", "and the logs too", []);
    expect(calls[1]).toEqual({
      url: "/api/sessions/s1/messages",
      method: "POST",
      body: { message: "and the logs too" },
    });
    expect(session.value?.queued.map((q) => q.id)).toEqual(["q1"]);
    // the revision is the envelope's to move
    expect(session.value?.session.revision).toBe(1);
    expect(sending.value).toBe(false);
  });

  test.serial(
    "a queue change reads the detail again, a rename does not",
    async () => {
      answer = () => Response.json(detail());
      await loadSession("s1");
      answer = () =>
        Response.json(
          detail({ session: summary({ revision: 2 }), queued: [queued()] }),
        );
      onSocket({
        type: "session",
        row: null,
        projectId: "p1",
        session: summary({ revision: 2 }),
        messages: [],
        send: null,
      });
      await settle();
      expect(calls.map((c) => c.url)).toEqual([
        "/api/sessions/s1",
        "/api/sessions/s1",
      ]);
      expect(session.value?.queued).toHaveLength(1);
      onSocket({
        type: "session",
        row: null,
        projectId: "p1",
        session: summary({ revision: 3, title: "Renamed" }),
        messages: [],
        send: null,
      });
      await settle();
      expect(calls).toHaveLength(2);
      expect(session.value?.session.title).toBe("Renamed");
    },
  );
});

describe("when an envelope reads the queue again", () => {
  const held = {
    session: summary(),
    messages: [] as Message[],
    queued: [queued()],
  };

  test("an envelope that changes nothing but the revision", () => {
    expect(
      queueMoved(held, { session: summary({ revision: 5 }), messages: [] }),
    ).toBe(true);
    // the keys in another order are the same summary
    const { title, ...rest } = summary({ revision: 5 });
    expect(
      queueMoved(held, { session: { title, ...rest }, messages: [] }),
    ).toBe(true);
    expect(
      queueMoved(held, {
        session: summary({ revision: 5, status: "done" }),
        messages: [],
      }),
    ).toBe(false);
  });

  test("a new user message while messages wait, never without", () => {
    const ev = {
      session: summary({ revision: 5 }),
      messages: [userMessage("m9")],
    };
    expect(queueMoved(held, ev)).toBe(true);
    expect(queueMoved({ ...held, queued: [] }, ev)).toBe(false);
    expect(queueMoved({ ...held, messages: [userMessage("m9")] }, ev)).toBe(
      false,
    );
  });
});

describe("the author's writes", () => {
  test.serial("an edit sends the text and the revision seen", async () => {
    answer = (_url, method) =>
      method === "GET"
        ? Response.json(detail({ queued: [queued()] }))
        : Response.json({ queued: queued({ text: "the logs", revision: 2 }) });
    await loadSession("s1");
    await editQueued("s1", queued(), "the logs");
    expect(calls[1]).toEqual({
      url: "/api/sessions/s1/queued/q1",
      method: "PATCH",
      body: { message: "the logs", revision: 1 },
    });
    expect(session.value?.queued[0]?.text).toBe("the logs");
  });

  test.serial("a remove names the revision and drops the row", async () => {
    answer = (_url, method) =>
      method === "GET"
        ? Response.json(detail({ queued: [queued()] }))
        : new Response(null, { status: 204 });
    await loadSession("s1");
    await removeQueued("s1", queued());
    expect(calls[1]).toEqual({
      url: "/api/sessions/s1/queued/q1",
      method: "DELETE",
      body: { revision: 1 },
    });
    expect(session.value?.queued).toEqual([]);
  });

  test.serial("an edit that lost to a start keeps its text", async () => {
    const key = draftKey("u1", { sessionId: "s1" });
    const text = signal("the logs");
    const failure = signal<string | null>(null);
    const saving = signal(false);
    const open = {
      sessionId: "s1",
      id: "q1",
      revision: 1,
      before: "",
    };
    editing.value = open;
    await saveEdit(
      open,
      "the logs",
      async () => {
        throw new ApiError(409, "the message has started or was removed");
      },
      { key, text, failure, saving },
    );
    expect(editing.value).toBeNull();
    expect(text.value).toBe("the logs");
    expect(failure.value).toBe(EDIT_LOST);
    expect(saving.value).toBe(false);
  });

  test.serial("a saved edit empties the composer", async () => {
    const key = draftKey("u1", { sessionId: "s1" });
    stored.set(key, JSON.stringify({ text: "the logs", uploads: [] }));
    const text = signal("the logs");
    const failure = signal<string | null>(null);
    const open = { sessionId: "s1", id: "q1", revision: 1, before: "" };
    editing.value = open;
    const saved: string[] = [];
    await saveEdit(
      open,
      "the logs",
      async (row, body) => {
        saved.push(`${row.id}:${row.revision}:${body}`);
      },
      { key, text, failure, saving: signal(false) },
    );
    expect(saved).toEqual(["q1:1:the logs"]);
    expect(text.value).toBe("");
    expect(readDraft(key).text).toBe("");
    expect(editing.value).toBeNull();
  });

  test("a handoff goes before the draft and a second edit replaces the first", () => {
    expect(merged("queued", "")).toBe("queued");
    expect(merged("queued", "draft")).toBe("queued\n\ndraft");
    const first = takeHandoff(
      { sessionId: "s1", text: "one", edit: { id: "q1", revision: 1 } },
      "draft",
      null,
    );
    expect(first.text).toBe("one\n\ndraft");
    expect(first.editing).toEqual({
      sessionId: "s1",
      id: "q1",
      revision: 1,
      before: "draft",
    });
    const second = takeHandoff(
      { sessionId: "s1", text: "two", edit: null },
      first.text,
      first.editing,
    );
    expect(second).toEqual({ text: "two\n\ndraft", editing: null });
  });
});

// the props a render gave the elements matching pick
function propsOf(
  node: VNode,
  pick: (vnode: VNode) => boolean,
): Record<string, unknown>[] {
  const previous = options.vnode;
  const found: Record<string, unknown>[] = [];
  options.vnode = (vnode) => {
    previous?.(vnode);
    if (pick(vnode)) found.push(vnode.props as Record<string, unknown>);
  };
  try {
    render(node);
  } finally {
    options.vnode = previous;
  }
  return found;
}

describe("the queued rows", () => {
  const authorOf = (id: string | null) =>
    id === "u1"
      ? { name: "Casey", username: "casey" }
      : { name: "someone", username: null };
  const rows = (
    list: QueuedMessage[],
    running = true,
    extra: { onSendAgain?: (row: QueuedMessage) => Promise<void> } = {},
  ) => (
    <QueuedRows
      rows={list}
      running={running}
      userId="u1"
      editing={null}
      authorOf={authorOf}
      onEdit={() => {}}
      onRemove={async () => {}}
      {...extra}
    />
  );

  test("the author's row has Edit and Remove, another's none", () => {
    const html = render(
      rows([
        queued(),
        queued({ id: "q2", author: { id: "u2", username: "ana" }, text: "b" }),
      ]),
    );
    expect(html).toContain(QUEUED_RUNNING);
    expect(html.match(/>Edit</g)).toHaveLength(1);
    expect(html.match(/>Remove</g)).toHaveLength(1);
    // a member the page does not know keeps their username
    expect(html).toContain('href="/users/ana">ana<');
    expect(html).toContain('href="/users/casey">Casey<');
    expect(html).toContain("transcript-queued-card");
  });

  test("an idle chat's row waits for a free place", () => {
    expect(render(rows([queued()], false))).toContain(QUEUED_WAITING);
  });

  test("a not-sent row says why, with Send again and Discard", () => {
    const html = render(
      rows([queued({ state: "not-sent", reason: "expired" })], false, {
        onSendAgain: async () => {},
      }),
    );
    expect(html).toContain("Not sent. It waited too long.");
    expect(html).toContain(">Send again<");
    expect(html).toContain(">Discard<");
    expect(html).not.toContain(">Edit<");
    // no composer to take the text: Discard alone
    const archived = render(
      rows([queued({ state: "not-sent", reason: "archived" })], false),
    );
    expect(archived).toContain("Not sent. The chat was archived.");
    expect(archived).not.toContain("Send again");
  });

  test.serial(
    "Remove and Send again hand the row to their callers",
    async () => {
      const seen: string[] = [];
      const buttons = propsOf(
        <QueuedRows
          rows={[
            queued(),
            queued({ id: "q2", state: "not-sent", reason: "failed" }),
          ]}
          running
          userId="u1"
          editing={null}
          authorOf={authorOf}
          onEdit={(row) => seen.push(`edit ${row.id}`)}
          onRemove={async (row) => {
            seen.push(`remove ${row.id}`);
          }}
          onSendAgain={async (row) => {
            seen.push(`again ${row.id}`);
          }}
        />,
        (vnode) =>
          vnode.type === "button" &&
          (vnode.props as { class?: string }).class === "btn-text",
      );
      for (const props of buttons) (props.onClick as () => void)();
      await settle();
      expect(seen).toEqual(["edit q1", "remove q1", "again q2", "remove q2"]);
    },
  );
});

describe("the composer while a turn runs", () => {
  const agent: AgentSummary = {
    id: "a1",
    name: "coder",
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
    default: true,
    createdAt: 0,
  };
  const composer = (running: boolean) =>
    render(
      <Composer
        scope={{ sessionId: "s1" }}
        filesProjectId="p1"
        agents={[agent]}
        agentId="a1"
        running={running}
        busy={false}
        queued={[queued()]}
        onSend={async () => {}}
        onStop={async () => {}}
        onEdit={async () => {}}
      />,
    );

  test.serial("Send sits beside Stop", () => {
    const html = composer(true);
    expect(html).toMatch(/aria-label="Stop".*aria-label="Send"/s);
    expect(composer(false)).not.toContain('aria-label="Stop"');
  });

  test.serial("an open edit makes Send Save", () => {
    editing.value = { sessionId: "s1", id: "q1", revision: 1, before: "" };
    const html = composer(true);
    expect(html).toContain("Editing a queued message");
    expect(html).toContain('aria-label="Save"');
    expect(html).not.toContain('aria-label="Send"');
    // another chat's edit is not this composer's
    editing.value = { sessionId: "s2", id: "q1", revision: 1, before: "" };
    expect(composer(true)).toContain('aria-label="Send"');
  });
});
