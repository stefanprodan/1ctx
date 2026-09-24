// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  KEY_BYTES,
  type KeyState,
  MAX_CREDENTIALS_PER_PROJECT,
} from "../../shared/contracts/credential.ts";
import type { WebAccess } from "../../shared/web.ts";
import {
  isName,
  isServerName,
  isSkillName,
  isUsername,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD,
  PERSONAL_PROJECT_NAME,
  type SecretKind,
} from "../../shared/words.ts";
import { parseUserPassword } from "../access/index.ts";
import { prefixesOverlap } from "../credentials/index.ts";
import { checkFile, checkNames, checkTotals } from "../knowledge/index.ts";
import type { KnowledgeCaps } from "../limits/index.ts";
import { object } from "./fields.ts";
import * as spec from "./spec.ts";

export const KINDS = [
  "User",
  "Project",
  "Credential",
  "Provider",
  "Skill",
  "McpServer",
  "Agent",
  "Tool",
] as const;

export type Kind = (typeof KINDS)[number];
export type Source = { path: string; text: string };
export type Inventory = Record<Kind, string[]>;
// a team project's live docs and the limits they are held to, empty for
// a project not made yet
export type ProjectDocs = (project: string) => {
  caps: KnowledgeCaps;
  live: { name: string; bytes: number }[];
};
// the credentials the database holds, and what a key file's value is
// now, for the checks that span objects
export type CredentialsView = {
  key(name: string): KeyState;
  list(): { name: string; prefix: string; projects: string[] }[];
};

// a project doc read from the folder spec.knowledge names; bytes are
// the text's UTF-8 length, as the store counts them
export type KnowledgeDoc = { name: string; text: string; bytes: number };
export type Document = {
  [K in Kind]: {
    source: string;
    kind: K;
    name: string;
    spec: spec.Specs[K];
  } & (K extends "Project" ? { docs?: KnowledgeDoc[] } : unknown);
}[Kind];

export type {
  AgentSpec,
  CredentialSpec,
  McpServerSpec,
  ProjectSpec,
  ProviderSpec,
  SkillSpec,
  ToolSpec,
  UserSpec,
} from "./spec.ts";

function document(value: unknown, source: string): Document {
  const raw =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const metadata = raw.metadata as Record<string, unknown> | undefined;
  const label = `${typeof raw.kind === "string" ? raw.kind : "?"}/${
    typeof metadata?.name === "string" ? metadata.name : "?"
  }`;
  try {
    const b = object(value, ["apiVersion", "kind", "metadata", "spec"], "");
    if (b.apiVersion !== "config.1ctx.dev/v1") {
      throw new Error("apiVersion must be config.1ctx.dev/v1");
    }
    if (!KINDS.includes(b.kind as Kind)) {
      throw new Error("kind must be a supported kind");
    }
    const kind = b.kind as Kind;
    const meta = object(b.metadata, ["name"], "metadata");
    const guard = {
      User: isUsername,
      Project: isName,
      Credential: isName,
      Provider: isName,
      Skill: isSkillName,
      McpServer: isServerName,
      Agent: isName,
      Tool: (name: unknown): name is string =>
        name === "web" || name === "websearch" || name === "visualize",
    }[kind];
    if (!guard(meta.name)) throw new Error("metadata.name is invalid");
    const name = meta.name;
    if (kind === "Project" && name === PERSONAL_PROJECT_NAME) {
      throw new Error(
        "metadata.name personal is reserved for personal projects",
      );
    }
    const base = { source, name };
    switch (kind) {
      case "User":
        return { ...base, kind, spec: spec.user(b.spec) };
      case "Project":
        return { ...base, kind, spec: spec.project(b.spec) };
      case "Credential":
        return { ...base, kind, spec: spec.credential(b.spec) };
      case "Provider":
        return { ...base, kind, spec: spec.provider(b.spec) };
      case "Skill":
        return { ...base, kind, spec: spec.skill(b.spec) };
      case "McpServer":
        return { ...base, kind, spec: spec.mcpServer(b.spec) };
      case "Agent":
        return { ...base, kind, spec: spec.agent(b.spec) };
      case "Tool":
        return { ...base, kind, spec: spec.tool(b.spec, name) };
    }
  } catch (error) {
    throw new Error(`${source}: ${label}: ${(error as Error).message}`);
  }
}

