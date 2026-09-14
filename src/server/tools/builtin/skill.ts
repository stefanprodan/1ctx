// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { OfferedSkill } from "../../../shared/contracts/skill.ts";
import { skillContent } from "../../../shared/skills.ts";
import type { SkillBody } from "../../skills/index.ts";
import type { Tool } from "../types.ts";

export type SkillToolsPort = {
  body(id: string, name: string): SkillBody | null;
  file(id: string, name: string, path: string): string | null;
};

function named(args: Record<string, unknown>): string {
  if (typeof args.name !== "string" || args.name === "") {
    throw new Error("name must be a skill name");
  }
  return args.name;
}

function offeredSkill(
  offered: OfferedSkill[],
  args: Record<string, unknown>,
): OfferedSkill {
  const name = named(args);
  const skill = offered.find((item) => item.name === name);
  if (skill === undefined)
    throw new Error(`skill ${name} is no longer available`);
  return skill;
}

export function makeSkillTools(
  offered: OfferedSkill[],
  skills: SkillToolsPort,
): Tool[] {
  if (offered.length === 0) return [];
  const names = offered.map((skill) => skill.name);
  const hasFileTool = offered.some((skill) => skill.hasFiles);
  const tools: Tool[] = [
    {
      name: "skill",
      description:
        "Load the full instructions for one available skill before using it.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            enum: names,
            description: "The available skill to load.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      async run(args) {
        const snapshot = offeredSkill(offered, args);
        const row = skills.body(snapshot.id, snapshot.name);
        if (row === null) {
          throw new Error(`skill ${snapshot.name} is no longer available`);
        }
        return skillContent({
          name: row.name,
          compatibility: row.compatibility,
          body: row.body,
          files: hasFileTool ? row.files : null,
        });
      },
    },
  ];
  if (hasFileTool) {
    tools.push({
      name: "skill_file",
      description: "Read one text file belonging to an available skill.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", enum: names, description: "The skill name." },
          path: {
            type: "string",
            description: "The file path listed by the skill.",
          },
        },
        required: ["name", "path"],
        additionalProperties: false,
      },
      async run(args) {
        const snapshot = offeredSkill(offered, args);
        if (typeof args.path !== "string" || args.path === "") {
          throw new Error("path must be a skill file path");
        }
        const row = skills.body(snapshot.id, snapshot.name);
        if (row === null) {
          throw new Error(`skill ${snapshot.name} is no longer available`);
        }
        const content = skills.file(snapshot.id, snapshot.name, args.path);
        if (content === null) {
          const available =
            row.files.length === 0 ? "none" : row.files.join(", ");
          throw new Error(
            `no file ${args.path}; available paths: ${available}`,
          );
        }
        return content;
      },
    });
  }
  return tools;
}
