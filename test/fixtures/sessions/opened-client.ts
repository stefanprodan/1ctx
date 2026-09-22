// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A turn whose bash call opened three files and whose second call drew
// a visual, so the cards can be asserted in call order.

import type { OpenedFileResponse } from "../../../src/shared/api/sessions.ts";
import type {
  Message,
  OpenedFile,
  SessionDetail,
} from "../../../src/shared/contracts/session.ts";
import type { MessageStatus } from "../../../src/shared/words.ts";
import { visualCall, visualDetail, visualRow } from "./visual-client.ts";

export const BASH_ROW = "tool0000001";

export const opens: OpenedFile[] = [
  {
    path: "/tmp/chart.html",
    kind: "visual",
    language: null,
    bytes: 120,
    lines: 4,
    title: "Deploys",
  },
  {
    path: "/knowledge/plans/open.md",
    kind: "markdown",
    language: null,
    bytes: 900,
    lines: 40,
    title: null,
  },
  {
    path: "/tmp/deploy.yaml",
    kind: "code",
    language: "yaml",
    bytes: 200,
    lines: 6,
    title: null,
  },
];

export const bashCall = {
  id: "call0",
  name: "bash",
  arguments: JSON.stringify({ command: "open /tmp/chart.html" }),
};

export function openedRow(fields: Partial<Message> = {}): Message {
  return visualRow({
    id: BASH_ROW,
    seq: 3,
    kind: "tool",
    slot: null,
    status: "done",
    toolCallId: "call0",
    toolName: "bash",
    files: opens,
    ...fields,
  });
}

// the work reply, the bash row with its opens, then the visualize row
export function openedDetail(
  fields: { status?: MessageStatus; files?: OpenedFile[] | null } = {},
): SessionDetail {
  const detail = visualDetail();
  detail.live = null;
  detail.messages = [
    visualRow({ status: "done", toolCalls: [bashCall, visualCall] }),
    openedRow({
      status: fields.status ?? "done",
      files: fields.files === undefined ? opens : fields.files,
    }),
    visualRow({
      id: "tool0000002",
      seq: 4,
      kind: "tool",
      slot: null,
      status: "done",
      toolCallId: "call1",
      toolName: "visualize",
    }),
  ];
  return detail;
}

export function openedAnswer(
  file: OpenedFile,
  fields: Partial<OpenedFileResponse> = {},
): OpenedFileResponse {
  const html =
    file.kind === "visual"
      ? "<h1>Deploys</h1>"
      : file.kind === "markdown"
        ? '<p class="md-p">the plan</p>'
        : '<span class="hljs-string">on</span>: true';
  return {
    ...file,
    html,
    text: file.kind === "visual" ? "" : "on: true\n",
    ...fields,
  };
}
