// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A scheduled task's check URL: one GET before each scheduled fire,
// and a run only on a new answer, which its first message and a kept
// file hold.

import { describe, expect, test } from "bun:test";
import { RunCapacity } from "../../../src/server/runner/index.ts";
import type { AutomationSummary } from "../../../src/shared/contracts/automation.ts";
import {
  CHECK_URL,
  type CheckHost,
  checkHost,
  collectLogs,
  testApp,
} from "../../helpers/app.ts";
import { createAutomation } from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  sessionSettled,
  setLimits,
  until,
  waitScript,
} from "../../helpers/chat.ts";
import { SMTP } from "../../helpers/links.ts";

const URL_ = `${CHECK_URL}/alerts?token=query-secret`;

async function checkApp(window?: number) {
  const host = checkHost();
  const logs = collectLogs();
  const chat = await chatApp({
    fetcher: host.fetcher,
    logFactory: logs.logFactory,
    ...(window === undefined ? {} : { window }),
  });
  chat.app.automationScheduler.stop();
  const automation = await createAutomation(chat, { checkUrl: URL_ });
  return { chat, host, logs, automation };
}

const row = (chat: ChatApp, id: string) => chat.app.automations.byId(id)!;

const makeDue = (chat: ChatApp, id: string) =>
  chat.app.db
    .query("update automations set next_at = ? where id = ?")
    .run(chat.app.now.value, id);

// one scheduled fire: its GET, then the fire its answer allows
async function fireChecked(chat: ChatApp, id: string) {
  const scheduler = chat.app.automationScheduler;
  expect(await scheduler.fire(id)).toBeNull();
  await scheduler.checked();
  return scheduler.fire(id);
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  });

// the run a new answer started, ended done
async function endRun(chat: ChatApp, sessionId: string) {
  const script = chat.scripted.scripts.at(-1)!;
  script.reply("done");
  await sessionSettled(chat.app, sessionId);
}

// a done run its agent marked
const markedRun = (chat: ChatApp, id: string, sessionId: string, at: number) =>
  chat.app.db
    .query(
      `insert into sessions (id, project_id, owner_id, agent_id, origin,
         automation_id, title, status, attention, attention_reason,
         created_at, last_activity_at)
       values (?, ?, ?, ?, 'automation', ?, 't', 'done', 1, 'pods down', ?, ?)`,
    )
    .run(sessionId, chat.projectId, chat.memberId, chat.agentId, id, at, at);

const checkLogs = (logs: ReturnType<typeof collectLogs>) =>
  logs.events.filter((event) => event.msg === "check failed");

