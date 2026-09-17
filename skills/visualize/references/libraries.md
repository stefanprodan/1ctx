# Libraries

Start with inline HTML and SVG. Add a library only when its layout,
interaction or rendering does work the visual actually needs. The tool
description is the authority for allowed hosts. The URLs below are
versioned examples on the default hosts, not a guarantee they are enabled.
If a host is absent, use an allowed mirror or omit the dependency.

Use a UMD script followed by its initialization script, or a module that
imports a full URL and uses the import itself. Put every script after
the content. Classic scripts finish loading in order before modules
are inserted; a classic script must not depend on a module. Dependencies
of modules also need allowed hosts. Avoid bare specifiers, remote data,
remote images, worker-based renderers and libraries that require storage.

An empty hosts list is supported: replace Mermaid with a small SVG
relationship diagram, D3 with computed SVG positions, Three.js with a
labeled orthographic still, and audio with its note sequence and timing.
Show the essential content before final and keep it if loading fails.
Make failures explicit beside that content. Never use an empty catch.

## Mermaid relationships

Mermaid is useful for an ERD, a sequence, a class relationship or a graph
too dense to place by hand. For a handful of boxes, the measured layout
in `references/svg-diagrams.md` needs no dependency. Set `startOnLoad: false` so the final script owns rendering.
Use strict content handling, no click actions and no HTML labels.
Write the diagram source as a template literal with real line breaks.
Never join lines with an escaped newline such as `\n`: inside the tool's
JSON argument it is easy to escape twice, and the script then gets a
backslash and an `n`, which Mermaid refuses with a parse error on line 1.
Show the error's message in the status line, so a failure says what
went wrong.
Read the app's scheme through `document.documentElement.dataset.theme`.
Supply colours from the frame's variables and redraw on `visualtheme`.

Without libraries: this example draws the author, post and comment
relationships as an HTML list. The list stays alongside the rendered
diagram, or alone with a failure message if loading or rendering fails.

```html
<style>
.relations { padding: 24px; }
.relation-list { color: var(--s); font-size: 14px; padding-left: 20px; }
.relation-status { color: var(--s); font-size: 12px; }
</style>
<div class="relations">
  <ul class="relation-list">
    <li>One author writes many posts.</li>
    <li>One post receives many comments.</li>
  </ul>
  <div id="relations-diagram" aria-label="Author, post and comment relationships"></div>
  <p id="relations-status" class="relation-status" role="status">Relationships shown; layout draws after final.</p>
</div>
<script type="module">
const status = document.getElementById("relations-status");
try {
  const { default: mermaid } = await import("https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs");
  // real line breaks in a template literal: a backslash n typed into the
  // html argument can arrive as two characters and break the parse
  const source = `flowchart LR
Author -->|writes| Post
Post -->|receives| Comment`;
  let version = 0;
  async function draw() {
    const ticket = ++version;
    const styles = getComputedStyle(document.documentElement);
    const color = (name) => styles.getPropertyValue(name).trim();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      flowchart: { htmlLabels: false },
      themeVariables: {
        darkMode: document.documentElement.dataset.theme === "dark",
        fontFamily: color("--font-sans"),
        fontSize: "14px",
        primaryColor: color("--color-background-info"),
        primaryTextColor: color("--color-text-primary"),
        primaryBorderColor: color("--color-border-info"),
        secondaryColor: color("--color-background-secondary"),
        tertiaryColor: color("--color-background-tertiary"),
        lineColor: color("--color-text-secondary"),
        textColor: color("--color-text-primary"),
        background: color("--color-background-primary")
      }
    });
    try {
      const result = await mermaid.render(`relations-${ticket}`, source);
      if (ticket !== version) return;
      document.getElementById("relations-diagram").innerHTML = result.svg;
      status.textContent = "Diagram and list show the same relationships.";
    } catch (error) {
      if (ticket === version) {
        status.textContent = `Diagram unavailable; read the relationship list. (${error.message})`;
      }
    }
  }
  window.addEventListener("visualtheme", draw);
  await draw();
} catch (error) {
  status.textContent = `Layout library unavailable; read the relationship list. (${error.message})`;
}
</script>
```

## D3 scales and local exploration

D3 is useful for custom scales, selection and larger graph layouts.
Use the UMD build when a classic script is enough. For a force simulation,
bound node counts, stop it when the document leaves and show a fixed
layout when reduced motion is requested. Do not load remote datasets.

