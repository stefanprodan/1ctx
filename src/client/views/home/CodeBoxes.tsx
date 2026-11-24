// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sign-in's code, one box per digit: typing moves on, Backspace and
// the arrows move, and a paste or the code the system offers from Mail
// fills every box at once. The rules are SignIn.model.ts's.

import { useRef } from "preact/hooks";
import { DIGITS, erase, put, typedIn } from "./SignIn.model.ts";

export function CodeBoxes({
  value,
  first,
  wrong,
  disabled,
  onChange,
}: {
  value: string;
  first: { current: HTMLInputElement | null };
  wrong: boolean;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  // selected too, as a box already focused gets no focus event
  const focus = (i: number) => {
    const box = boxes.current[Math.max(0, Math.min(i, DIGITS - 1))];
    box?.focus();
    box?.select();
  };
  const land = (next: { value: string; focus: number } | null) => {
    if (next === null) return;
    // focus first, so a sign-in the last digit starts can move it again
    focus(next.focus);
    onChange(next.value);
  };
  return (
    <fieldset
      class="signin-boxes"
      aria-labelledby="signin-code-label"
      disabled={disabled}
    >
      {Array.from({ length: DIGITS }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
            if (i === 0) first.current = el;
          }}
          class={`signin-box${wrong ? " signin-box-wrong" : ""}`}
          aria-label={`Digit ${i + 1}`}
          autocomplete={i === 0 ? "one-time-code" : "off"}
          inputmode="numeric"
          value={value[i] ?? ""}
          onInput={(e) => {
            const el = e.currentTarget as HTMLInputElement;
            const typed = typedIn(value[i], el.value);
            el.value = value[i] ?? "";
            land(put(value, i, typed));
          }}
          onPaste={(e) => {
            e.preventDefault();
            land(put(value, i, e.clipboardData?.getData("text") ?? ""));
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace") {
              e.preventDefault();
              land(erase(value, i));
            } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              // the caret never moves inside a box: the next one's digit
              // is selected, so a digit typed replaces it
              e.preventDefault();
              focus(e.key === "ArrowLeft" ? i - 1 : i + 1);
            }
          }}
          onFocus={(e) => (e.currentTarget as HTMLInputElement).select()}
        />
      ))}
    </fieldset>
  );
}
