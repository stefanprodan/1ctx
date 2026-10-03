// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The schedule's shape: a segmented switch where its six options fit
// one line, a select on a phone, the same pick either way.

import { afterEach, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { narrow } from "../../../src/client/app/shell.ts";
import { ScheduleField } from "../../../src/client/views/projects/ScheduleField.tsx";

const drawn = (disabled = false) =>
  render(
    <ScheduleField
      projectId="p1"
      schedule="0 9 * * *"
      tz="UTC"
      disabled={disabled}
      onSchedule={() => {}}
      onTz={() => {}}
    />,
  );

afterEach(() => {
  narrow.value = false;
});

test.serial("a wide window picks the shape from a segmented switch", () => {
  const html = drawn();
  expect(html).toContain('<fieldset class="seg" aria-label="Repeats"');
  expect(html).toMatch(/class="seg-option seg-on"[^>]*>Daily</);
  expect(html).toContain(">Cron<");
});

test.serial("a phone picks it from a select showing the same shape", () => {
  narrow.value = true;
  const html = drawn();
  expect(html).not.toContain('aria-label="Repeats"><button');
  expect(html).not.toContain('class="seg"');
  expect(html).toMatch(/aria-label="Repeats"[^>]*>/);
  expect(html).toContain("Daily");
});

test.serial("the select waits while the form does", () => {
  narrow.value = true;
  expect(drawn(true)).toMatch(/<button[^>]*aria-label="Repeats"[^>]*disabled/);
});
