// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Save } from "../../../src/client/lib/save.ts";
import { LabelDrafts } from "../../../src/client/views/projects/LabelDrafts.tsx";
import {
  defaultDrafts,
  labelsProblem,
} from "../../../src/client/views/projects/Labels.model.ts";

test("a refused draft shows the form's words under its input, no request sent", async () => {
  const drafts = [...defaultDrafts(), { key: 9, name: "Fix", description: "" }];
  let sent = 0;
  const save = new Save(async () => {
    sent++;
  });
  await save.run(labelsProblem(drafts));
  const html = render(
    <LabelDrafts drafts={drafts} save={save} onChange={() => {}} />,
  );
  expect(sent).toBe(0);
  expect(html).toContain(
    '<span class="field-error" role="alert">This name is used above.</span>',
  );
  expect(html).toMatch(/name="labels\.4\.name"[^>]*aria-invalid="true"/);
  expect(html).not.toContain("Labels.4.name");
  save.dispose();
});
