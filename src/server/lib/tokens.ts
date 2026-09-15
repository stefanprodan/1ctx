// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Token counts for what a page shows, through OpenAI's o200k_base
// encoding. It is exact for OpenAI models and close for the open ones
// on English and code; other vendors count their own way, so a count is
// shown as an estimate. Only the one encoding is imported, since each
// carries its whole vocabulary into the binary.

import { countTokens } from "gpt-tokenizer/encoding/o200k_base";

export function tokens(text: string): number {
  return text === "" ? 0 : countTokens(text);
}
