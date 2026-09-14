// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The inline SVGs: the mark and the logo from the brand book, and the
// 16 px stroke icons, one style. A colour comes from currentColor; the
// sparkle is always brand amber.

const SPARKLE =
  "M19.5 1.0C19.5 2.925 21.075 4.5 23.0 4.5C21.075 4.5 19.5 6.075 19.5 8.0C19.5 6.075 17.925 4.5 16.0 4.5C17.925 4.5 19.5 2.925 19.5 1.0Z";

// the mark alone (site/mark.svg): the chip with the 1 and the sparkle.
// The stroke follows the brand book: 1.75 under 32 px, 1.5 from there
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={size < 32 ? 1.75 : 1.5}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-label="1ctx"
      role="img"
    >
      <path d="M13.5 4H11C6.757 4 4.636 4 3.318 5.318S2 8.758 2 13s0 6.364 1.318 7.682S6.758 22 11 22s6.364 0 7.682-1.318S20 17.242 20 13v-2.5" />
      <path d="M8.75 11.25 11.5 8.75V17.5" />
      <path fill="var(--brand)" stroke="none" d={SPARKLE} />
    </svg>
  );
}

// the wordmark inside the wide chip (site/logo.svg, 170.19 by 90)
export function Logo({ height = 26 }: { height?: number }) {
  const width = Math.round((height * 170.19) / 90);
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 170.19 90"
      aria-label="1ctx"
      role="img"
    >
      <g
        transform="translate(3 15)"
        fill="none"
        stroke-width="6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path
          stroke="currentColor"
          d="M126.19 0H18.72A18.72 18.72 0 0 0 0 18.72V53.28A18.72 18.72 0 0 0 18.72 72H133.47A18.72 18.72 0 0 0 152.19 53.28V26"
        />
        <path
          fill="var(--brand)"
          stroke="none"
          transform="translate(74.19 -18) scale(4)"
          d={SPARKLE}
        />
      </g>
      <path
        fill="currentColor"
        transform="translate(23 68.5)"
        d="M4.03 0V-5.42H13.14V-29.2L3.98 -22.49V-29.2L12.03 -35H19.13V-5.42H26.47V0Z M42.62 0.48Q39.22 0.48 36.7 -0.79Q34.18 -2.06 32.79 -4.39Q31.4 -6.71 31.4 -9.88V-16.49Q31.4 -19.66 32.79 -21.98Q34.18 -24.31 36.7 -25.58Q39.22 -26.85 42.62 -26.85Q47.56 -26.85 50.56 -24.28Q53.55 -21.72 53.7 -17.31H47.8Q47.66 -19.37 46.24 -20.5Q44.83 -21.62 42.62 -21.62Q40.18 -21.62 38.79 -20.3Q37.4 -18.99 37.4 -16.54V-9.88Q37.4 -7.43 38.79 -6.09Q40.18 -4.75 42.62 -4.75Q44.88 -4.75 46.27 -5.87Q47.66 -7 47.8 -9.06H53.7Q53.55 -4.65 50.56 -2.09Q47.56 0.48 42.62 0.48Z M72.64 0Q68.95 0 66.76 -2.13Q64.58 -4.27 64.58 -7.91V-20.95H57.29V-26.37H64.58V-33.8H70.62V-26.37H81.12V-20.95H70.62V-8.05Q70.62 -6.9 71.27 -6.16Q71.92 -5.42 73.07 -5.42H80.88V0Z M85.15 0 94.36 -13.62 85.77 -26.37H92.53L96.61 -19.9Q96.99 -19.32 97.33 -18.6Q97.66 -17.88 97.81 -17.45Q98 -17.88 98.31 -18.6Q98.62 -19.32 99.01 -19.9L103.08 -26.37H109.89L101.31 -13.62L110.47 0H103.66L99.1 -7.24Q98.72 -7.82 98.36 -8.56Q98 -9.3 97.81 -9.73Q97.62 -9.3 97.28 -8.56Q96.95 -7.82 96.56 -7.24L91.96 0Z"
      />
    </svg>
  );
}

const PATHS: Record<string, string> = {
  home: "M2.5 7.5 8 3l5.5 4.5M4 6.5V13h8V6.5",
  projects:
    "M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z",
  lock: "M4.5 7.5h7a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1zM5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2",
  hash: "M6.5 2.5 5 13.5M11 2.5 9.5 13.5M3 6h10.5M2.5 10h10.5",
  settings: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11",
  plus: "M8 3v10M3 8h10",
  chevron: "M5 6.5l3 3 3-3",
  "chevron-right": "M6.5 5l3 3-3 3",
  check: "M3 8.5l3 3 7-7",
  copy: "M6 6h7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM3.5 10.5h-.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5",
  "sign-out": "M6.5 3H3v10h3.5M10 5l3 3-3 3M13 8H6",
  sidebar:
    "M3.5 3h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM6 3v10",
  close: "M4 4l8 8M12 4l-8 8",
  users:
    "M6 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 13.5c0-2.4 2-3.5 4.5-3.5s4.5 1.1 4.5 3.5M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12.2 10.3c1.4.5 2.3 1.5 2.3 3.2",
  user: "M8 8.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5zM2.5 13.5c0-2.5 2.5-3.5 5.5-3.5s5.5 1 5.5 3.5",
  admin:
    "M8 2.5l4.5 1.8v3.2c0 2.9-1.9 5-4.5 6-2.6-1-4.5-3.1-4.5-6V4.3zM6 8l1.5 1.5L10.5 6.5",
  providers:
    "M4.5 12.5h7a2.5 2.5 0 0 0 .3-5A3.5 3.5 0 0 0 5 6.6 3 3 0 0 0 4.5 12.5z",
  search: "M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.3 10.3l3.2 3.2",
  send: "M8 13.5v-11M3.5 7 8 2.5 12.5 7",
  down: "M8 2.5v11M3.5 9 8 13.5 12.5 9",
  "arrow-right": "M2.5 8h11M9 3.5 13.5 8 9 12.5",
  pencil: "M10.5 3 13 5.5 6 12.5H3.5V10zM9 4.5 11.5 7",
  download: "M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10",
  stop: "M4 4h8v8H4z",
  chat: "M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z",
  agents:
    "M4 6.5h8a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 12 12.5H4A1.5 1.5 0 0 1 2.5 11V8A1.5 1.5 0 0 1 4 6.5zM8 6.5V4M6 9.5h.01M10 9.5h.01",
  spinner: "M13 8a5 5 0 1 1-2-4",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v4M9.2 7v4",
  redo: "M14 8a6 6 0 1 1-1.8-4.3M14 2v3.5h-3.5",
  clock: "M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM8 4.5V8l2.5 1.5",
  play: "M5 3.5v9l7-4.5z",
  pause: "M5.5 3.5v9M10.5 3.5v9",
  tools:
    "M10 2.5a3.5 3.5 0 0 0-4.2 4.6L2.5 10.4l3.1 3.1 3.3-3.3a3.5 3.5 0 0 0 4.6-4.2L11.3 8.2 7.8 4.7z",
};

export type IconName = keyof typeof PATHS;

// a personal project is its owner's alone, so it wears the lock
export const projectIcon = (kind: "personal" | "team"): IconName =>
  kind === "personal" ? "lock" : "hash";

export function Icon({
  name,
  size = 16,
  class: cls,
}: {
  name: IconName;
  size?: number;
  class?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={cls}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
