// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The viewer's keys and focus, apart from the view so they are tested
// without a DOM. The close button is its one control, so Tab stays on
// it; Escape closes, and the focus goes back to what opened it.

export type Focusable = { focus(): void };

export class ViewerFocus {
  constructor(
    // what had the focus when the viewer opened: the image clicked
    private readonly from: Focusable | null,
    private readonly close: () => void,
  ) {}

  // true when the key was the viewer's, so the page does nothing with it
  key(key: string, button: Focusable | null): boolean {
    if (key === "Escape") {
      this.close();
      return true;
    }
    if (key === "Tab") {
      button?.focus();
      return true;
    }
    return false;
  }

  // the viewer is gone: the focus returns
  end(): void {
    this.from?.focus();
  }
}
