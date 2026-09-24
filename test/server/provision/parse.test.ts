// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import { readSources } from "../../../src/server/provision/input.ts";
import {
  type Document,
  type Inventory,
  KINDS,
  type Kind,
  parse,
  preflight,
  type Source,
} from "../../../src/server/provision/parse.ts";
import {
  MAX_PASSWORD_BYTES,
  type SecretKind,
} from "../../../src/shared/words.ts";

const ROOT = "test/fixtures/provision";
const fixture = async (name: string): Promise<Source> => ({
  path: `${ROOT}/${name}.yaml`,
  text: await Bun.file(`${ROOT}/${name}.yaml`).text(),
});
const inventory = (existing: Partial<Inventory> = {}): Inventory => ({
  User: [],
  Project: [],
  Provider: [],
  Skill: [],
  McpServer: [],
  Agent: [],
  Tool: ["web", "websearch", "visualize"],
  ...existing,
});
const web = { mode: "all" as const, domains: [] };
const noDocs = () => ({ caps: DEFAULT_LIMITS, live: [] });
const secret = (kind: SecretKind, name: string) =>
  kind === "user-" && name === "user-zed" ? "test-password" : null;
function source(
  kind: Kind,
  name: string,
  spec: unknown,
  path = "input.yaml",
): Source {
  return {
    path,
    text: JSON.stringify({
      apiVersion: "config.1ctx.dev/v1",
      kind,
      metadata: { name },
      spec,
    }),
  };
}
function check(docs: Document[], existing: Partial<Inventory> = {}) {
  return preflight(docs, inventory(existing), secret, web, noDocs);
}

