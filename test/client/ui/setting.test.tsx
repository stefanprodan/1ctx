// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Save } from "../../../src/client/lib/save.ts";
import {
  Setting,
  SettingAlert,
  SettingDelete,
  SettingFact,
  SettingFacts,
  SettingFoot,
  SettingForm,
  SettingStack,
} from "../../../src/client/ui/Setting.tsx";

const plain = (html: string) => html.replaceAll("<!-- -->", "");
const noop = async () => {};

describe("Setting", () => {
  test("a card wraps its head and control in the body; a list card does not", () => {
    expect(render(<Setting title="Name" line="Shown in chats." />)).toBe(
      '<section class="card setting"><div class="setting-body"><div class="setting-head"><div class="setting-words"><h2 class="setting-title">Name</h2><p class="setting-line">Shown in chats.</p></div></div></div></section>',
    );
    expect(
      render(
        <Setting list title="Skills" count="2" foot={<span>f</span>}>
          <p>rows</p>
        </Setting>,
      ),
    ).toBe(
      '<section class="card setting setting-list"><div class="setting-head setting-head-one"><div class="setting-words"><h2 class="setting-title">Skills<span class="setting-count">2</span></h2></div></div><p>rows</p><div class="setting-foot"><span>f</span></div></section>',
    );
  });

  test("the foot, the stack and the form draw their one element", () => {
    expect(render(<SettingFoot>x</SettingFoot>)).toBe(
      '<div class="setting-foot">x</div>',
    );
    expect(render(<SettingStack>x</SettingStack>)).toBe(
      '<div class="setting-stack">x</div>',
    );
    expect(
      render(
        <SettingForm save={new Save(noop)} class="owner">
          x
        </SettingForm>,
      ),
    ).toBe('<form class="owner">x</form>');
  });

  test("facts are label and value pairs in one grid", () => {
    expect(
      render(
        <SettingFacts>
          <SettingFact label="URL" mono>
            https://x
          </SettingFact>
          <SettingFact label="About" pre bad>
            a
          </SettingFact>
        </SettingFacts>,
      ),
    ).toBe(
      '<div class="setting-facts"><span class="label">URL</span><span class="setting-fact setting-fact-mono">https://x</span><span class="label">About</span><span class="setting-fact setting-fact-pre error">a</span></div>',
    );
  });

  test("an alert is a status line with its icon, the words in a span", () => {
    const html = render(
      <SettingAlert>
        <a href="/x">2 skills</a> failing
      </SettingAlert>,
    );
    expect(html).toStartWith('<p class="setting-alert" role="status"><svg');
    expect(html).toContain('class="setting-alert-icon"');
    expect(plain(html)).toEndWith(
      '<span><a href="/x">2 skills</a> failing</span></p>',
    );
  });
});

describe("SettingDelete", () => {
  test("a danger card with its line and Delete in the foot", () => {
    const html = plain(
      render(
        <SettingDelete
          title="Delete flux"
          line="No agent uses it."
          ask="Delete flux?"
          onDelete={noop}
          leaveTo="/admin/config/mcp"
        />,
      ),
    );
    expect(html).toStartWith(
      '<section class="card setting setting-danger"><div class="setting-body"><div class="setting-head"><div class="setting-words"><h2 class="setting-title">Delete flux</h2><p class="setting-line">No agent uses it.</p></div></div></div><div class="setting-foot"><div class="foot"><div class="setting-delete"><button type="button" class="btn">Delete</button></div></div></div></section>',
    );
  });

  test("off keeps Delete disabled", () => {
    const html = render(
      <SettingDelete
        title="Delete flux"
        line="An agent uses it."
        ask="Delete flux?"
        off
        onDelete={noop}
        leaveTo="/admin/config/mcp"
      />,
    );
    expect(html).toContain(
      '<button type="button" class="btn" disabled>Delete</button>',
    );
  });
});