describe("a check URL", () => {
  test("a quiet answer starts no run and records no event", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      const body = '{"issues":[],"total":0}';
      chat.app.db
        .query("update automations set check_body_hash = ? where id = ?")
        .run(
          new Bun.CryptoHasher("sha256").update(body).digest("hex"),
          automation.id,
        );
      const answers: [() => Response, string][] = [
        [() => new Response(null, { status: 204 }), "204"],
        [() => new Response(null, { status: 304 }), "304"],
        [() => new Response(" \n"), "empty"],
        [() => json([]), "empty"],
        [() => json({}), "empty"],
        [() => json("null"), "empty"],
        [() => json(body), "unchanged"],
      ];
      for (const [reply, result] of answers) {
        host.answer(reply);
        makeDue(chat, automation.id);
        const before = row(chat, automation.id);
        expect(await fireChecked(chat, automation.id)).toBeNull();
        const after = row(chat, automation.id);
        expect(after).toMatchObject({
          lastEventAt: null,
          lastEventOutcome: null,
          lastCheckedAt: chat.app.now.value,
          lastCheckResult: result,
          lastAnsweredAt: chat.app.now.value,
        });
        expect(after.nextAt).toBeGreaterThan(chat.app.now.value);
        expect(after.revision).toBeGreaterThan(before.revision);
      }
      expect(chat.scripted.scripts).toHaveLength(0);
      expect(host.calls).toHaveLength(answers.length);
    } finally {
      await chat.app.shutdown();
    }
  });

  test.each([32_000, 200_000, 1_000_000])(
    "a new answer starts a run with its start and keeps it whole, at a %d window",
    async (window) => {
      const { chat, host, automation } = await checkApp(window);
      try {
        const body = JSON.stringify(
          Array.from({ length: 3000 }, (_, i) => ({
            id: i,
            title: `alert ${i}`,
          })),
          null,
          1,
        );
        host.answer(() => json(body, { etag: '"v1"' }));
        makeDue(chat, automation.id);
        const pending = chat.scripted.next();
        const detail = await fireChecked(chat, automation.id);
        const script = await pending;
        const sessionId = detail!.session.id;
        const first = detail!.messages.find((m) => m.kind === "user")!;
        expect(first.content).toStartWith(
          "check the system\n\nThe check URL answered with something new.",
        );
        expect(first.content).toContain('\n```json\n[\n {\n  "id": 0,');
        expect(first.content).toEndWith(
          `whole answer: /mcp/0001-check/answer.json, ${body.split("\n").length.toLocaleString("en-US")} lines, ${Math.round(Buffer.byteLength(body) / 1024)} KB: query it with jq`,
        );
        const start = first.content.length - "check the system".length;
        expect(start).toBeLessThan(window === 32_000 ? 20_000 : 52_000);
        expect(JSON.stringify(script.body.messages)).toContain("0001-check");
        const kept = chat.app.db
          .query<
            { dir: string; name: string; text: string; folder: number },
            [string]
          >(
            "select dir, name, text, folder from mcp_kept_files where session_id = ?",
          )
          .all(sessionId);
        expect(kept).toEqual([
          { dir: "0001-check", name: "answer.json", text: body, folder: 1 },
        ]);
        expect(row(chat, automation.id)).toMatchObject({
          lastEventOutcome: "run",
          lastCheckResult: "200",
          lastRunSessionId: sessionId,
        });
        await endRun(chat, sessionId);
      } finally {
        await chat.app.shutdown();
      }
    },
  );

  test("failures are skipped events with fixed reasons, and never log the URL", async () => {
    const { chat, host, automation, logs } = await checkApp();
    try {
      await setLimits(chat, { mcpKeptBytes: 1024 * 1024 });
      const cases: [() => Response | Promise<Response>, string, string][] = [
        [
          () => new Response("a\0b"),
          "answer is not text",
          "answer is not text",
        ],
        [
          () => new Response("x".repeat(1024 * 1024 + 1)),
          "answer too large",
          "answer too large",
        ],
        [
          () => new Response("down", { status: 503 }),
          "HTTP 503",
          "check failed: HTTP 503",
        ],
        [
          () =>
            new Response(null, { status: 301, headers: { location: "/x" } }),
          "too many redirects",
          "check failed: too many redirects",
        ],
        [
          () => {
            throw new TypeError(`connect to ${URL_} failed`);
          },
          "could not connect",
          "check could not connect",
        ],
      ];
      for (const [reply, result, reason] of cases) {
        host.answer(reply);
        makeDue(chat, automation.id);
        expect(await fireChecked(chat, automation.id)).toBeNull();
        expect(row(chat, automation.id)).toMatchObject({
          lastEventOutcome: "skipped",
          lastEventReason: reason,
          lastCheckResult: result,
        });
      }
      expect(chat.scripted.scripts).toHaveLength(0);
      expect(checkLogs(logs).map((event) => event.fields.result)).toEqual(
        cases.map(([, result]) => result),
      );
      expect(JSON.stringify(logs.events)).not.toContain("check.test");
      expect(JSON.stringify(logs.events)).not.toContain("query-secret");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a GET past its timeout is a skipped event", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      host.answer(
        (_call, signal) =>
          new Promise((_, reject) =>
            signal!.addEventListener("abort", () => reject(signal!.reason)),
          ),
      );
      makeDue(chat, automation.id);
      const slept = chat.app.slept((at) => at === chat.app.now.value + 10_000);
      await chat.app.automationScheduler.fire(automation.id);
      chat.app.now.value = await slept;
      await chat.app.automationScheduler.checked();
      await chat.app.automationScheduler.fire(automation.id);
      expect(row(chat, automation.id)).toMatchObject({
        lastEventReason: "check timed out",
        lastCheckResult: "timed out",
      });
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a check in flight", () => {
  // a GET held until the test lets it answer
  const held = (host: CheckHost) => {
    const gate: { release: (r: Response) => void } = { release: () => {} };
    host.answer(
      () => new Promise<Response>((resolve) => (gate.release = resolve)),
    );
    return gate;
  };

  test.serial(
    "holds its row: the loop sleeps and the answer wakes it",
    async () => {
      const { chat, host, automation } = await checkApp();
      try {
        const gate = held(host);
        makeDue(chat, automation.id);
        // each sleep of the loop reads the earliest fire once
        const sleeps = { count: 0 };
        const store = chat.app.automations;
        const earliest = store.earliest.bind(store);
        store.earliest = (after) => {
          sleeps.count++;
          return earliest(after);
        };
        const slept = chat.app.slept(
          (at) => at === chat.app.now.value + 60_000,
        );
        chat.app.automationScheduler.start();
        // the loop sleeps a pass interval rather than spinning on the row
        expect(await slept).toBe(chat.app.now.value + 60_000);
        expect(sleeps.count).toBe(1);
        expect(host.calls).toHaveLength(1);
        const pending = chat.scripted.next();
        gate.release(json({ alerts: [1] }));
        const script = await pending;
        expect(host.calls).toHaveLength(1);
        // the wake ended that sleep: one pass fired the row
        expect(sleeps.count).toBeLessThanOrEqual(2);
        chat.app.automationScheduler.stop();
        script.reply("done");
        await sessionSettled(
          chat.app,
          row(chat, automation.id).lastRunSessionId!,
        );
      } finally {
        await chat.app.shutdown();
      }
    },
  );

  test("a row edited during the GET fires as the new row says", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      const gate = held(host);
      makeDue(chat, automation.id);
      await chat.app.automationScheduler.fire(automation.id);
      const patched = await chat.member.call(
        "PATCH",
        `/api/automations/${automation.id}`,
        {
          body: {
            editRevision: row(chat, automation.id).editRevision,
            instructions: "the new words",
          },
        },
      );
      expect(patched.status).toBe(200);
      gate.release(json({ alerts: [1] }));
      await chat.app.automationScheduler.checked();
      // dropped: nothing ran, nothing saved, the row still due
      expect(await chat.app.automationScheduler.fire(automation.id)).toBeNull();
      expect(chat.scripted.scripts).toHaveLength(0);
      expect(row(chat, automation.id).lastCheckedAt).toBeNull();
      host.answer(() => json({ alerts: [1] }));
      const pending = chat.scripted.next();
      await chat.app.automationScheduler.checked();
      const detail = await fireChecked(chat, automation.id);
      await pending;
      expect(host.calls).toHaveLength(2);
      expect(
        detail!.messages.find((m) => m.kind === "user")!.content,
      ).toStartWith("the new words\n");
      await endRun(chat, detail!.session.id);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a row suspended during the GET fires nothing", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      const gate = held(host);
      makeDue(chat, automation.id);
      await chat.app.automationScheduler.fire(automation.id);
      await chat.member.call(
        "POST",
        `/api/automations/${automation.id}/suspend`,
      );
      gate.release(new Response("down", { status: 503 }));
      await chat.app.automationScheduler.checked();
      await chat.app.automationScheduler.fire(automation.id);
      expect(row(chat, automation.id)).toMatchObject({
        lastEventOutcome: null,
        lastCheckedAt: null,
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a full cap starts nothing and saves nothing, and the next try asks again", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      const start = chat.app.runner.startRun;
      chat.app.runner.startRun = () => {
        throw new RunCapacity("process", "full");
      };
      host.answer(() => json({ alerts: [1] }, { etag: '"v1"' }));
      makeDue(chat, automation.id);
      expect(await fireChecked(chat, automation.id)).toBeNull();
      expect(row(chat, automation.id)).toMatchObject({
        lastEventOutcome: null,
        lastCheckedAt: null,
      });
      chat.app.runner.startRun = start;
      const pending = chat.scripted.next();
      const detail = await fireChecked(chat, automation.id);
      await pending;
      expect(host.calls).toHaveLength(2);
      await endRun(chat, detail!.session.id);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a drain aborts it and defers its row", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      const signals: AbortSignal[] = [];
      host.answer((_call, signal) => {
        signals.push(signal!);
        return new Promise(() => {});
      });
      makeDue(chat, automation.id);
      await chat.app.automationScheduler.fire(automation.id);
      chat.app.automationScheduler.drain();
      expect(signals[0]!.aborted).toBe(true);
      await chat.app.automationScheduler.pass();
      expect(row(chat, automation.id)).toMatchObject({
        lastEventOutcome: "deferred",
        lastEventReason: "restarting",
        lastCheckedAt: null,
      });
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("what a check saw", () => {
  test("goes out on the next check once the run ends, and clears on a new URL", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      const body = JSON.stringify({ alerts: [1] });
      host.answer(() =>
        json(body, {
          etag: '"v1"',
          "last-modified": "Mon, 26 Oct 2026 06:00:00 GMT",
        }),
      );
      makeDue(chat, automation.id);
      const pending = chat.scripted.next();
      const detail = await fireChecked(chat, automation.id);
      await pending;
      // the run going: nothing saved yet
      const saved = () =>
        chat.app.db
          .query<
            { check_etag: string | null; check_body_hash: string | null },
            [string]
          >("select check_etag, check_body_hash from automations where id = ?")
          .get(automation.id)!;
      expect(saved().check_etag).toBeNull();
      await endRun(chat, detail!.session.id);
      expect(saved().check_etag).toBe('"v1"');

      host.answer(() => json(body));
      makeDue(chat, automation.id);
      await fireChecked(chat, automation.id);
      expect(host.calls.at(-1)!.headers).toMatchObject({
        "if-none-match": '"v1"',
        "if-modified-since": "Mon, 26 Oct 2026 06:00:00 GMT",
      });
      // the same body by its hash
      expect(row(chat, automation.id).lastCheckResult).toBe("unchanged");

      const answeredAt = row(chat, automation.id).lastAnsweredAt;
      chat.app.now.value += 60_000;
      const patched = await chat.member.call(
        "PATCH",
        `/api/automations/${automation.id}`,
        {
          body: {
            editRevision: row(chat, automation.id).editRevision,
            checkUrl: `${CHECK_URL}/other`,
          },
        },
      );
      expect(patched.status).toBe(200);
      expect(saved()).toEqual({ check_etag: null, check_body_hash: null });
      expect(row(chat, automation.id)).toMatchObject({
        checkUrl: `${CHECK_URL}/other`,
        lastCheckedAt: null,
        lastCheckResult: null,
        lastAnsweredAt: chat.app.now.value,
      });
      expect(answeredAt).toBeLessThan(chat.app.now.value);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a run cut by a shutdown saves nothing, and its restart rerun asks again", async () => {
    const host = checkHost();
    const chat = await chatApp({ fetcher: host.fetcher });
    chat.app.automationScheduler.stop();
    const automation = await createAutomation(chat, {
      checkUrl: URL_,
      rerunOnRestart: true,
    });
    host.answer(() => json({ alerts: [1] }, { etag: '"v1"' }));
    makeDue(chat, automation.id);
    const pending = chat.scripted.next();
    await fireChecked(chat, automation.id);
    await pending;
    await chat.app.shutdown();
    expect(
      chat.app.db
        .query<{ check_etag: string | null }, [string]>(
          "select check_etag from automations where id = ?",
        )
        .get(automation.id)!.check_etag,
    ).toBeNull();
    const next = await testApp({
      db: chat.app.db,
      fetcher: chat.scripted.fetcher,
      activate: true,
    });
    try {
      await waitScript(chat.scripted, 2);
      expect(host.calls).toHaveLength(2);
      expect(host.calls[1]!.headers["if-none-match"]).toBeUndefined();
      expect(next.automations.byId(automation.id)!.lastEventSource).toBe(
        "restart",
      );
      const sessionId = next.automations.byId(automation.id)!.lastRunSessionId!;
      chat.scripted.scripts.at(-1)!.reply("done");
      await sessionSettled(next, sessionId);
    } finally {
      await next.shutdown();
    }
  });
  test("a restart rerun's failed check is recorded", async () => {
    const host = checkHost();
    const chat = await chatApp({ fetcher: host.fetcher });
    chat.app.automationScheduler.stop();
    const automation = await createAutomation(chat, {
      checkUrl: URL_,
      rerunOnRestart: true,
    });
    host.answer(() => json({ alerts: [1] }));
    makeDue(chat, automation.id);
    const pending = chat.scripted.next();
    await fireChecked(chat, automation.id);
    await pending;
    await chat.app.shutdown();
    host.answer(() => new Response("down", { status: 503 }));
    const next = await testApp({
      db: chat.app.db,
      fetcher: chat.scripted.fetcher,
      activate: true,
    });
    try {
      await until(
        () =>
          next.automations.byId(automation.id)?.lastCheckResult === "HTTP 503",
      );
      expect(next.automations.byId(automation.id)).toMatchObject({
        lastEventSource: "restart",
        lastEventOutcome: "skipped",
        lastEventReason: "check failed: HTTP 503",
      });
      expect(chat.scripted.scripts).toHaveLength(1);
    } finally {
      await next.shutdown();
    }
  });
});

describe("the reach of a check", () => {
  test("an MCP server's origin signs with its key, the web row off", async () => {
    const host = checkHost();
    const chat = await chatApp({
      fetcher: host.fetcher,
      secrets: { "mcp-markets": "mcp-secret-value" },
    });
    chat.app.automationScheduler.stop();
    try {
      const server = chat.app.mcp.create(
        {
          name: "markets",
          url: `${CHECK_URL}/mcp`,
          keyName: "mcp-markets",
          read: true,
          write: false,
          instructionsOn: false,
          timeoutMs: null,
          readPatterns: [],
          writePatterns: [],
          excludedPatterns: [],
        },
        {
          serverName: "markets",
          serverVersion: "1",
          protocolEra: "modern",
          protocolVersion: "2026-07-28",
          instructions: "",
          fingerprint: "markets",
          checkedAt: 1,
          tools: [],
        },
      );
      chat.app.mcp.setAgentServers(chat.agentId, [
        { serverId: server.id, read: true, write: false },
      ]);
      expect(
        (
          await chat.admin.call("PATCH", "/api/tools/web", {
            body: { mode: "off" },
          })
        ).status,
      ).toBe(200);
      const automation = await createAutomation(chat, { checkUrl: URL_ });
      host.answer(() => new Response(null, { status: 204 }));
      makeDue(chat, automation.id);
      await fireChecked(chat, automation.id);
      expect(host.calls[0]!.headers.authorization).toBe(
        "Bearer mcp-secret-value",
      );
      expect(row(chat, automation.id).lastCheckResult).toBe("204");

      // without the server the web row decides
      chat.app.mcp.setAgentServers(chat.agentId, []);
      makeDue(chat, automation.id);
      await fireChecked(chat, automation.id);
      expect(host.calls).toHaveLength(1);
      expect(row(chat, automation.id).lastEventReason).toBe(
        "check failed: web access is off",
      );
      expect(JSON.stringify(row(chat, automation.id))).not.toContain(
        "mcp-secret-value",
      );
    } finally {
      await chat.app.shutdown();
    }
  });

  test("follows a 301 then a 302 and the last answer decides", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      host.answer((call) =>
        call.url === URL_
          ? new Response(null, { status: 301, headers: { location: "/v2" } })
          : call.url === `${CHECK_URL}/v2`
            ? new Response(null, {
                status: 302,
                headers: { location: `${CHECK_URL}/v3` },
              })
            : new Response(null, { status: 204 }),
      );
      await chat.admin.call("PATCH", "/api/tools/web", {
        body: { mode: "listed", domains: ["check.test"] },
      });
      makeDue(chat, automation.id);
      await fireChecked(chat, automation.id);
      expect(host.calls.map((call) => call.url)).toEqual([
        URL_,
        `${CHECK_URL}/v2`,
        `${CHECK_URL}/v3`,
      ]);
      expect(row(chat, automation.id).lastCheckResult).toBe("204");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a listed host, a custom port and the task's web switch", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      host.answer(() => new Response(null, { status: 204 }));
      await chat.admin.call("PATCH", "/api/tools/web", {
        body: { mode: "listed", domains: ["check.test"] },
      });
      makeDue(chat, automation.id);
      await fireChecked(chat, automation.id);
      expect(row(chat, automation.id).lastCheckResult).toBe("204");
      const edit = async (body: Record<string, unknown>) => {
        const res = await chat.member.call(
          "PATCH",
          `/api/automations/${automation.id}`,
          {
            body: {
              editRevision: row(chat, automation.id).editRevision,
              ...body,
            },
          },
        );
        expect(res.status).toBe(200);
      };
      await edit({ checkUrl: "https://check.test:8443/alerts" });
      makeDue(chat, automation.id);
      await fireChecked(chat, automation.id);
      expect(row(chat, automation.id).lastEventReason).toBe(
        "check failed: host is not in Web access",
      );
      await edit({ checkUrl: URL_, disabledCapabilities: ["web"] });
      makeDue(chat, automation.id);
      await fireChecked(chat, automation.id);
      expect(row(chat, automation.id).lastEventReason).toBe(
        "check failed: web access is off",
      );
      expect(host.calls).toHaveLength(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a credential under the URL's prefix signs it", async () => {
    const host = checkHost();
    const chat = await chatApp({
      fetcher: host.fetcher,
      secrets: { "http-check": "http-secret-value" },
    });
    chat.app.automationScheduler.stop();
    try {
      const created = await chat.admin.call("POST", "/api/projects", {
        body: { name: "finops", description: "A team project." },
      });
      const { project } = await created.json();
      await chat.admin.call("POST", `/api/projects/${project.id}/members`, {
        body: { userId: chat.memberId },
      });
      const credential = await chat.admin.call("POST", "/api/credentials", {
        body: {
          name: "check",
          keyName: "http-check",
          prefix: `${CHECK_URL}/`,
          header: "X-Api-Key",
          template: "{key}",
          projectIds: [project.id],
        },
      });
      expect(credential.status).toBe(201);
      const response = await chat.member.call(
        "POST",
        `/api/projects/${project.id}/automations`,
        {
          body: {
            name: "watch",
            agentId: chat.agentId,
            instructions: "check",
            schedule: "0 * * * *",
            tz: "UTC",
            deadlineMs: null,
            retentionDays: 30,
            ownMemory: false,
            attentionMode: "off",
            checkUrl: URL_,
          },
        },
      );
      expect(response.status).toBe(201);
      const automation: AutomationSummary = (await response.json()).automation;
      host.answer(() => new Response(null, { status: 304 }));
      makeDue(chat, automation.id);
      await fireChecked(chat, automation.id);
      expect(host.calls[0]!.headers["x-api-key"]).toBe("http-secret-value");
      expect(row(chat, automation.id).lastCheckResult).toBe("304");
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a silent check's alert", () => {
  const fail = async (chat: ChatApp, id: string) => {
    makeDue(chat, id);
    await fireChecked(chat, id);
  };

  test("opens past 30 minutes of silence, emails once and closes on an answer", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      host.answer(() => new Response("down", { status: 503 }));
      // inside the silence: nothing opens
      for (let i = 0; i < 6; i++) {
        chat.app.now.value += 5 * 60_000;
        await fail(chat, automation.id);
        expect(row(chat, automation.id).alert).toBeNull();
      }
      chat.app.now.value += 5 * 60_000;
      await fail(chat, automation.id);
      expect(row(chat, automation.id).alert).toEqual({
        since: chat.app.now.value,
        runs: 0,
        reason: "The check failed: HTTP 503",
        by: null,
        check: true,
      });
      chat.app.now.value += 5 * 60_000;
      await fail(chat, automation.id);
      expect(row(chat, automation.id).alert?.since).toBeLessThan(
        chat.app.now.value,
      );
      host.answer(() => new Response(null, { status: 204 }));
      await fail(chat, automation.id);
      expect(row(chat, automation.id).alert).toBeNull();
    } finally {
      await chat.app.shutdown();
    }
  });

  test("emails the owner once, linking the task's page", async () => {
    const host = checkHost();
    const chat = await chatApp({
      fetcher: host.fetcher,
      secrets: { "email-relay": "secret-pass" },
    });
    chat.app.automationScheduler.stop();
    await chat.app.email.stop();
    try {
      expect(
        (await chat.admin.call("PUT", "/api/admin/smtp", { body: SMTP }))
          .status,
      ).toBe(200);
      expect(
        (
          await chat.member.call("PUT", "/api/profile/email", {
            body: { fromAgents: true },
          })
        ).status,
      ).toBe(200);
      const automation = await createAutomation(chat, { checkUrl: URL_ });
      host.answer(() => new Response("down", { status: 503 }));
      for (let i = 0; i < 3; i++) {
        chat.app.now.value += 40 * 60_000;
        await fail(chat, automation.id);
      }
      const rows = chat.app.db
        .query<
          {
            kind: string;
            session_id: string | null;
            automation_id: string;
            body: string;
          },
          []
        >("select kind, session_id, automation_id, body from email_outbox")
        .all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "alert",
        session_id: null,
        automation_id: automation.id,
      });
      expect(JSON.parse(rows[0]!.body)).toMatchObject({
        open: "Open the automation:",
        path: `/automations/${automation.id}`,
        text: "The check failed: HTTP 503",
      });
      expect(rows[0]!.body).not.toContain("check.test");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a daily task's first failure opens it", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      host.answer(() => new Response("down", { status: 500 }));
      chat.app.now.value += 24 * 3_600_000;
      await fail(chat, automation.id);
      expect(row(chat, automation.id).alert?.check).toBe(true);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an alert a marked run opened stays open after the check answers", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      const at = chat.app.now.value;
      chat.app.db
        .query("update automations set attention_since = ? where id = ?")
        .run(at, automation.id);
      chat.app.db
        .query(
          `insert into sessions (id, project_id, owner_id, agent_id, origin,
             automation_id, title, status, attention, attention_reason,
             created_at, last_activity_at)
           values ('marked1', ?, ?, ?, 'automation', ?, 't', 'done', 1, 'pods down', ?, ?)`,
        )
        .run(
          chat.projectId,
          chat.memberId,
          chat.agentId,
          automation.id,
          at,
          at,
        );
      host.answer(() => new Response("down", { status: 503 }));
      chat.app.now.value += 3_600_000;
      await fail(chat, automation.id);
      expect(row(chat, automation.id).alert).toMatchObject({
        runs: 1,
        reason: "The check failed: HTTP 503",
        check: true,
      });
      host.answer(() => new Response(null, { status: 204 }));
      await fail(chat, automation.id);
      expect(row(chat, automation.id).alert).toMatchObject({
        since: at,
        runs: 1,
        reason: "pods down",
        check: false,
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a dismissed one stays closed until an answer and a new silence", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      host.answer(() => new Response("down", { status: 503 }));
      chat.app.now.value += 3_600_000;
      await fail(chat, automation.id);
      expect(row(chat, automation.id).alert?.check).toBe(true);
      const dismissed = await chat.member.call(
        "POST",
        `/api/automations/${automation.id}/dismiss`,
      );
      expect(dismissed.status).toBe(200);
      chat.app.now.value += 3_600_000;
      await fail(chat, automation.id);
      expect(row(chat, automation.id).alert).toBeNull();
      host.answer(() => new Response(null, { status: 204 }));
      await fail(chat, automation.id);
      host.answer(() => new Response("down", { status: 503 }));
      chat.app.now.value += 10 * 60_000;
      await fail(chat, automation.id);
      expect(row(chat, automation.id).alert).toBeNull();
      chat.app.now.value += 30 * 60_000;
      await fail(chat, automation.id);
      expect(row(chat, automation.id).alert?.check).toBe(true);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a new URL takes the old one's part of the alert with it", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      host.answer(() => new Response("down", { status: 503 }));
      chat.app.now.value += 3_600_000;
      await fail(chat, automation.id);
      expect(row(chat, automation.id).alert?.check).toBe(true);
      const patch = (checkUrl: string | null) =>
        chat.member.call("PATCH", `/api/automations/${automation.id}`, {
          body: {
            editRevision: row(chat, automation.id).editRevision,
            checkUrl,
          },
        });
      expect((await patch(`${CHECK_URL}/other`)).status).toBe(200);
      expect(row(chat, automation.id).alert).toBeNull();

      // with a marked run the run's alert stays, the check's part gone
      chat.app.now.value += 3_600_000;
      await fail(chat, automation.id);
      const at = chat.app.now.value;
      markedRun(chat, automation.id, "marked2", at);
      expect((await patch(null)).status).toBe(200);
      expect(row(chat, automation.id).alert).toMatchObject({
        runs: 1,
        reason: "pods down",
        check: false,
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a dismissed check's mark never claims a run's later alert", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      host.answer(() => new Response("down", { status: 503 }));
      chat.app.now.value += 3_600_000;
      await fail(chat, automation.id);
      await chat.member.call(
        "POST",
        `/api/automations/${automation.id}/dismiss`,
      );
      chat.app.now.value += 60_000;
      const at = chat.app.now.value;
      chat.app.db
        .query("update automations set attention_since = ? where id = ?")
        .run(at, automation.id);
      markedRun(chat, automation.id, "marked3", at);
      expect(row(chat, automation.id).alert).toMatchObject({
        runs: 1,
        reason: "pods down",
        check: false,
      });
      const gone = await chat.member.call("DELETE", "/api/sessions/marked3");
      expect(gone.status).toBe(200);
      expect(row(chat, automation.id).alert).toBeNull();
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a new answer that could not run still ends the silence", async () => {
    const { chat, host, automation } = await checkApp();
    try {
      chat.app.now.value += 3_600_000;
      const start = chat.app.runner.startRun;
      chat.app.runner.startRun = () => {
        throw new RunCapacity("process", "full");
      };
      host.answer(() => json({ alerts: [1] }));
      await fail(chat, automation.id);
      chat.app.runner.startRun = start;
      expect(row(chat, automation.id)).toMatchObject({
        lastAnsweredAt: chat.app.now.value,
        lastCheckedAt: null,
      });
      host.answer(() => new Response("down", { status: 503 }));
      chat.app.now.value += 60_000;
      await fail(chat, automation.id);
      expect(row(chat, automation.id).alert).toBeNull();
    } finally {
      await chat.app.shutdown();
    }
  });
});
