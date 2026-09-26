// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The composer's keys: the arrows, Tab and Escape walk the command list
// only while it has a match, so a message with none keeps them.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { options } from "preact";
import { render } from "preact-render-to-string";
import { Composer } from "../../../src/client/composer/Composer.tsx";
import { draftKey } from "../../../src/client/composer/draft.ts";
import { me } from "../../../src/client/data/me.ts";

const SCOPE = { sessionId: "s1" };
const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let rows: Map<string, string>;

beforeEach(() => {
  rows = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => rows.get(key) ?? null,
      setItem: (key: string, value: string) => rows.set(key, value),
      removeItem: (key: string) => rows.delete(key),
    },
  });
  me.value = {
    id: "u1",
    username: "admin",
    fullName: "Admin",
    role: "admin",
    mustChangePassword: false,
  };
});

afterEach(() => {
  me.value = undefined;
  if (realStorage === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
  } else {
    Object.defineProperty(globalThis, "localStorage", realStorage);
  }
});

// the box's key handler, from a render of the composer over a draft
function keysOver(text: string): (key: string) => boolean {
  rows.set(draftKey("u1", SCOPE), JSON.stringify({ text, uploads: [] }));
  const previous = options.vnode;
  let onKeyDown: ((event: KeyboardEvent) => void) | undefined;
  options.vnode = (node) => {
    previous?.(node);
    const props = node.props as Record<string, unknown>;
    if (node.type === "textarea" && props.name === "message") {
      onKeyDown = props.onKeyDown as (event: KeyboardEvent) => void;
    }
  };
  try {
    render(
      <Composer
        scope={SCOPE}
        filesProjectId="p1"
        agents={null}
        agentId={null}
        running={false}
        busy={false}
        onSend={async () => {}}
        onStop={async () => {}}
      />,
    );
  } finally {
    options.vnode = previous;
  }
  if (onKeyDown === undefined) throw new Error("no message box");
  const handler = onKeyDown;
  return (key) => {
    let prevented = false;
    handler({
      key,
      isComposing: false,
      shiftKey: false,
      preventDefault() {
        prevented = true;
      },
    } as unknown as KeyboardEvent);
    return prevented;
  };
}

describe("the composer's keys", () => {
  test.serial("an empty command list leaves the keys to the box", () => {
    const press = keysOver("hello");
    for (const key of ["ArrowDown", "ArrowUp", "Tab", "Escape"]) {
      expect(press(key)).toBe(false);
    }
  });

  test.serial("a list with a match takes the arrows", () => {
    const press = keysOver("/");
    expect(press("ArrowDown")).toBe(true);
    expect(press("ArrowUp")).toBe(true);
  });
});
