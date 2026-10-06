// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The small shared parts: the status tag, a list's failure, an aside
// fact, the segmented switch, a board's bones and meters, the ask
// before a delete, and a card foot's refusal.

import { describe, expect, test } from "bun:test";
import { signal } from "@preact/signals";
import { render } from "preact-render-to-string";
import { shareWidth } from "../../../src/client/lib/format.ts";
import { Save } from "../../../src/client/lib/save.ts";
import { ChartPanel, Meter } from "../../../src/client/ui/Chart.tsx";
import { CodeTag } from "../../../src/client/ui/CodeTag.tsx";
import { AskDelete, Foot } from "../../../src/client/ui/Foot.tsx";
import { RowsFailed } from "../../../src/client/ui/Rows.tsx";
import { Seg } from "../../../src/client/ui/Seg.tsx";
import { AsideLine } from "../../../src/client/ui/Split.tsx";
import { TileMeter, TilesGhost } from "../../../src/client/ui/Tiles.tsx";

const noop = () => {};
const plain = (html: string) => html.replaceAll("<!-- -->", "");

describe("CodeTag", () => {
  test("draws the status, and nothing without one", () => {
    expect(plain(render(<CodeTag status={409} />))).toContain(">HTTP 409<");
    const spaced = plain(render(<CodeTag status={500} spaced class="x" />));
    expect(spaced).toStartWith(" ");
    expect(spaced).toContain(">HTTP 500<");
    expect(spaced).toMatch(/class="[^"]*\bx\b/);
    expect(render(<CodeTag status={null} spaced />)).toBe("");
    expect(render(<CodeTag status={undefined} />)).toBe("");
  });
});

test("a list's failure is its words, then the status", () => {
  const failed = plain(
    render(<RowsFailed failure={{ words: "busy", status: 503 }} />),
  );
  expect(failed).toMatch(/role="alert"[^>]*>Busy\./);
  expect(failed).toContain(">HTTP 503<");
  expect(failed.indexOf("Busy.")).toBeLessThan(failed.indexOf("HTTP 503"));
  const offline = render(
    <RowsFailed failure={{ words: "offline", status: null }} />,
  );
  expect(offline).toMatch(/role="alert"[^>]*>Offline\./);
  expect(offline).not.toContain("HTTP ");
});

test("an aside fact is its label, then the value, cut or linked", () => {
  const role = render(<AsideLine label="Role">Admin</AsideLine>);
  expect(role).toMatch(/>Role<[\s\S]*>Admin</);
  expect(role).not.toContain("<a ");
  const email = render(
    <AsideLine label="Email" cut href="mailto:a@b.c">
      a@b.c
    </AsideLine>,
  );
  expect(email).toContain(">Email<");
  expect(email).toMatch(
    /<a\b(?=[^>]*class="[^"]*\bcut\b)(?=[^>]*href="mailto:a@b.c")[^>]*>a@b.c<\/a>/,
  );
});

test("a segmented switch presses the picked option and names it", () => {
  const html = render(
    <Seg
      label="Show"
      small
      invalid
      name="memory"
      class="own"
      options={[
        { value: "a", label: "A" },
        { value: "b", label: "B", disabled: true, title: "Why not" },
      ]}
      value="a"
      onPick={noop}
    />,
  );
  expect(html).toMatch(/<fieldset\b[^>]*aria-label="Show"/);
  // a worded option keeps its words as its name, the title describes
  expect(html).toContain('title="Why not">B<');
  const icons = render(
    <Seg
      label="Show"
      options={[{ value: "a", label: <i />, title: "Preview" }]}
      value="a"
      onPick={noop}
    />,
  );
  expect(icons).toContain('title="Preview" aria-label="Preview"');
  for (const name of ["seg-small", "seg-invalid", "own"]) {
    expect(html).toMatch(new RegExp(`class="[^"]*\\b${name}\\b`));
  }
  const buttons = html.match(/<button\b[^>]*>[^<]*<\/button>/g) ?? [];
  expect(buttons).toHaveLength(2);
  // a Seg sits inside forms: a submit button would save on a pick
  for (const b of buttons) expect(b).toContain('type="button"');
  expect(buttons[0]).toMatch(/class="[^"]*\bseg-on\b/);
  expect(buttons[1]).not.toContain("seg-on");
  expect(buttons[0]).toContain('name="memory"');
  expect(buttons[0]).toContain('aria-pressed="true"');
  expect(buttons[0]).toContain(">A<");
  expect(buttons[0]).not.toContain("disabled");
  expect(buttons[1]).toContain('aria-pressed="false"');
  expect(buttons[1]).toContain("disabled");
  expect(buttons[1]).toContain(">B<");
});

