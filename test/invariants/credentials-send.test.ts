// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A send in a team project carries the project's credentials while it
// has network, and bash's curl signs with their keys without a key ever
// reaching the shell, a tool result or a stored row. curl reaches the
// global fetch, which a test here replaces, so the tests that run curl
// are serial.

import { expect, test } from "bun:test";
import type { ProjectAgentsResponse } from "../../src/shared/api/sessions.ts";
import {
  type CapabilityChange,
  credentialKey,
} from "../../src/shared/capabilities.ts";
import type { SessionDetail } from "../../src/shared/contracts/session.ts";
import { automationBody, settleRun } from "../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  waitScript,
} from "../helpers/chat.ts";

const KEY = "quotes-key-0123456789";
const OTHER_KEY = "prices-key-9876543210";
const PREFIX = "https://quotes.example.test/api/v1/";
const CLAUSE = `curl to ${PREFIX} (quotes) is signed in; send no key.`;

async function setup() {
  const chat = await chatApp({
    secrets: { "http-quotes": KEY, "http-prices": OTHER_KEY },
  });
  chat.app.automationScheduler.stop();
  const created = await chat.admin.call("POST", "/api/projects", {
    body: { name: "finops" },
  });
  const { project } = await created.json();
  const member = await chat.admin.call(
    "POST",
    `/api/projects/${project.id}/members`,
    { body: { userId: chat.memberId } },
  );
  expect(member.status).toBe(201);
  const credential = async (body: Record<string, unknown>) => {
    const res = await chat.admin.call("POST", "/api/credentials", {
      body: { template: "{key}", projectIds: [project.id], ...body },
    });
    expect(res.status).toBe(201);
    return (await res.json()).credential.id as string;
  };
  const quotes = await credential({
    name: "quotes",
    keyName: "http-quotes",
    prefix: PREFIX,
    header: "X-Api-Key",
  });
  const prices = await credential({
    name: "prices",
    keyName: "http-prices",
    prefix: "https://prices.example.test/",
    header: "Authorization",
    template: "Bearer {key}",
  });
  return { chat, teamId: project.id as string, quotes, prices };
}

async function closed(chat: ChatApp) {
  await chat.app.shutdown();
  chat.app.db.close();
}

type Seen = { url: string; headers: Headers };

async function withTransport(body: (seen: Seen[]) => Promise<void>) {
  const original = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      seen.push({ url, headers });
      const sent = headers.get("x-api-key") ?? "none";
      return new Response(`got ${sent}\n`, {
        headers: { "set-cookie": `session=${sent}`, "x-echo": sent },
      });
    },
    { preconnect: original.preconnect },
  );
  try {
    await body(seen);
  } finally {
    globalThis.fetch = original;
  }
}

async function send(
  chat: ChatApp,
  projectId: string,
  sessionId: string | null,
  capabilities?: CapabilityChange,
) {
  const count = chat.scripted.scripts.length + 1;
  const response = await chat.member.call(
    "POST",
    sessionId === null
      ? "/api/sessions"
      : `/api/sessions/${sessionId}/messages`,
    {
      body: {
        ...(sessionId === null ? { projectId, agentId: chat.agentId } : {}),
        message: "Fetch the quote.",
        capabilities,
      },
    },
  );
  expect(response.status).toBe(201);
  const detail = (await response.json()) as SessionDetail;
  const script = await waitScript(chat.scripted, count);
  const policy = chat.app.runner.registry.get(detail.session.id)!.policy;
  return { detail, script, policy, id: detail.session.id };
}

const bashWords = (script: Script) =>
  (
    script.body.tools as {
      function: { name: string; description: string };
    }[]
  ).find((tool) => tool.function.name === "bash")!.function.description;

async function bash(chat: ChatApp, script: Script, command: string) {
  const count = chat.scripted.scripts.length + 1;
  script.toolRound([
    {
      id: `call-${count}`,
      name: "bash",
      arguments: JSON.stringify({ command }),
    },
  ]);
  script.end();
  const next = await waitScript(chat.scripted, count);
  const result = (next.body.messages as { role: string; content: string }[])
    .filter((message) => message.role === "tool")
    .at(-1)!.content;
  return { next, result };
}

// every text and byte the database holds
function stored(chat: ChatApp): string {
  const tables = chat.app.db
    .query<{ name: string }, []>(
      "select name from sqlite_schema where type = 'table'",
    )
    .all();
  return tables
    .flatMap(({ name }) =>
      chat.app.db
        .query<Record<string, unknown>, []>(`select * from "${name}"`)
        .all()
        .flatMap((row) =>
          Object.values(row).map((value) =>
            value instanceof Uint8Array
              ? Buffer.from(value).toString("latin1")
              : String(value),
          ),
        ),
    )
    .join("\n");
}

