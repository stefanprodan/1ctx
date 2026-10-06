// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type {
  PutSmtpRequest,
  SmtpResponse,
  SmtpTestResponse,
} from "../../shared/api/smtp.ts";
import { jsonBody } from "../lib/body.ts";
import { json, type Principal, type RouteDescriptor } from "../lib/http.ts";
import { parseSmtp } from "./parse.ts";

export type RoutesDeps = {
  response(principal: Principal): SmtpResponse;
  save(fields: PutSmtpRequest): void;
  test(principal: Principal): Promise<SmtpTestResponse>;
};

export function routes(deps: RoutesDeps): RouteDescriptor[] {
  return [
    {
      method: "GET",
      path: "/api/admin/smtp",
      policy: "admin",
      handle(_req, ctx) {
        return json(deps.response(ctx.principal!));
      },
    },
    {
      method: "PUT",
      path: "/api/admin/smtp",
      policy: "admin",
      async handle(req, ctx) {
        deps.save(parseSmtp(await jsonBody(req)));
        return json(deps.response(ctx.principal!));
      },
    },
    {
      method: "POST",
      path: "/api/admin/smtp/test",
      policy: "admin",
      async handle(_req, ctx) {
        return json(await deps.test(ctx.principal!));
      },
    },
  ];
}
