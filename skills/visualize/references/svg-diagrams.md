# Diagrams

A diagram is layout, and layout is arithmetic. Let the browser do it.
Hand-placed coordinates are the main source of broken diagrams: labels
that run out of their boxes, arrows that cross text, boxes that collide.

## Pick how the layout happens

| Subject | Method |
| --- | --- |
| Nodes with relationships: a flow, a pipeline, an architecture | Measured layout: CSS places the boxes, a short final script draws the connectors |
| A dense graph, an ERD, a sequence or a class diagram | Mermaid, see `references/libraries.md` |
| A mechanism, a map, an annotated drawing, anything whose shape carries meaning | Hand-laid SVG, below |

Measured layout is the default for boxes and arrows. Reach for hand-laid
SVG when the geometry is the subject, not when a flowchart feels simple.

## Measured layout

Write the nodes as HTML in rows. CSS grid and flex size each box around
its own text, so no label can overflow and nothing needs measuring by
hand. The preview already shows the boxes, since styles apply before
scripts run. A final script then reads each box with
`getBoundingClientRect()` and draws the connectors into an overlay SVG
that covers the container.

Rules that keep it correct:

- The container is `position: relative` and the overlay is
  `position: absolute; inset: 0; pointer-events: none`.
- Give every node a stable id and list the connections as data, so the
  drawing code stays one loop.
- Offsets come from the container's own rectangle, so the drawing is
  independent of scrolling and of where the card sits.
- Redraw on `visualtheme`, and on a `ResizeObserver` of the container,
  which also covers a late font.
- Put a connector label beside its line, not on it.
- Keep the reading direction one way, top to bottom or left to right.

```html
<style>
.flow { display: grid; gap: 28px 20px; padding: 24px 12px; position: relative; }
.flow-row { display: flex; gap: 20px; justify-content: center; flex-wrap: wrap; }
.flow-node {
  flex: 1 1 0; min-width: 120px; max-width: 220px; padding: 12px 14px;
  border: 0.5px solid var(--b); border-radius: var(--border-radius-lg);
  background: var(--bg2);
}
.flow-node h3 { font-size: 14px; font-weight: 500; margin: 0; }
.flow-node p { margin: 2px 0 0; color: var(--s); font-size: 12px; }
.flow-wires { position: absolute; inset: 0; pointer-events: none; }
.flow-caption { color: var(--t); font-size: 12px; text-align: center; }
</style>

<div class="flow" id="flow">
  <svg class="flow-wires" id="wires" aria-hidden="true"></svg>
  <div class="flow-row">
    <div class="flow-node" id="git"><h3>Git repository</h3><p>desired state</p></div>
  </div>
  <div class="flow-row">
    <div class="flow-node" id="source"><h3>source-controller</h3><p>fetches artifacts</p></div>
  </div>
  <div class="flow-row">
    <div class="flow-node" id="kustomize"><h3>kustomize-controller</h3><p>applies manifests</p></div>
    <div class="flow-node" id="helm"><h3>helm-controller</h3><p>manages releases</p></div>
  </div>
  <div class="flow-row">
    <div class="flow-node" id="cluster"><h3>Kubernetes cluster</h3><p>live workloads</p></div>
  </div>
  <p class="flow-caption">Flux pulls from Git, reconciles, and keeps the cluster on the declared state.</p>
</div>

<script>
(function () {
  const wires = document.getElementById("wires");
  const frame = document.getElementById("flow");
  const links = [
    ["git", "source", "pull"],
    ["source", "kustomize", "build"],
    ["source", "helm", "release"],
    ["kustomize", "cluster", "apply"],
    ["helm", "cluster", "apply"],
  ];
  const ns = "http://www.w3.org/2000/svg";
  function draw() {
    const box = frame.getBoundingClientRect();
    wires.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    wires.setAttribute("width", box.width);
    wires.setAttribute("height", box.height);
    wires.replaceChildren();
    for (const [fromId, toId, label] of links) {
      const a = document.getElementById(fromId).getBoundingClientRect();
      const b = document.getElementById(toId).getBoundingClientRect();
      const x1 = a.left - box.left + a.width / 2;
      const y1 = a.bottom - box.top;
      const x2 = b.left - box.left + b.width / 2;
      const y2 = b.top - box.top;
      const mid = (y1 + y2) / 2;
      const path = document.createElementNS(ns, "path");
      path.setAttribute("class", "arr");
      path.setAttribute("fill", "none");
      path.setAttribute("d", `M ${x1} ${y1} L ${x1} ${mid} L ${x2} ${mid} L ${x2} ${y2 - 6}`);
      wires.append(path);
      const head = document.createElementNS(ns, "path");
      head.setAttribute("class", "arr");
      head.setAttribute("d", `M ${x2 - 4} ${y2 - 7} L ${x2} ${y2 - 1} L ${x2 + 4} ${y2 - 7}`);
      wires.append(head);
      // a label beside its line, never on it
      const straight = Math.abs(x1 - x2) < 1;
      const text = document.createElementNS(ns, "text");
      text.setAttribute("class", "ts");
      text.setAttribute("x", straight ? x1 + 8 : (x1 + x2) / 2);
      text.setAttribute("y", mid - 5);
      text.setAttribute("text-anchor", straight ? "start" : "middle");
      text.textContent = label;
      wires.append(text);
    }
  }
  draw();
  new ResizeObserver(draw).observe(frame);
  window.addEventListener("visualtheme", draw);
})();
</script>
```

## Hand-laid SVG for geometry

Use this only where the shapes carry the meaning. Use a 680-unit-wide
viewBox. Keep ordinary content between x=40 and x=640.
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

A flowchart of boxes belongs in measured layout above. For the arrows of
a hand-laid drawing, declare one `marker` in `defs` with a local id, an
open head of `fill="none"` whose `stroke` is `context-stroke` so it takes
the connector's own colour, and `orient="auto-start-reverse"`. Reference
it with `marker-end` and stop the line clear of the shape it points at.

## Pick the diagram type

Choose one reading direction, label branches with their conditions and
leave room for the labels. Do not imply every process is linear if it
has a meaningful failure or feedback path.

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

These apply to hand-laid SVG, where nothing measures the text for you.
Do them with numbers, not by eye, and fix the SVG before calling
`visualize`. A diagram that fails one is not ready to send. Measured
layout needs only checks 3 and 4, and only for its connectors.

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
