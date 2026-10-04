// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One open alert per automation: a flagged run's end opens it once, the
// runs after join it, a clean finish or a dismiss closes it, and a stop
// leaves it. A decider's word on a run decides only while no newer run
// ended. The summary counts the alert's runs, the feed's Needs attention
// pick lists the open ones newest first, and the Runs list filters the
// marked runs.

import { describe, expect, test } from "bun:test";
import { alerts } from "../../../src/server/automations/alerts.ts";
import { type BusEvent, subscribe } from "../../../src/server/lib/bus.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { ATTENTION_STEP_MS } from "../../../src/server/runner/attention-step.ts";
import {
  alertColumns,
  endedAfter,
  MARKED,
} from "../../../src/server/sessions/alerts.ts";
import { markAttention } from "../../../src/server/sessions/attention.ts";
import { listAlerts } from "../../../src/server/sessions/list.ts";
import type { AutomationSummary } from "../../../src/shared/contracts/automation.ts";
import {
  answerRun,
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  waitScript,
} from "../../helpers/chat.ts";

const flag = (reason: string) => (script: Script) => {
  script.toolRound([
    {
      id: "c1",
      name: "needs_attention",
      arguments: JSON.stringify({ reason }),
    },
  ]);
  script.end();
};

const since = (chat: ChatApp, id: string) =>
  chat.app.db
    .query<{ attention_since: number | null }, [string]>(
      "select attention_since from automations where id = ?",
    )
    .get(id)!.attention_since;

const endOf = (chat: ChatApp, sessionId: string) =>
  chat.app.sessions.byId(sessionId)!.lastActivityAt;

async function summary(chat: ChatApp, id: string): Promise<AutomationSummary> {
  const response = await chat.member.call("GET", `/api/automations/${id}`);
  return (await response.json()).automation;
}

async function failedRun(chat: ChatApp, automationId: string) {
  chat.app.now.value += 60_000;
  const run = await startRun(chat, automationId);
  run.main.content("half");
  run.main.end();
  expect((await settleRun(chat, run.sessionId))?.status).toBe("failed");
  return run.sessionId;
}

async function cleanRun(chat: ChatApp, automationId: string, step = 60_000) {
  chat.app.now.value += step;
  const run = await startRun(chat, automationId);
  await answerRun(chat, run.main, "All good.");
  expect((await settleRun(chat, run.sessionId))?.status).toBe("done");
  return run.sessionId;
}

async function markedRun(chat: ChatApp, automationId: string, reason: string) {
  chat.app.now.value += 60_000;
  const run = await startRun(chat, automationId);
  await answerRun(chat, run.main, "Pods are down.", flag(reason));
  expect((await settleRun(chat, run.sessionId))?.status).toBe("done");
  return run.sessionId;
}

async function stoppedRun(chat: ChatApp, automationId: string) {
  chat.app.now.value += 60_000;
  const run = await startRun(chat, automationId);
  const stop = await chat.member.call(
    "POST",
    `/api/sessions/${run.sessionId}/stop`,
  );
  expect(stop.status).toBe(200);
  expect((await settleRun(chat, run.sessionId))?.status).toBe("stopped");
  return run.sessionId;
}

const dismiss = (chat: ChatApp, id: string) =>
  chat.member.call("POST", `/api/automations/${id}/dismiss`);

