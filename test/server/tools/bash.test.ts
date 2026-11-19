// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shell boundary uses the send's actor, not model-supplied identity.
// A command can fail after writing, so its error flag must survive the
// registry alongside the receipts.

import { describe, expect, test } from "bun:test";
import { BACKSTOP_MS } from "../../../src/server/bash/index.ts";
import {
  acquireSession,
  heldWorkspaces,
} from "../../../src/server/bash/queue.ts";
import { PROCESS_SLOTS } from "../../../src/server/knowledge/limits.ts";
import { acquireProcess } from "../../../src/server/knowledge/queue.ts";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { wireTokens } from "../../../src/server/providers/index.ts";
import {
  asSubagent,
  commandCredentials,
  makeBashTool,
} from "../../../src/server/tools/builtin/bash.ts";
import { builtinCatalog } from "../../../src/server/tools/catalog.ts";
import { Registry } from "../../../src/server/tools/registry.ts";
import type { ToolContext } from "../../../src/server/tools/types.ts";
import { SANDBOX_DEFAULT_HOSTS } from "../../../src/shared/sandbox-net.ts";
import { settleRun } from "../../helpers/automations.ts";
import { chatApp, startChat, waitScript } from "../../helpers/chat.ts";
import { freshSignal, type Setup, setup } from "../bash/helpers.ts";

const context = (): ToolContext => ({
  web: null,
  sendId: "send00000001",
  messageId: "tool00000001",
  disabledCapabilities: [],
  actor: {
    projectId: "project",
    userId: "user",
    agentId: "agent",
    agentName: "coder",
    sessionId: "session",
    workspace: { id: "session", sessionId: "session" },
    origin: "chat",
  },
  signal: new AbortController().signal,
  now: () => 0,
  budget: { bashCalls: 0, fetches: 0, searches: 0, visualBytes: 0, visuals: 0 },
  caps: DEFAULT_LIMITS,
});

const call = (args: unknown) => ({
  id: "command",
  name: "bash",
  arguments: JSON.stringify(args),
});

function mountedContext(s: Setup): ToolContext {
  return {
    ...context(),
    sendId: "send00000001",
    messageId: "tool00000001",
    disabledCapabilities: [],
    actor: {
      projectId: s.projectId,
      userId: s.author.id,
      agentId: s.agent.id,
      agentName: s.agent.name,
      sessionId: s.session.id,
      workspace: { id: s.session.id, sessionId: s.session.id },
      origin: "chat",
    },
  };
}

