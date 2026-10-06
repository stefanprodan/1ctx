// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  MailResponse,
  MailTestResponse,
  PutMailRequest,
} from "../../shared/api/mail.ts";
import { jsonBody } from "../lib/body.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import { parseMail } from "./parse.ts";

export type RoutesDeps = {
  response(principal: Principal): MailResponse;
  save(fields: PutMailRequest): void;
  test(principal: Principal): Promise<MailTestResponse>;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/admin/mail",
      policy: "admin",
      handle(_req, ctx) {
        return json(deps.response(ctx.principal!));
      },
    },
    {
      method: "PUT",
      path: "/api/admin/mail",
      policy: "admin",
      async handle(req, ctx) {
        deps.save(parseMail(await jsonBody(req)));
        return json(deps.response(ctx.principal!));
      },
    },
    {
      method: "POST",
      path: "/api/admin/mail/test",
      policy: "admin",
      async handle(_req, ctx) {
        return json(await deps.test(ctx.principal!));
      },
    },
  ];
}
