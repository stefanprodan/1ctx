// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A chat's queue in the client: the answers and the watchers' frames
// carry the queue and land by revision with no read, a start swaps the
// rows for their messages at once, a write's late answer never puts a row
// back, the author's own not-sent rows come on their own event, the
// author alone acts on a row, and an edit keeps the draft apart, lives
// in the draft across a reload and ends plainly when it cannot land.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { options, type VNode } from "preact";
import { render } from "preact-render-to-string";
import { path, query } from "../../../src/client/app/router.ts";
import { Composer } from "../../../src/client/composer/Composer.tsx";
import {
  draftKey,
  readDraft,
  writeDraftEdit,
} from "../../../src/client/composer/draft.ts";
import {
  editGone,
  PLACEHOLDER_RUNNING,
  saveEdit,
} from "../../../src/client/composer/Edit.tsx";
import {
  EDIT_LOST,
  EDIT_OPEN,
  EDIT_REMOVED,
  editing,
  handoff,
  takeHandoff,
} from "../../../src/client/composer/handoff.ts";
import { ApiError } from "../../../src/client/data/api.ts";
import { me } from "../../../src/client/data/me.ts";
import {
  editQueued,
  removeQueued,
  sendMessage,
} from "../../../src/client/data/queued.ts";
import {
  leaveSession,
  loadSession,
  onSocket,
  sending,
  session,
} from "../../../src/client/data/sessions.ts";
import { QueuedRows } from "../../../src/client/transcript/Queued.tsx";
import {
  QUEUED_RUNNING,
  QUEUED_WAITING,
} from "../../../src/client/transcript/Queued.words.ts";
import { queueActions } from "../../../src/client/views/sessions/queue.ts";
import type { AgentSummary } from "../../../src/shared/contracts/agent.ts";
import type {
  Message,
  QueuedMessage,
  SessionDetail,
  SessionSummary,
} from "../../../src/shared/contracts/session.ts";
import type { SocketEvent } from "../../../src/shared/socket.ts";

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
    cut: false,
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

// an envelope of the chat at a revision, with the rows it wrote
const envelope = (
  revision: number,
  messages: Message[] = [],
  extra: { messagesCut?: true } = {},
): SocketEvent => ({
  type: "session",
  row: null,
  projectId: "p1",
  session: summary({ revision }),
  messages,
  send: null,
  ...extra,
});

// the watchers' queue frame at a revision; turn when a start made it
const frame = (
  revision: number,
  rows: QueuedMessage[],
  turn = false,
): SocketEvent => ({ type: "queue", sessionId: "s1", revision, turn, rows });

const ids = () => session.value?.queued.map((row) => row.id);

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

// the chat on screen at revision 1 with the given rows
async function open(rows: QueuedMessage[] = []): Promise<void> {
  answer = () => Response.json(detail({ queued: rows }));
  await loadSession("s1");
  calls = [];
}

