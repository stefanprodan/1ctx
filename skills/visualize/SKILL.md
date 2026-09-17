---
name: visualize
description: Load when a diagram, chart, UI mockup, interactive explainer or illustration would explain better than text.
license: MIT, see LICENSE
compatibility: Requires the visualize tool to be offered.
---

Use this skill only when the `visualize` tool is offered. Otherwise,
answer in text. Take the allowed library hosts from the tool description,
not from this skill: an administrator may change them or allow none.

## Choose a useful visual

Draw to clarify a relationship, make a quantity comparable or let someone
explore a variable. Never place boxes by hand-computed coordinates when
CSS or a library can lay them out. Ask whether the reader would screenshot the result
for reference. If not, a short answer may be better.

| Need | First choice |
| --- | --- |
| A fact, a definition or a short answer | Text |
| Writing, editing, code or personal support | Text |
| A process or an architecture | HTML boxes, connectors drawn by a script |
| A physical mechanism or an annotated drawing | Inline SVG |
| A comparison or a proposed interface | HTML grid or table |
| A trend, ranking, proportion or distribution | Inline SVG chart |
| A parameter, a cycle or a system's changing state | HTML controls and SVG |
| A dense relationship graph | Library layout, with an inline alternative |
| A creative illustration | SVG, or canvas for many repeated marks |

Use the least machinery that explains the subject. A chart with three
bars does not need a library. A visual is not an application, a saved
document or a substitute for requested working code. Respect a request
for brevity and do not decorate an answer that already says enough.

Introduce the visual with one short sentence saying what to look for.
Build it, then explain the important relationship or limitation in the
reply. Put narration outside the frame. Inside, keep labels, units,
legends, control instructions and source or sample-data notes that make
the visual understandable on its own. The tool's title is already shown
above the frame, so do not repeat it as a large heading inside.

## Deliver one fragment

Call `visualize(title, html)` with `title` first: a short, descriptive
single line. Put the complete fragment in `html`, in this order:

1. One short `<style>` block for this visual's layout.
2. HTML or inline SVG containing the visible content and initial state.
3. Any `<script>` blocks last, with functions and their first calls together.

Do not send document wrappers, a doctype or Markdown fences in `html`.
The fenced examples in these references are complete fragments to put
in that argument, not separate tool calls. Static content needs no script.
Use stable, distinct ids for elements that scripts update. Keep related
logic in parameterized functions rather than duplicating drawing code.

A preview appears while the fragment arrives if the provider streams
arguments. Some providers deliver it whole. Preview scripts never run:
there are no working event handlers, module imports or canvas drawing
until final. Wire behavior with `addEventListener` in the closing script,
never in element attributes. Static markup must tell the story without
JavaScript; a canvas alone is blank in preview. Keep all panels visible
at first. Only the final script may hide panels, enable controls or
start an animation.

The final fragment runs its scripts once after the call succeeds.
Classic scripts run in order; an external classic script is awaited
before the next one. Modules run after all classic scripts, in order of
insertion, but another script does not wait for a module's asynchronous
work. Never make a classic script depend on a module. Initialize a module
and use its imports within that same module.

After acceptance, do not call `visualize` again for the same visual and
do not repeat its source in the answer. Acceptance is not proof that
every reader loaded every library. On a refusal, use the error to explain
the limitation rather than repeatedly submitting the same content.

## Stay inside the frame

The document has an opaque origin. It cannot access the surrounding
page, its cookies or storage. There is no host messaging API for authored
content and no way to send a chat message. Do not access the parent or
post messages to it. Do not use network requests, storage, forms,
navigation, links, popups, nested frames or downloads. Controls change
only this visual. Do not request secrets or remote live data; put the
data needed for the explanation in the fragment.

Only scripts, styles and fonts can load from the hosts named in the
tool description. Images must be inline SVG or data/blob resources.
Prefer system fonts and inline drawing. An empty hosts list still allows
inline scripts, HTML, SVG and canvas. A library URL can send what it
contains to that host, so do not place user data in a path or query.
There are no preloaded libraries or bare module specifiers. Read
`references/libraries.md` before adding a dependency.

The frame is 680 CSS pixels wide even on a phone, where the card scrolls
horizontally instead of shrinking text. Use `viewBox="0 0 680 H"` and
`width="100%"` for SVG, computing H from the content. Leave generous
margins. Content taller than 2,000 pixels scrolls inside the card;
prefer a shorter explanation. Avoid viewport-relative heights.

Keep the fragment small. `visualBytes` caps each fragment in UTF-8 bytes
and `visualSendBytes` caps the total accepted in a send. The defaults are
256 KiB and 1 MiB respectively, but an administrator can lower them.
Do not fill the budget with embedded assets or repeated geometry.

## Use the supplied design system

The outer background is transparent. Use flat surfaces, spacing and
alignment, not gradients, shadows, blur, glow, neon or emoji. Colour
encodes meaning; use two or three categories rather than a rainbow.
Pair colour with a label, shape or line pattern.

