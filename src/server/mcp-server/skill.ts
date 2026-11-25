// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import {
  memorySkillFiles,
  SkillCatalog,
} from "@modelcontextprotocol/server/ext/skills";
import skill from "../../../skills/external-tasks/SKILL.md" with {
  type: "text",
};
import type { Log } from "../lib/log.ts";

export { skill };

// strict, so a SKILL.md the extension would warn about fails instead;
// a warning's text names files, so only the phrase is logged
export const skillCatalog = (log: Log): Promise<SkillCatalog> =>
  SkillCatalog.load(memorySkillFiles({ "external-tasks/SKILL.md": skill }), {
    strict: true,
    onWarning: () => log.warn("mcp skill warning"),
  });