describe("the queue on screen", () => {
  test.serial("a 202 shows the caller's queue from the answer", async () => {
    await open();
    answer = () =>
      Response.json(
        { queued: queued(), queue: [queued()], revision: 2 },
        { status: 202 },
      );
    await sendMessage("s1", "and the logs too", []);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/sessions/s1/messages",
    ]);
    expect(ids()).toEqual(["q1"]);
    expect(sending.value).toBe(false);
  });

  test.serial("a queue frame replaces the rows with no read", async () => {
    await open([queued()]);
    const two = queued({ id: "q2", author: { id: "u2", username: "ana" } });
    onSocket(frame(2, [queued(), two]));
    // an envelope carries no queue and leaves it alone
    onSocket(envelope(3));
    await settle();
    expect(calls).toEqual([]);
    expect(ids()).toEqual(["q1", "q2"]);
  });

  test.serial(
    "a start swaps the rows for their messages in one frame",
    async () => {
      await open([queued()]);
      // the start's frame comes first and waits for its envelope
      onSocket(frame(2, [], true));
      expect(ids()).toEqual(["q1"]);
      expect(session.value?.messages).toEqual([]);
      onSocket(envelope(2, [userMessage("m9")]));
      expect(ids()).toEqual([]);
      expect(session.value?.messages.map((m) => m.id)).toEqual(["m9"]);
      await settle();
      expect(calls).toEqual([]);
    },
  );

  test.serial(
    "an edit's answer after the start never puts the row back",
    async () => {
      await open([queued()]);
      let release = () => {};
      answer = () =>
        new Promise<Response>((resolve) => {
          release = () =>
            resolve(
              Response.json({
                queued: queued({ text: "x", revision: 2 }),
                queue: [queued({ text: "x", revision: 2 })],
                revision: 2,
              }),
            );
        });
      const edit = editQueued("s1", queued(), "x");
      onSocket(frame(3, [], true));
      onSocket(envelope(3, [userMessage("m9")]));
      release();
      await edit;
      expect(calls.map((c) => c.body)).toEqual([{ message: "x", revision: 1 }]);
      expect(ids()).toEqual([]);
      expect(session.value?.messages).toHaveLength(1);
    },
  );

  test.serial("a watch's answer brings the queue by revision", async () => {
    answer = () =>
      Response.json(detail({ session: summary({ status: "done" }) }));
    await loadSession("s1");
    const watched = (revision: number, rows: QueuedMessage[]): SocketEvent => ({
      type: "watched",
      sessionId: "s1",
      live: null,
      queue: { revision, rows },
    });
    onSocket(watched(2, [queued()]));
    expect(ids()).toEqual(["q1"]);
    // an older one changes nothing
    onSocket(watched(1, []));
    expect(ids()).toEqual(["q1"]);
  });

  test.serial("a start too large for its envelope reads the chat", async () => {
    await open([queued()]);
    onSocket(frame(2, [], true));
    answer = () =>
      Response.json(
        detail({
          session: summary({ revision: 2 }),
          messages: [userMessage("m9")],
        }),
      );
    onSocket(envelope(2, [], { messagesCut: true }));
    // the rows stay until the detail brings the messages with them
    expect(ids()).toEqual(["q1"]);
    await settle();
    await settle();
    expect(calls.map((c) => c.url)).toEqual(["/api/sessions/s1"]);
    expect(ids()).toEqual([]);
    expect(session.value?.messages.map((m) => m.id)).toEqual(["m9"]);
  });

  test.serial("a remove names the revision and takes the answer", async () => {
    await open([queued()]);
    answer = () => Response.json({ queue: [], revision: 2 });
    await removeQueued("s1", queued());
    expect(calls).toEqual([
      {
        url: "/api/sessions/s1/queued/q1",
        method: "DELETE",
        body: { revision: 1 },
      },
    ]);
    expect(ids()).toEqual([]);
  });

  test.serial(
    "the user's not-sent rows come on their own event, never the envelope",
    async () => {
      await open([queued(), queued({ id: "q2", queuedAt: 40 })]);
      // q1 turned not sent: the watchers' frame drops it
      onSocket(frame(2, [queued({ id: "q2", queuedAt: 40 })]));
      const late = queued({ state: "not-sent", reason: "expired" });
      onSocket({
        type: "notSent",
        projectId: "p1",
        sessionId: "s1",
        revision: 2,
        rows: [late],
      });
      expect(session.value?.queued).toEqual([
        late,
        queued({ id: "q2", queuedAt: 40 }),
      ]);
      // an older event changes nothing
      onSocket({
        type: "notSent",
        projectId: "p1",
        sessionId: "s1",
        revision: 1,
        rows: [],
      });
      expect(ids()).toEqual(["q1", "q2"]);
      await settle();
      expect(calls).toEqual([]);
    },
  );

  test.serial(
    "a detail read before the queue moved keeps the newer rows",
    async () => {
      await open([queued()]);
      // a remove answered at revision 4; no envelope moved the chat yet
      answer = () => Response.json({ queue: [], revision: 4 });
      await removeQueued("s1", queued());
      // a load that read the chat at revision 3, before the remove
      answer = () =>
        Response.json(
          detail({ session: summary({ revision: 3 }), queued: [queued()] }),
        );
      await loadSession("s1");
      expect(session.value?.session.revision).toBe(3);
      expect(ids()).toEqual([]);
    },
  );
});

