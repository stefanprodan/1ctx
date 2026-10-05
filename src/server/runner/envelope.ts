// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { LastLine, Message } from "../../shared/contracts/session.ts";
import { lineFrom } from "../sessions/index.ts";

// undefined for a row with nothing to say, so the envelope keeps the
// line the client holds rather than showing an empty one
export const lastLine = (
  message: Message,
  author: string,
): LastLine | undefined => {
  const text = lineFrom(message.content);
  return text === "" ? undefined : { seq: message.seq, author, text };
};

// the last line a finished answer gives, none for any other row
export const answerLine = (
  row: Message | null,
  author: string,
): LastLine | undefined =>
  row?.status === "done" && row.slot === "answer"
    ? lastLine(row, author)
    : undefined;