Without libraries: this example draws three inline bars for the sample
counts. D3 enables a local toggle between input order and descending
order; the original labeled bars remain if it cannot load.

```html
<style>
.counts { padding: 24px; }
.count-bar { fill: var(--color-background-info); stroke: var(--color-border-info); stroke-width: 0.5; }
.count-status { color: var(--s); font-size: 12px; }
</style>
<div class="counts">
  <p>Sample item counts</p>
  <svg id="counts" width="100%" viewBox="0 0 680 240" role="img" aria-label="Sample counts: A 20, B 60, C 40">
    <g transform="translate(0 40)"><text class="t" x="40" y="22">A: 20</text><rect class="count-bar" x="140" y="0" width="140" height="32" rx="4"></rect></g>
    <g transform="translate(0 100)"><text class="t" x="40" y="22">B: 60</text><rect class="count-bar" x="140" y="0" width="420" height="32" rx="4"></rect></g>
    <g transform="translate(0 160)"><text class="t" x="40" y="22">C: 40</text><rect class="count-bar" x="140" y="0" width="280" height="32" rx="4"></rect></g>
  </svg>
  <button id="count-order" type="button" disabled>Rank by count</button>
  <p id="count-status" class="count-status" role="status">Input order</p>
</div>
<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>
<script>
(() => {
  const button = document.getElementById("count-order");
  const status = document.getElementById("count-status");
  if (typeof d3 === "undefined") {
    status.textContent = "Sorting unavailable; the inline bars show all counts.";
    return;
  }
  const rows = [{ name: "A", value: 20 }, { name: "B", value: 60 }, { name: "C", value: 40 }];
  const width = d3.scaleLinear().domain([0, 60]).range([0, 420]);
  let ranked = false;
  button.addEventListener("click", () => {
    ranked = !ranked;
    const ordered = ranked ? rows.slice().sort((a, b) => b.value - a.value) : rows;
    const groups = d3.select("#counts").selectAll("g").data(ordered);
    groups.select("rect").attr("width", (row) => width(row.value));
    groups.select("text").text((row) => `${row.name}: ${row.value}`);
    button.textContent = ranked ? "Use input order" : "Rank by count";
    status.textContent = ranked ? "Descending count" : "Input order";
  });
  button.disabled = false;
})();
</script>
```

## Three.js geometry and axes

Use real WebGL geometry for a 3D subject, not CSS perspective or manual
2D projection pretending to be a renderer. Three.js is right-handed:
positive X goes right, positive Y up and positive Z toward the viewer.
For an aircraft, the body runs along Z, nose toward negative Z, wings
along X and the vertical fin along Y. A cylinder starts along Y; rotate
it around X by a quarter turn to align it with Z. Pitch is rotation
around X, roll around Z and yaw around Y.

Use a perspective camera aimed at the subject, antialiasing, ambient
and directional light, and real materials. Size the renderer to its
container and handle resize. Avoid a continuous loop for a still scene.
For interactive orbiting, import a compatible controls module from an
allowed full URL and render on change; do not assume it is preloaded.

Without libraries: the example draws an inline top view labeled with the
aircraft axes. It remains if the module or WebGL is unavailable. When
available, a locally controlled 3D view appears below the still.

