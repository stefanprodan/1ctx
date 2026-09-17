# SVG diagrams

Use SVG for a small process, an architecture or a mechanism whose spatial
relationships carry the explanation. Start with the whole story, then
remove nodes that do not help it. Three clear stages beat twelve tiny ones.

## Geometry and text

Use a 680-unit-wide viewBox. Keep ordinary content between x=40 and x=640.
Compute the height from the lowest shape or label plus 40 units; leave
40 units at the top too. The frame stays 680 CSS pixels wide on narrow
screens, so a 12-unit label remains 12px rather than being squeezed.

Use `th` for node titles, `t` for labels and `ts` for short secondary
lines. For centered text, set both `text-anchor="middle"` and
`dominant-baseline="central"`. Estimate a title's width as its character
count times 8, a subtitle's as count times 7, then add 48 units of padding.
Widen the box or shorten the words. SVG text does not wrap automatically;
use separate text lines or positioned tspans deliberately.

Use 44-unit-high single-line nodes and 56-unit-high two-line nodes, 24
units of inner padding, at least 12 units between text and any edge.
Allow about 60 units for connectors between boxes. At most four or five
short nodes fit a row; longer labels usually need a vertical layout.
Borders are 0.5 units, connectors 1.5. Use modest rounding, usually
`rx="4"` or `rx="8"`, and consistent geometry for equal roles.

## Node and connector patterns

A `c-teal` group supplies a themed fill, border and text for a source;
`c-purple` can mark processing; `box` suits neutral structure. Keep one
meaning for each colour. The class belongs on the group, with its shape
directly inside it. Use `arr` for connectors and an open arrowhead, whose
stroke is `context-stroke`, to match the connector. A `leader` points
from a short margin annotation to a feature, without implying flow.

This complete fragment draws three stages. The marker uses a local id,
not an external image. Each line stops clear of the following box.

```html
<style>
.pipeline { display: block; }
</style>
<svg class="pipeline" width="100%" viewBox="0 0 680 368" role="img" aria-label="A request is checked, then recorded">
  <defs>
    <marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
    </marker>
  </defs>
  <g class="c-teal">
    <rect x="220" y="40" width="240" height="56" rx="8" stroke-width="0.5"></rect>
    <text class="th" x="340" y="59" text-anchor="middle" dominant-baseline="central">Receive request</text>
    <text class="ts" x="340" y="78" text-anchor="middle" dominant-baseline="central">Capture the input</text>
  </g>
  <line class="arr" x1="340" y1="102" x2="340" y2="148" marker-end="url(#flow-arrow)"></line>
  <g class="c-purple">
    <rect x="220" y="156" width="240" height="56" rx="8" stroke-width="0.5"></rect>
    <text class="th" x="340" y="175" text-anchor="middle" dominant-baseline="central">Check the input</text>
    <text class="ts" x="340" y="194" text-anchor="middle" dominant-baseline="central">Reject invalid values</text>
  </g>
  <line class="arr" x1="340" y1="218" x2="340" y2="264" marker-end="url(#flow-arrow)"></line>
  <g class="box">
    <rect x="220" y="272" width="240" height="56" rx="8" stroke-width="0.5"></rect>
    <text class="th" x="340" y="291" text-anchor="middle" dominant-baseline="central">Keep the record</text>
    <text class="ts" x="340" y="310" text-anchor="middle" dominant-baseline="central">Commit once</text>
  </g>
</svg>
```

## Pick the diagram type

For a flowchart, choose one reading direction. Label branches with their
conditions and leave room for the labels. Route an elbow around a box,
never through unrelated content. Do not imply every process is linear
if it has a meaningful failure or feedback path.

For containment, draw the outer region first, then its inner regions.
Keep two or three nesting levels at most, at least 20 units of padding
and an open band for the container's name. A parent and a child need
distinct surfaces; do not use overlapping borders as the only signal.
Keep containment separate from arrows showing communication.

For a physical mechanism, follow the subject's geometry rather than
forcing it into rectangles. Use paths, ellipses and polygons for parts;
their colours come from semantic variables because ramp classes do not
style arbitrary paths. Label parts in the margins with `leader` lines.
Never run a line across text. Show a scale or explicitly say the drawing
is schematic when proportions could mislead.

For a dense topic, use a simple overview and a separate focused view
only when both are needed. Put their explanation in the reply. Do not
shrink an entire architecture until every label is unreadable.

## Final checks

Do these checks with numbers, not by eye, and fix the SVG before calling
`visualize`. A diagram that fails one is not ready to send.

1. Label fit. For every `text` inside a box, estimate its width: `th`
   and `t` as character count times 8, `ts` as count times 7. The width
   plus 24 must not exceed the box width. When it does, widen the box,
   split the line into two `text` lines, or shorten the words. A line
   like "Declarative YAML / Kustomize / Helm" (35 characters of `ts`, about
   245 units) does not fit a 170-unit box.
2. Label clearance. A connector label needs its estimated width plus 16
   units of free space along the connector. When the gap between two
   boxes is narrower, put the label above or below the gap, clear of
   both boxes, or widen the gap. Never center a label on a short arrow
   that ends at a box edge.
3. No overlaps. No text crosses a shape edge, a connector or another
   text. No connector runs through a box it does not connect.
4. Connectors. Trace each one from its source edge to its target edge.
   Every path has `fill="none"` or `arr`, and each arrowhead stops clear
   of nearby text.
5. Bounds. Every shape and label stays inside x=40 to x=640, and the
   lowest one sits at least 40 units above the viewBox height.
6. Theme. All text uses `t`, `ts`, `th` or an explicit themed fill, a
   ramp's child shapes are ones it supports, peer nodes are aligned and
   no crossing is only decoration.
