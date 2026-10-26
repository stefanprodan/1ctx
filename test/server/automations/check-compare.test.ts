// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A check's Compare: one JSON value of the answer decides what is new,
// while the run still gets the whole answer.

import { describe, expect, test } from "bun:test";
import { canonical } from "../../../src/shared/check-compare.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import { CHECK_URL, checkHost, collectLogs } from "../../helpers/app.ts";
import { automationBody, createAutomation } from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  sessionSettled,
  waitScript,
} from "../../helpers/chat.ts";

const URL_ = `${CHECK_URL}/releases/latest`;

async function checkApp(checkCompare: string) {
  const host = checkHost();
  const logs = collectLogs();
  const chat = await chatApp({
    fetcher: host.fetcher,
    logFactory: logs.logFactory,
  });
  chat.app.automationScheduler.stop();
  const automation = await createAutomation(chat, {
    checkUrl: URL_,
    checkCompare,
  });
  return { chat, host, logs, automation };
}

const row = (chat: ChatApp, id: string) => chat.app.automations.byId(id)!;

const makeDue = (chat: ChatApp, id: string) =>
  chat.app.db
    .query("update automations set next_at = ? where id = ?")
    .run(chat.app.now.value, id);

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

const sha = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

const release = (tag: string, downloads: number) => ({
  tag_name: tag,
  assets: [{ name: "flux.tar.gz", download_count: downloads }],
});

const kept = (chat: ChatApp, sessionId: string) =>
  chat.app.db
    .query<{ text: string }, [string]>(
      "select text from mcp_kept_files where session_id = ?",
    )
    .all(sessionId)
    .map((file) => file.text);

const saved = (chat: ChatApp, id: string) =>
  chat.app.db
    .query<
      {
        check_etag: string | null;
        check_last_modified: string | null;
        check_body_hash: string | null;
      },
      [string]
    >(
      `select check_etag, check_last_modified, check_body_hash
       from automations where id = ?`,
    )
    .get(id)!;

// a scheduled fire whose new answer starts a run, ended done
async function newAnswer(chat: ChatApp, id: string, nth: number) {
  makeDue(chat, id);
  const detail = await fireChecked(chat, id);
  expect(detail).not.toBeNull();
  const sessionId = detail!.session.id;
  (await waitScript(chat.scripted, nth)).reply("done");
  await sessionSettled(chat.app, sessionId);
  return sessionId;
}

