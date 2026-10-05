// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The Copy button of a rendered code block. The HTML comes from
// render/ with the button in it, so whoever shows such HTML delegates
// clicks here rather than wiring each block.

import { copyText } from "../lib/clipboard.ts";

export async function copyCode(ev: MouseEvent): Promise<void> {
  if (!(ev.target instanceof Element)) return;
  const b = ev.target.closest(".md-copy");
  if (!b) return;
  const code = b.closest(".md-block")?.querySelector(".md-block-code");
  if (!code) return;
  // no clipboard: the button stays as it is
  if (!(await copyText(code.textContent ?? ""))) return;
  b.classList.add("md-copy-copied");
  setTimeout(() => {
    if (b.isConnected) b.classList.remove("md-copy-copied");
  }, 1200);
}