describe("bash", () => {
  test("the catalog uses the command-only schema and its unfilled description", () => {
    const tool = makeBashTool({ web: { mode: "all", domains: [] } });
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command line, as for bash -c.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    });
    const listed = builtinCatalog(0, (text) => text).find(
      (entry) => entry.name === "bash",
    )!;
    expect(listed).toMatchObject({
      description: tool.description,
      parameters: tool.parameters,
      when: "knowledge",
      variant: null,
    });
    const { name, description, parameters } = tool;
    expect(listed.tokens).toBe(wireTokens([{ name, description, parameters }]));
    expect(tool.description).not.toContain("{{year}}");
    expect(tool.description).toContain("curl calls HTTP APIs on any host,");
    expect(tool.description).not.toContain(";");
    expect(tool.description).not.toContain("\n");
    expect(makeBashTool().description.endsWith("No network.")).toBe(true);
  });

  test.each([false, true])(
    "forwards the actor, caps and signal and preserves error=%s",
    async (error) => {
      const ctx = context();
      const result = {
        content: `exit ${error ? 1 : 0}\nwrote docs/x.md (rev 2, 1 lines)`,
        error,
        tail: "exit 0\nwrote docs/x.md (rev 2, 1 lines)".length,
      };
      let calls = 0;
      const tool = makeBashTool({
        bash: {
          async run(projectId, sessionId, author, command, caps, signal) {
            calls++;
            expect(projectId).toBe("project");
            expect(sessionId).toEqual({ id: "session", sessionId: "session" });
            expect(author).toEqual({
              kind: "agent",
              id: "agent",
              name: "coder",
              sessionId: "session",
              origin: "chat",
              keyName: null,
            });
            expect(command).toBe("sed -i 's/hello/world/' docs/x.md");
            expect(caps).toEqual({
              callTimeoutMs: ctx.caps.callTimeoutMs,
              resultCut: ctx.caps.resultCut,
              visuals: true,
              knowledge: true,
            });
            expect(signal.aborted).toBe(false);
            return result;
          },
        },
      });
      expect(
        await new Registry([tool]).run(
          call({ command: "sed -i 's/hello/world/' docs/x.md" }),
          ctx,
        ),
      ).toEqual(result);
      expect(calls).toBe(1);
      expect(ctx.budget.bashCalls).toBe(1);
    },
  );

  test.serial(
    "a spent count never enters an occupied session queue or process slot",
    async () => {
      const s = setup();
      const ctx = mountedContext(s);
      ctx.caps = { ...ctx.caps, maxBashCalls: 1, callTimeoutMs: 100 };
      ctx.budget.bashCalls = 1;
      const registry = new Registry([makeBashTool({ bash: s.bash })]);
      const slots = await Promise.all(
        Array.from({ length: PROCESS_SLOTS }, () =>
          acquireProcess(freshSignal()),
        ),
      );
      let releaseSession: (() => void) | undefined;
      try {
        const refused = registry.run(call({ command: "echo no > file" }), ctx);
        expect(heldWorkspaces().has(s.session.id)).toBe(false);
        expect(await refused).toEqual({
          content: "the bash budget for this reply is spent",
          error: true,
        });
        releaseSession = await acquireSession(
          { id: s.session.id, sessionId: s.session.id },
          freshSignal(),
        );
        expect(
          await registry.run(call({ command: "echo no > file" }), ctx),
        ).toEqual({
          content: "the bash budget for this reply is spent",
          error: true,
        });
        releaseSession();
        expect(heldWorkspaces().has(s.session.id)).toBe(false);
        expect(
          s.bash.scratch.read({ id: s.session.id, sessionId: s.session.id })
            .revision,
        ).toBe(0);
        expect(s.knowledge.list(s.projectId).files).toEqual([]);
        expect(ctx.budget.bashCalls).toBe(1);
      } finally {
        releaseSession?.();
        for (const release of slots) release();
        s.db.close();
      }
    },
  );

  test.serial(
    "parallel calls claim the count in order before waiting",
    async () => {
      const s = setup();
      const ctx = mountedContext(s);
      ctx.caps = { ...ctx.caps, maxBashCalls: 2 };
      const registry = new Registry([makeBashTool({ bash: s.bash })]);
      const release = await acquireSession(
        { id: s.session.id, sessionId: s.session.id },
        freshSignal(),
      );
      const pending = ["first", "second", "third", "fourth"].map((name) =>
        registry.run(call({ command: `echo ${name} > ${name}` }), ctx),
      );
      try {
        expect(ctx.budget.bashCalls).toBe(2);
        expect(await Promise.all(pending.slice(2))).toEqual([
          { content: "the bash budget for this reply is spent", error: true },
          { content: "the bash budget for this reply is spent", error: true },
        ]);
        expect(s.knowledge.list(s.projectId).files).toEqual([]);
        release();
        const results = await Promise.all(pending.slice(0, 2));
        expect(results.map((result) => result.error)).toEqual([false, false]);
        expect(
          s.knowledge
            .list(s.projectId)
            .files.map((file) => file.name)
            .sort(),
        ).toEqual(["first", "second"]);
        expect(
          s.bash.scratch.read({ id: s.session.id, sessionId: s.session.id })
            .revision,
        ).toBe(2);
      } finally {
        release();
        await Promise.all(pending);
        s.db.close();
      }
    },
  );

  test("the bash cap refuses the call while the tool loop continues", async () => {
    const chat = await chatApp();
    try {
      expect(
        (
          await chat.admin.call("PUT", "/api/limits", {
            body: { values: { ...DEFAULT_LIMITS, maxBashCalls: 1 } },
          })
        ).status,
      ).toBe(200);
      const { script, sessionId } = await startChat(chat);
      const bash = (id: string, command: string) => ({
        id,
        name: "bash",
        arguments: JSON.stringify({ command }),
      });
      script.toolRound([bash("first", "printf saved > kept")]);
      script.end();
      const second = await waitScript(chat.scripted, 2);
      second.toolRound([bash("spent", "printf refused > missing")]);
      second.end();
      const third = await waitScript(chat.scripted, 3);
      expect(third.body.messages).toContainEqual({
        role: "tool",
        tool_call_id: "spent",
        content: "the bash budget for this reply is spent",
      });
      third.toolRound([
        {
          id: "time",
          name: "datetime",
          arguments: JSON.stringify({ timezone: "UTC" }),
        },
      ]);
      third.end();
      const fourth = await waitScript(chat.scripted, 4);
      fourth.reply("The saved file is enough.");
      expect((await settleRun(chat, sessionId))?.status).toBe("done");
      const rows = chat.app.sessions.messages(sessionId);
      expect(rows.find((row) => row.toolCallId === "spent")?.status).toBe(
        "failed",
      );
      expect(rows.find((row) => row.toolCallId === "time")?.status).toBe(
        "done",
      );
      expect(rows.some((row) => row.finishReason === "tool_limit")).toBe(false);
      expect(
        chat.app.knowledge.list(chat.projectId).files.map((file) => file.name),
      ).toEqual(["kept"]);
    } finally {
      await chat.app.shutdown();
      chat.app.db.close();
    }
  });

  test("keeps the exit and every receipt as the tail through the registry", async () => {
    const s = setup();
    const ctx = mountedContext(s);
    ctx.caps = { ...ctx.caps, resultCut: 1000 };
    s.knowledge.create(s.projectId, s.author, "old", "old");
    s.knowledge.create(s.projectId, s.author, "source", "x".repeat(2000));
    try {
      const result = await new Registry([makeBashTool({ bash: s.bash })]).run(
        call({
          command:
            "cat source; printf one > first; printf two > second; rm old; false",
        }),
        ctx,
      );
      const tail =
        "exit 1\nwrote first (rev 1, 1 lines)\nwrote second (rev 1, 1 lines)\ndeleted old";
      expect(result.error).toBe(true);
      expect(result.tail).toBe(tail.length);
      expect(result.content.slice(-result.tail!)).toBe(tail);
      expect(result.content).toContain("output cut at 1000 characters");
      expect(result.content.length).toBeLessThanOrEqual(1000);
    } finally {
      s.db.close();
    }
  });

  test("a missing actor fails without running a command", async () => {
    const ctx = context();
    ctx.actor = null;
    expect(
      await new Registry([makeBashTool()]).run(call({ command: "ls" }), ctx),
    ).toEqual({ error: true, content: "no project" });
  });

  test.each([
    {},
    { command: null },
    { command: 1 },
    { command: "ls", id: "x" },
  ])("refuses invalid arguments %j before calling knowledge", async (args) => {
    let calls = 0;
    const tool = makeBashTool({
      bash: {
        async run() {
          calls++;
          return { content: "exit 0", error: false };
        },
      },
    });
    const result = await new Registry([tool]).run(call(args), context());
    expect(result.error).toBe(true);
    expect(result.content).toMatch(/command must be|accepts only command/);
    expect(calls).toBe(0);
  });

  test("a missing command capability fails explicitly", async () => {
    expect(
      await new Registry([makeBashTool()]).run(
        call({ command: "ls" }),
        context(),
      ),
    ).toEqual({ error: true, content: "Error: knowledge is not configured" });
  });

  test("the call signal reaches the command through the registry", async () => {
    const ctx = context();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const tool = makeBashTool({
      bash: {
        async run(_projectId, _sessionId, _author, _command, _caps, signal) {
          controller.abort(new Error("stopped"));
          expect(signal.aborted).toBe(true);
          signal.throwIfAborted();
          return { content: "exit 0", error: false };
        },
      },
    });
    expect(
      await new Registry([tool]).run(call({ command: "ls" }), ctx),
    ).toEqual({ error: true, content: "Error: stopped", interrupted: true });
  });
});