describe("provision documents", () => {
  test("parses all seven kinds and resolves forward references without I/O", async () => {
    const docs = parse([await fixture("good")]);
    expect([...new Set(docs.map((doc) => doc.kind))]).toEqual([...KINDS]);
    expect(docs.every((doc) => doc.source === `${ROOT}/good.yaml`)).toBe(true);
    expect(docs.find((doc) => doc.kind === "Agent")?.spec.servers).toEqual([
      { name: "toolbox", read: true, write: false },
    ]);
    check(docs.toReversed());
  });

  test.each([
    ["unknown-kind", "Limits/rounds", "kind"],
    ["unknown-api-version", "Project/nebula", "apiVersion"],
    ["unknown-field", "Agent/guide", "spec.prompts"],
    ["duplicate-name", "Project/nebula", "metadata.name"],
    ["bad-time-zone", "User/zed-user", "spec.tz"],
  ])(
    "refuses %s with a source, identity and field",
    async (file, identity, field) => {
      const input = await fixture(file!);
      expect(() => parse([input])).toThrow(input.path);
      expect(() => parse([input])).toThrow(identity!);
      expect(() => parse([input])).toThrow(field!);
    },
  );

  test("a name may appear once per kind, but not twice across files", () => {
    const a = source("Project", "nebula", {}, "a.yaml");
    const b = source("Project", "nebula", {}, "b.yml");
    expect(() => parse([a, b])).toThrow(
      "b.yml: Project/nebula: metadata.name is duplicated (first in a.yaml)",
    );
    expect(parse([a, source("Agent", "nebula", {})])).toHaveLength(2);
  });

  test("preserves absent fields and the defaults only inside a server pick", () => {
    expect(
      parse([source("Agent", "guide", { prompt: " Changed. " })])[0]?.spec,
    ).toEqual({
      prompt: "Changed.",
    });
    expect(
      parse([source("User", "zed-user", { role: "member" })])[0]?.spec,
    ).toEqual({
      role: "member",
    });
    expect(parse([source("McpServer", "toolbox", {})])[0]?.spec).toEqual({});
    const docs = parse([source("Agent", "guide", { skills: [], servers: [] })]);
    expect(docs[0]?.spec).toEqual({ skills: [], servers: [] });
  });

  test("normalizes present values the way the HTTP parsers do", () => {
    const docs = parse([
      source("User", "zed-user", { role: "member", email: "ZED@PEOPLE.TEST" }),
      source("Provider", "mock-provider", {
        baseUrl: "http://models.test/v1///",
      }),
      source("Agent", "guide", { prompt: " \nAnswer directly.\n " }),
      source("Tool", "visualize", {
        hosts: [
          "https://B.assets.test:443/",
          "https://a.assets.test",
          "https://a.assets.test/",
        ],
      }),
    ]);
    expect(docs.map((doc) => doc.spec)).toEqual([
      { role: "member", email: "zed@people.test" },
      { baseUrl: "http://models.test/v1" },
      { prompt: "Answer directly." },
      { hosts: ["https://a.assets.test", "https://b.assets.test"] },
    ]);
    expect(
      parse([
        source("Agent", "guide", { prompt: null, avatar: null, skills: null }),
      ])[0]?.spec,
    ).toEqual({ prompt: "", avatar: "bot", skills: [] });
  });

  test("keeps native YAML block scalars, directives and document ends", async () => {
    const docs = parse([
      await fixture("stream"),
      source("Tool", "web", { mode: "all" }, "next.yaml"),
    ]);
    expect(docs).toHaveLength(3);
    expect(docs[0]?.spec).toEqual({ prompt: "First.\n---\nLast.\n..." });
    expect(docs[1]?.source).toBe(`${ROOT}/stream.yaml`);
    expect(docs[2]?.source).toBe("next.yaml");
  });

  test("attributes a later document in a later file without changing its YAML", () => {
    const first = source("Project", "nebula", {}, "first.yaml");
    const later = {
      path: "later.yml",
      text: `${source("Tool", "web", { mode: "all" }).text}\n---\n${source("Agent", "guide", { mcpMode: "unknown" }).text}`,
    };
    expect(() => parse([first, later])).toThrow(
      "later.yml: Agent/guide: spec.mcpMode",
    );
  });

  test("ignores empty documents and comments without flattening a YAML sequence", () => {
    expect(parse([])).toEqual([]);
    expect(parse([{ path: "empty.yaml", text: "# Empty.\n---\n" }])).toEqual(
      [],
    );
    expect(() =>
      parse([{ path: "list.yaml", text: "- apiVersion: config.1ctx.dev/v1" }]),
    ).toThrow("list.yaml");
    expect(() => parse([{ path: "value.yaml", text: "42" }])).toThrow("object");
  });

  test("attributes YAML errors to the right source without echoing input text", () => {
    const invalid = { path: "broken.yaml", text: "password: [private-literal" };
    expect(() => parse([source("Project", "nebula", {}), invalid])).toThrow(
      "broken.yaml: invalid YAML",
    );
    try {
      parse([invalid]);
      throw new Error("expected invalid YAML");
    } catch (error) {
      expect((error as Error).message).not.toContain("private-literal");
    }
  });

  test("checks unknown fields at every object boundary", () => {
    for (const [field, body] of [
      ["extra", { extra: true }],
      ["metadata.extra", { metadata: { name: "nebula", extra: true } }],
      ["spec.extra", { spec: { extra: true } }],
    ] as const) {
      const base = JSON.parse(source("Project", "nebula", {}).text);
      expect(() =>
        parse([
          { path: "input.yaml", text: JSON.stringify({ ...base, ...body }) },
        ]),
      ).toThrow(field);
    }
    expect(() =>
      parse([
        source("Agent", "guide", {
          servers: [{ name: "toolbox", extra: true }],
        }),
      ]),
    ).toThrow("spec.servers[0].extra");
  });

  test.each([
    ["User", "xy", { role: "member" }],
    ["Project", "personal", {}],
    ["Provider", "Uppercase", {}],
    ["Skill", "paper_skill", {}],
    ["Skill", "paper--skill", {}],
    ["McpServer", "bad_name", {}],
    ["McpServer", "a".repeat(25), {}],
    ["Tool", "datetime", { enabled: true }],
    ["Tool", "webfetch", { enabled: true }],
    ["Tool", "webfetch", {}],
  ] satisfies [Kind, string, unknown][])(
    "checks %s/%s identity with its own name guard",
    (kind, name, spec) => {
      expect(() => parse([source(kind, name, spec)])).toThrow("metadata.name");
    },
  );

  test.each([
    ["User", "zed-user", {}, "role"],
    ["User", "zed-user", { role: "owner" }, "role"],
    ["User", "zed-user", { role: "member", disabled: "false" }, "disabled"],
    ["User", "zed-user", { role: "member", email: "zed@invalid" }, "email"],
    ["User", "zed-user", { role: "member", fullName: " Zed" }, "fullName"],
    ["User", "zed-user", { role: "member", about: "x".repeat(2001) }, "about"],
    [
      "User",
      "zed-user",
      { role: "member", passwordFrom: "user-zed.key" },
      "passwordFrom",
    ],
    [
      "User",
      "zed-user",
      { role: "member", mustChangePassword: null },
      "mustChangePassword",
    ],
    ["Project", "nebula", { description: "two\nlines" }, "description"],
    ["Project", "nebula", { members: ["zed-user", "zed-user"] }, "members"],
    [
      "Provider",
      "mock-provider",
      { baseUrl: "http://models.test/v1?q=x" },
      "baseUrl",
    ],
    ["Provider", "mock-provider", { wire: "unknown" }, "wire"],
    ["Provider", "mock-provider", { keyFrom: "user-zed" }, "keyFrom"],
    ["McpServer", "toolbox", { url: "https://user@mcp.test/mcp" }, "url"],
    ["McpServer", "toolbox", { timeoutMs: 1 }, "timeoutMs"],
    [
      "McpServer",
      "toolbox",
      { readPatterns: ["get*", "get*"] },
      "readPatterns",
    ],
    ["McpServer", "toolbox", { writePatterns: ["g*t"] }, "writePatterns"],
    ["McpServer", "toolbox", { keyFrom: "provider-token" }, "keyFrom"],
    ["Agent", "guide", { model: "" }, "model"],
    ["Agent", "guide", { avatar: "other" }, "avatar"],
    ["Agent", "guide", { thinking: true }, "thinking"],
    ["Agent", "guide", { effort: 1 }, "effort"],
    ["Agent", "guide", { mcpMode: "other" }, "mcpMode"],
    ["Agent", "guide", { skills: ["bad_name"] }, "skills"],
    ["Agent", "guide", { skills: ["paper-skill", "paper-skill"] }, "skills"],
    [
      "Agent",
      "guide",
      { servers: [{ name: "toolbox", read: false }] },
      "servers",
    ],
    [
      "Agent",
      "guide",
      { servers: [{ name: "toolbox", write: "false" }] },
      "servers[0].write",
    ],
    [
      "Agent",
      "guide",
      { servers: [{ name: "toolbox" }, { name: "toolbox" }] },
      "servers[1].name",
    ],
    ["Tool", "web", { provider: null }, "provider"],
    ["Tool", "web", { enabled: false }, "enabled"],
    ["Tool", "web", { hosts: [] }, "hosts"],
    ["Tool", "websearch", { enabled: false }, "enabled"],
    ["Tool", "websearch", { mode: "all" }, "mode"],
    ["Tool", "websearch", { hosts: [] }, "hosts"],
    ["Tool", "visualize", { hosts: ["http://assets.test"] }, "hosts"],
    ["Tool", "visualize", { domains: [] }, "domains"],
    ["Tool", "websearch", { provider: "other" }, "provider"],
  ] satisfies [Kind, string, unknown, string][])(
    "checks %s/%s field shape",
    (kind, name, spec, field) => {
      expect(() => parse([source(kind, name, spec)])).toThrow(`spec.${field}`);
    },
  );

  test("accepts any string effort without checking a live provider", () => {
    for (const effort of [null, "", "future-level"]) {
      const docs = parse([
        source("Agent", "guide", {
          provider: "mock-provider",
          model: "fake-model",
          effort,
        }),
      ]);
      check(docs, { Provider: ["mock-provider"] });
    }
  });

  test("validates skill source fields without fetching or accepting a digest", () => {
    expect(
      parse([
        source("Skill", "paper-skill", {
          url: "https://skills.test",
          fromIndex: true,
        }),
      ])[0]?.spec,
    ).toEqual({ url: "https://skills.test", fromIndex: true });
    expect(
      parse([
        source("Skill", "paper-skill", {
          url: "https://skills.test/pack.tgz",
          path: "skills/paper",
        }),
      ])[0]?.spec,
    ).toEqual({ url: "https://skills.test/pack.tgz", path: "skills/paper" });
    expect(
      parse([source("Skill", "paper-skill", { path: "" })])[0]?.spec,
    ).toEqual({ path: "" });
    for (const spec of [
      { url: "https://skills.test", fromIndex: false },
      { url: "https://skills.test/SKILL.md", fromIndex: true },
      { url: "https://skills.test/SKILL.md", path: "" },
      { url: "https://skills.test/pack.tar", path: "../paper" },
      { url: "https://skills.test/pack.tar", fromIndex: true, path: "" },
      { url: "https://skills.test", fromIndex: true, digest: "sha256:bad" },
    ]) {
      expect(() => parse([source("Skill", "paper-skill", spec)])).toThrow(
        "spec.",
      );
    }
  });
});

