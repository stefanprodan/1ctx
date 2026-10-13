// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Access keys card on Connect agents: the draft's checks, the
// server's refusals at their fields, the row's words, the key shown
// once with its export line, and the entity behind the list.

import { beforeEach, describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { render } from "preact-render-to-string";
import {
  accessKeys,
  accessKeysError,
  accessKeysLimit,
  createAccessKey,
  loadAccessKeys,
  revokeAccessKey,
} from "../../../src/client/data/access-keys.ts";
import { ApiError } from "../../../src/client/data/api.ts";
import { me } from "../../../src/client/data/me.ts";
import { projects } from "../../../src/client/data/projects.ts";
import { Save } from "../../../src/client/lib/save.ts";
import {
  capLine,
  createBody,
  exportLine,
  keyFieldOf,
  keyProblem,
  NEW_KEY,
  OFF_TEXT,
} from "../../../src/client/views/connect/AccessKeys.model.ts";
import {
  AccessKeys,
  KeyFields,
  NewKeyForm,
  ShownKey,
} from "../../../src/client/views/connect/AccessKeys.tsx";
import { KeyRow } from "../../../src/client/views/keys/KeyRow.tsx";
import {
  expiryWords,
  REVOKE_ASK,
  reachWords,
  usedWords,
} from "../../../src/client/views/keys/Keys.model.ts";
import type { CreateAccessKeyResponse } from "../../../src/shared/api/profile.ts";
import type { AccessKey } from "../../../src/shared/contracts/access-key.ts";
import { clientFetch } from "../../helpers/client-fetch.ts";

const DAY = 86_400_000;
const NOW = Date.now();

// nothing shown once, as the page starts
const card = () => (
  <AccessKeys shown={signal<CreateAccessKeyResponse | null>(null)} />
);

const key = (over: Partial<AccessKey> = {}): AccessKey => ({
  id: "k1",
  name: "laptop-claude",
  scope: "write",
  projectIds: null,
  createdAt: NOW - 10 * DAY,
  expiresAt: NOW + 80 * DAY,
  lastUsedAt: NOW - 2 * 3_600_000,
  ...over,
});

const team = (id: string, name: string) => ({
  id,
  kind: "team" as const,
  name,
  createdAt: 0,
  memberCount: 1,
});

let answer: (url: string, init?: RequestInit) => Response;
const calls = clientFetch((url, init) => answer(url, init));

beforeEach(() => {
  me.value = null;
  me.value = {
    id: "u1",
    username: "casey",
    fullName: "Casey Doe",
    role: "member",
    mustChangePassword: false,
  };
  projects.value = [team("p1", "platform"), team("p2", "research")];
});

describe("the new key's checks", () => {
  test("a name, unique among the user's keys, and a pick when picking", () => {
    expect(keyProblem({ ...NEW_KEY, name: "laptop" }, [])).toBeNull();
    expect(keyProblem(NEW_KEY, [])).toEqual({
      error: "Enter a name",
      field: "name",
    });
    expect(keyProblem({ ...NEW_KEY, name: "a\nb" }, [])?.field).toBe("name");
    expect(keyProblem({ ...NEW_KEY, name: "a".repeat(65) }, [])?.field).toBe(
      "name",
    );
    expect(
      keyProblem({ ...NEW_KEY, name: " laptop-claude " }, [key()]),
    ).toEqual({ error: "Another access key has this name", field: "name" });
    expect(
      keyProblem({ ...NEW_KEY, name: "laptop", reach: "picked" }, []),
    ).toEqual({ error: "Pick a project", field: "projectIds" });
  });

  test("the body trims the name and sends null for every project", () => {
    // read and write first, since working a task writes
    expect(createBody({ ...NEW_KEY, name: " laptop " })).toEqual({
      name: "laptop",
      scope: "write",
      projectIds: null,
      days: 30,
    });
    // picks left over from Picked are not sent with Every project
    expect(
      createBody({ ...NEW_KEY, name: "a", projectIds: ["p1"] }).projectIds,
    ).toBeNull();
    expect(
      createBody({
        ...NEW_KEY,
        name: "a",
        scope: "write",
        reach: "picked",
        projectIds: ["p1"],
        days: 365,
      }),
    ).toEqual({ name: "a", scope: "write", projectIds: ["p1"], days: 365 });
  });

  test("the server's refusals land at their fields, the cap on the form", () => {
    // the words of access/parse.ts and access/key-routes.ts
    expect(
      keyFieldOf(
        "name must be 1 to 64 characters on one line, no leading or trailing spaces",
      ),
    ).toBe("name");
    expect(keyFieldOf("access key name is taken")).toBe("name");
    expect(keyFieldOf("scope must be read or write")).toBe("scope");
    expect(keyFieldOf("days must be 30, 90 or 365")).toBe("days");
    expect(keyFieldOf("projectIds must be null or distinct project ids")).toBe(
      "projectIds",
    );
    expect(keyFieldOf("no such project")).toBe("projectIds");
    expect(keyFieldOf("access key limit reached")).toBeUndefined();
    expect(keyFieldOf("access keys are off")).toBeUndefined();
    expect(keyFieldOf("change your password first")).toBeUndefined();
  });
});

describe("a key's words", () => {
  test("its projects by name, a lost one counted", () => {
    const list = [team("p1", "platform"), team("p2", "research")];
    expect(reachWords(key(), list)).toBe("Every project");
    expect(reachWords(key({ projectIds: ["p1", "p2"] }), list)).toBe(
      "platform, research",
    );
    expect(reachWords(key({ projectIds: ["p1", "gone"] }), list)).toBe(
      "platform and 1 more",
    );
    expect(reachWords(key({ projectIds: ["gone"] }), list)).toBe("1 project");
  });

  test("when it was used and when it ends", () => {
    expect(usedWords(key(), NOW)).toBe("Used 2h ago");
    expect(usedWords(key({ lastUsedAt: null }), NOW)).toBe("Never used");
    expect(expiryWords(key(), NOW)).toStartWith("Expires ");
    expect(expiryWords(key({ expiresAt: NOW - DAY }), NOW)).toStartWith(
      "Expired ",
    );
    expect(capLine(5)).toBe(
      "At most 5 access keys, expired ones included. Revoke one to make another.",
    );
    expect(capLine(1)).toStartWith("At most 1 access key, ");
  });

  test("the export line quotes the key into the shared variable", () => {
    expect(exportLine("1ctx_abc")).toBe('export ONECTX_ACCESS_KEY="1ctx_abc"');
  });
});

describe("the card", () => {
  test.serial("at a cap of 0 it says keys are off and offers no form", () => {
    accessKeys.value = [];
    accessKeysLimit.value = 0;
    const html = render(card());
    expect(html).toContain(">Access keys<");
    expect(html).toContain(OFF_TEXT);
    expect(html).not.toContain("New access key");
    expect(html).not.toContain("No access keys yet.");
    // a key kept from before can still be revoked
    accessKeys.value = [key()];
    const kept = render(card());
    expect(kept).toContain("laptop-claude");
    expect(kept).toContain(">Revoke<");
    expect(kept).not.toContain("New access key");
  });

  test.serial("the list shows every column and a Revoke per key", () => {
    accessKeys.value = [
      key(),
      key({
        id: "k2",
        name: "ci-codex",
        scope: "read",
        projectIds: ["p2"],
        lastUsedAt: null,
        expiresAt: NOW - DAY,
      }),
    ];
    accessKeysLimit.value = 5;
    const html = render(card());
    expect(html).toContain("New access key");
    expect(html).toContain(">laptop-claude<");
    expect(html).toContain("Read and write · Every project");
    expect(html).toContain("Created ");
    expect(html).toContain("Used 2h ago");
    expect(html).toContain("Expires ");
    expect(html).toContain(">ci-codex<");
    expect(html).toContain("Read · research");
    expect(html).toContain("Never used");
    expect(html).toMatch(/rows-bad">Expired /);
    expect(html.match(/>Revoke</g)).toHaveLength(2);
    // the token is never in a list
    expect(html).not.toContain("Bearer");
  });

  test.serial("at the cap it says why there is no New", () => {
    accessKeys.value = [key()];
    accessKeysLimit.value = 1;
    const html = render(card());
    expect(html).not.toContain("New access key");
    expect(html).toContain(capLine(1));
  });

  test.serial("no keys yet", () => {
    accessKeys.value = [];
    accessKeysLimit.value = 5;
    expect(render(card())).toContain("No access keys yet.");
  });

  test.serial("a failed load says so", () => {
    accessKeys.value = null;
    accessKeysError.value = { words: "down", status: 503 };
    try {
      expect(render(card())).toContain("Down.");
    } finally {
      accessKeysError.value = null;
    }
  });

  test("the key is shown once with its export line and copy buttons", () => {
    const html = render(<ShownKey token="1ctx_secret" onDone={() => {}} />);
    expect(html).toContain("Copy the key now. It is not shown again.");
    expect(html).toContain(">1ctx_secret<");
    expect(html).toContain("export ONECTX_ACCESS_KEY=&quot;1ctx_secret&quot;");
    expect(html).toContain("In your shell profile.");
    expect(html).toContain('aria-label="Copy Key"');
    expect(html).toContain('aria-label="Copy Environment"');
    // the agents' setup is the page's, never the box's
    expect(html).not.toContain("claude mcp add");
    expect(html).toContain(">Done<");
  });

  test.serial("a key made on the new page is shown on the card", () => {
    accessKeys.value = [key()];
    accessKeysLimit.value = 5;
    const shown = signal<CreateAccessKeyResponse | null>({
      key: key(),
      token: "1ctx_made",
    });
    const html = render(<AccessKeys shown={shown} />);
    expect(html).toContain(">1ctx_made<");
    // one key at a time: New waits for Done
    expect(html).toMatch(
      /<button[^>]*rows-add"[^>]* disabled>(?:(?!<\/button>).)*New access key/s,
    );
  });
});

describe("the form and the row", () => {
  test.serial("the new page asks every field, the shortest life first", () => {
    const html = render(
      <NewKeyForm keys={[]} username="casey" onMade={() => {}} />,
    );
    expect(html).toContain('name="name"');
    expect(html).toContain("Edits show as @casey via this name.");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Read and write</);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Every project</);
    expect(html).toMatch(/aria-pressed="true"[^>]*>30 days</);
    expect(html).toContain("Create access key");
    expect(html).toMatch(/href="\/connect"[^>]*>Cancel</);
  });

  test.serial(
    "a server refusal shows at its field in its hint's place",
    async () => {
      const refused = (words: string) => {
        const save = new Save(
          async () => {
            throw new ApiError(409, words);
          },
          2000,
          keyFieldOf,
        );
        return save;
      };
      const fields = (save: Save) =>
        render(
          <KeyFields
            draft={{ ...NEW_KEY, name: "laptop", reach: "picked" }}
            save={save}
            username="casey"
            set={() => {}}
          />,
        );
      const taken = refused("access key name is taken");
      await taken.run(null);
      const named = fields(taken);
      expect(named).toMatch(/name="name"[^>]*aria-invalid="true"/);
      expect(named).toContain(
        'class="field-error" role="alert">Access key name is taken.<',
      );
      expect(named).not.toContain("Edits show as");
      const lost = refused("no such project");
      await lost.run(null);
      const picked = fields(lost);
      expect(picked).toContain(
        'class="field-error" role="alert">No such project.<',
      );
      expect(picked).not.toContain("Only these.");
      expect(picked).toContain("Edits show as @casey via laptop.");
    },
  );

  test("a row asks before it revokes", () => {
    const row = (asking: boolean) =>
      render(
        <KeyRow
          row={key()}
          sub="Read and write · Every project"
          lines={[{ text: "Expires 1 Jan 2027" }]}
          asking={asking}
          onRevoke={async () => {}}
        />,
      );
    const idle = row(false);
    expect(idle).toContain(">Revoke<");
    expect(idle).not.toContain(REVOKE_ASK);
    expect(idle).not.toContain(">Keep<");
    const asking = row(true);
    expect(asking).toContain(`>${REVOKE_ASK}<`);
    expect(asking).toMatch(/btn-small btn-danger"[^>]*>Revoke</);
    expect(asking).toMatch(/btn btn-small"[^>]*>Keep</);
  });
});

describe("the entity", () => {
  test.serial("loads the keys and the cap", async () => {
    answer = () => Response.json({ keys: [key()], limit: 5 });
    await loadAccessKeys();
    expect(accessKeys.value).toEqual([key()]);
    expect(accessKeysLimit.value).toBe(5);
  });

  test.serial(
    "a create puts the new key first and hands back the token",
    async () => {
      accessKeys.value = [key()];
      const made = key({ id: "k2", name: "ci" });
      answer = () =>
        Response.json({ key: made, token: "1ctx_t" }, { status: 201 });
      const body = createBody({ ...NEW_KEY, name: "ci" });
      const answered = await createAccessKey(body);
      expect(answered.token).toBe("1ctx_t");
      expect(calls.at(-1)?.url).toBe("/api/profile/keys");
      expect(calls.at(-1)?.init?.method).toBe("POST");
      expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual(body);
      expect(accessKeys.value?.map((k) => k.id)).toEqual(["k2", "k1"]);
      // the entity never keeps the token
      expect(JSON.stringify(accessKeys.value)).not.toContain("1ctx_t");
    },
  );

  test.serial("a revoke deletes the key and drops its row", async () => {
    accessKeys.value = [key(), key({ id: "k2" })];
    answer = () => new Response(null, { status: 204 });
    await revokeAccessKey("k1");
    expect(calls.at(-1)?.url).toBe("/api/profile/keys/k1");
    expect(calls.at(-1)?.init?.method).toBe("DELETE");
    expect(accessKeys.value?.map((k) => k.id)).toEqual(["k2"]);
  });

  test.serial("a key already revoked elsewhere drops its row", async () => {
    accessKeys.value = [key(), key({ id: "k2" })];
    answer = () =>
      Response.json({ error: "no such access key" }, { status: 404 });
    await revokeAccessKey("k1");
    expect(accessKeys.value?.map((k) => k.id)).toEqual(["k2"]);
  });

  test.serial("any other refused revoke keeps the row", async () => {
    accessKeys.value = [key()];
    answer = () => Response.json({ error: "down" }, { status: 503 });
    await expect(revokeAccessKey("k1")).rejects.toThrow("down");
    expect(accessKeys.value).toEqual([key()]);
  });

  test.serial("another user's sign in drops the keys", () => {
    accessKeys.value = [key()];
    accessKeysLimit.value = 5;
    me.value = { ...me.value!, id: "u2" };
    expect(accessKeys.value).toBeNull();
    expect(accessKeysLimit.value).toBe(0);
  });

  for (const action of ["create", "revoke"] as const) {
    test.serial(
      `a late ${action} for an ended sign-in keeps the next one's load`,
      async () => {
        const original = globalThis.fetch;
        const pending: ((response: Response) => void)[] = [];
        globalThis.fetch = (() =>
          new Promise<Response>((resolve) => {
            pending.push(resolve);
          })) as unknown as typeof fetch;
        try {
          const write =
            action === "create"
              ? createAccessKey({ ...NEW_KEY, name: "laptop" })
              : revokeAccessKey("k1");
          // out and back in as the same user
          const was = me.value!;
          me.value = null;
          me.value = was;
          const load = loadAccessKeys();
          pending[0]!(
            action === "create"
              ? Response.json({ key: key(), token: "t" }, { status: 201 })
              : new Response(null, { status: 204 }),
          );
          await write;
          pending[1]!(Response.json({ keys: [key({ id: "k2" })], limit: 5 }));
          await load;
          expect(accessKeys.value?.map((k) => k.id)).toEqual(["k2"]);
          expect(accessKeysLimit.value).toBe(5);
        } finally {
          globalThis.fetch = original;
        }
      },
    );
  }
});
