// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The deciders and the decisions, all for admins. A decider's save names
// a provider that serves decisions and a model its decisions catalog
// lists; what the catalog says about it is kept on the row. Check asks
// the fixed yes/no. A decision's save is its whole settings.

import type {
  CheckDeciderResponse,
  DeciderResponse,
  DecidersResponse,
} from "../../shared/api/deciders.ts";
import type {
  DecisionResponse,
  DecisionsResponse,
} from "../../shared/api/decisions.ts";
import { isDecisionId } from "../../shared/contracts/decision.ts";
import type { CatalogMatch } from "../../shared/contracts/provider.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { BadGateway, BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import { errorFields, type Log } from "../lib/log.ts";
import { DecisionError, servesDecisions } from "../providers/index.ts";
import {
  ask,
  CHECK_QUESTIONS,
  CHECK_STATE,
  CHECK_TIMEOUT_MS,
  type ProvidersPort,
  type UsagePort,
} from "./decide.ts";
import type { DecisionStore } from "./decisions.ts";
import { type ParsedDecider, parseDecider, parseDecision } from "./parse.ts";
import {
  type DeciderFields,
  type DeciderRow,
  type DeciderStore,
  summary,
} from "./store.ts";

export type RoutesDeps = {
  db: Db;
  store: DeciderStore;
  decisions: DecisionStore;
  providers: ProvidersPort;
  usage: UsagePort;
  clock: Clock;
  log: Log;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  const providerName = (id: string) => deps.providers.byId(id)?.name ?? id;
  const logged = (msg: string, decider: DeciderRow) =>
    deps.log.info(msg, {
      name: decider.name,
      provider: providerName(decider.providerId),
      model: decider.model,
    });
  // the rows the body names are checked before the catalog fetch and
  // again in the transaction, since the world may move while it waits
  const check = (body: ParsedDecider, except: string | null) => {
    const other = deps.store.byName(body.name);
    if (other && other.id !== except) {
      throw new Conflict(`a decider named ${body.name} exists`);
    }
    const provider = deps.providers.byId(body.providerId);
    if (!provider) throw new BadRequest("no such provider");
    if (!servesDecisions(provider.wire)) {
      throw new BadRequest(`${provider.name} serves no decision models`);
    }
    return provider;
  };
  const resolve = async (
    req: Request,
    before: DeciderRow | null,
  ): Promise<() => DeciderFields & { mark: boolean | null }> => {
    const body = parseDecider(await jsonBody(req));
    const provider = check(body, before?.id ?? null);
    // a model kept is not asked again, so a decider whose model left
    // the catalog can still be renamed or marked
    const kept =
      before !== null &&
      before.providerId === provider.id &&
      before.model === body.model;
    const model: CatalogMatch | null = kept
      ? null
      : await deps.providers.model(provider, body.model, "decisions");
    // called by the handler right before its write, with no await between
    return () => {
      const provider = check(body, before?.id ?? null);
      if (!kept && model === null) {
        throw new BadRequest(
          `${provider.name} does not list ${body.model} as a decision model`,
        );
      }
      return {
        name: body.name,
        providerId: provider.id,
        model: body.model,
        contextLength: (kept ? before : model)?.contextLength ?? null,
        promptPrice: (kept ? before : model)?.promptPrice ?? null,
        mark: body.mark,
      };
    };
  };
  const find = (id: string) => {
    const decider = deps.store.byId(id);
    if (!decider) throw new NotFound("no such decider");
    return decider;
  };
  return [
    {
      method: "GET",
      path: "/api/deciders",
      policy: "admin",
      handle() {
        const body: DecidersResponse = {
          deciders: deps.store.list().map(summary),
        };
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/decisions",
      policy: "admin",
      handle() {
        const body: DecisionsResponse = { decisions: deps.decisions.list() };
        return json(body);
      },
    },
    {
      method: "PUT",
      path: "/api/decisions/:id",
      policy: "admin",
      async handle(req, ctx) {
        const id = ctx.params.id;
        if (!isDecisionId(id)) throw new NotFound("no such decision");
        const body = parseDecision(id, await jsonBody(req));
        const decision = transact(deps.db, () => {
          if (body.deciderId !== null && !deps.store.byId(body.deciderId)) {
            throw new BadRequest("no such decider");
          }
          deps.decisions.save(id, body, deps.clock());
          return { result: deps.decisions.byId(id) };
        });
        deps.log.info("decision updated", { decision: id });
        const answer: DecisionResponse = { decision };
        return json(answer);
      },
    },
    {
      method: "POST",
      path: "/api/deciders",
      policy: "admin",
      async handle(req) {
        const fields = await resolve(req, null);
        const decider = transact(deps.db, () => {
          const values = fields();
          const created = deps.store.create({ ...values, now: deps.clock() });
          if (values.mark === true) deps.store.setDefault(created.id, true);
          return { result: deps.store.byId(created.id)! };
        });
        logged("decider created", decider);
        const body: DeciderResponse = { decider: summary(decider) };
        return json(body, 201);
      },
    },
    {
      method: "PATCH",
      path: "/api/deciders/:id",
      policy: "admin",
      async handle(req, ctx) {
        const decider = find(ctx.params.id);
        const fields = await resolve(req, decider);
        const updated = transact(deps.db, () => {
          const values = fields();
          if (!deps.store.update(decider.id, values)) {
            throw new NotFound("no such decider");
          }
          if (values.mark !== null) {
            deps.store.setDefault(decider.id, values.mark);
          }
          return { result: deps.store.byId(decider.id)! };
        });
        logged("decider updated", updated);
        const body: DeciderResponse = { decider: summary(updated) };
        return json(body);
      },
    },
    {
      // the default goes to the oldest left, with no write
      method: "DELETE",
      path: "/api/deciders/:id",
      policy: "admin",
      handle(_req, ctx) {
        const decider = find(ctx.params.id);
        if (!deps.store.delete(decider.id)) {
          throw new NotFound("no such decider");
        }
        logged("decider deleted", decider);
        return json({});
      },
    },
    {
      method: "POST",
      path: "/api/deciders/:id/check",
      policy: "admin",
      async handle(req, ctx) {
        const decider = find(ctx.params.id);
        try {
          const decided = await ask(
            deps,
            decider,
            { purpose: "check", sessionId: null, projectId: null },
            CHECK_QUESTIONS,
            CHECK_STATE,
            CHECK_TIMEOUT_MS,
            req.signal,
          );
          const answer = decided.answers.check!;
          const body: CheckDeciderResponse = {
            pick: answer.pick === true,
            probability: answer.probability,
            ms: decided.ms,
            cost: decided.usage.cost,
            served: decided.served,
          };
          return json(body);
        } catch (err) {
          if (!(err instanceof DecisionError)) throw err;
          deps.log.warn("decider check failed", {
            name: decider.name,
            provider: providerName(decider.providerId),
            model: decider.model,
            ...errorFields(err, false),
          });
          throw new BadGateway(err.message);
        }
      },
    },
  ];
}