describe("an automation's open alert", () => {
  test.serial(
    "opens once, joins, closes, holds on a stop and reopens",
    async () => {
      const chat = await chatApp();
      chat.app.automationScheduler.stop();
      const opened: BusEvent[] = [];
      const unsubscribe = subscribe((event) => {
        if (event.type === "automation.attention") opened.push(event);
      }, silent);
      try {
        const automation = await createAutomation(chat, {
          attentionMode: "agent",
        });
        const id = automation.id;
        expect(automation.alert).toBeNull();

        const first = await failedRun(chat, id);
        expect(since(chat, id)).toBe(endOf(chat, first));
        expect(opened).toEqual([
          {
            type: "automation.attention",
            data: {
              projectId: chat.projectId,
              automationId: id,
              sessionId: first,
              since: endOf(chat, first),
            },
          },
        ]);

        const second = await markedRun(chat, id, "podinfo is not ready");
        expect(since(chat, id)).toBe(endOf(chat, first));
        expect(opened).toHaveLength(1);
        expect((await summary(chat, id)).alert).toEqual({
          since: endOf(chat, first),
          runs: 2,
          reason: "podinfo is not ready",
          by: "coder",
        });
        expect(endOf(chat, second)).toBeGreaterThan(endOf(chat, first));

        await stoppedRun(chat, id);
        expect(since(chat, id)).toBe(endOf(chat, first));

        await cleanRun(chat, id);
        expect(since(chat, id)).toBeNull();
        expect((await summary(chat, id)).alert).toBeNull();

        // a stop leaves a closed alert closed too
        await stoppedRun(chat, id);
        expect(since(chat, id)).toBeNull();

        const third = await failedRun(chat, id);
        expect(since(chat, id)).toBe(endOf(chat, third));
        expect(opened).toHaveLength(2);

        const closed = await dismiss(chat, id);
        expect(closed.status).toBe(200);
        const after = (await closed.json()).automation as AutomationSummary;
        expect(after.alert).toBeNull();
        expect(since(chat, id)).toBeNull();

        // nothing open: the automation as it is, its revision kept
        const again = await dismiss(chat, id);
        expect(again.status).toBe(200);
        expect((await again.json()).automation.revision).toBe(after.revision);

        const fourth = await markedRun(chat, id, "flux is behind");
        expect(since(chat, id)).toBe(endOf(chat, fourth));
        expect(opened).toHaveLength(3);
        expect((await summary(chat, id)).alert).toEqual({
          since: endOf(chat, fourth),
          runs: 1,
          reason: "flux is behind",
          by: "coder",
        });
      } finally {
        unsubscribe();
        await chat.app.shutdown();
      }
    },
  );

  test("an automation set to off opens nothing on a failure", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    try {
      const automation = await createAutomation(chat, { attentionMode: "off" });
      await failedRun(chat, automation.id);
      expect(since(chat, automation.id)).toBeNull();
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("the open alert's reason", () => {
  test("is the latest any run gave, past a newer decider's mark", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    try {
      const automation = await createAutomation(chat, {
        attentionMode: "agent",
      });
      await markedRun(chat, automation.id, "podinfo is not ready");
      const later = await markedRun(chat, automation.id, "flux is behind");
      // a decider's mark has no reason
      chat.app.db
        .query(
          "update sessions set attention_reason = null, attention_source = 'decider', attention_by = 'judge' where id = ?",
        )
        .run(later);
      expect((await summary(chat, automation.id)).alert).toEqual({
        since: expect.any(Number),
        runs: 2,
        reason: "podinfo is not ready",
        by: "judge",
      });
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a Stop after a run's answer", () => {
  const stop = async (chat: ChatApp, sessionId: string) => {
    const stopped = await chat.member.call(
      "POST",
      `/api/sessions/${sessionId}/stop`,
    );
    expect(stopped.status).toBe(200);
    const session = await settleRun(chat, sessionId);
    expect(chat.app.sessions.lastSend(sessionId)?.cause).toBe("finish");
    return session;
  };

  test("during the attention step leaves the open alert and marks nothing", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    try {
      const automation = await createAutomation(chat, {
        attentionMode: "agent",
      });
      const id = automation.id;
      const first = await failedRun(chat, id);
      chat.app.now.value += 60_000;
      const run = await startRun(chat, id);
      const step = await answerRun(chat, run.main, "All good.", () => {});
      expect((await stop(chat, run.sessionId))?.attention).toBeNull();
      expect(step.aborted).toBeTrue();
      expect(since(chat, id)).toBe(endOf(chat, first));
      expect((await summary(chat, id)).alert?.runs).toBe(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("during the memory phase keeps the step's mark, which opens the alert", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    try {
      const automation = await createAutomation(chat, {
        attentionMode: "agent",
        ownMemory: true,
      });
      const id = automation.id;
      const run = await startRun(chat, id);
      await answerRun(chat, run.main, "Pods are down.", flag("not ready"));
      const phase = await waitScript(chat.scripted, 3);
      const session = await stop(chat, run.sessionId);
      expect(phase.aborted).toBeTrue();
      expect(session).toMatchObject({
        attention: 1,
        attentionReason: "not ready",
        attentionSource: "agent",
      });
      expect(since(chat, id)).toBe(endOf(chat, run.sessionId));
    } finally {
      await chat.app.shutdown();
    }
  });

  test("the step's own window running out is a clean finish that closes it", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    try {
      const automation = await createAutomation(chat, {
        attentionMode: "agent",
      });
      const id = automation.id;
      await failedRun(chat, id);
      expect(since(chat, id)).not.toBeNull();
      chat.app.now.value += 60_000;
      const run = await startRun(chat, id);
      await answerRun(chat, run.main, "All good.", () => {});
      chat.app.now.value += ATTENTION_STEP_MS;
      expect((await settleRun(chat, run.sessionId))?.status).toBe("done");
      expect(since(chat, id)).toBeNull();
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a decider's word", () => {
  test.serial(
    "opens, closes or changes nothing once a newer run ended",
    async () => {
      const chat = await chatApp();
      chat.app.automationScheduler.stop();
      const opened: BusEvent[] = [];
      const unsubscribe = subscribe((event) => {
        if (event.type === "automation.attention") opened.push(event);
      }, silent);
      try {
        const automation = await createAutomation(chat, {
          attentionMode: "agent",
        });
        const id = automation.id;
        const word = alerts({
          db: chat.app.db,
          store: chat.app.automations,
          sessions: chat.app.sessions,
          markAttention: (sessionId, attention, by) =>
            markAttention(
              chat.app.db,
              chat.app.sessions,
              sessionId,
              attention,
              by,
            ),
        });

        const older = await cleanRun(chat, id);
        const newer = await cleanRun(chat, id);
        // a yes on the older run: the newer one already said
        expect(word.decided(older, 0.9, "judge")).toBeTrue();
        expect(since(chat, id)).toBeNull();
        expect(opened).toEqual([]);

        // a yes on the latest run opens the alert at its end
        expect(word.decided(newer, 0.9, "judge")).toBeTrue();
        expect(since(chat, id)).toBe(endOf(chat, newer));
        expect(opened).toHaveLength(1);
        expect((await summary(chat, id)).alert).toEqual({
          since: endOf(chat, newer),
          runs: 1,
          reason: null,
          by: "judge",
        });

        // a no on the older run leaves the newer run's alert
        expect(word.decided(older, 0.1, "judge")).toBeTrue();
        expect(since(chat, id)).toBe(endOf(chat, newer));

        // a no on the latest run closes it
        expect(word.decided(newer, 0.1, "judge")).toBeTrue();
        expect(since(chat, id)).toBeNull();

        // a word that never came closes it as a clean run's end would
        word.decided(newer, 0.9, "judge");
        expect(since(chat, id)).toBe(endOf(chat, newer));
        word.undecided(newer);
        expect(since(chat, id)).toBeNull();

        // a gone run changes nothing
        expect(word.decided("nosuchrun000", 0.9, "judge")).toBeFalse();
        expect(since(chat, id)).toBeNull();
      } finally {
        unsubscribe();
        await chat.app.shutdown();
      }
    },
  );
});

describe("the decider's guard", () => {
  const wordOf = (chat: ChatApp) =>
    alerts({
      db: chat.app.db,
      store: chat.app.automations,
      sessions: chat.app.sessions,
      markAttention: (sessionId, attention, by) =>
        markAttention(chat.app.db, chat.app.sessions, sessionId, attention, by),
    });

  test("a mark wins a tie of one millisecond", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    try {
      const automation = await createAutomation(chat, {
        attentionMode: "agent",
      });
      const id = automation.id;
      const word = wordOf(chat);
      const older = await cleanRun(chat, id);
      const newer = await cleanRun(chat, id, 0);
      expect(endOf(chat, newer)).toBe(endOf(chat, older));
      // the newer run's yes opens; the older run's later no keeps it
      word.decided(newer, 0.9, "judge");
      expect(since(chat, id)).toBe(endOf(chat, newer));
      word.decided(older, 0.1, "judge");
      expect(since(chat, id)).toBe(endOf(chat, newer));
      // nor does the newer run's own no, its tied neighbour unheard
      word.decided(newer, 0.1, "judge");
      expect(since(chat, id)).toBe(endOf(chat, newer));
      // dismissed, the older run's yes opens over its tied neighbour
      await dismiss(chat, id);
      expect(since(chat, id)).toBeNull();
      word.decided(older, 0.9, "judge");
      expect(since(chat, id)).toBe(endOf(chat, older));
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a newer run a user stopped says nothing; one past its deadline does", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    try {
      const automation = await createAutomation(chat, {
        attentionMode: "agent",
      });
      const id = automation.id;
      const clean = await cleanRun(chat, id);
      const stopped = await stoppedRun(chat, id);
      expect(
        endedAfter(chat.app.db, id, clean, endOf(chat, clean), false),
      ).toBeFalse();
      wordOf(chat).decided(clean, 0.9, "judge");
      expect(since(chat, id)).toBe(endOf(chat, clean));
      // the same stopped status by its deadline ended the run itself
      chat.app.db
        .query("update sends set cause = 'deadline' where session_id = ?")
        .run(stopped);
      expect(
        endedAfter(chat.app.db, id, clean, endOf(chat, clean), false),
      ).toBeTrue();
      const plan = chat.app.db
        .query<{ detail: string }, [string, number, string]>(
          `explain query plan select 1 from sessions
             indexed by sessions_automation
             where automation_id = ? and last_activity_at > ?
               and status != 'running' and id != ?
               and not exists (select 1 from sends
                 where sends.session_id = sessions.id
                   and sends.cause in ('stop', 'shutdown', 'restart'))
             limit 1`,
        )
        .all(id, 0, clean)
        .map((row) => row.detail);
      expect(plan).toEqual([
        "SEARCH sessions USING INDEX sessions_automation (automation_id=? AND last_activity_at>?)",
        "CORRELATED SCALAR SUBQUERY 1",
        "SEARCH sends USING INDEX sends_session (session_id=?)",
      ]);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a deleted marked run", () => {
  test.serial(
    "closes an alert it leaves with no run, by a user or by retention",
    async () => {
      const chat = await chatApp();
      chat.app.automationScheduler.stop();
      const changed: BusEvent[] = [];
      const unsubscribe = subscribe((event) => {
        if (event.type === "automation.changed") changed.push(event);
      }, silent);
      try {
        const automation = await createAutomation(chat, {
          attentionMode: "agent",
          retentionDays: 1,
        });
        const id = automation.id;

        // a marked run from before the alert goes: nothing to tell
        await cleanRun(chat, id);
        const old = await failedRun(chat, id);
        await cleanRun(chat, id);
        const first = await failedRun(chat, id);
        const second = await failedRun(chat, id);
        expect((await summary(chat, id)).alert?.runs).toBe(2);
        const revision = (await summary(chat, id)).revision;
        const seen = changed.length;
        const early = await chat.member.call("DELETE", `/api/sessions/${old}`);
        expect(early.status).toBe(200);
        expect(changed).toHaveLength(seen);
        expect((await summary(chat, id)).revision).toBe(revision);

        // one of two goes: the alert stays, one run fewer, and the page
        // and the pick are told
        const gone = await chat.member.call(
          "DELETE",
          `/api/sessions/${second}`,
        );
        expect(gone.status).toBe(200);
        expect(since(chat, id)).toBe(endOf(chat, first));
        expect(changed.slice(seen)).toEqual([
          expect.objectContaining({
            data: expect.objectContaining({
              automation: expect.objectContaining({
                id,
                revision: revision + 1,
                alert: {
                  since: endOf(chat, first),
                  runs: 1,
                  reason: "The run failed: stream ended early",
                  by: null,
                },
              }),
            }),
          }),
        ]);
        expect((await summary(chat, id)).alert?.runs).toBe(1);

        // the last one goes: closed, and the page and the pick are told
        const last = await chat.member.call("DELETE", `/api/sessions/${first}`);
        expect(last.status).toBe(200);
        expect(since(chat, id)).toBeNull();
        expect(changed.at(-1)).toMatchObject({
          type: "automation.changed",
          data: { automation: { id, alert: null } },
        });

        // retention takes the last marked run of a new alert
        const third = await failedRun(chat, id);
        await cleanRun(chat, id);
        expect(since(chat, id)).toBeNull();
        const fourth = await failedRun(chat, id);
        expect(since(chat, id)).toBe(endOf(chat, fourth));
        chat.app.now.value += 2 * 86_400_000;
        const before = changed.length;
        expect(chat.app.automationScheduler.sweep()).toBe(5);
        expect(chat.app.sessions.byId(third)).toBeNull();
        expect(since(chat, id)).toBeNull();
        expect(changed.slice(before)).toEqual([
          expect.objectContaining({
            data: expect.objectContaining({
              automation: expect.objectContaining({ id, alert: null }),
            }),
          }),
        ]);
      } finally {
        unsubscribe();
        await chat.app.shutdown();
      }
    },
  );
});

describe("the open alert's lists", () => {
  test("the feed's pick lists open alerts, newest first, and the Runs filter the marked runs", async () => {
    const chat = await chatApp();
    chat.app.automationScheduler.stop();
    try {
      const a = await createAutomation(chat, {
        name: "alpha",
        attentionMode: "agent",
      });
      const b = await createAutomation(chat, {
        name: "bravo",
        attentionMode: "agent",
      });
      const c = await createAutomation(chat, {
        name: "charlie",
        attentionMode: "agent",
      });
      const aMarked = await failedRun(chat, a.id);
      await cleanRun(chat, b.id);
      const cFailed = await failedRun(chat, c.id);
      const cLatest = await failedRun(chat, c.id);

      const pick = async (query: string) => {
        const response = await chat.member.call(
          "GET",
          `/api/sessions?attention=1${query}`,
        );
        expect(response.status).toBe(200);
        return response.json();
      };
      const all = await pick("");
      // b has no alert; c's alert opened after a's
      expect(
        all.rows.map((row: { session: { id: string } }) => row.session.id),
      ).toEqual([cLatest, aMarked]);
      expect(all.rows[0].runs).toBe(2);
      expect(all.rows[0].automation).toEqual({
        id: c.id,
        name: "charlie",
        alert: {
          since: endOf(chat, cFailed),
          runs: 2,
          reason: "The run failed: stream ended early",
          by: null,
        },
      });
      expect(all.next).toBeNull();

      const project = await pick(`&project=${chat.projectId}`);
      expect(project.rows).toHaveLength(2);

      // a page of one, then the next by the alert's place
      const usage = { latestFor: () => new Map(), latest: () => null };
      const page = listAlerts(
        chat.app.db,
        usage,
        [chat.projectId],
        "",
        null,
        1,
      );
      expect(page.rows.map((row) => row.session.id)).toEqual([cLatest]);
      expect(page.next).toBe(`${endOf(chat, cFailed)}.${c.id}`);
      const rest = await pick(`&before=${page.next}`);
      expect(
        rest.rows.map((row: { session: { id: string } }) => row.session.id),
      ).toEqual([aMarked]);

      await dismiss(chat, c.id);
      const dismissed = await pick("");
      expect(
        dismissed.rows.map(
          (row: { session: { id: string } }) => row.session.id,
        ),
      ).toEqual([aMarked]);

      // the marked runs of c stay marked, dismissed or not
      await cleanRun(chat, c.id);
      const runs = await chat.member.call(
        "GET",
        `/api/automations/${c.id}/runs?filter=attention`,
      );
      expect(runs.status).toBe(200);
      expect(
        (await runs.json()).rows.map(
          (row: { session: { id: string } }) => row.session.id,
        ),
      ).toEqual([cLatest, cFailed]);
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("the open alert's reads", () => {
  test("never scan the runs: the count and the filter stay on sessions_marked", async () => {
    const chat = await chatApp();
    try {
      const plan = (sql: string) =>
        chat.app.db
          .query<{ detail: string }, []>(`explain query plan ${sql}`)
          .all()
          .map((row) => row.detail);
      expect(
        plan(
          `select ${alertColumns("automations")} from automations where id = 'x'`,
        ),
      ).toContain(
        "SEARCH marked USING COVERING INDEX sessions_marked (automation_id=? AND last_activity_at>?)",
      );
      expect(
        plan(
          `select * from sessions where automation_id = 'x' and ${MARKED}
           order by last_activity_at desc, id limit 5`,
        ),
      ).toEqual([
        "SEARCH sessions USING INDEX sessions_marked (automation_id=?)",
      ]);
    } finally {
      await chat.app.shutdown();
    }
  });
});