describe("a check's compare", () => {
  test("only a change in its value starts a run, which keeps the whole body", async () => {
    const { chat, host, automation } = await checkApp("tag_name");
    try {
      const first = JSON.stringify(release("v2.1.0", 10));
      host.answer(() => json(first, { etag: '"a"' }));
      const sessionId = await newAnswer(chat, automation.id, 1);
      expect(kept(chat, sessionId)).toEqual([first]);
      expect(saved(chat, automation.id)).toEqual({
        check_etag: '"a"',
        check_last_modified: null,
        check_body_hash: sha(canonical("v2.1.0")),
      });

      // a counter and its ETag moved, the release did not
      host.answer(() => json(release("v2.1.0", 99), { etag: '"b"' }));
      makeDue(chat, automation.id);
      expect(await fireChecked(chat, automation.id)).toBeNull();
      expect(host.calls.at(-1)!.headers["if-none-match"]).toBe('"a"');
      expect(row(chat, automation.id)).toMatchObject({
        lastCheckResult: "unchanged",
        lastEventOutcome: "run",
        lastRunSessionId: sessionId,
      });
      expect(chat.scripted.scripts).toHaveLength(1);

      const next = JSON.stringify(release("v2.2.0", 0));
      host.answer(() => json(next));
      const second = await newAnswer(chat, automation.id, 2);
      expect(kept(chat, second)).toEqual([next]);
      expect(row(chat, automation.id).lastCheckResult).toBe("200");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a reordered object is the same value", async () => {
    const { chat, host, automation } = await checkApp(".data[0]");
    try {
      host.answer(() => json({ data: [{ id: 1, name: "a" }], at: 1 }));
      await newAnswer(chat, automation.id, 1);
      host.answer(() => json('{"at":2,"data":[{"name":"a","id":1}]}'));
      makeDue(chat, automation.id);
      expect(await fireChecked(chat, automation.id)).toBeNull();
      expect(row(chat, automation.id).lastCheckResult).toBe("unchanged");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an empty value is nothing new", async () => {
    const { chat, host, automation } = await checkApp("items");
    try {
      for (const items of [null, [], {}, ""]) {
        host.answer(() => json({ items, total: 0 }));
        makeDue(chat, automation.id);
        expect(await fireChecked(chat, automation.id)).toBeNull();
        expect(row(chat, automation.id)).toMatchObject({
          lastCheckResult: "empty",
          lastEventOutcome: null,
        });
      }
      expect(chat.scripted.scripts).toHaveLength(0);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an answer that is not JSON or lacks the path fails as any check does", async () => {
    const { chat, host, logs, automation } = await checkApp("tag_name");
    try {
      const cases: [() => Response, string][] = [
        [() => new Response("<html>v2</html>"), "answer is not JSON"],
        [() => json({ name: "v2" }), "compare path not found"],
        [() => json([{ tag_name: "v2" }]), "compare path not found"],
      ];
      for (const [reply, result] of cases) {
        host.answer(reply);
        makeDue(chat, automation.id);
        expect(await fireChecked(chat, automation.id)).toBeNull();
        expect(row(chat, automation.id)).toMatchObject({
          lastEventOutcome: "skipped",
          lastEventReason: result,
          lastCheckResult: result,
        });
      }
      expect(chat.scripted.scripts).toHaveLength(0);
      expect(
        logs.events
          .filter((event) => event.msg === "check failed")
          .map((event) => event.fields.result),
      ).toEqual(cases.map(([, result]) => result));
      // silent past the limit, a failure opens the alert
      expect(row(chat, automation.id).alert).toBeNull();
      chat.app.now.value += 3_600_000;
      host.answer(cases[1]![0]);
      makeDue(chat, automation.id);
      await fireChecked(chat, automation.id);
      expect(row(chat, automation.id).alert?.check).toBe(true);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("Run now with a compare", () => {
  async function runNow(chat: ChatApp, id: string) {
    const response = await chat.member.call(
      "POST",
      `/api/automations/${id}/run`,
    );
    expect(response.status).toBe(201);
    const detail = (await response.json()) as SessionDetail;
    return {
      sessionId: detail.session.id,
      first: detail.messages.find((m) => m.kind === "user")!.content,
    };
  }

  test("saves the compared hash, so the next counter change is unchanged", async () => {
    const { chat, host, automation } = await checkApp("tag_name");
    try {
      const body = JSON.stringify(release("v2.1.0", 10));
      host.answer(() => json(body));
      const run = await runNow(chat, automation.id);
      expect(kept(chat, run.sessionId)).toEqual([body]);
      (await waitScript(chat.scripted, 1)).reply("done");
      await sessionSettled(chat.app, run.sessionId);
      expect(saved(chat, automation.id).check_body_hash).toBe(
        sha(canonical("v2.1.0")),
      );
      host.answer(() => json(release("v2.1.0", 11)));
      makeDue(chat, automation.id);
      expect(await fireChecked(chat, automation.id)).toBeNull();
      expect(row(chat, automation.id).lastCheckResult).toBe("unchanged");
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a compare that fails still starts the run with the failure line", async () => {
    const { chat, host, automation } = await checkApp("tag_name");
    try {
      host.answer(() => json({ name: "v2" }));
      const run = await runNow(chat, automation.id);
      expect(run.first).toBe(
        "check the system\n\nThe check URL failed: compare path not found.",
      );
      expect(kept(chat, run.sessionId)).toEqual([]);
      expect(row(chat, automation.id)).toMatchObject({
        lastCheckResult: "compare path not found",
        lastEventSource: "manual",
        lastEventOutcome: "run",
      });
      (await waitScript(chat.scripted, 1)).reply("done");
      await sessionSettled(chat.app, run.sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("saving a compare", () => {
  const patch = (chat: ChatApp, id: string, body: Record<string, unknown>) =>
    chat.member.call("PATCH", `/api/automations/${id}`, {
      body: { editRevision: row(chat, id).editRevision, ...body },
    });

  test("a new compare clears the validators, and only that", async () => {
    const { chat, automation } = await checkApp("tag_name");
    try {
      const seed = () =>
        chat.app.db
          .query(
            `update automations set check_etag = '"a"',
               check_last_modified = 'Mon, 26 Oct 2026 06:00:00 GMT',
               check_body_hash = 'h', last_check_result = 'unchanged'
             where id = ?`,
          )
          .run(automation.id);
      seed();
      expect(
        (await patch(chat, automation.id, { name: "renamed" })).status,
      ).toBe(200);
      expect(saved(chat, automation.id).check_body_hash).toBe("h");
      const res = await patch(chat, automation.id, { checkCompare: "name" });
      expect(res.status).toBe(200);
      expect(saved(chat, automation.id)).toEqual({
        check_etag: null,
        check_last_modified: null,
        check_body_hash: null,
      });
      expect(row(chat, automation.id)).toMatchObject({
        checkCompare: "name",
        checkUrl: URL_,
        lastCheckResult: "unchanged",
      });
      seed();
      expect(
        (await patch(chat, automation.id, { checkCompare: "" })).status,
      ).toBe(200);
      expect(row(chat, automation.id).checkCompare).toBeNull();
      expect(saved(chat, automation.id).check_body_hash).toBeNull();
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a cleared URL clears it, and it is refused without one", async () => {
    const { chat, automation } = await checkApp("tag_name");
    try {
      const refused = await patch(chat, automation.id, {
        checkUrl: null,
        checkCompare: "tag_name",
      });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toBe("Compare needs a Check URL");
      expect((await patch(chat, automation.id, { checkUrl: "" })).status).toBe(
        200,
      );
      expect(row(chat, automation.id)).toMatchObject({
        checkUrl: null,
        checkCompare: null,
      });
      const alone = await patch(chat, automation.id, { checkCompare: "a" });
      expect(alone.status).toBe(400);
      const created = await chat.member.call(
        "POST",
        `/api/projects/${chat.projectId}/automations`,
        {
          body: {
            ...automationBody(chat, { name: "other" }),
            checkCompare: "a",
          },
        },
      );
      expect(created.status).toBe(400);
      expect((await created.json()).error).toBe("Compare needs a Check URL");
    } finally {
      await chat.app.shutdown();
    }
  });
});