function duplicate(documents: Document[]): void {
  const seen = new Map<string, string>();
  for (const doc of documents) {
    const key = `${doc.kind}/${doc.name}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new Error(
        `${doc.source}: ${key}: metadata.name is duplicated (first in ${previous})`,
      );
    }
    seen.set(key, doc.source);
  }
}

export function parse(sources: Source[]): Document[] {
  if (sources.length === 0) return [];
  // Boundary documents keep native multi-document parsing and source
  // attribution together, without treating "---" in a scalar as a split.
  const boundary = crypto.randomUUID();
  const stream = sources
    .map(({ text }, index) => {
      const body = text.replace(/^\uFEFF/, "");
      const explicit =
        /^(?:[ \t]*(?:#[^\r\n]*)?\r?\n)*(?:---(?:[ \t\r\n]|$)|%)/.test(body);
      return `---\n${JSON.stringify([boundary, index])}\n...\n${
        explicit ? "" : "---\n"
      }${body}\n`;
    })
    .join("");
  let values: unknown;
  try {
    values = Bun.YAML.parse(stream);
  } catch {
    // Native syntax errors may quote input text. Report only its source,
    // never a value that could have been pasted into the wrong field.
    for (const source of sources) {
      try {
        Bun.YAML.parse(source.text);
      } catch {
        throw new Error(`${source.path}: invalid YAML`);
      }
    }
    throw new Error(
      `${sources.map((s) => s.path).join(", ")}: invalid YAML stream`,
    );
  }
  const documents: Document[] = [];
  let source = sources[0]!.path;
  for (const value of Array.isArray(values) ? values : [values]) {
    if (Array.isArray(value) && value.length === 2 && value[0] === boundary) {
      source = sources[value[1] as number]!.path;
    } else if (value !== null && value !== undefined) {
      documents.push(document(value, source));
    }
  }
  duplicate(documents);
  return documents;
}

export function preflight(
  documents: Document[],
  inventory: Inventory,
  secret: (kind: SecretKind, name: string) => string | null,
  web: Pick<WebAccess, "mode" | "domains">,
  projectDocs: ProjectDocs,
  credentials: CredentialsView,
): void {
  duplicate(documents);
  const known = Object.fromEntries(
    KINDS.map((kind) => [kind, new Set(inventory[kind])]),
  ) as Record<Kind, Set<string>>;
  for (const doc of documents) known[doc.kind].add(doc.name);
  for (const doc of documents) {
    const fail = (field: string, message: string): never => {
      throw new Error(
        `${doc.source}: ${doc.kind}/${doc.name}: spec.${field} ${message}`,
      );
    };
    const reference = (field: string, kind: Kind, name: string) => {
      if (!known[kind].has(name))
        fail(field, `references missing ${kind}/${name}`);
    };
    const required = (fields: string[]) => {
      for (const field of fields) {
        if (!Object.hasOwn(doc.spec, field))
          fail(field, "is required for a new object");
      }
    };
    const readSecret = (field: string, kind: SecretKind, name: string) => {
      let value: string | null;
      try {
        value = secret(kind, name);
      } catch {
        return fail(field, `could not read secret ${name}.key`);
      }
      if (value === null || value === "")
        fail(field, `secret ${name}.key is missing or empty`);
      return value;
    };
    const exists = inventory[doc.kind].includes(doc.name);
    switch (doc.kind) {
      case "User": {
        if (!exists) required(["fullName", "email", "tz", "passwordFrom"]);
        if (doc.spec.passwordFrom !== undefined) {
          const password = readSecret(
            "passwordFrom",
            "user-",
            doc.spec.passwordFrom,
          );
          if (!exists) {
            try {
              parseUserPassword({ password });
            } catch {
              fail(
                "passwordFrom",
                `secret must contain a password of ${MIN_PASSWORD} to ${MAX_PASSWORD_BYTES} bytes`,
              );
            }
          }
        }
        break;
      }
      case "Project":
        for (const name of doc.spec.members ?? [])
          reference("members", "User", name);
        if (doc.docs !== undefined) {
          const { caps, live } = projectDocs(doc.name);
          const named = new Set(doc.docs.map((file) => file.name));
          const kept = live.filter((file) => !named.has(file.name));
          const previous = new Map(live.map((file) => [file.name, file.bytes]));
          const bytes = (files: { bytes: number }[]) =>
            files.reduce((sum, file) => sum + file.bytes, 0);
          try {
            for (const file of doc.docs) {
              checkFile(
                file.name,
                file.bytes,
                previous.get(file.name) ?? 0,
                caps,
              );
            }
            checkNames([...kept.map((file) => file.name), ...named]);
            checkTotals(
              { files: live.length, bytes: bytes(live) },
              {
                files: kept.length + doc.docs.length,
                bytes: bytes(kept) + bytes(doc.docs),
              },
              caps,
            );
          } catch (error) {
            fail("knowledge", (error as Error).message);
          }
        }
        break;
      case "Credential": {
        if (!exists) required(["keyFrom", "url", "header", "value"]);
        const keyFrom = doc.spec.keyFrom;
        if (keyFrom !== undefined) {
          const state = credentials.key(keyFrom);
          if (state === "missing")
            fail("keyFrom", `secret ${keyFrom}.key is missing`);
          if (state === "unusable") {
            fail(
              "keyFrom",
              `secret ${keyFrom}.key must hold ${KEY_BYTES.min} to ${KEY_BYTES.max} visible ASCII characters`,
            );
          }
        }
        for (const name of doc.spec.projects ?? []) {
          if (name === PERSONAL_PROJECT_NAME) {
            fail("projects", "cannot name a personal project");
          }
          reference("projects", "Project", name);
        }
        break;
      }
      case "Provider":
        if (!exists) required(["wire", "baseUrl"]);
        if (doc.spec.keyFrom)
          readSecret("keyFrom", "provider-", doc.spec.keyFrom);
        break;
      case "Skill":
        if (!exists) required(["url"]);
        break;
      case "McpServer":
        if (!exists) required(["url"]);
        if (doc.spec.keyFrom) readSecret("keyFrom", "mcp-", doc.spec.keyFrom);
        break;
      case "Agent":
        if (!exists) required(["provider", "model"]);
        if (doc.spec.provider !== undefined)
          reference("provider", "Provider", doc.spec.provider);
        for (const name of doc.spec.skills ?? [])
          reference("skills", "Skill", name);
        for (const server of doc.spec.servers ?? [])
          reference("servers", "McpServer", server.name);
        break;
      case "Tool":
        if (
          doc.name === "web" &&
          (doc.spec.mode ?? web.mode) === "listed" &&
          (doc.spec.domains ?? web.domains).length === 0
        ) {
          fail("domains", "list at least one host");
        }
        break;
    }
  }
  bindings(documents, credentials);
}

// the credentials each project would hold once applied: no more than the
// cap, and no two whose prefixes overlap
type Binding = { name: string; prefix: string; projects: string[] };

function bindings(documents: Document[], credentials: CredentialsView): void {
  const final = new Map<string, Binding & { source?: string }>(
    credentials.list().map((row) => [row.name, row]),
  );
  for (const doc of documents) {
    if (doc.kind !== "Credential") continue;
    const held = final.get(doc.name);
    final.set(doc.name, {
      name: doc.name,
      prefix: doc.spec.url ?? held?.prefix ?? "",
      projects: doc.spec.projects ?? held?.projects ?? [],
      source: doc.source,
    });
  }
  // documents last, so the one blamed is one the input names
  const rows = [...final.values()].sort(
    (a, b) =>
      Number(a.source !== undefined) - Number(b.source !== undefined) ||
      a.name.localeCompare(b.name),
  );
  const byProject = new Map<string, Binding[]>();
  for (const row of rows) {
    const fail = (message: string): never => {
      throw new Error(
        `${row.source}: Credential/${row.name}: spec.projects ${message}`,
      );
    };
    for (const project of row.projects) {
      const list = byProject.get(project) ?? [];
      const overlap = list.find((other) =>
        prefixesOverlap(other.prefix, row.prefix),
      );
      if (overlap !== undefined) {
        fail(`${project}: the prefix overlaps Credential/${overlap.name}`);
      }
      if (list.length >= MAX_CREDENTIALS_PER_PROJECT) {
        fail(
          `${project}: a project holds at most ${MAX_CREDENTIALS_PER_PROJECT} credentials`,
        );
      }
      list.push(row);
      byProject.set(project, list);
    }
  }
}
