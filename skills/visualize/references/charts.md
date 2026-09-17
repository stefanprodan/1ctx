# Charts

Use actual data supplied by the task or obtained through an offered tool
before drawing. Label illustrative values as sample data. Never imply
that the visual itself can retrieve new measurements.

## Select an honest encoding

Use bars for categories and rankings, lines for ordered time, a histogram
for a distribution and scatter for two numeric variables. A part-to-whole
chart needs a meaningful total; a short stacked bar is often easier to
compare than a doughnut. Use few slices if a doughnut is justified.
Radar charts make precise comparison difficult; prefer aligned bars
unless the shape itself is the point. Label a range or uncertainty band
and explain what its endpoints mean.

Start bar lengths at zero, use the same scale for comparable panels and
keep time gaps proportional. Distinguish a missing sample from zero.
Include units and round labels, not underlying data. Put legends beside
the plot and supplement colours with words or line patterns.

## Inline SVG first

For a few values, explicit geometry is smaller and survives any library
failure. This complete example draws a sample ranking on a zero baseline.
The longest bar is 420 units for 60 jobs, so every unit of value is seven
SVG units. A ramp group keeps the bars and their labels theme-aware.

```html
<style>
.ranking { display: block; }
</style>
<svg class="ranking" width="100%" viewBox="0 0 680 244" role="img" aria-label="Sample completed jobs: Alpha 60, Beta 40, Gamma 20">
  <text class="ts" x="40" y="32">Completed jobs, sample data</text>
  <line x1="160" y1="48" x2="160" y2="204" stroke="var(--b)" stroke-width="0.5"></line>
  <text class="t" x="40" y="80">Alpha</text>
  <text class="t" x="40" y="136">Beta</text>
  <text class="t" x="40" y="192">Gamma</text>
  <g class="c-blue">
    <rect x="160" y="56" width="420" height="32" rx="4" stroke-width="0.5"></rect>
    <rect x="160" y="112" width="280" height="32" rx="4" stroke-width="0.5"></rect>
    <rect x="160" y="168" width="140" height="32" rx="4" stroke-width="0.5"></rect>
    <text class="th" x="592" y="80">60</text>
    <text class="th" x="452" y="136">40</text>
    <text class="th" x="312" y="192">20</text>
  </g>
</svg>
```

## Chart.js with an inline alternative

Use Chart.js when interactions or many points justify it. Check the tool
description allows the example's host before using it. Put height on a
positioned wrapper, not the canvas; use `responsive: true` and
`maintainAspectRatio: false`. For a horizontal ranking, budget roughly
40px per bar plus 80px for axes.

Disable the built-in legend and use a small HTML legend that inherits the
frame's variables. Chart options need resolved colour strings, not CSS
variable expressions. Read them inside the draw function and redraw on
`visualtheme`. Disable chart animation when it adds no information.

Without libraries: the example draws a table of the four monthly sample
values and keeps it visible. If Chart.js cannot load, the status says so;
the chart wrapper is hidden only after final establishes that failure.
The CDN URL is an example, not permission to use a host absent from the tool.

```html
<style>
.revenue { padding: 24px; }
.chart-legend { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--s); margin-bottom: 8px; }
.chart-swatch { width: 20px; height: 2px; background: var(--color-text-info); }
.chart-wrap { position: relative; width: 100%; height: 280px; }
.chart-values { width: 100%; border-collapse: collapse; font-size: 14px; }
.chart-values th { text-align: left; font-weight: 500; }
.chart-values td { text-align: right; }
.chart-values th, .chart-values td { padding: 4px 8px; border-bottom: 0.5px solid var(--b); }
.chart-status { color: var(--s); font-size: 12px; }
</style>
<div class="revenue">
  <div class="chart-legend"><span class="chart-swatch"></span>Revenue, sample data in thousands</div>
  <div id="chart-wrap" class="chart-wrap"><canvas id="revenue-chart" role="img" aria-label="Monthly sample revenue, values in the following table"></canvas></div>
  <table class="chart-values" aria-label="Sample revenue in thousands">
    <tbody>
      <tr><th scope="row">January</th><td>30</td></tr>
      <tr><th scope="row">February</th><td>45</td></tr>
      <tr><th scope="row">March</th><td>28</td></tr>
      <tr><th scope="row">April</th><td>62</td></tr>
    </tbody>
  </table>
  <p id="chart-status" class="chart-status" role="status">Values shown; chart draws after final.</p>
</div>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.8/dist/chart.umd.min.js"></script>
<script>
(() => {
  const status = document.getElementById("chart-status");
  if (typeof Chart === "undefined") {
    document.getElementById("chart-wrap").hidden = true;
    status.textContent = "Chart unavailable; the table shows every value.";
    return;
  }
  let chart;
  function draw() {
    const style = getComputedStyle(document.documentElement);
    const color = (name) => style.getPropertyValue(name).trim();
    const text = color("--color-text-secondary");
    const grid = color("--color-border-tertiary");
    if (chart) chart.destroy();
    chart = new Chart(document.getElementById("revenue-chart"), {
      type: "line",
      data: {
        labels: ["Jan", "Feb", "Mar", "Apr"],
        datasets: [{
          label: "Revenue",
          data: [30, 45, 28, 62],
          borderColor: color("--color-text-info"),
          backgroundColor: color("--color-background-info"),
          pointBackgroundColor: color("--color-text-info"),
          tension: 0,
          fill: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: color("--color-background-secondary"),
            titleColor: color("--color-text-primary"),
            bodyColor: color("--color-text-primary"),
            borderColor: grid,
            borderWidth: 0.5
          }
        },
        scales: {
          x: { ticks: { color: text }, grid: { color: grid } },
          y: { beginAtZero: true, ticks: { color: text }, grid: { color: grid } }
        }
      }
    });
    status.textContent = "Chart and table show the same sample values.";
  }
  draw();
  window.addEventListener("visualtheme", draw);
  window.addEventListener("pagehide", () => chart.destroy());
})();
</script>
```

When updating a chart in place, update every theme-sensitive option,
including tooltip, grid, tick, point and dataset colours. Recreating one
chart is often simpler; destroy the old instance first. A theme change
must not accumulate canvases or listeners. Use a custom HTML legend for
multiple series, with matching labels and toggles that also update
`aria-pressed`. Retain the source table for exact values.