describe("the board's parts", () => {
  test("a share is a clamped width", () => {
    expect(shareWidth(0.5)).toBe("50.0%");
    expect(shareWidth(-1)).toBe("0.0%");
    expect(shareWidth(2)).toBe("100.0%");
    expect(render(<Meter share={0.25} />)).toContain('style="width:25.0%;"');
    const full = render(<TileMeter share={1} full />);
    expect(full).toContain('aria-hidden="true"');
    expect(full).toContain("tiles-meter-full");
    expect(full).toContain('style="width:100.0%;"');
  });

  test("a row of tile bones is four tiles, their pulse from at", () => {
    const html = render(<TilesGhost at={16} />);
    expect(html.startsWith('<div class="tiles">')).toBe(true);
    expect(html.match(/tiles-ghost/g)?.length).toBe(4);
  });

  test("a panel is a card of rows with a live hint", () => {
    const html = render(
      <ChartPanel label="Areas" hint="4 MB">
        <p>x</p>
      </ChartPanel>,
    );
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(labelledBy).toBeDefined();
    expect(html).toContain(`id="${labelledBy}">Areas<`);
    expect(html).toMatch(/aria-live="polite"[^>]*>4 MB</);
    expect(html).toContain("<p>x</p>");
  });
});

describe("AskDelete", () => {
  const save = { pending: signal<string | null>(null), touch: noop };

  test("Delete alone until it asks", () => {
    const html = render(
      <AskDelete
        save={save}
        asking={signal(false)}
        busy
        words="Delete a?"
        onDelete={noop}
      />,
    );
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).toMatch(
      /<button\b(?=[^>]*type="button")[^>]*disabled[^>]*>Delete<\/button>/,
    );
    expect(html).not.toContain("Delete a?");
    expect(html).not.toContain(">Keep<");
  });

  test("the ask: the owner's words, the danger button and Keep", () => {
    const html = render(
      <AskDelete
        save={save}
        asking={signal(true)}
        busy={false}
        words="Delete a?"
        wordsClass="mcp-ask"
        onDelete={noop}
      />,
    );
    expect(html).toMatch(/class="[^"]*\bmcp-ask\b[^"]*"[^>]*>Delete a\?</);
    expect(html).toMatch(
      /<button\b(?=[^>]*type="button")[^>]*\bbtn-danger\b[^>]*>Delete<\/button>/,
    );
    expect(html).toMatch(/<button\b[^>]*type="button"[^>]*>Keep<\/button>/);
    expect(html).not.toContain("disabled");
    const deleting = { pending: signal<string | null>("delete"), touch: noop };
    const busy = render(
      <AskDelete
        save={deleting}
        asking={signal(true)}
        busy
        label="Delete with 3 chats"
        onDelete={noop}
      />,
    );
    expect(busy).toMatch(
      /<button\b(?=[^>]*type="button")(?=[^>]*\bbtn-danger\b)[^>]*disabled[^>]*>Deleting<\/button>/,
    );
    expect(busy).toMatch(
      /<button\b(?=[^>]*type="button")[^>]*disabled[^>]*>Keep<\/button>/,
    );
    expect(busy).not.toContain("Delete with 3 chats");
  });
});

describe("Foot", () => {
  const failed = () => {
    const save = new Save(async () => {});
    save.status.value = { error: "the server did not answer", status: 503 };
    return save;
  };

  test("a refusal is a notice over the buttons", () => {
    const html = plain(render(<Foot save={failed()} label="Save" />));
    expect(html).toContain('class="notice-failed foot-notice"');
    expect(html).not.toContain("foot-actions");
  });

  test("inline, it is red words in the buttons' line, the buttons one group", () => {
    const html = plain(
      render(
        <Foot
          save={failed()}
          label="Save"
          inline
          start={<span>Unsaved changes</span>}
          before={<button type="button">Discard</button>}
        />,
      ),
    );
    expect(html).not.toContain("notice-failed");
    expect(html).not.toContain("Unsaved changes");
    expect(html).toMatch(/role="alert"[^>]*>The server did not answer\./);
    expect(html).toContain(">HTTP 503<");
    expect(html).toContain("foot-start-beside");
    expect(html.indexOf("The server did not answer")).toBeLessThan(
      html.indexOf("foot-actions"),
    );
    expect(html).toMatch(
      /class="[^"]*\bfoot-actions\b[^"]*"[^>]*>[\s\S]*<button\b[^>]*>Discard<\/button>/,
    );
  });
});