describe("an edit", () => {
  const key = draftKey("u1", { sessionId: "s1" });
  const box = () => ({
    key,
    text: signal("the logs"),
    failure: signal<string | null>(null),
    saving: signal(false),
  });
  const open = { sessionId: "s1", id: "q1", revision: 1, before: "a draft" };

  test("opens with the row's text alone and the draft set aside", () => {
    const taken = takeHandoff(
      {
        kind: "edit",
        sessionId: "s1",
        row: { id: "q1", revision: 1, text: "queued" },
      },
      "a draft",
      null,
    );
    expect(taken).toEqual({
      text: "queued",
      edit: { id: "q1", revision: 1, before: "a draft" },
      words: null,
    });
    // a second Edit or Send again while one is open changes nothing
    expect(
      takeHandoff(
        { kind: "again", sessionId: "s1", text: "other" },
        "queued",
        taken!.edit!,
      ),
    ).toBeNull();
    // Send again puts the text before the draft
    expect(
      takeHandoff({ kind: "again", sessionId: "s1", text: "again" }, "d", null)
        ?.text,
    ).toBe("again\n\nd");
    // a Remove here gives the draft back with its own words
    expect(
      takeHandoff(
        { kind: "close", sessionId: "s1", id: "q1", words: EDIT_REMOVED },
        "queued",
        taken!.edit!,
      ),
    ).toEqual({ text: "a draft", edit: undefined, words: EDIT_REMOVED });
  });

  test.serial("lives in the draft, so a reload keeps editing", () => {
    writeDraftEdit(key, "queued", { id: "q1", revision: 1, before: "d" });
    expect(readDraft(key)).toEqual({
      text: "queued",
      uploads: [],
      edit: { id: "q1", revision: 1, before: "d" },
    });
    writeDraftEdit(key, "d", undefined);
    expect(readDraft(key)).toEqual({ text: "d", uploads: [] });
  });

  test.serial("a save gives the draft back and clears the words", async () => {
    const state = box();
    state.failure.value = "old words";
    editing.value = open;
    const saved: string[] = [];
    await saveEdit(
      open,
      "the logs",
      async (row, text) => {
        saved.push(`${row.id}:${row.revision}:${text}`);
      },
      state,
    );
    expect(saved).toEqual(["q1:1:the logs"]);
    expect(state.text.value).toBe("a draft");
    expect(readDraft(key)).toEqual({ text: "a draft", uploads: [] });
    expect(state.failure.value).toBeNull();
    expect(editing.value).toBeNull();
  });

  test.serial("a save that lost to a start keeps its text", async () => {
    const state = box();
    editing.value = open;
    await saveEdit(
      open,
      "the logs",
      async () => {
        throw new ApiError(409, "the message has started or was removed");
      },
      state,
    );
    expect(editing.value).toBeNull();
    expect(state.text.value).toBe("the logs\n\na draft");
    expect(readDraft(key).edit).toBeUndefined();
    expect(state.failure.value).toBe(EDIT_LOST);
    expect(state.saving.value).toBe(false);
  });

  test("a row gone or not sent ends it, unless a save or a Remove answers", () => {
    const gone: QueuedMessage[] = [];
    expect(editGone(open, [queued()], false, null)).toBeNull();
    expect(editGone(open, gone, false, null)).toBe("gone");
    // a row that expired while it was edited says so
    expect(
      editGone(
        open,
        [queued({ state: "not-sent", reason: "expired" })],
        false,
        null,
      ),
    ).toBe("not-sent");
    expect(editGone(open, gone, true, null)).toBeNull();
    expect(
      editGone(open, gone, false, {
        kind: "close",
        sessionId: "s1",
        id: "q1",
        words: EDIT_REMOVED,
      }),
    ).toBeNull();
    // the queue frame of a Remove here landing before its answer
    expect(editGone(open, gone, false, null, new Set(["q1"]))).toBeNull();
  });
});