describe("provision preflight", () => {
  test.each([
    ["missing-reference", "Agent/guide", "spec.provider"],
    ["missing-password", "User/zed-user", "spec.passwordFrom"],
    ["missing-key", "Provider/mock-provider", "spec.keyFrom"],
  ])("refuses %s before apply", async (file, identity, field) => {
    const docs = parse([await fixture(file!)]);
    expect(() => check(docs)).toThrow(`${ROOT}/${file}.yaml`);
    expect(() => check(docs)).toThrow(identity!);
    expect(() => check(docs)).toThrow(field!);
  });

  test("resolves every name against the whole input and existing inventory", () => {
    const docs = parse([
      source("Agent", "guide", {
        provider: "mock-provider",
        model: "fake-model",
        skills: ["paper-skill"],
        servers: [{ name: "toolbox" }],
      }),
      source("Project", "nebula", { members: ["zed-user", "admin"] }),
    ]);
    const existing = {
      User: ["zed-user", "admin"],
      Provider: ["mock-provider"],
      Skill: ["paper-skill"],
      McpServer: ["toolbox"],
    };
    check(docs, existing);
    for (const [kind, field] of [
      ["User", "members"],
      ["Provider", "provider"],
      ["Skill", "skills"],
      ["McpServer", "servers"],
    ] as const) {
      expect(() => check(docs, { ...existing, [kind]: [] })).toThrow(
        `spec.${field}`,
      );
    }
  });

  test.each([
    ["User", "zed-user", { role: "member" }, "fullName"],
    ["Provider", "mock-provider", {}, "wire"],
    ["Skill", "paper-skill", {}, "url"],
    ["McpServer", "toolbox", {}, "url"],
    ["Agent", "guide", {}, "provider"],
  ] satisfies [Kind, string, unknown, string][])(
    "new %s requires creation fields, an update does not",
    (kind, name, spec, field) => {
      const docs = parse([source(kind, name, spec)]);
      expect(() => check(docs)).toThrow(`spec.${field} is required`);
      check(docs, { [kind]: [name] });
    },
  );

  test("checks every required new user field and the second provider/agent field", () => {
    const fields = {
      role: "member",
      fullName: "Zed User",
      email: "zed@people.test",
      tz: "UTC",
      passwordFrom: "user-zed",
    };
    for (const field of ["fullName", "email", "tz", "passwordFrom"]) {
      const spec = Object.fromEntries(
        Object.entries(fields).filter(([key]) => key !== field),
      );
      expect(() => check(parse([source("User", "zed-user", spec)]))).toThrow(
        `spec.${field}`,
      );
    }
    expect(() =>
      check(
        parse([
          source("Provider", "mock-provider", { wire: "openai-compatible" }),
        ]),
      ),
    ).toThrow("spec.baseUrl");
    expect(() =>
      check(parse([source("Agent", "guide", { provider: "mock-provider" })])),
    ).toThrow("spec.model");
  });

  test("a prospective bootstrap admin is treated as an existing user", () => {
    const docs = parse([
      source("User", "admin", { role: "admin", about: "The administrator." }),
    ]);
    check(docs, { User: ["admin"] });
  });

  test("checks password references on updates but never validates or returns their values", () => {
    const docs = parse([
      source("User", "zed-user", { role: "member", passwordFrom: "user-zed" }),
    ]);
    expect(() =>
      preflight(
        docs,
        inventory({ User: ["zed-user"] }),
        () => null,
        web,
        noDocs,
      ),
    ).toThrow("spec.passwordFrom");
    expect(
      preflight(
        docs,
        inventory({ User: ["zed-user"] }),
        () => "short",
        web,
        noDocs,
      ),
    ).toBeUndefined();
    expect(JSON.stringify(docs)).not.toContain("short");
  });

  test("new user passwords have the API floor and byte cap, without revealing a value", async () => {
    const docs = parse([await fixture("good")]);
    for (const value of ["short", "é".repeat(MAX_PASSWORD_BYTES / 2 + 1)]) {
      expect(() =>
        preflight(docs, inventory(), () => value, web, noDocs),
      ).toThrow("spec.passwordFrom");
      try {
        preflight(docs, inventory(), () => value, web, noDocs);
      } catch (error) {
        expect((error as Error).message).not.toContain(value);
      }
    }
    preflight(
      docs,
      inventory(),
      () => "é".repeat(MAX_PASSWORD_BYTES / 2),
      web,
      noDocs,
    );
  });

  test("secret failures never echo the callback error or returned values", () => {
    const docs = parse([
      source("McpServer", "toolbox", {
        url: "https://mcp.test/mcp",
        keyFrom: "mcp-toolbox",
      }),
    ]);
    for (const read of [
      () => null,
      () => "",
      () => {
        throw new Error("private-secret-value");
      },
    ]) {
      try {
        preflight(docs, inventory(), read, web, noDocs);
        throw new Error("expected missing secret");
      } catch (error) {
        expect((error as Error).message).toContain("spec.keyFrom");
        expect((error as Error).message).not.toContain("private-secret-value");
      }
    }
  });
});

