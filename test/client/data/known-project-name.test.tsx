// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's name as a crumb knows it: the row, else the rail's list,
// null (a bone) until either lands, and "" once the list failed, so
// every page's crumb drops a bone that would never land, while a row
// that loads still names it.

import { afterEach, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { path } from "../../../src/client/app/router.ts";
import {
  automationError,
  automationProject,
  automations,
} from "../../../src/client/data/automations.ts";
import {
  knownProjectName,
  project,
  projects,
  projectsError,
} from "../../../src/client/data/projects.ts";
import { Automation } from "../../../src/client/views/projects/Automation.tsx";
import type {
  ProjectDetail,
  ProjectSummary,
} from "../../../src/shared/contracts/project.ts";
import { withClass } from "../../helpers/classes.ts";

afterEach(() => {
  project.value = null;
  projects.value = null;
  projectsError.value = null;
  path.value = "/";
});

const listed = {
  id: "p1",
  kind: "team",
  name: "infra",
  createdAt: 0,
  memberCount: 1,
} as ProjectSummary;

test.serial("the row, else the list, else a bone, else nothing", () => {
  expect(knownProjectName("p1")).toBeNull();
  expect(knownProjectName(null)).toBeNull();
  projects.value = [listed];
  expect(knownProjectName("p1")).toBe("infra");
  project.value = { ...listed, name: "infra-row" } as ProjectDetail;
  expect(knownProjectName("p1")).toBe("infra-row");
  project.value = null;
  projects.value = null;
  projectsError.value = { words: "down", status: 500 };
  expect(knownProjectName("p1")).toBe("");
  expect(knownProjectName(null)).toBe("");
  // the row still names it once it lands
  project.value = { ...listed, name: "infra-row" } as ProjectDetail;
  expect(knownProjectName("p1")).toBe("infra-row");
});

test.serial("an automation's crumb drops its bone when the list failed", () => {
  automations.value = null;
  automationProject.value = null;
  automationError.value = null;
  path.value = "/automations/a1";
  const waiting = render(<Automation params={{ id: "a1" }} />);
  // the project's bone and the name's
  expect(withClass(waiting, "page-crumb-bone")).toBe(2);
  projectsError.value = { words: "down", status: 500 };
  const failed = render(<Automation params={{ id: "a1" }} />);
  expect(withClass(failed, "page-crumb-bone")).toBe(1);
  expect(failed).not.toContain('class="page-crumb-sep"');
});