describe("bash with credentials", () => {
  const KEY = "quotes-key-0123456789";
  const quotes = {
    id: "quotes1",
    name: "quotes",
    keyName: "http-quotes",
    prefix: "https://quotes.example.test/api/v1/",
    header: "X-Api-Key",
    template: "Token {key}",
    methods: ["GET" as const],
  };
  const all = { mode: "all" as const, domains: [] };

  test("the description signs each offered prefix, cut at 80 characters", () => {
    const long = {
      ...quotes,
      id: "long1",
      name: "long",
      prefix: `https://long.example.test/${"a".repeat(80)}/`,
    };
    const words = makeBashTool({
      web: all,
      credentials: {
        offered: [long, quotes],
        off: [{ name: "prices", prefix: "https://prices.example.test/" }],
      },
    }).description;
    expect(words).toEndWith(
      `Save downloads in /tmp. curl to ${long.prefix.slice(0, 77)}... (long) is signed in; send no key. curl to https://quotes.example.test/api/v1/ (quotes) is signed in; send no key.`,
    );
    expect(words).not.toContain("prices");
    expect(
      makeBashTool({ credentials: { offered: [quotes], off: [] } }).description,
    ).toEndWith("No network.");
  });

  test("each command checks the row and reads the key, and scrubs the result", async () => {
    const rows = new Map([
      ["quotes1", { ...quotes, projectIds: ["project"] }],
      ["gone1", { ...quotes, keyName: "http-gone", projectIds: ["project"] }],
      ["other1", { ...quotes, projectIds: ["elsewhere"] }],
    ]);
    const reads = new Map([
      ["http-quotes", { ok: true as const, key: KEY }],
      ["http-gone", { ok: false as const, reason: "missing" as const }],
    ]);
    let seen: unknown;
    const tool = makeBashTool({
      bash: {
        async run(_projectId, _sessionId, _author, _command, caps) {
          seen = caps;
          return {
            content: `echo ${KEY}\nexit 0 ${KEY}`,
            error: false,
            tail: `exit 0 ${KEY}`.length,
          };
        },
      },
      web: all,
      credentials: {
        offered: [
          quotes,
          { ...quotes, id: "gone1", name: "gone", keyName: "http-gone" },
          { ...quotes, id: "other1", name: "other" },
          { ...quotes, id: "deleted1", name: "deleted" },
        ],
        off: [{ name: "prices", prefix: "https://prices.example.test/" }],
      },
      keys: {
        byId: (id) => rows.get(id) ?? null,
        readKey: (name) => reads.get(name)!,
      },
    });
    const result = await tool.run(
      { command: "curl" },
      { ...context(), web: all },
    );
    expect(result).toEqual({
      content: "echo [credential quotes]\nexit 0 [credential quotes]",
      error: false,
      tail: "exit 0 [credential quotes]".length,
    });
    const credentials = (seen as { credentials: unknown[] }).credentials;
    expect(credentials).toEqual([
      {
        name: "quotes",
        prefix: quotes.prefix,
        key: KEY,
        header: "X-Api-Key",
        template: "Token {key}",
        value: `Token ${KEY}`,
        methods: ["GET"],
      },
      { name: "gone", prefix: quotes.prefix, refused: "missing" },
      { name: "other", prefix: quotes.prefix, refused: "deleted" },
      { name: "deleted", prefix: quotes.prefix, refused: "deleted" },
      {
        name: "prices",
        prefix: "https://prices.example.test/",
        refused: "off",
      },
    ]);
  });

  test("a read-only credential signs its row's read methods alone", () => {
    const row = { ...quotes, methods: ["GET" as const, "POST" as const] };
    const [credential] = commandCredentials(
      { offered: [{ ...row, readOnly: true }], off: [] },
      {
        byId: () => ({ ...row, projectIds: ["project"] }),
        readKey: () => ({ ok: true, key: KEY }),
      },
      "project",
    );
    expect(credential).toMatchObject({ key: KEY, methods: ["GET"] });
    expect(
      makeBashTool({
        web: { mode: "all", domains: [] },
        credentials: { offered: [{ ...row, readOnly: true }], off: [] },
      }).description,
    ).toContain("(quotes) is signed in, GET and HEAD only; send no key.");
  });

  test("a subagent's words keep a prefix that reads as a replace pattern", () => {
    const web = { mode: "all" as const, domains: [] };
    const odd = { ...quotes, prefix: "https://odd.example.test/v1$'x/" };
    const parent = makeBashTool({
      web,
      credentials: { offered: [odd], off: [] },
    }).description;
    const child = asSubagent(
      `${parent}\n\nrepos`,
      web,
      [odd],
      [{ ...odd, readOnly: true }],
    );
    expect(child).toContain(
      "(quotes) is signed in, GET and HEAD only; send no key.\n\nrepos",
    );
    expect(child).toContain("/v1$'x/");
  });

  test("a row changed since the send began refuses its credential", async () => {
    const moved = {
      keyName: { keyName: "http-other" },
      prefix: { prefix: "https://evil.example.test/" },
      header: { header: "X-Other" },
      template: { template: "Bearer {key}" },
      methods: { methods: ["GET" as const, "POST" as const] },
    };
    const reads: string[] = [];
    for (const [field, change] of Object.entries(moved)) {
      const [credential] = commandCredentials(
        { offered: [quotes], off: [] },
        {
          byId: () => ({ ...quotes, ...change, projectIds: ["project"] }),
          readKey: (name) => {
            reads.push(name);
            return { ok: true, key: KEY };
          },
        },
        "project",
      );
      expect(credential, field).toEqual({
        name: "quotes",
        prefix: quotes.prefix,
        refused: "changed",
      });
    }
    expect(reads).toEqual([]);
    const [same] = commandCredentials(
      { offered: [quotes], off: [] },
      {
        byId: () => ({ ...quotes, projectIds: ["project"] }),
        readKey: () => ({ ok: true, key: `${KEY}-new` }),
      },
      "project",
    );
    expect(same).toMatchObject({ key: `${KEY}-new` });
  });

  test("a command without network reads no key", async () => {
    let caps: unknown;
    const tool = makeBashTool({
      bash: {
        async run(_projectId, _sessionId, _author, _command, given) {
          caps = given;
          return { content: "exit 0", error: false };
        },
      },
      credentials: { offered: [quotes], off: [] },
      keys: {
        byId: () => {
          throw new Error("no row is read");
        },
        readKey: () => {
          throw new Error("no key is read");
        },
      },
    });
    await tool.run({ command: "ls" }, context());
    expect(caps).not.toHaveProperty("credentials");
  });
});