describe("the row's actions in a chat", () => {
  test.serial(
    "Edit and Send again are refused while an edit is open",
    async () => {
      editing.value = { sessionId: "s1", id: "q1", revision: 1, before: "" };
      const actions = queueActions("s1", false);
      await expect(actions.onEdit(queued({ id: "q2" }))).rejects.toThrow(
        EDIT_OPEN,
      );
      await expect(
        actions.onSendAgain!(queued({ id: "q3", state: "not-sent" })),
      ).rejects.toThrow(EDIT_OPEN);
      expect(calls).toEqual([]);
      expect(handoff.value).toBeNull();
    },
  );

  test.serial(
    "Send again deletes first, then hands the text over",
    async () => {
      await open([queued({ state: "not-sent", reason: "expired" })]);
      answer = () =>
        Response.json({ error: "the message changed" }, { status: 409 });
      const row = queued({ state: "not-sent", reason: "expired" });
      await expect(
        queueActions("s1", false).onSendAgain!(row),
      ).rejects.toThrow();
      expect(handoff.value).toBeNull();
      answer = () => Response.json({ queue: [], revision: 2 });
      await queueActions("s1", false).onSendAgain!(row);
      // read after the reset above
      expect(handoff.peek() as unknown).toEqual({
        kind: "again",
        sessionId: "s1",
        text: "and the logs too",
      });
    },
  );

  test.serial(
    "a row a frame carried cut is read whole for Edit and Send again",
    async () => {
      const cut = queued({ text: "and the", cut: true });
      answer = (_url, method) =>
        method === "GET"
          ? Response.json({ queued: queued({ revision: 2 }) })
          : Response.json({ queue: [], revision: 3 });
      await queueActions("s1", false).onEdit(cut);
      expect(handoff.value).toEqual({
        kind: "edit",
        sessionId: "s1",
        row: queued({ revision: 2 }),
      });
      handoff.value = null;
      await queueActions("s1", false).onSendAgain!({
        ...cut,
        state: "not-sent",
      });
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        "GET /api/sessions/s1/queued/q1",
        "GET /api/sessions/s1/queued/q1",
        "DELETE /api/sessions/s1/queued/q1",
      ]);
      // read past the reset above, which narrows the signal's type
      expect(handoff.peek() as unknown).toEqual({
        kind: "again",
        sessionId: "s1",
        text: "and the logs too",
      });
    },
  );

  test.serial("Remove of the row open for an edit closes it", async () => {
    await open([queued()]);
    editing.value = { sessionId: "s1", id: "q1", revision: 1, before: "" };
    const open1 = editing.value;
    let release = () => {};
    answer = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(Response.json({ queue: [], revision: 3 }));
      });
    const removed = queueActions("s1", false).onRemove(queued());
    await settle();
    // the queue frame lands before the answer: the edit is not ended as
    // a row gone elsewhere
    onSocket(frame(2, []));
    expect(ids()).toEqual([]);
    expect(
      editGone(open1, session.value?.queued, false, handoff.value),
    ).toBeNull();
    release();
    await removed;
    expect(handoff.value).toEqual({
      kind: "close",
      sessionId: "s1",
      id: "q1",
      words: EDIT_REMOVED,
    });
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
      onEdit={async () => {}}
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

  test.serial("the buttons hand the row to their callers", async () => {
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
        onEdit={async (row) => {
          seen.push(`edit ${row.id}`);
        }}
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
  });
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
      outputLimit: null,
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

  test.serial("Send sits beside Stop, over a box that says so", () => {
    const html = composer(true);
    expect(html).toMatch(/aria-label="Stop".*aria-label="Send"/s);
    expect(html).toContain(`placeholder="${PLACEHOLDER_RUNNING}"`);
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
