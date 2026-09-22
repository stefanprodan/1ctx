// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { OpenedFileResponse } from "../../shared/api/sessions.ts";
import type { OpenedRecord } from "../knowledge/index.ts";
import { escapeHtml, highlight, renderMarkdown } from "../render/index.ts";

export function openedFileResponse(file: OpenedRecord): OpenedFileResponse {
  if (file.kind === "visual") return { ...file, html: file.text, text: "" };
  if (file.kind === "markdown") {
    return { ...file, html: renderMarkdown(file.text), text: file.text };
  }
  const html =
    file.language === null
      ? escapeHtml(file.text)
      : (highlight(file.text, file.language) ?? escapeHtml(file.text));
  return { ...file, html, text: file.text };
}
