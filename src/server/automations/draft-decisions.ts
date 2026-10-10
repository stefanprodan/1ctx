// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { DraftDecisionResponse } from "../../shared/api/automations.ts";
import { STALE_EDIT } from "../../shared/contracts/automation.ts";
import type { DraftState } from "../../shared/contracts/automation-draft.ts";
import { type Db, transact } from "../db/index.ts";
import type { Clock } from "../lib/clock.ts";
import { Conflict, HttpError, NotFound } from "../lib/errors.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import type { PreparedRun } from "../runner/index.ts";
import type { SessionRow } from "../sessions/index.ts";
import type { AutomationActions } from "./actions.ts";
import { draftChanged } from "./draft-events.ts";
import type { AutomationDraftStore, DraftRow } from "./draft-store.ts";
import { parsePatchAutomation, parseSaveAutomation } from "./parse.ts";
import type { AutomationStore } from "./store.ts";

type Deps = {
  db: Db;
  clock: Clock;
  drafts: AutomationDraftStore;
  store: AutomationStore;
  actions: AutomationActions;
  visibleSession(principal: Principal, id: string): SessionRow;
  wake(): void;
};

type Decision = DraftDecisionResponse;

export function draftDecisions(deps: Deps) {
  const visible = (principal: Principal, id: string) => {
    const draft = deps.drafts.byId(id);
    if (draft === null) throw new NotFound("no such chat");
    const session = deps.visibleSession(principal, draft.sessionId);
    return { draft, session };
  };
  const decided = (draft: DraftRow): Decision => ({
    state: draft.state,
    error: `the proposal is ${draft.state}`,
  });
  const finish = (
    draft: DraftRow,
    state: Exclude<DraftState, "pending">,
    by: string | null,
    error?: string,
    links: { createdAutomationId?: string; runSessionId?: string } = {},
  ) => {
    if (!deps.drafts.decide(draft.id, state, by, deps.clock(), links)) {
      throw new Conflict("the proposal was decided");
    }
    return {
      result: { state, ...(error === undefined ? {} : { error }) },
      events: [draftChanged(deps.db, draft.id)],
    };
  };
  const confirm = (principal: Principal, id: string): Decision => {
    const holder: { run: PreparedRun | null } = { run: null };
    let result: Decision;
    try {
      result = transact<Decision>(deps.db, () => {
        const { draft, session } = visible(principal, id);
        if (draft.state !== "pending") return { result: decided(draft) };
        if (draft.expiresAt <= deps.clock() || session.archived !== null) {
          return finish(draft, "expired", null, "the proposal expired");
        }
        const current =
          draft.automationId === null
            ? null
            : deps.store.byId(draft.automationId);
        if (draft.action !== "create") {
          if (current === null || current.projectId !== session.projectId) {
            return finish(draft, "stale", null, "the task is gone");
          }
          if (current.editRevision !== draft.editRevision) {
            return finish(draft, "stale", null, STALE_EDIT);
          }
        }
        const name =
          draft.action === "create" || draft.action === "update"
            ? draft.fields.name
            : undefined;
        if (
          name !== undefined &&
          deps.store.nameTaken(session.projectId, name, current?.id)
        ) {
          return finish(draft, "stale", null, "name is taken");
        }
        let createdAutomationId: string | undefined;
        switch (draft.action) {
          case "create":
            createdAutomationId = deps.actions.create(
              principal,
              session.projectId,
              parseSaveAutomation(draft.fields),
            ).id;
            break;
          case "update":
            deps.actions.update(
              principal,
              current!.id,
              parsePatchAutomation({
                ...draft.fields,
                editRevision: draft.editRevision,
              }),
            );
            break;
          case "suspend":
            deps.actions.suspend(principal, current!.id);
            break;
          case "resume":
            deps.actions.resume(principal, current!.id);
            break;
          case "run":
            holder.run = deps.actions.run(principal, current!.id);
            break;
        }
        return finish(draft, "confirmed", principal.userId, undefined, {
          createdAutomationId,
          runSessionId: holder.run?.detail.session.id,
        });
      });
    } catch (error) {
      holder.run?.abandon();
      // Unlike the page, a capacity refusal leaves a confirmable line.
      if (error instanceof HttpError && error.status === 429) {
        return { state: "pending", error: error.message };
      }
      if (error instanceof HttpError && error.status === 409) {
        return { state: deps.drafts.byId(id)!.state, error: error.message };
      }
      throw error;
    }
    holder.run?.launch();
    if (result.error === undefined) deps.wake();
    return result;
  };
  const dismiss = (principal: Principal, id: string): Decision =>
    transact(deps.db, () => {
      const { draft } = visible(principal, id);
      return draft.state !== "pending"
        ? { result: decided(draft) }
        : finish(draft, "dismissed", principal.userId);
    });
  return { confirm, dismiss };
}

export function draftRoutes(
  decisions: ReturnType<typeof draftDecisions>,
): RouteDescriptor[] {
  return (["confirm", "dismiss"] as const).map((action) => ({
    method: "POST",
    path: `/api/automation-drafts/:id/${action}`,
    policy: "authenticated",
    handle(_req, ctx) {
      const result = decisions[action](ctx.principal!, ctx.params.id);
      return json(result, result.error === undefined ? 200 : 409);
    },
  }));
}
