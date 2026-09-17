# Art and illustration

Draw art when the task asks for an illustration or when a concrete
picture explains a subject. Do not insert decoration into a short factual
answer. A rich composition can use more of the canvas than a diagram,
but still needs a clear focal point and deliberate negative space.

## Flat compositions

Build depth with overlapping shapes, not gradients, shadows, blur or
glow. Use curved paths for organic forms, ellipses for petals or joints,
and repeated lines or dots for texture. A group transform can repeat a
motif around a center without recomputing its geometry. Keep the number
of elements bounded so the fragment remains small.

Use the frame's ramps for rects, circles and ellipses and semantic
variables for paths. Choose a small related palette, not every available
ramp. Text and surrounding UI must always follow the frame's colours.
Keep the outer surface transparent. For a schematic scene, name the
objects so their identity does not rely on a physical colour.

## A radial botanical motif

This complete static example uses four repeated petal pairs and a center.
It is visible in preview and changes palette with the app's theme without
scripts. The petals' geometry creates the depth.

```html
<style>
.botanical { display: block; }
</style>
<svg class="botanical" width="100%" viewBox="0 0 680 400" role="img" aria-label="A geometric flower with eight petals">
  <g transform="translate(340 200)" stroke-width="0.5">
    <g class="c-teal">
      <ellipse cx="0" cy="-78" rx="32" ry="92"></ellipse>
      <ellipse cx="0" cy="78" rx="32" ry="92"></ellipse>
    </g>
    <g class="c-purple" transform="rotate(45)">
      <ellipse cx="0" cy="-78" rx="32" ry="92"></ellipse>
      <ellipse cx="0" cy="78" rx="32" ry="92"></ellipse>
    </g>
    <g class="c-teal" transform="rotate(90)">
      <ellipse cx="0" cy="-78" rx="32" ry="92"></ellipse>
      <ellipse cx="0" cy="78" rx="32" ry="92"></ellipse>
    </g>
    <g class="c-purple" transform="rotate(135)">
      <ellipse cx="0" cy="-78" rx="32" ry="92"></ellipse>
      <ellipse cx="0" cy="78" rx="32" ry="92"></ellipse>
    </g>
    <circle class="c-amber" cx="0" cy="0" r="36"></circle>
  </g>
</svg>
```

## Generators and scenes

For procedural patterns, keep a deterministic seed and parameterize
count, spacing and angle. A reset should restore the same composition,
not change it accidentally. Write generators in the closing script and
call them there. Include a representative still in the initial markup;
do not make the preview depend on script-generated geometry.

Use canvas for thousands of small marks, reading actual colour strings
from `getComputedStyle` inside each drawing pass. Listen for `visualtheme`
and resize, clear before redrawing and account for device pixel ratio.
Keep animation paused unless the user starts it, honor reduced motion
and stop work when the document leaves. A static illustration needs
neither an animation loop nor an external library.

For an actual 3D scene, read `references/libraries.md`: use real geometry
with a deliberate camera and lighting, not CSS perspective pretending to
be a renderer. Always provide a readable still or explanation if the
renderer is unavailable.
