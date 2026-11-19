// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { PutSandboxRequest } from "../../shared/api/sandbox.ts";
import {
  isGatewayEndpoint,
  isSandboxImage,
  isSandboxShell,
  MAX_GATEWAY_ENDPOINT,
  MAX_SANDBOX_IMAGE,
} from "../../shared/contracts/sandbox.ts";
import { fields } from "../lib/body.ts";
import { BadRequest } from "../lib/errors.ts";

export const ENDPOINT_RULE = `an https origin (https://host:port) of at most ${MAX_GATEWAY_ENDPOINT} characters`;
export const IMAGE_RULE = `an image reference of at most ${MAX_SANDBOX_IMAGE} characters`;

export function parseSandbox(body: unknown): PutSandboxRequest {
  const b = fields(body, ["shell", "endpoint", "image"]);
  const out: PutSandboxRequest = {};
  if ("shell" in b) {
    if (!isSandboxShell(b.shell)) {
      throw new BadRequest("shell must be builtin or sandbox");
    }
    out.shell = b.shell;
  }
  if ("endpoint" in b) {
    if (b.endpoint !== null && !isGatewayEndpoint(b.endpoint)) {
      throw new BadRequest(`endpoint must be null or ${ENDPOINT_RULE}`);
    }
    out.endpoint = b.endpoint;
  }
  if ("image" in b) {
    if (b.image !== null && !isSandboxImage(b.image)) {
      throw new BadRequest(`image must be null or ${IMAGE_RULE}`);
    }
    out.image = b.image;
  }
  if (Object.keys(out).length === 0) {
    throw new BadRequest("body must name shell, endpoint or image");
  }
  return out;
}
