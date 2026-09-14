// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testApp } from "../helpers/app.ts";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "fixtures", "skills", name));
const text = (name: string) => fixture(name).toString("utf8");
const digest = (bytes: Uint8Array) =>
  `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;

type Answer = Response | (() => Response | Promise<Response>);
function sources(entries: Record<string, Answer>): typeof fetch {
  return (async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const answer = entries[url];
    if (answer === undefined) throw new TypeError("unable to connect");
    return typeof answer === "function" ? answer() : answer.clone();
  }) as typeof fetch;
}

async function admin(fetcher: typeof fetch) {
  const app = await testApp({ fetcher });
  const client = app.client();
  await client.login("admin", "hunter2-test");
  return { app, client };
}

const raw = (name: string, body: string, description = "A test skill") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

describe("skill routes", () => {
  test("discovers and adds recorded GitHub and index skills", async () => {
    const gitops = text("gitops-knowledge.SKILL.md");
    const timoni = fixture("timoni.SKILL.md");
    const archive = await new Bun.Archive(
      {
        "repo-main/skills/gitops-knowledge/SKILL.md": gitops,
        "repo-main/skills/gitops-knowledge/references/runbook.md": "runbook",
      },
      { compress: "gzip" },
    ).bytes();
    const index = JSON.parse(text("timoni.index.json"));
    index.skills[0].digest = digest(timoni);
    const indexUrl = "https://skills.test/.well-known/agent-skills/index.json";
    const skillUrl =
      "https://skills.test/.well-known/agent-skills/timoni/skill.md";
    const { app, client } = await admin(
      sources({
        "https://codeload.github.com/acme/repo/tar.gz/main": new Response(
          archive,
        ),
        [indexUrl]: new Response(JSON.stringify(index)),
        [skillUrl]: new Response(timoni),
      }),
    );
    const found = await client.call("POST", "/api/skills/discover", {
      body: { url: "https://skills.test" },
    });
    expect(found.status).toBe(200);
    const discovery = await found.json();
    expect(discovery.entries[0].name).toBe("timoni");

    const github = await client.call("POST", "/api/skills", {
      body: {
        url: "https://github.com/acme/repo/tree/main/skills/gitops-knowledge",
      },
    });
    expect(github.status).toBe(201);
    const indexed = await client.call("POST", "/api/skills", {
      body: {
        url: "https://skills.test",
        name: "timoni",
        digest: index.skills[0].digest,
      },
    });
    expect(indexed.status).toBe(201);
    const list = await client.call("GET", "/api/skills");
    const { skills } = await list.json();
    expect(skills.map((skill: { name: string }) => skill.name)).toEqual([
      "gitops-knowledge",
      "timoni",
    ]);
    const gitopsRow = await github.json();
    const detail = await client.call(
      "GET",
      `/api/skills/${gitopsRow.skill.id}`,
    );
    expect((await detail.json()).body).toContain("Flux CD Knowledge Base");
    const file = await client.call(
      "GET",
      `/api/skills/${gitopsRow.skill.id}/file?path=references%2Frunbook.md`,
    );
    expect(await file.json()).toEqual({
      path: "references/runbook.md",
      content: "runbook",
      bytes: 7,
    });
    expect(
      (
        await client.call(
          "GET",
          `/api/skills/${gitopsRow.skill.id}/file?path=missing.md`,
        )
      ).status,
    ).toBe(404);
    expect(app.skills.list()).toHaveLength(2);
  });

  test("refuses duplicate names and bad index bytes without a row", async () => {
    const url = "https://skills.test/x.md";
    const indexUrl = "https://index.test/.well-known/agent-skills/index.json";
    const body = raw("same", "one");
    const index = {
      skills: [
        {
          name: "other",
          type: "skill-md",
          description: "other",
          url,
          digest: `sha256:${"0".repeat(64)}`,
        },
      ],
    };
    const { app, client } = await admin(
      sources({
        [url]: new Response(body),
        [indexUrl]: new Response(JSON.stringify(index)),
      }),
    );
    expect(
      (await client.call("POST", "/api/skills", { body: { url } })).status,
    ).toBe(201);
    expect(
      (await client.call("POST", "/api/skills", { body: { url } })).status,
    ).toBe(409);
    const mismatch = await client.call("POST", "/api/skills", {
      body: {
        url: "https://index.test",
        name: "other",
        digest: index.skills[0]!.digest,
      },
    });
    expect(mismatch.status).toBe(400);
    expect(app.skills.list().map((skill) => skill.name)).toEqual(["same"]);
  });

  test("refreshes in place, records change, and keeps rows after failure", async () => {
    const url = "https://skills.test/ops.md";
    const answers = [
      new Response(raw("ops", "one")),
      new Response(raw("ops", "two")),
      new Response("down", { status: 504 }),
    ];
    const { app, client } = await admin(
      sources({
        [url]: () => answers.shift() ?? new Response("down", { status: 504 }),
      }),
    );
    const created = await (
      await client.call("POST", "/api/skills", { body: { url } })
    ).json();
    const id = created.skill.id;
    const refreshed = await client.call("POST", `/api/skills/${id}/refresh`);
    expect(refreshed.status).toBe(200);
    const after = await refreshed.json();
    expect(after.skill.id).toBe(id);
    expect(after.body).toBe("two");
    expect(after.skill.lastChange.body).toBeTrue();
    const failed = await client.call("POST", `/api/skills/${id}/refresh`);
    expect(failed.status).toBe(502);
    expect(app.skills.byId(id)?.body).toBe("two");
    expect(app.skills.byId(id)?.refreshError).toContain("504");
  });

  test("refuses a renamed refresh", async () => {
    const url = "https://skills.test/ops.md";
    const answers = [
      new Response(raw("ops", "one")),
      new Response(raw("new-name", "two")),
    ];
    const { app, client } = await admin(
      sources({ [url]: () => answers.shift()! }),
    );
    const created = await (
      await client.call("POST", "/api/skills", { body: { url } })
    ).json();
    const res = await client.call(
      "POST",
      `/api/skills/${created.skill.id}/refresh`,
    );
    expect(res.status).toBe(409);
    expect(app.skills.byId(created.skill.id)?.name).toBe("ops");
  });

  test("blocks another refresh and delete while one fetch is running", async () => {
    const url = "https://skills.test/ops.md";
    let release!: (response: Response) => void;
    let calls = 0;
    const { client } = await admin(
      sources({
        [url]: () => {
          calls++;
          if (calls === 1) return new Response(raw("ops", "one"));
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        },
      }),
    );
    const created = await (
      await client.call("POST", "/api/skills", { body: { url } })
    ).json();
    const pending = client.call(
      "POST",
      `/api/skills/${created.skill.id}/refresh`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      (await client.call("POST", `/api/skills/${created.skill.id}/refresh`))
        .status,
    ).toBe(409);
    expect(
      (await client.call("DELETE", `/api/skills/${created.skill.id}`)).status,
    ).toBe(409);
    release(new Response(raw("ops", "one")));
    expect((await pending).status).toBe(200);
  });

  test("shutdown aborts an add with 503 and writes nothing", async () => {
    const url = "https://skills.test/held.md";
    const fetcher = (async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      })) as typeof fetch;
    const { app, client } = await admin(fetcher);
    const pending = client.call("POST", "/api/skills", { body: { url } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await app.shutdown();
    expect((await pending).status).toBe(503);
    expect(app.skills.list()).toEqual([]);
  });
});
