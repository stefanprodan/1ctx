// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What a change in the rows' height does to the transcript's view.

export interface Follow {
  toEnd: boolean;
  stick: boolean;
  jumpHidden: boolean;
}

// a view that follows the end keeps following growth no render reports
// (a turn's refusal, an image loading), but not a fold the user opened
// or closed: following that would push what they opened out of view,
// so the view stays and follows only if the end is still in it
export function followRows(view: {
  stick: boolean;
  toggled: boolean;
  gap: number;
}): Follow {
  if (view.stick && !view.toggled) {
    return { toEnd: true, stick: true, jumpHidden: true };
  }
  const stick = view.gap < 40;
  return { toEnd: false, stick, jumpHidden: stick || view.gap < 80 };
}
