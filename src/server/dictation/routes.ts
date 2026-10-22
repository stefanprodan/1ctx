// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { DictationResponse } from "../../shared/api/dictation.ts";
import { servesTranscription } from "../../shared/contracts/dictation.ts";
import { type Db, transact } from "../db/index.ts";
import { jsonBody, parseNoQuery } from "../lib/body.ts";
import type { Clock } from "../lib/clock.ts";
import { BadRequest } from "../lib/errors.ts";
import { json, type RouteDescriptor } from "../lib/http.ts";
import type { Log } from "../lib/log.ts";
import { parseDictation, parseDictationSwitch } from "./parse.ts";
import type { DictationStore } from "./store.ts";
import {
  type ProvidersPort,
  TRANSCRIBE_IDLE_SECONDS,
  type transcriber,
} from "./transcribe.ts";

export type RoutesDeps = {
  db: Db;
  store: DictationStore;
  providers: ProvidersPort;
  transcribe: ReturnType<typeof transcriber>;
  clock: Clock;
  log: Log;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  const answer = (): DictationResponse => ({
    enabled: deps.store.on(),
    settings: deps.store.settings(),
  });
  // checked before the catalog's wait and again in the write, since the
  // provider may go while it waits
  const provider = (id: string) => {
    const row = deps.providers.byId(id);
    if (row === null) throw new BadRequest("no such provider");
    if (!servesTranscription(row.wire)) {
      throw new BadRequest(`${row.name} serves no transcription models`);
    }
    return row;
  };
  return [
    {
      method: "GET",
      path: "/api/admin/dictation",
      policy: "admin",
      handle() {
        return json(answer());
      },
    },
    {
      method: "PUT",
      path: "/api/admin/dictation",
      policy: "admin",
      async handle(req) {
        const body = parseDictation(await jsonBody(req));
        const row = provider(body.providerId);
        const before = deps.store.settings();
        // a model kept is not asked again, so a catalog that is down
        // never blocks a save that changes nothing
        const kept =
          before?.providerId === row.id && before.model === body.model;
        if (
          !kept &&
          (await deps.providers.model(row, body.model, "transcription")) ===
            null
        ) {
          throw new BadRequest(
            `${row.name} does not list ${body.model} as a transcription model`,
          );
        }
        transact(deps.db, () => {
          provider(body.providerId);
          deps.store.save(body.providerId, body.model, deps.clock());
          return { result: undefined };
        });
        deps.log.info("dictation saved", {
          provider: row.name,
          model: body.model,
        });
        return json(answer());
      },
    },
    {
      method: "PATCH",
      path: "/api/admin/dictation",
      policy: "admin",
      async handle(req) {
        const { enabled } = parseDictationSwitch(await jsonBody(req));
        const flipped = transact(deps.db, () => {
          const was = deps.store.on();
          const held = deps.store.setOn(enabled, deps.clock());
          if (!held && enabled) throw new BadRequest("pick a model first");
          return { result: was !== enabled };
        });
        if (flipped) {
          deps.log.info(
            enabled ? "dictation turned on" : "dictation turned off",
          );
        }
        return json(answer());
      },
    },
    {
      method: "POST",
      path: "/api/transcribe",
      policy: "authenticated",
      idleSeconds: TRANSCRIBE_IDLE_SECONDS,
      async handle(req, ctx) {
        parseNoQuery(ctx.url);
        return json(await deps.transcribe(req, ctx.principal!));
      },
    },
  ];
}
