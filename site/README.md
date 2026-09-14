# 1ctx brand

The brand book and the files. `uv run scripts/brand.py` regenerates
every SVG here from the numbers below.

## The mark

An open-cornered chip with a 1 inside and a sparkle on the corner. The
chip is a 24-unit square: stroke 1.5, corner radius 4.68, the top edge
stops 6.5 units short of the right corner and the right edge starts
6.5 units below it. The 1 is 8.75 units tall, centred. The sparkle is
a filled four-point star with concave sides, 7 units across, centred
on the corner, so it pokes 3 units past the top and the right edge.
The chip and the 1 take the foreground colour; the sparkle is always
brand amber.

Stroke by rendered size, so the lines stay about 1.5 px:

| Rendered at | Stroke |
|---|---|
| 32 px and up | 1.5 |
| 22 to 24 px (the app header) | 1.75 |
| 16 px (the favicon) | 2, sparkle scaled 1.25x |

Minimum size 16 px. Clear space around the mark: half its height on
every side, the sparkle included.

## The wordmark

"1ctx", lowercase, JetBrains Mono Bold, tracked -0.02em, in the
foreground colour with no accent. Never a cursor, never a coloured 1,
never a different case.

## The logo

The wordmark inside a wide chip drawn with the mark's geometry: the
same stroke, corner radius, opening and sparkle, at 18 units tall
instead of 24, with 5 units of air left and right of the word and the
caps 8.75 units tall as the 1 is in the mark. It is the mark with the
whole name where the 1 was, so the 1 appears once. Use it where there
is room for one element only: the social preview, a slide, a sticker.

## The lockup

Mark beside wordmark, on one line, the wordmark's caps centred on the
mark. The app header uses a 22 px mark, a 16 px wordmark at weight 600
and a 9 px gap. The README header stacks mark, wordmark and tagline.

## Type

| Role | Family | Weights | Fallback |
|---|---|---|---|
| Wordmark, code, stats, labels | JetBrains Mono | 400, 500, 600, 700 | SF Mono, Menlo, monospace |
| Copy, transcripts, UI text | IBM Plex Sans | 400, 500, 600 | Helvetica Neue, Arial, sans-serif |

Both are open licence (SIL OFL) and bundled with the app, never loaded
from a font host. Sources:
[JetBrains Mono](https://github.com/JetBrains/JetBrainsMono),
[IBM Plex](https://github.com/IBM/plex).

Sizes in the UI:

| Use | Size | Notes |
|---|---|---|
| Section label | 11 px | uppercase, 0.12em tracking, dim colour |
| UI copy | 13 px | line height 1.5 |
| Body and tagline | 15 to 16 px | line height 1.5 |
| Page title | 22 px | Plex 600 or Mono 500 |
| Mono values | 13 px | Mono 500 for a number that matters |

The tagline is set in Plex Sans regular in the dim colour, never in
mono and never bold: **One continuous context for agents**.

## Colour

Console greys and one amber.

| Token | Hex | Use |
|---|---|---|
| page | `#131314` | the page ground |
| card | `#1e1f20` | cards, panels, the composer |
| inset | `#0f1216` | inset tiles, code blocks, the lockup ground |
| line | `#2a2b2d` | hairlines and borders |
| fg | `#e7e7e9` | text, the mark, the wordmark |
| dim | `#b3b3b8` | secondary text, the tagline |
| faint | `#8b8b91` | labels, hints, placeholders |
| brand | `#f2c14e` | the sparkle, links, the one accent |
| brand hover | `#f7d27a` | a link under the pointer, in the UI only |
| brand on light | `#d9a53a` | the sparkle on a light ground |
| light ground | `#f4f2ec` | when the mark sits on light |
| fg on light | `#131314` | text and the mark on a light ground |

Amber is the only accent. It marks the sparkle, links, focus and the
one thing on a page that is live. It is not a background colour and
not a text colour for more than a word. State colours for the UI
(green for done, red for failed, blue for running) come from the
console's tokens and are UI, not brand; they never appear in a logo.

## Files

| File | Use |
|---|---|
| `mark.svg` | The mark with the chip and the 1 in `currentColor`; for the app header and anywhere the page colour should drive it |
| `mark-dark.svg`, `mark-light.svg` | The mark with a fixed foreground, for a dark or a light ground |
| `favicon.svg` | The mark at stroke 2 with the sparkle 1.25x, foreground follows the browser's colour scheme |
| `favicon-32.png`, `favicon-16.png` | The same, light foreground on transparent, for browsers without SVG favicons |
| `apple-touch-icon.png` | 180 px opaque dark tile; iOS applies its own mask |
| `icon.svg`, `icon-512.png` | Rounded dark tile with the mark, transparent corners, for Slack, GitHub and app listings |
| `logo.svg`, `logo-dark.svg`, `logo-light.svg` | The logo: the wordmark inside the wide chip; `logo.svg` takes the page colour |
| `wordmark-dark.svg`, `wordmark-light.svg` | "1ctx" alone |
| `lockup-dark.svg`, `lockup-light.svg` | Mark beside the wordmark, the header proportions |
| `readme-dark.svg`, `readme-light.svg` | Mark, wordmark and tagline stacked, transparent, for the README |
| `social-preview.svg`, `social-preview.png` | 1280 by 640 on the dark ground: the logo and the tagline, for the GitHub repo's social preview |

Every SVG has the type outlined, so nothing here needs a font
installed.

README header, switching with the reader's theme:

```html
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="site/readme-dark.svg">
    <img alt="1ctx" src="site/readme-light.svg" width="640">
  </picture>
</p>
```

Head of the web page:

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

The PNGs are rasterized from the SVGs in a browser; the transparent
ones through a canvas export, which keeps the alpha channel.
