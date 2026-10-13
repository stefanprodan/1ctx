// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  createBody,
  defaultDrafts,
  draftOf,
  footOf,
  LABEL_NAME_PROBLEM,
  LABEL_REPEAT_PROBLEM,
  labelFieldOf,
  labelNameProblem,
  labelsBody,
  labelsProblem,
  openOf,
  patchBody,
} from "../../../src/client/views/projects/Labels.model.ts";

const build = { id: "l1", name: "build", description: "New work" };

describe("a project's labels", () => {
  test("a delete asked for gives way once its label is the last", () => {
    expect(footOf(null, false, false)).toBe("add");
    expect(footOf(build, false, false)).toBe("delete");
    expect(footOf(build, false, true)).toBe("asking");
    // a refresh left one label: the ask has nothing to confirm
    expect(footOf(build, true, true)).toBe("last");
    expect(footOf(build, true, false)).toBe("last");
  });

  test("a create sends the name as saved and leaves out no description", () => {
    expect(createBody({ name: " Build ", description: "  " })).toEqual({
      name: "build",
    });
    expect(createBody({ name: "ops", description: " Pages " })).toEqual({
      name: "ops",
      description: "Pages",
    });
  });

  test("an edit sends only what changed against the row it opened on", () => {
    expect(patchBody(draftOf(build), build)).toBeNull();
    expect(patchBody({ name: "BUILD ", description: "New work" }, build)).toBe(
      null,
    );
    expect(patchBody({ name: "make", description: "New work" }, build)).toEqual(
      { name: "make" },
    );
    expect(patchBody({ name: "build", description: "" }, build)).toEqual({
      description: "",
    });
  });

  test("a row deleted elsewhere closes its form", () => {
    expect(openOf(build, [build])).toBe(build);
    expect(openOf(build, [])).toBeNull();
    expect(openOf("new", [])).toBe("new");
  });

  test("a refusal names its field", () => {
    expect(labelFieldOf("name is taken")).toBe("name");
    expect(labelFieldOf("description must be one trimmed line")).toBe(
      "description",
    );
    expect(labelFieldOf("a project holds at most 20 labels")).toBeUndefined();
  });

  test("a new project's form starts with the four and sends them", () => {
    const drafts = defaultDrafts();
    expect(drafts.map((d) => d.name)).toEqual([
      "research",
      "plan",
      "build",
      "fix",
    ]);
    expect(new Set(drafts.map((d) => d.key)).size).toBe(4);
    expect(labelsBody(drafts)[3]).toEqual({
      name: "fix",
      description: "A defect or failure to correct",
    });
  });

  test("a label's name is checked before a send", () => {
    const draft = (name: string) => ({ name, description: "" });
    expect(labelNameProblem(draft(" Ops "))).toBeNull();
    expect(labelNameProblem(draft("back end"))).toEqual({
      field: "name",
      error: LABEL_NAME_PROBLEM,
    });
    expect(labelNameProblem(draft(""))?.field).toBe("name");
  });

  test("a new project's drafts are checked at their inputs before a send", () => {
    const drafts = (...names: string[]) =>
      names.map((name) => ({ name, description: "" }));
    expect(labelsProblem(drafts(" Ops ", "build"))).toBeNull();
    expect(labelsProblem(drafts("ops", "back end"))).toEqual({
      field: "labels.1.name",
      error: LABEL_NAME_PROBLEM,
    });
    expect(labelsProblem(drafts("", "ops"))?.field).toBe("labels.0.name");
    expect(labelsProblem(drafts("-ops"))?.error).toBe(LABEL_NAME_PROBLEM);
    expect(labelsProblem(drafts("x".repeat(25)))?.error).toBe(
      LABEL_NAME_PROBLEM,
    );
    expect(labelsProblem(drafts("ops", "fix", "OPS "))).toEqual({
      field: "labels.2.name",
      error: LABEL_REPEAT_PROBLEM,
    });
  });
});
