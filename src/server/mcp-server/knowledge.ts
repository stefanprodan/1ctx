// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { KnowledgeAuthor } from "../../shared/contracts/knowledge.ts";
import { transact } from "../db/index.ts";
import { BadRequest, Conflict, NotFound } from "../lib/errors.ts";
import { sha256 } from "../lib/ids.ts";
import type { KnowledgeInput } from "./parse.ts";
import type { KeyPrincipal, McpServerDeps } from "./ports.ts";
import {
  asSent,
  cappedLines,
  dataLabel,
  jsonLine,
  MCP_FILE_BYTES,
  type McpResult,
  mimeType,
  textResult,
} from "./result.ts";

const metadata = (file: {
  id: string;
  name: string;
  kind?: string;
  bytes: number;
  lines: number;
  revision: number;
}) => ({
  id: file.id,
  name: file.name,
  kind: file.kind,
  bytes: file.bytes,
  lines: file.lines,
  revision: file.revision,
});

// what decides a list's order and members: an edit to a file already
// read never refuses the next page
const listStamp = (rows: readonly { id: string; name: string }[]): string =>
  sha256(JSON.stringify(rows.map((row) => [row.id, row.name])));

const versionsStamp = (
  rows: readonly { id: string; name: string; revision: number }[],
): string =>
  sha256(JSON.stringify(rows.map((row) => [row.id, row.name, row.revision])));

const author = (principal: KeyPrincipal): KnowledgeAuthor => ({
  kind: "user",
  id: principal.userId,
  name: principal.username,
  sessionId: null,
  origin: "key",
  keyName: principal.via.name,
});

const pathUri = (projectId: string, name: string, revision: number): string => {
  const path = name.split("/").map(encodeURIComponent).join("/");
  return `1ctx://${projectId}/knowledge/${path}?revision=${revision}`;
};

function wholeFile(fields: {
  projectId: string;
  name: string;
  revision: number;
  text: string;
  deleted?: boolean;
}): McpResult {
  const bytes = Buffer.byteLength(fields.text);
  if (bytes >= MCP_FILE_BYTES) {
    throw new BadRequest(
      `${fields.name} is ${bytes} bytes, more than /mcp sends; read it on the page`,
    );
  }
  // the stored text exactly, as an edit's old must match it
  return {
    content: [
      {
        type: "text",
        text: `${dataLabel("Knowledge file")} Revision ${fields.revision}${fields.deleted ? " deletes the file" : ""}.`,
      },
      {
        type: "resource",
        resource: {
          uri: pathUri(fields.projectId, fields.name, fields.revision),
          mimeType: mimeType(fields.name),
          text: fields.text,
        },
      },
    ],
  };
}

function write(
  deps: McpServerDeps,
  principal: KeyPrincipal,
  projectId: string,
  perform: (writer: KnowledgeAuthor) => {
    id: string;
    name: string;
    revision: number;
  },
): McpResult {
  const file = transact(deps.db, () => {
    deps.access.checkKey(principal, projectId);
    return { result: perform(author(principal)) };
  });
  return textResult(
    jsonLine({ id: file.id, name: file.name, revision: file.revision }),
  );
}

export function knowledgeTool(
  deps: McpServerDeps,
  principal: KeyPrincipal,
  input: KnowledgeInput,
): McpResult {
  const project = deps.access.project(principal, input.projectId);
  if (input.action === "list") {
    const all = deps.knowledge.list(project.id).files;
    const stamp = listStamp(all);
    if (input.stamp !== null && input.stamp !== stamp) {
      throw new Conflict("the file list changed; read from the start");
    }
    const files = all.filter(
      (file) => input.after === null || file.name > input.after,
    );
    return textResult(
      cappedLines(
        files.map((file) => jsonLine(metadata(file))),
        (next) =>
          `Read on with knowledge action=list, projectId=${project.id}, after=${JSON.stringify(files[next - 1]!.name)}, stamp=${stamp}.`,
      ),
    );
  }
  if (input.action === "search") {
    const found = deps.knowledge.search(
      project.id,
      principal.userId,
      input.q,
      input.after,
    );
    const lines = [
      ...found.names.map((file) =>
        jsonLine({ match: "name", file: metadata(file) }),
      ),
      ...found.files.map((hit) =>
        jsonLine({
          match: "text",
          file: metadata(hit.file),
          count: hit.count,
          lines: hit.lines.map((line) => ({
            ...line,
            text: asSent(line.text),
          })),
        }),
      ),
    ];
    if (found.next !== null) {
      lines.push(
        `Read on with knowledge action=search, projectId=${project.id}, q=${JSON.stringify(input.q)}, after=${JSON.stringify(found.next)}.`,
      );
    }
    return textResult(
      `${dataLabel("Knowledge search results")}\n${lines.join("\n")}`,
    );
  }
  if (input.action === "read") {
    const file = deps.knowledge.rawFile(project.id, input.fileId);
    if (file === null) throw new NotFound();
    return wholeFile({
      projectId: project.id,
      name: file.name,
      revision: file.revision,
      text: file.text,
    });
  }
  if (input.action === "versions") {
    const all = deps.knowledge.versions(project.id, input.fileId);
    const stamp = versionsStamp(all);
    if (input.stamp !== null && input.stamp !== stamp) {
      throw new Conflict("the version list changed; read from the start");
    }
    const start =
      input.after === null
        ? 0
        : all.findIndex((version) => version.id === input.after) + 1;
    if (input.after !== null && start === 0) {
      throw new Conflict("the version list changed; read from the start");
    }
    const versions = all.slice(start);
    return textResult(
      cappedLines(
        versions.map((version) =>
          jsonLine({
            id: version.id,
            fileId: version.fileId,
            name: version.name,
            revision: version.revision,
            bytes: version.bytes,
            lines: version.lines,
            writtenAt: version.writtenAt,
            deleted: version.deleted,
          }),
        ),
        (next) =>
          `Read on with knowledge action=versions, projectId=${project.id}, fileId=${input.fileId}, after=${versions[next - 1]!.id}, stamp=${stamp}.`,
      ),
    );
  }
  if (input.action === "version") {
    const version = deps.knowledge.rawVersion(project.id, input.versionId);
    if (version === null) throw new NotFound();
    return wholeFile({
      projectId: project.id,
      name: version.name,
      revision: version.revision,
      text: version.text,
      deleted: version.deleted,
    });
  }
  if (input.action === "create") {
    return write(deps, principal, project.id, (by) =>
      deps.knowledge.create(project.id, by, input.name, input.text),
    );
  }
  if (input.action === "edit") {
    return write(deps, principal, project.id, (by) =>
      deps.knowledge.edit(
        project.id,
        by,
        input.fileId,
        input.revision,
        input.edits,
      ),
    );
  }
  if (input.action === "replace") {
    return write(deps, principal, project.id, (by) =>
      deps.knowledge.replace(
        project.id,
        by,
        input.fileId,
        input.text,
        input.revision,
      ),
    );
  }
  if (input.action === "rename") {
    return write(deps, principal, project.id, (by) =>
      deps.knowledge.rename(
        project.id,
        by,
        input.fileId,
        input.name,
        input.revision,
      ),
    );
  }
  return write(deps, principal, project.id, (by) =>
    deps.knowledge.remove(project.id, by, input.fileId, input.revision),
  );
}