```html
<style>
.aircraft { padding: 24px; }
.aircraft-body { fill: var(--color-background-info); stroke: var(--color-border-info); stroke-width: 0.5; }
.aircraft-status { color: var(--s); font-size: 12px; }
.scene { width: 100%; }
</style>
<div class="aircraft">
  <svg width="100%" viewBox="0 0 680 240" role="img" aria-label="Aircraft top view: nose at negative Z, wings along X, fin along Y">
    <path class="aircraft-body" d="M340 40L356 108L540 130L540 150L356 142L356 190L390 202L390 210L290 210L290 202L324 190L324 142L140 150L140 130L324 108Z"></path>
    <text class="ts" x="370" y="54">Nose: -Z</text>
    <text class="ts" x="550" y="144">Wing: +X</text>
    <text class="ts" x="430" y="202">Fin rises along Y</text>
  </svg>
  <div id="aircraft-scene" class="scene"></div>
  <button id="aircraft-turn" type="button" disabled>Turn view</button>
  <p id="aircraft-status" class="aircraft-status" role="status">Top view shown; 3D draws after final.</p>
</div>
<script type="module">
const status = document.getElementById("aircraft-status");
try {
  const THREE = await import("https://cdn.jsdelivr.net/npm/three@0.174.0/build/three.module.js");
  const host = document.getElementById("aircraft-scene");
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(3, 2, 4);
  camera.lookAt(0, 0, 0);
  const model = new THREE.Group();
  const material = new THREE.MeshStandardMaterial();
  const bodyGeometry = new THREE.CylinderGeometry(0.08, 0.14, 2, 16);
  const wingGeometry = new THREE.BoxGeometry(2.5, 0.04, 0.4);
  const finGeometry = new THREE.BoxGeometry(0.04, 0.4, 0.3);
  const body = new THREE.Mesh(bodyGeometry, material);
  body.rotation.x = -Math.PI / 2;
  const wings = new THREE.Mesh(wingGeometry, material);
  const fin = new THREE.Mesh(finGeometry, material);
  fin.position.set(0, 0.2, 0.8);
  model.add(body, wings, fin);
  scene.add(model);
  const light = new THREE.DirectionalLight();
  light.position.set(3, 5, 4);
  scene.add(new THREE.AmbientLight(undefined, 1.5), light);
  function draw() {
    material.color.set(getComputedStyle(document.documentElement)
      .getPropertyValue("--color-text-info").trim());
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, 280);
    camera.aspect = host.clientWidth / 280;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  }
  document.getElementById("aircraft-turn").addEventListener("click", () => {
    model.rotation.y += Math.PI / 8;
    draw();
  });
  draw();
  document.getElementById("aircraft-turn").disabled = false;
  status.textContent = "Turn view rotates the model around Y.";
  window.addEventListener("resize", draw);
  window.addEventListener("visualtheme", draw);
  window.addEventListener("pagehide", () => {
    bodyGeometry.dispose();
    wingGeometry.dispose();
    finGeometry.dispose();
    material.dispose();
    renderer.dispose();
  });
} catch (error) {
  status.textContent = `3D unavailable; the labeled top view shows the axes. (${error.message})`;
}
</script>
```

## Tone.js and user-started audio

Audio must start only on an explicit click, at a moderate volume. Use
synthesized notes, not remote samples. Keep a visual score and duration
available, dispose audio resources when the document leaves and handle
audio permission refusal. A simple finite phrase needs no endless loop.

Tone.js can schedule complex phrases, but its common UMD builds create
a worker clock and an audio context on load. Workers are blocked here;
do not load those builds or widen the sandbox to accommodate them.
For a short phrase, use native Web Audio instead, creating its context
inside the click handler. The example below needs no library.

Without libraries: the example draws the note sequence and timing as
text and plays synthesized notes on a click if Web Audio is available.
The score stays visible if audio is unsupported or refused.

```html
<style>
.score { padding: 24px; }
.score-notes { font-family: var(--font-mono); margin-bottom: 12px; }
.score-status { color: var(--s); font-size: 12px; }
</style>
<div class="score">
  <p class="score-notes">C4, E4, G4: one note every 0.4 seconds</p>
  <button id="play-score" type="button" disabled>Play three notes</button>
  <p id="score-status" class="score-status" role="status">Score shown; sound waits for a click after final.</p>
</div>
<script>
(() => {
  const button = document.getElementById("play-score");
  const status = document.getElementById("score-status");
  if (typeof AudioContext === "undefined") {
    status.textContent = "Sound unavailable; read the three-note score.";
    return;
  }
  let context;
  let timer;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      if (!context) context = new AudioContext();
      await context.resume();
      const start = context.currentTime + 0.05;
      [261.63, 329.63, 392].forEach((frequency, i) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const at = start + i * 0.4;
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.06, at + 0.02);
        gain.gain.linearRampToValueAtTime(0, at + 0.2);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(at);
        oscillator.stop(at + 0.21);
        oscillator.addEventListener("ended", () => {
          oscillator.disconnect();
          gain.disconnect();
        });
      });
      status.textContent = "Playing C4, E4, G4.";
      timer = setTimeout(() => {
        button.disabled = false;
        status.textContent = "Finished.";
      }, 1200);
    } catch (error) {
      status.textContent = `Audio refused; the score is still available. (${error.message})`;
      button.disabled = false;
    }
  });
  button.disabled = false;
  window.addEventListener("pagehide", () => {
    clearTimeout(timer);
    if (context) {
      context.close().catch(() => {
        status.textContent = "The audio context could not close.";
      });
    }
  });
})();
</script>
```
