// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { type Event, Registry } from "../../../src/server/runner/index.ts";
import { automationBody, createAutomation } from "../../helpers/automations.ts";
import { chatApp, startChat, tick } from "../../helpers/chat.ts";

async function settle(
  chat: Awaited<ReturnType<typeof chatApp>>,
  sessionId: string,
) {
  for (let i = 0; i < 100; i++) {
    if (chat.app.sessions.byId(sessionId)?.status !== "running") return;
    await tick();
  }
  throw new Error("run did not settle");
}

describe("automation scheduler", () => {
  test.each(["schedule", "manual"] as const)(
    "%s runs snapshot guidance before later edits",
    async (source) => {
      const chat = await chatApp();
      chat.app.automationScheduler.stop();
      const events: Event[] = [];
      const start = chat.app.runner.startRun;
      chat.app.runner.startRun = (event) => {
        events.push(event);
        return start(event);
      };
      try {
        const automation = await createAutomation(chat, {
          ownMemory: true,
          memoryGuidance: "Sources: remember failed hosts",
        });
        const launch = async () => {
          const pending = chat.scripted.next();
          if (source === "schedule") {
            chat.app.db
              .query("update automations set next_at = ? where id = ?")
              .run(chat.app.now.value, automation.id);
            const detail = await chat.app.automationScheduler.fire(
              automation.id,
            );
            return { detail: detail!, script: await pending };
          }
          const response = await chat.member.call(
            "POST",
            `/api/automations/${automation.id}/run`,
          );
          expect(response.status).toBe(201);
          return { detail: await response.json(), script: await pending };
        };
        const first = await launch();
        const send = chat.app.runner.registry.get(first.detail.session.id)!;
        const policy = send.policy;
        expect(policy.automation).toMatchObject({
          source,
          ownMemory: true,
          memoryGuidance: automation.memoryGuidance,
        });
        expect(events[0]?.automation.memoryGuidance).toBe(
          automation.memoryGuidance,
        );
        expect(JSON.stringify(first.script.body.messages)).not.toContain(
          automation.memoryGuidance,
        );
        const changed = await chat.member.call(
          "PATCH",
          `/api/automations/${automation.id}`,
          { body: { memoryGuidance: "Snapshot: remember the latest result" } },
        );
        expect(changed.status).toBe(200);
        expect(policy.automation?.memoryGuidance).toBe(
          automation.memoryGuidance,
        );
        expect(events[0]?.automation.memoryGuidance).toBe(
          automation.memoryGuidance,
        );
        await chat.member.call(
          "POST",
          `/api/sessions/${first.detail.session.id}/stop`,
        );
        await send.drained;
        const second = await launch();
        expect(
          chat.app.runner.registry.get(second.detail.session.id)?.policy
            .automation?.memoryGuidance,
        ).toBe("Snapshot: remember the latest result");
        expect(events[1]?.automation.memoryGuidance).toBe(
          "Snapshot: remember the latest result",
        );
      } finally {
        chat.app.runner.startRun = start;
        await chat.app.shutdown();
      }
    },
  );

  test("fires a due row once and skips a second fire while it runs", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    const automation = await createAutomation(chat);
    chat.app.db
      .query("update automations set next_at = ? where id = ?")
      .run(chat.app.now.value, automation.id);
    const pending = chat.scripted.next();
    await chat.app.automationScheduler.pass();
    const script = await pending;
    expect(chat.scripted.scripts).toHaveLength(1);
    const first = chat.app.automations.byId(automation.id)!;
    expect(first.lastEventOutcome).toBe("run");
    expect(first.lastEventDueAt).toBe(chat.app.now.value);
    expect(first.nextAt).toBeGreaterThan(chat.app.now.value);

    chat.app.db
      .query("update automations set next_at = ? where id = ?")
      .run(chat.app.now.value, automation.id);
    await chat.app.automationScheduler.pass();
    const skipped = chat.app.automations.byId(automation.id)!;
    expect(skipped.lastEventOutcome).toBe("skipped");
    expect(skipped.lastEventReason).toBe("still running");
    expect(skipped.lastRunSessionId).toBe(first.lastRunSessionId);
    expect(chat.scripted.scripts).toHaveLength(1);

    script.reply("done");
    await settle(chat, first.lastRunSessionId!);
    expect(chat.app.automations.byId(automation.id)?.lastRunStatus).toBe(
      "done",
    );
    await chat.app.shutdown();
  });

  test("does not fire suspended rows and skips a disabled owner", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    const suspended = await createAutomation(chat, { name: "suspended" });
    await chat.member.call("POST", `/api/automations/${suspended.id}/suspend`);
    chat.app.now.value += 86_400_000;
    await chat.app.automationScheduler.pass();
    expect(chat.scripted.scripts).toHaveLength(0);

    const disabled = await createAutomation(chat, { name: "disabled-owner" });
    chat.app.users.setDisabled(chat.memberId, true);
    chat.app.db
      .query("update automations set next_at = ? where id = ?")
      .run(chat.app.now.value, disabled.id);
    await chat.app.automationScheduler.pass();
    expect(chat.app.automations.byId(disabled.id)).toMatchObject({
      lastEventOutcome: "skipped",
      lastEventReason: "owner unavailable",
      lastRunSessionId: null,
    });
    expect(chat.scripted.scripts).toHaveLength(0);
    await chat.app.shutdown();
  });

  test("the loop waits for next_at and not one millisecond before", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    await tick();
    const automation = await createAutomation(chat);
    const dueAt = chat.app.now.value + 100;
    chat.app.db
      .query("update automations set next_at = ? where id = ?")
      .run(dueAt, automation.id);

    chat.app.automationScheduler.start();
    await tick();
    chat.app.now.value = dueAt - 1;
    await tick();
    expect(chat.scripted.scripts).toHaveLength(0);

    chat.app.now.value = dueAt;
    await tick();
    expect(chat.scripted.scripts).toHaveLength(1);
    expect(chat.app.automations.byId(automation.id)?.lastEventDueAt).toBe(
      dueAt,
    );
    chat.app.automationScheduler.stop();
    await chat.app.shutdown();
  });

  test("stops before another due row starts", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    await tick();
    const first = await createAutomation(chat, { name: "first-due" });
    const second = await createAutomation(chat, { name: "second-due" });
    chat.app.db
      .query("update automations set next_at = ? where id in (?, ?)")
      .run(chat.app.now.value, first.id, second.id);

    chat.app.automationScheduler.start();
    chat.app.automationScheduler.stop();
    await tick();

    expect(chat.scripted.scripts).toHaveLength(1);
    const outcomes = [first, second].map(
      (row) => chat.app.automations.byId(row.id)?.lastEventOutcome,
    );
    expect(outcomes.filter((outcome) => outcome === "run")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(1);
    await chat.app.shutdown();
  });

  test("re-reads rows edited or deleted after the pass snapshot", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    const rows = [
      await createAutomation(chat, { name: "snapshot-one" }),
      await createAutomation(chat, { name: "snapshot-two" }),
      await createAutomation(chat, { name: "snapshot-three" }),
    ];
    chat.app.db
      .query("update automations set next_at = ?")
      .run(chat.app.now.value);
    const due = chat.app.automations.due(chat.app.now.value);
    const edited = due[1]!;
    const deleted = due[2]!;

    const passing = chat.app.automationScheduler.pass();
    chat.app.db
      .query("update automations set instructions = ? where id = ?")
      .run("instructions changed after the snapshot", edited.id);
    chat.app.automations.delete(deleted.id);
    await passing;
    await tick();

    expect(chat.scripted.scripts).toHaveLength(2);
    const instructions = chat.scripted.scripts.map(
      (script) =>
        (script.body.messages as { content: string }[]).at(-1)?.content,
    );
    expect(instructions).toContain("instructions changed after the snapshot");
    expect(
      chat.app.sessions
        .list([chat.projectId], "")
        .some((row) => row.session.automationId === deleted.id),
    ).toBe(false);
    expect(rows).toHaveLength(3);
    await chat.app.shutdown();
  });

  test("records an unexpected fire failure and moves on", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    const automation = await createAutomation(chat);
    chat.app.db
      .query("update automations set next_at = ? where id = ?")
      .run(chat.app.now.value, automation.id);
    const original = chat.app.runner.startRun;
    chat.app.runner.startRun = () => {
      throw new Error("unexpected start failure");
    };

    await chat.app.automationScheduler.fire(automation.id);
    chat.app.runner.startRun = original;

    expect(chat.app.automations.byId(automation.id)).toMatchObject({
      lastEventOutcome: "skipped",
      lastEventReason: "unexpected start failure",
      lastRunSessionId: null,
    });
    expect(chat.app.automations.byId(automation.id)?.nextAt).toBeGreaterThan(
      chat.app.now.value,
    );
    await chat.app.shutdown();
  });

  test("skips a scheduled run after its owner loses project access", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    chat.app.db
      .query(
        "insert into projects (id, kind, name, owner_id, created_at) values ('scheduled-team', 'team', 'scheduled-team', ?, ?)",
      )
      .run(chat.adminId, chat.app.now.value);
    chat.app.db
      .query(
        "insert into memberships (project_id, user_id, created_at) values ('scheduled-team', ?, ?)",
      )
      .run(chat.memberId, chat.app.now.value);
    const response = await chat.member.call(
      "POST",
      "/api/projects/scheduled-team/automations",
      { body: automationBody(chat, { name: "lost-access" }) },
    );
    const automation = (await response.json()).automation;
    chat.app.db
      .query("delete from memberships where project_id = ? and user_id = ?")
      .run("scheduled-team", chat.memberId);
    chat.app.db
      .query("update automations set next_at = ? where id = ?")
      .run(chat.app.now.value, automation.id);

    await chat.app.automationScheduler.pass();

    expect(chat.app.automations.byId(automation.id)).toMatchObject({
      lastEventOutcome: "skipped",
      lastEventReason: "owner cannot see project",
      lastRunSessionId: null,
    });
    expect(chat.scripted.scripts).toHaveLength(0);
    await chat.app.shutdown();
  });

  test("records a cap refusal without starting a run", async () => {
    const chat = await chatApp({
      registry: new Registry({ running: 4, perUser: 1 }),
    });
    chat.app.automationScheduler.stop();
    const active = await startChat(chat, "hold the user cap");
    const automation = await createAutomation(chat);
    chat.app.db
      .query("update automations set next_at = ? where id = ?")
      .run(chat.app.now.value, automation.id);

    await chat.app.automationScheduler.pass();

    expect(chat.app.automations.byId(automation.id)).toMatchObject({
      lastEventOutcome: "skipped",
      lastEventReason: "1 of your chats are running; wait for one",
      lastRunSessionId: null,
      lastRunStatus: null,
    });
    expect(chat.scripted.scripts).toHaveLength(1);
    active.script.reply("done");
    await settle(chat, active.sessionId);
    await chat.app.shutdown();
  });

  test("reconciles an ended run and sweeps expired run usage", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    const automation = await createAutomation(chat, { retentionDays: 1 });
    const pending = chat.scripted.next();
    const response = await chat.member.call(
      "POST",
      `/api/automations/${automation.id}/run`,
    );
    const detail = await response.json();
    const script = await pending;
    script.reply("done");
    await settle(chat, detail.session.id);
    chat.app.db
      .query("update automations set last_run_status = 'running' where id = ?")
      .run(automation.id);
    expect(chat.app.automationScheduler.reconcile()).toBe(1);
    expect(chat.app.automations.byId(automation.id)?.lastRunStatus).toBe(
      "done",
    );

    chat.app.db
      .query("update sessions set last_activity_at = ? where id = ?")
      .run(chat.app.now.value - 86_400_001, detail.session.id);
    expect(chat.app.db.query("select count(*) as n from usage").get()).toEqual({
      n: 1,
    });
    expect(chat.app.automationScheduler.sweep()).toBe(1);
    expect(chat.app.sessions.byId(detail.session.id)).toBeNull();
    expect(chat.app.db.query("select count(*) as n from usage").get()).toEqual({
      n: 0,
    });
    await chat.app.shutdown();
  });
});