test.serial(
  "bash's curl signs with the key and nothing the shell sees holds it",
  async () => {
    const { chat, teamId } = await setup();
    try {
      await withTransport(async (seen) => {
        const first = await send(chat, teamId, null);
        expect(first.policy.offered.credentials.map((c) => c.name)).toEqual([
          "prices",
          "quotes",
        ]);
        expect(first.policy.offered.credentialsOff).toEqual([]);
        expect(bashWords(first.script)).toContain(
          `curl to https://prices.example.test/ (prices) is signed in; send no key. ${CLAUSE}`,
        );
        const { next, result } = await bash(
          chat,
          first.script,
          [
            "env",
            "set",
            "set -x",
            `curl -sS -v ${PREFIX}q`,
            `curl -sS -i ${PREFIX}q`,
            `curl -sS -o /tmp/out ${PREFIX}q`,
            `curl -sS -o /knowledge/out.txt ${PREFIX}q`,
            `curl -sS -c /tmp/jar ${PREFIX}q`,
            "cat /tmp/out /tmp/jar /knowledge/out.txt",
          ].join("\n"),
        );
        expect(seen).toHaveLength(5);
        expect(seen.every((r) => r.headers.get("x-api-key") === KEY)).toBe(
          true,
        );
        expect(result).toContain("got [credential quotes]");
        expect(result).toContain("x-echo: [credential quotes]");
        expect(result).toContain("session=[credential quotes]");
        expect(result).not.toContain(KEY);
        expect(JSON.stringify(next.body)).not.toContain(KEY);
        const scratch = chat.app.knowledge.scratch.read(first.id);
        expect(scratch.entries.map((file) => file.path).sort()).toEqual([
          "jar",
          "out",
        ]);
        for (const file of scratch.entries) {
          expect(Buffer.from(file.data).toString("latin1")).not.toContain(KEY);
        }
        next.reply("Done.");
        await settleRun(chat, first.id);
        const docs = chat.app.knowledge.store.read(teamId);
        expect(docs.map((doc) => doc.text)).toEqual([
          "got [credential quotes]\n",
        ]);
        expect(stored(chat)).not.toContain(KEY);
        expect(stored(chat)).not.toContain(OTHER_KEY);
      });
    } finally {
      await closed(chat);
    }
  },
);

test.serial(
  "a key replaced or a credential removed applies to the next command",
  async () => {
    const { chat, teamId, quotes } = await setup();
    try {
      await withTransport(async (seen) => {
        const first = await send(chat, teamId, null);
        chat.secrets["http-quotes"] = "rotated-key-0123456789";
        const rotated = await bash(
          chat,
          first.script,
          `curl -sS ${PREFIX}q?n=1`,
        );
        expect(rotated.result).toContain("got [credential quotes]");
        expect(seen.at(-1)!.headers.get("x-api-key")).toBe(
          "rotated-key-0123456789",
        );
        chat.secrets["http-quotes"] = "short";
        const unusable = await bash(
          chat,
          rotated.next,
          `curl -sS ${PREFIX}q?n=2`,
        );
        expect(unusable.result).toContain(
          "Network access denied: credential quotes has an unusable key",
        );
        delete chat.secrets["http-quotes"];
        const missing = await bash(
          chat,
          unusable.next,
          `curl -sS ${PREFIX}q?n=3`,
        );
        expect(missing.result).toContain("credential quotes has no key");
        chat.secrets["http-quotes"] = KEY;
        const removed = await chat.admin.call(
          "DELETE",
          `/api/credentials/${quotes}`,
        );
        expect(removed.status).toBe(204);
        const gone = await bash(chat, missing.next, `curl -sS ${PREFIX}q?n=4`);
        expect(gone.result).toContain("credential quotes was removed");
        expect(seen).toHaveLength(1);
        gone.next.reply("Done.");
        await settleRun(chat, first.id);
      });
    } finally {
      await closed(chat);
    }
  },
);