The frame supplies these variables. Use them instead of literal colours,
including for text, canvas and chart options. Do not redefine the frame's
names. A local custom property belongs in the example's style block.

| Role | Names |
| --- | --- |
| Surfaces | `--color-background-primary`, `--color-background-secondary`, `--color-background-tertiary` |
| Text | `--color-text-primary`, `--color-text-secondary`, `--color-text-tertiary` |
| Borders | `--color-border-primary`, `--color-border-secondary`, `--color-border-tertiary` |
| Semantic variants | Each of background, text and border also has `info`, `danger`, `success`, `warning` |
| Fonts | `--font-sans`, `--font-serif`, `--font-mono` |
| Radii | `--border-radius-md`, `--border-radius-lg`, `--border-radius-xl` |
| Aliases | `--p` = primary text, `--s` = secondary text, `--t` = tertiary text, `--bg2` = secondary background, `--b` = tertiary border |

The body already uses the sans stack, 16px text and 1.7 line height.
Use only weights 400 and 500, sentence case and no text below 11px.
Diagram labels are 14px and supporting labels 12px. Within mockups,
section headings may be 22, 18 or 16px at weight 500. Use mono for
identifiers, serif sparingly for editorial content. Borders are normally
`0.5px solid var(--color-border-tertiary)`; reserve stronger contrast for
focus or a meaningful selection. Cards use the supplied radius variables.

Bare buttons, text/number inputs, selects, textareas, ranges, checkboxes
and radios already have styling and focus states. Add layout, labels
and generous click targets, not another control design system.

SVG has ready-made classes:

| Class | Use |
| --- | --- |
| `t`, `ts`, `th` | 14px body, 12px supporting, 14px medium text |
| `box` | Neutral group's direct rect, circle or ellipse children |
| `arr` | 1.5px unfilled connector |
| `leader` | Fine dashed annotation line |
| `node` | Hover feedback for a genuinely interactive local node |
| `c-purple`, `c-teal`, `c-coral`, `c-pink`, `c-gray`, `c-blue`, `c-green`, `c-amber`, `c-red` | Theme-aware shape and text ramps |

Put a ramp class on a group with direct rect/circle/ellipse children
and descendant `t`, `ts` or `th` text. It also styles a rect, circle or
ellipse directly. It does not colour arbitrary paths or HTML boxes.
Use semantic variables for those. Do not add `node` to a static box.

The scheme is `document.documentElement.dataset.theme`, either `light`
or `dark`, set from the app rather than the operating system. The frame
dispatches `visualtheme` on `window` when it changes. CSS variables and
ramp classes update themselves. For canvas or a library, resolve colours
with `getComputedStyle(document.documentElement).getPropertyValue(...)`
inside the drawing function, call it initially and register it for
`visualtheme`. A theme update does not rerun initialization scripts.

## Small static example

This compares two stages without a library or behavior. More diagram
geometry and complete interactive examples are in the references.

```html
<style>
.stages { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; padding: 24px; }
.stage { padding: 16px; border: 0.5px solid var(--b); border-radius: var(--border-radius-lg); background: var(--bg2); }
.stage-label { font-weight: 500; }
.stage-detail { color: var(--s); font-size: 14px; }
</style>
<div class="stages">
  <div class="stage">
    <p class="stage-label">Collect</p>
    <p class="stage-detail">Record the inputs.</p>
  </div>
  <div class="stage">
    <p class="stage-label">Compare</p>
    <p class="stage-detail">Find what changed.</p>
  </div>
</div>
```

## Read only the references you need

Use `skill_file` with this skill's name and the path.

| File | Read when |
| --- | --- |
| [references/svg-diagrams.md](references/svg-diagrams.md) | Any diagram: which layout method to use, nodes, arrows, containers, mechanisms |
| [references/ui-mockups.md](references/ui-mockups.md) | Drawing cards, metrics, records, comparisons, tables or controls |
| [references/interactive.md](references/interactive.md) | Adding controls, steps, tabs, a simulation, plotter or animation |
| [references/charts.md](references/charts.md) | Choosing a chart, sizing Chart.js or handling its theme and fallback |
| [references/art.md](references/art.md) | Making an illustration, pattern or generative composition |
| [references/libraries.md](references/libraries.md) | Loading Mermaid, D3, Three.js or Tone.js from allowed hosts |

## Check before sending

Choose a visual only if it teaches more than the prose. Check the initial
static state, units, rounded numbers and data accuracy. For an SVG
diagram, run the numbered final checks in `references/svg-diagrams.md`:
compute each label's width against its box and the space beside each
connector, and fix every overlap before calling `visualize`. Mark invented demonstration data as sample data. Keep the
style first, visible content next and scripts last, with no incomplete
tags, placeholders or comments. Every control must do something local
and be keyboard usable. Give animated content a pause control and
respect reduced motion. Verify readable colours in both themes and
keep an inline explanation if a library cannot load. Finish with useful
narration outside the frame, not a second copy of the source.
