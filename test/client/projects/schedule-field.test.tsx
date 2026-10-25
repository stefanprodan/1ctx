// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The schedule's shape: a segmented switch where its six options fit
// one line, a select on a phone, the same pick either way; the check URL
// under it.

import { afterEach, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { narrow } from "../../../src/client/app/shell.ts";
import { ScheduleField } from "../../../src/client/views/projects/ScheduleField.tsx";
import {
  CHECK_HINT,
  WhenSection,
} from "../../../src/client/views/projects/WhenSection.tsx";

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

test.serial(
  "the check URL sits under the schedule with its hint, or the refusal",
  () => {
    const when = (error: string | null) =>
      render(
        <WhenSection
          projectId="p1"
          draft={{
            schedule: "0 9 * * *",
            tz: "UTC",
            once: false,
            checkUrl: "https://api.example.test/alerts",
          }}
          set={() => {}}
          save={{
            fieldError: (field) => (field === "checkUrl" ? error : null),
          }}
          disabled={false}
        />,
      );
    const html = when(null);
    expect(html.indexOf('aria-label="Repeats"')).toBeLessThan(
      html.indexOf("Check URL"),
    );
    expect(html).toContain('name="checkUrl"');
    expect(html).toContain('value="https://api.example.test/alerts"');
    expect(html).toContain(`<span class="hint">${CHECK_HINT}</span>`);
    expect(CHECK_HINT).toBe(
      "Asked at every scheduled time. Runs only when the answer is new.",
    );
    const refused = when("CheckUrl must be http or https.");
    expect(refused).toContain("CheckUrl must be http or https.");
    expect(refused).toContain('aria-invalid="true"');
    expect(refused).not.toContain(CHECK_HINT);
  },
);
