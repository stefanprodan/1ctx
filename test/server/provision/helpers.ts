// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type App, compose } from "../../../src/server/compose.ts";
import type { Db } from "../../../src/server/db/index.ts";
import { silent } from "../../../src/server/lib/log.ts";
import { parse } from "../../../src/server/provision/index.ts";
import { TEST_PASSWORD_COST, type TestApp } from "../../helpers/app.ts";
import { mcpFetch } from "../mcp/fake.ts";

export const MODEL_URL = "http://models.test/v1";
// a strict server whose catalog lists only ids
export const BARE_URL = "http://bare.test/v1";
export const SKILL_URL = "https://skills.test/SKILL.md";
export const MCP_URL = "https://mcp.test/mcp";
export const INDEX_URL = "https://index.test";

export function object(
  kind: string,
  name: string,
  spec: Record<string, unknown>,
) {
  return { apiVersion: "config.1ctx.dev/v1", kind, metadata: { name }, spec };
}

export function documents(...objects: ReturnType<typeof object>[]) {
  return parse([
    {
      path: "instance.yaml",
      text: objects.map((value) => JSON.stringify(value)).join("\n---\n"),
    },
  ]);
}

export async function fullDocuments() {
  return parse([
    {
      path: "instance.yaml",
      text: await Bun.file("test/fixtures/provision/good.yaml").text(),
    },
  ]);
}

export const provider = (spec: Record<string, unknown> = {}) =>
  object("Provider", "mock-provider", {
    wire: "openai-compatible",
    baseUrl: MODEL_URL,
    keyFrom: null,
    ...spec,
  });

export const agent = (spec: Record<string, unknown> = {}) =>
  object("Agent", "guide", {
    provider: "mock-provider",
    model: "fake-model",
    prompt: "Answer plainly.",
    ...spec,
  });

export const user = (spec: Record<string, unknown> = {}) =>
  object("User", "zed-user", {
    role: "member",
    fullName: "Zed User",
    email: "zed@example.test",
    tz: "UTC",
    passwordFrom: "user-zed",
    ...spec,
  });

export function network() {
  const calls: string[] = [];
  const state = {
    skillName: "paper-skill",
    badDigest: false,
    mcpFailure: false,
  };
  const skill = () =>
    `---\nname: ${state.skillName}\ndescription: Read papers carefully.\n---\nCheck the sources.\n`;
  const digest = () =>
    `sha256:${new Bun.CryptoHasher("sha256").update(skill()).digest("hex")}`;
  const mcp = mcpFetch({
    recorded: {
      initialize: {
        capabilities: { tools: {} },
        serverInfo: { name: "toolbox", version: "1" },
        instructions: "Read before writing.",
      },
      tools: {
        tools: [
          {
            name: "read_note",
            description: "Read a note.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    },
  });
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request =
      input instanceof Request ? input : new Request(String(input), init);
    const url = request.url;
    calls.push(url);
    if (url === `${MODEL_URL}/models`) {
      return Response.json({
        data: ["fake-model", "fake-model-next"].map((id, index) => ({
          id,
          name: `Fake model ${index + 1}`,
          context_length: 32_768 * (index + 1),
          supported_parameters: ["tools", "reasoning"],
        })),
      });
    }
    if (url === `${MODEL_URL}/models?pageSize=1000`) {
      return Response.json({
        models: ["fake-model", "fake-model-next"].map((id) => ({
          name: `models/${id}`,
          displayName: id,
          inputTokenLimit: 32_768,
          supportedGenerationMethods: ["generateContent"],
        })),
      });
    }
    if (url === `${BARE_URL}/models`) {
      return Response.json({
        data: ["bare-model", "bare-model-next"].map((id) => ({
          id,
          object: "model",
        })),
      });
    }
    if (url === SKILL_URL) return new Response(skill());
    if (url === `${INDEX_URL}/.well-known/agent-skills/index.json`) {
      return Response.json({
        skills: [
          {
            name: "paper-skill",
            description: "Read papers carefully.",
            type: "skill-md",
            url: SKILL_URL,
            digest: state.badDigest ? `sha256:${"0".repeat(64)}` : digest(),
          },
        ],
      });
    }
    if (url === MCP_URL || url === "https://mcp.test/next") {
      if (state.mcpFailure) return new Response("unavailable", { status: 503 });
      return mcp.fetcher(request);
    }
    throw new TypeError(`unexpected test request: ${url}`);
  }) as typeof fetch;
  return { fetcher, calls, state, digest };
}

function tables(db: Db): string[] {
  return db
    .query<{ name: string }, []>(
      "select name from sqlite_master where type = 'table' order by name",
    )
    .all()
    .map(({ name }) => name)
    .filter((name) => !name.startsWith("sqlite_"));
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

export function snapshot(db: Db) {
  return Object.fromEntries(
    tables(db).map((name) => [
      name,
      db.query(`select * from ${quoted(name)}`).all(),
    ]),
  );
}

export function mutations(db: Db) {
  const watched = tables(db).filter((name) => name !== "logins");
  db.exec("create table provision_writes (object_table text, operation text)");
  for (const [index, name] of watched.entries()) {
    for (const operation of ["insert", "update", "delete"]) {
      db.exec(
        `create trigger provision_watch_${index}_${operation}
         after ${operation} on ${quoted(name)}
         begin insert into provision_writes values ('${name}', '${operation}'); end`,
      );
    }
  }
  return () => db.query("select * from provision_writes").all();
}

export const changes = (db: Db) =>
  db.query<{ n: number }, []>("select total_changes() as n").get()!.n;

export const loginCount = (db: Db) =>
  db.query<{ n: number }, []>("select count(*) as n from logins").get()!.n;

export async function recompose(
  app: Pick<TestApp, "db" | "now">,
  fetcher: typeof fetch,
  secrets: Record<string, string> = {},
): Promise<App> {
  const values = { "user-admin": "hunter2-test", ...secrets };
  return compose({
    db: app.db,
    clock: () => app.now.value,
    secret: (_kind, name) => values[name as keyof typeof values] ?? null,
    secretNames: (kind) =>
      Object.keys(values).filter((name) => name.startsWith(kind)),
    fetcher,
    log: () => silent,
    version: "test",
    secureCookie: false,
    trustProxy: false,
    activate: false,
    passwordCost: TEST_PASSWORD_COST,
  });
}