describe("provision input loading", () => {
  test("loads sorted YAML files nonrecursively and preserves repeated input order", async () => {
    const paths = [`${ROOT}/inputs/20-project.yml`, `${ROOT}/inputs`];
    const inputs = await readSources(paths);
    expect(inputs.map((input) => input.path)).toEqual([
      `${ROOT}/inputs/20-project.yml`,
      `${ROOT}/inputs/10-user.yaml`,
      `${ROOT}/inputs/20-project.yml`,
    ]);
    expect(inputs.every((input) => input.text.includes("apiVersion:"))).toBe(
      true,
    );
    expect(() => parse(inputs)).toThrow("metadata.name is duplicated");
  });

  test("reads stdin once and treats each repeated - as another source", async () => {
    let reads = 0;
    const stdin = async () => {
      reads++;
      return source("Tool", "web", { mode: "off" }).text;
    };
    const inputs = await readSources(
      ["-", `${ROOT}/inputs/10-user.yaml`, "-"],
      stdin,
    );
    expect(reads).toBe(1);
    expect(inputs.map((input) => input.path)).toEqual([
      "-",
      `${ROOT}/inputs/10-user.yaml`,
      "-",
    ]);
    expect(() => parse(inputs)).toThrow(
      "-: Tool/web: metadata.name is duplicated",
    );
  });

  test("reads every input before parsing any YAML", async () => {
    await expect(
      readSources([`${ROOT}/unknown-field.yaml`, `${ROOT}/absent.yaml`]),
    ).rejects.toThrow(`${ROOT}/absent.yaml: could not read input`);
    const inputs = await readSources(
      [`${ROOT}/inputs`, "-"],
      async () => source("Tool", "web", { mode: "all" }).text,
    );
    expect(parse(inputs)).toHaveLength(3);
  });

  test("refuses no inputs and identifies stdin read errors", async () => {
    await expect(readSources([])).rejects.toThrow("-f");
    await expect(
      readSources(["-"], async () => {
        throw new Error("read failed");
      }),
    ).rejects.toThrow("-: could not read stdin");
  });
});