test.serial(
  "a credential off in the chat has no clause and refuses by name",
  async () => {
    const { chat, teamId, quotes, prices } = await setup();
    try {
      await withTransport(async (seen) => {
        const first = await send(chat, teamId, null, {
          disable: [credentialKey(quotes)],
        });
        expect(first.detail.session.disabledCapabilities).toEqual([
          credentialKey(quotes),
        ]);
        expect(first.policy.offered.credentials.map((c) => c.id)).toEqual([
          prices,
        ]);
        expect(first.policy.offered.credentialsOff).toEqual([
          { id: quotes, name: "quotes", prefix: PREFIX },
        ]);
        expect(bashWords(first.script)).not.toContain("(quotes)");
        expect(bashWords(first.script)).toContain("(prices) is signed in");
        const { next, result } = await bash(
          chat,
          first.script,
          `curl -sS ${PREFIX}q`,
        );
        expect(result).toContain(
          "curl: (7) Network access denied: credential quotes is off in this chat",
        );
        expect(seen).toHaveLength(0);
        next.reply("Off.");
        await settleRun(chat, first.id);
        const reply = chat.app.sessions
          .messages(first.id)
          .findLast((message) => message.kind === "reply")!;
        const forked = await chat.member.call(
          "POST",
          `/api/sessions/${first.id}/fork`,
          { body: { messageId: reply.id, agentId: chat.agentId } },
        );
        expect(forked.status).toBe(201);
        const fork = (await forked.json()) as SessionDetail;
        expect(fork.session.disabledCapabilities).toEqual([
          credentialKey(quotes),
        ]);
        const again = await send(chat, teamId, fork.session.id);
        expect(again.policy.offered.credentialsOff.map((c) => c.id)).toEqual([
          quotes,
        ]);
        again.script.reply("Still off.");
        await settleRun(chat, fork.session.id);
      });
    } finally {
      await closed(chat);
    }
  },
);

test("without network a send has no credentials, no clause and no curl", async () => {
  const { chat, teamId } = await setup();
  try {
    const chatOff = await send(chat, teamId, null, { disable: ["web"] });
    expect(chatOff.policy.offered.credentials).toEqual([]);
    expect(chatOff.policy.offered.credentialsOff).toEqual([]);
    expect(bashWords(chatOff.script)).toEndWith("No network.");
    const { next, result } = await bash(
      chat,
      chatOff.script,
      `curl -sS ${PREFIX}q`,
    );
    expect(result).toContain("curl: command not found");
    next.reply("No web.");
    await settleRun(chat, chatOff.id);
    const off = await chat.admin.call("PATCH", "/api/tools/web", {
      body: { mode: "off" },
    });
    expect(off.status).toBe(200);
    const adminOff = await send(chat, teamId, null);
    expect(adminOff.policy.offered.credentials).toEqual([]);
    expect(adminOff.policy.offered.credentialsOff).toEqual([]);
    expect(bashWords(adminOff.script)).not.toContain("signed in");
    adminOff.script.reply("No web.");
    await settleRun(chat, adminOff.id);
  } finally {
    await closed(chat);
  }
});

test("a personal project's send has none, and a run keeps its task's set", async () => {
  const { chat, teamId, quotes, prices } = await setup();
  try {
    const personal = await send(chat, chat.projectId, null);
    expect(personal.policy.offered.credentials).toEqual([]);
    expect(bashWords(personal.script)).not.toContain("signed in");
    personal.script.reply("Mine.");
    await settleRun(chat, personal.id);
    const created = await chat.member.call(
      "POST",
      `/api/projects/${teamId}/automations`,
      {
        body: automationBody(chat, {
          disabledCapabilities: [credentialKey(quotes)],
        }),
      },
    );
    expect(created.status).toBe(201);
    const { automation } = await created.json();
    const pending = chat.scripted.next();
    const started = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/run`,
    );
    expect(started.status).toBe(201);
    const run = (await started.json()).session.id as string;
    const script = await pending;
    const policy = chat.app.runner.registry.get(run)!.policy;
    expect(policy.offered.credentials.map((c) => c.id)).toEqual([prices]);
    expect(policy.offered.credentialsOff.map((c) => c.id)).toEqual([quotes]);
    expect(bashWords(script)).not.toContain("(quotes)");
    script.reply("Task done.");
    await settleRun(chat, run);
  } finally {
    await closed(chat);
  }
});

test("project agents answer the project's credentials in name order", async () => {
  const { chat, teamId, quotes, prices } = await setup();
  try {
    const path = `/api/projects/${teamId}/agents`;
    const member = (await (
      await chat.member.call("GET", path)
    ).json()) as ProjectAgentsResponse;
    expect(member.credentials).toEqual([
      { id: prices, name: "prices" },
      { id: quotes, name: "quotes" },
    ]);
    expect(await (await chat.admin.call("GET", path)).json()).toEqual(member);
    const personal = (await (
      await chat.member.call("GET", `/api/projects/${chat.projectId}/agents`)
    ).json()) as ProjectAgentsResponse;
    expect(personal.credentials).toEqual([]);
  } finally {
    await closed(chat);
  }
});