describe("bash's description under the sandbox shell", () => {
  const github = {
    id: "gh1",
    name: "gh-api",
    keyName: "http-gh",
    prefix: "https://api.github.test/",
    header: "Authorization",
    template: "token {key}",
    methods: ["GET" as const, "POST" as const],
  };
  const cookie = {
    ...github,
    id: "c1",
    name: "session",
    header: "Cookie",
    template: "s={key}",
  };
  const listed = {
    mode: "listed" as const,
    domains: ["api.github.test", "pypi.test"],
  };

  const hosts = { mode: "hosts" as const, hosts: SANDBOX_DEFAULT_HOSTS };

  // the words as the user wrote them: a call's time and the idle time
  // from the limits, then the network and each credential
  const WORDS =
    "Run a bash command in this chat's Linux sandbox: Python 3.15 with uv, Bun, git, jq, yq and rg; no node. /knowledge is the project's shared docs, saved as a new version when the command ends; if someone else changed a file meanwhile, nothing is saved: read it again and retry. /uploads holds the user's attachments, read-only. /tmp and $HOME are yours until the sandbox is recycled (after 30 idle minutes, a restart, a timeout or a failed save), so keep what must last in /knowledge. Search before reading: rg -il 'word' /knowledge, grep -n, sed -n '40,120p'. Never print whole files or trees; long output is cut. Each call is a new shell in the last directory: chain one task's steps in one call, and make independent calls in parallel. A call may run 10 minutes; send a background job's output to a file. Install with uv run --with pkg, a venv under $HOME, or bun add in a project under $HOME. open <file> shows a file to the user: HTML and SVG as visuals, Markdown rendered. Network: HTTP and HTTPS to the admin's list only: package and container registries, code hosts, docs, news and public APIs (pypi.org, registry.npmjs.org, github.com…); anything else is refused. Never write secrets.";

  test("its words are the short ones, byte for byte", () => {
    const hash = (text: string) =>
      new Bun.CryptoHasher("sha256").update(text).digest("hex");
    const words = makeBashTool({ web: listed, sandbox: hosts }).description;
    expect(words).toBe(WORDS);
    expect(hash(words)).toBe(
      "89f76173d949afc6e9a79e568dd3557036a435bef4795f7ad4a39aefa88c2a02",
    );
    expect(hash(makeBashTool({ web: null, sandbox: hosts }).description)).toBe(
      "a74885d876fdd6a2a0eb3991b9694d12e00c870b2f2be20dd293a0033226d3cf",
    );
    expect(
      hash(
        makeBashTool({ web: listed, sandbox: hosts, subagent: true })
          .description,
      ),
    ).toBe("0f9671be33052b1e11364b50024afef77664e36e156649b7cd5f3fb018a37300");
  });

  test("each credential it can place follows the network, its header named", () => {
    const words = makeBashTool({
      web: listed,
      credentials: { offered: [github, cookie], off: [] },
      sandbox: hosts,
    }).description;
    expect(words).toContain(
      'anything else is refused. For https://api.github.test/ (gh-api) send -H "Authorization: token $ONECTX_CRED_GH_API", a placeholder the key replaces there alone. Never write secrets.',
    );
    expect(words).not.toContain("session");
    expect(words).not.toContain("send no key");
  });

  test("a header or template the shell would read is never offered", () => {
    const words = makeBashTool({
      web: listed,
      credentials: {
        offered: [
          { ...github, name: "dollar", template: "token $(id) {key}" },
          { ...github, name: "tick", header: "X-`id`", template: "{key}" },
          { ...github, name: "quote", template: 'a" {key}' },
          { ...github, name: "slash", template: "a\\ {key}" },
        ],
        off: [],
      },
      sandbox: hosts,
    }).description;
    expect(words).not.toContain("send -H");
  });

  test("the admin's list is named by kind, never by its hosts", () => {
    const many = Array.from({ length: 13 }, (_, i) => `h${i + 10}.test`);
    const words = makeBashTool({
      web: { mode: "all", domains: [] },
      sandbox: { mode: "hosts", hosts: many },
    }).description;
    expect(words).toBe(
      WORDS.replace(" (pypi.org, registry.npmjs.org, github.com…)", ""),
    );
    expect(words).not.toContain("h10.test");
    expect(words).not.toContain("any host");
  });

  test("its examples are only those the admin's list holds, in their order", () => {
    const words = makeBashTool({
      web: { mode: "all", domains: [] },
      sandbox: { mode: "hosts", hosts: ["github.com", "x.test", "pypi.org"] },
    }).description;
    expect(words).toBe(
      WORDS.replace(
        "(pypi.org, registry.npmjs.org, github.com…)",
        "(pypi.org, github.com…)",
      ),
    );
  });

  test("a send without web access says no network, whatever the sandbox's hosts", () => {
    const words = makeBashTool({
      web: null,
      credentials: { offered: [github], off: [] },
      sandbox: hosts,
    }).description;
    expect(words.endsWith(" No network. Never write secrets.")).toBe(true);
    expect(words).not.toContain("Network:");
    expect(words).not.toContain("ONECTX_CRED");
    expect(words).toContain("uv run");
  });

  test("off says no network, whatever Web access says", () => {
    const words = makeBashTool({
      web: listed,
      credentials: { offered: [github], off: [] },
      sandbox: { mode: "off", hosts: ["pypi.test"] },
    }).description;
    expect(words.endsWith(" No network. Never write secrets.")).toBe(true);
    expect(words).not.toContain("ONECTX_CRED");
    expect(words).toContain("uv run");
  });

  test("the built-in shell's words are untouched, and a subagent's are its parent's less open", () => {
    const options = {
      web: listed,
      credentials: { offered: [github], off: [] },
    };
    expect(makeBashTool({ ...options, sandbox: null }).description).toBe(
      makeBashTool(options).description,
    );
    expect(makeBashTool(options).description).toContain(
      "jq, yq, awk and diff are there, git, python and node are not.",
    );
    const parent = makeBashTool({ ...options, sandbox: hosts }).description;
    // a subagent in its parent's sandbox has its parent's credentials
    const child = asSubagent(`${parent}\n\nrepos`, listed, [github], [github]);
    expect(child).toBe(
      `${parent.replace("open <file> shows a file to the user: HTML and SVG as visuals, Markdown rendered. ", "")}\n\nrepos`,
    );
    expect(child).toContain("(gh-api) send -H");
    expect(
      makeBashTool({ ...options, sandbox: hosts, subagent: true }).description,
    ).toBe(asSubagent(parent, listed, [github], [github]));
  });

  test("a sandbox command has its own time, said in the words and passed on", async () => {
    const seen: { caps: object; aborted: boolean }[] = [];
    const timeouts: number[] = [];
    const timer = {
      now: () => 0,
      timeout: (ms: number) => {
        timeouts.push(ms);
        return new AbortController().signal;
      },
    };
    const bash = (sandboxed: boolean) => ({
      async run(
        _p: string,
        _w: unknown,
        _a: unknown,
        _c: string,
        caps: object,
        signal: AbortSignal,
      ) {
        seen.push({ caps, aborted: signal.aborted });
        return { content: "ok", error: false };
      },
      sandbox: () => (sandboxed ? hosts : null),
      sandboxCommandSeconds: () => 900,
      sandboxIdleMinutes: () => 45,
    });
    const sandboxed = makeBashTool({ bash: bash(true) });
    expect(sandboxed.timeoutMs).toBe(900_000);
    expect(sandboxed.description).toContain("A call may run 15 minutes;");
    expect(sandboxed.description).toContain(
      "recycled (after 45 idle minutes, a restart,",
    );
    expect(
      makeBashTool({ sandbox: hosts, idleMinutes: 1 }).description,
    ).toContain("(after 1 idle minute, a restart");
    // a run's deadline under the command's own time caps the words
    expect(
      makeBashTool({ sandbox: hosts, deadlineMs: 300_000 }).description,
    ).toContain("A call may run 5 minutes;");
    expect(
      makeBashTool({ sandbox: hosts, deadlineMs: 1_800_000 }).description,
    ).toContain("A call may run 10 minutes;");
    await new Registry([sandboxed], undefined, timer).run(
      call({ command: "make test" }),
      context(),
    );
    const builtin = makeBashTool({ bash: bash(false) });
    expect(builtin.timeoutMs).toBeUndefined();
    expect(builtin.description).not.toContain("A call may run");
    await new Registry([builtin], undefined, timer).run(
      call({ command: "ls" }),
      context(),
    );
    const grace = BACKSTOP_MS + 500;
    expect(timeouts).toEqual([
      900_000 + grace,
      DEFAULT_LIMITS.callTimeoutMs + grace,
    ]);
    expect(seen.map((one) => one.caps)).toEqual([
      expect.objectContaining({
        callTimeoutMs: DEFAULT_LIMITS.callTimeoutMs,
        sandboxCommandMs: 900_000,
      }),
      expect.not.objectContaining({ sandboxCommandMs: expect.anything() }),
    ]);
    expect(makeBashTool({ sandbox: hosts }).description).toContain(
      "A call may run 10 minutes;",
    );
  });

  test("the built-in shell's words stay byte for byte", () => {
    const hash = (text: string) =>
      new Bun.CryptoHasher("sha256").update(text).digest("hex");
    expect(hash(makeBashTool().description)).toBe(
      "27825f49251f64e13747dcbde4c2bd6667d9e50a1a42fb22198b17f96b33036f",
    );
    expect(
      hash(makeBashTool({ web: { mode: "all", domains: [] } }).description),
    ).toBe("4d18abed7e696ad9463068295b1bf452f2e0f17d2f9eac7a7eb4bd7d3ff5bf12");
    expect(hash(makeBashTool({ subagent: true }).description)).toBe(
      "61c60fd5537e8b6553d29e1e5acd38cd099c819367d29fb83db0a7e0bda64338",
    );
    expect(makeBashTool().description).toContain(
      "/tmp is this chat's scratch for any bytes, kept between commands.",
    );
  });

  test("the send's end stops a sandbox command long before its own time", async () => {
    const send = new AbortController();
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const tool = makeBashTool({
      bash: {
        run: (_p, _w, _a, _c, _caps, signal) =>
          new Promise((_, reject) => {
            started();
            signal.addEventListener("abort", () => reject(signal.reason));
          }),
        sandbox: () => hosts,
        sandboxCommandSeconds: () => 3600,
      },
    });
    const timer = {
      now: () => 0,
      timeout: () => new AbortController().signal,
    };
    const pending = new Registry([tool], undefined, timer).run(
      call({ command: "sleep 3000" }),
      { ...context(), signal: send.signal },
    );
    await running;
    send.abort(new Error("the send's deadline"));
    const result = await pending;
    expect(result).toMatchObject({ error: true, interrupted: true });
  });

  test("bash's own word picks the variant", () => {
    const run = async () => ({ content: "", error: false });
    expect(
      makeBashTool({ bash: { run, sandbox: () => hosts }, web: listed })
        .description,
    ).toContain("uv run");
    expect(
      makeBashTool({ bash: { run, sandbox: () => null }, web: listed })
        .description,
    ).not.toContain("uv run");
  });
});
