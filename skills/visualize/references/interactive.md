# Interactive explainers

Add a control only when changing it reveals something. Use bounded inputs,
an informative initial state and a visible numeric readout. Buttons,
ranges, selects and checkboxes are already styled. Install listeners in
the closing script; nothing interactive runs while the preview streams.
Render initial results as HTML or SVG rather than leaving a blank canvas.

## A bounded function plotter

This plots a sine wave over one period. The static polyline shows its
initial shape before final; the script replaces its points with finer
samples and enables the amplitude control. Coordinates and units are
explicit. Clamp inputs and round only the displayed value.

```html
<style>
.plot-controls { display: flex; align-items: center; gap: 16px; padding: 12px 40px 24px; }
.plot-controls input { flex: 1; }
.plot-controls output { min-width: 4ch; font-family: var(--font-mono); }
.wave { fill: none; stroke: var(--color-text-info); stroke-width: 2; }
.axis { stroke: var(--b); stroke-width: 0.5; }
</style>
<svg width="100%" viewBox="0 0 680 300" role="img" aria-label="Sine wave, x from zero to one full period, y from minus two to two">
  <line class="axis" x1="60" y1="150" x2="620" y2="150"></line>
  <line class="axis" x1="60" y1="40" x2="60" y2="260"></line>
  <text class="ts" x="40" y="50">2</text>
  <text class="ts" x="34" y="255">-2</text>
  <text class="ts" x="60" y="280">0</text>
  <text class="ts" x="600" y="280">2 pi</text>
  <polyline id="wave" class="wave" points="60,150 130,115 200,100 270,115 340,150 410,185 480,200 550,185 620,150"></polyline>
</svg>
<div class="plot-controls">
  <label for="amplitude">Amplitude</label>
  <input id="amplitude" type="range" min="0" max="2" step="0.1" value="1" disabled>
  <output id="amplitude-value" for="amplitude">1.0</output>
</div>
<script>
(() => {
  const input = document.getElementById("amplitude");
  const wave = document.getElementById("wave");
  function draw(amplitude) {
    const points = Array.from({ length: 281 }, (_, i) => {
      const x = 60 + i * 2;
      const y = 150 - 50 * amplitude * Math.sin(i / 280 * Math.PI * 2);
      return `${x},${y.toFixed(2)}`;
    });
    wave.setAttribute("points", points.join(" "));
    document.getElementById("amplitude-value").textContent = amplitude.toFixed(1);
  }
  input.addEventListener("input", () => {
    const value = Number(input.value);
    if (Number.isFinite(value)) draw(Math.max(0, Math.min(2, value)));
  });
  draw(1);
  input.disabled = false;
})();
</script>
```

Keep a plot's mathematical function fixed or select it from known
functions. Do not evaluate user-entered code. For an adjustable frequency,
sample densely enough for the highest frequency and explain aliasing
if the demonstration is about undersampling.

## Steps and tabs after final

A staged process is easier to follow one step at a time, but its preview
must show every stage. This example begins as a stacked explanation.
The script enables Previous and Next only after wiring them and then
selects the first stage. The counter is announced without moving focus.

```html
<style>
.steps { padding: 24px; }
.step { padding: 16px; margin-bottom: 12px; background: var(--bg2); border-radius: var(--border-radius-md); }
.step-name { font-weight: 500; }
.step-nav { display: flex; gap: 12px; align-items: center; }
.step-nav button { min-height: 44px; }
.step-count { margin-left: auto; color: var(--s); font-size: 14px; }
</style>
<div class="steps">
  <section class="step">
    <p class="step-name">1. Read</p><p>Observe the current value.</p>
  </section>
  <section class="step">
    <p class="step-name">2. Compare</p><p>Find the difference from the target.</p>
  </section>
  <section class="step">
    <p class="step-name">3. Adjust</p><p>Apply a correction, then read again.</p>
  </section>
  <div class="step-nav">
    <button id="previous" type="button" disabled>Previous</button>
    <button id="next" type="button" disabled>Next</button>
    <span id="step-count" class="step-count" aria-live="polite">All 3 steps</span>
  </div>
</div>
<script>
(() => {
  const steps = [...document.querySelectorAll(".step")];
  const previous = document.getElementById("previous");
  const next = document.getElementById("next");
  let current = 0;
  function select(index) {
    current = Math.max(0, Math.min(steps.length - 1, index));
    steps.forEach((step, i) => { step.hidden = i !== current; });
    previous.disabled = current === 0;
    next.disabled = current === steps.length - 1;
    document.getElementById("step-count").textContent =
      `Step ${current + 1} of ${steps.length}`;
  }
  previous.addEventListener("click", () => select(current - 1));
  next.addEventListener("click", () => select(current + 1));
  select(0);
})();
</script>
```

Use tabs for alternative views of the same subject, not sequential steps.
Keep all panels visible in the markup. In the final script, add tab
semantics, `aria-selected`, `aria-controls` and a roving tab index;
handle arrow keys as well as clicks. Hide unselected panels only then.
Do not label a row of buttons as tabs without the keyboard behavior.

## Motion and simulations

Movement must demonstrate a change, not distract. Prefer a paused,
meaningful frame with Play, Pause and Reset. Keep one animation loop:
store the request id, cancel it before restarting, and reset state without
creating a second loop. Integrate time using the animation timestamp,
clamping a long gap after a hidden tab. Bound particle counts, speed and
the number of calculation steps per frame.

For canvas, set backing dimensions to CSS size times device pixel ratio,
reset the transform on resize and draw in CSS-pixel coordinates. Read
theme variables on every redraw; listen for `visualtheme` and resize.
Keep explanatory HTML or an SVG still visible until canvas has drawn.
Handle a missing drawing context with a visible message, not an empty box.

CSS animation is possible before scripts run, so gate authored motion on
a class added only by the final script. This complete example moves a
marker between two positions on demand. Reduced motion leaves it still.

```html
<style>
.motion { padding: 24px 40px; }
.track { height: 40px; background: var(--bg2); border-radius: var(--border-radius-md); margin-bottom: 12px; }
.marker { width: 24px; height: 40px; background: var(--color-text-info); border-radius: var(--border-radius-md); }
.moving .marker { animation: travel 2s ease-in-out infinite alternate; }
@keyframes travel { from { transform: translateX(0); } to { transform: translateX(480px); } }
@media (prefers-reduced-motion: reduce) { .moving .marker { animation: none; } }
</style>
<div id="motion" class="motion">
  <div class="track" role="img" aria-label="Marker moving along a track"><div class="marker"></div></div>
  <button id="play" type="button" disabled>Play</button>
  <span id="motion-state" aria-live="polite">Paused</span>
</div>
<script>
(() => {
  const root = document.getElementById("motion");
  const button = document.getElementById("play");
  const status = document.getElementById("motion-state");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  function stop() {
    root.classList.remove("moving");
    button.textContent = "Play";
    button.disabled = reduced.matches;
    status.textContent = reduced.matches ? "Reduced motion: still view" : "Paused";
  }
  button.addEventListener("click", () => {
    if (reduced.matches) return;
    const moving = root.classList.toggle("moving");
    button.textContent = moving ? "Pause" : "Play";
    status.textContent = moving ? "Playing" : "Paused";
  });
  reduced.addEventListener("change", stop);
  window.addEventListener("pagehide", stop);
  stop();
})();
</script>
```

Use the same reduced-motion preference to stop a JavaScript simulation,
not just its CSS transitions. Provide a Step button if movement is
essential to understanding a state transition. Test repeated Play,
Pause and Reset clicks, minimum and maximum inputs, and keyboard use.
