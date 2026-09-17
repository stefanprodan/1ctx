# UI mockups

Use a mockup for a proposed interface, not for a factual answer that fits
one sentence. Make its data visibly illustrative. Controls change local
state only; never imply that a mockup saved a real record or sent a message.

## Surfaces and reusable patterns

The outer canvas stays transparent. A small contained object, such as a
phone screen or a single record, may sit on a secondary surface with
24px padding. A full-width dashboard or table needs no extra outer card.
Lift repeated spacing and typography into the opening style block.

Use a primary surface, a 0.5px tertiary border, the large radius and
16px by 20px padding for record and comparison cards. Metric grids work
well with `repeat(auto-fit, minmax(160px, 1fr))`, 12px gaps, 13px muted
labels and 24px values at weight 500. Use `minmax(0, 1fr)` for columns
with long content so intrinsic text width does not break the grid.

A record header pairs initials or a simple SVG icon with a name and a
short role. Put field/value pairs below a fine divider. Status badges
use a semantic background and its matching text variable, plus the
status word. A colour alone is not a status. Comparison cards should
align the same fields in the same order and identify the actual tradeoff,
not mark every option as recommended.

For tables, align text left, numeric values right and column headings
with their values. Use a caption or adjacent sample-data note, proper
headers and explicit table sections. If sortable, put a real button in
the heading and maintain `aria-sort`; filtering and sorting must compose.
Render the initial rows in HTML, not only in a script.

## A record beside a metric

This complete static example combines a record, fields and a status badge.
The initials are text, not a fetched avatar.

```html
<style>
.overview { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; padding: 24px; }
.record { background: var(--color-background-primary); border: 0.5px solid var(--b); border-radius: var(--border-radius-lg); padding: 16px 20px; }
.record-head { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
.initials { display: grid; place-items: center; width: 44px; height: 44px; border-radius: var(--border-radius-md); background: var(--color-background-info); color: var(--color-text-info); }
.person { font-weight: 500; }
.muted { color: var(--s); font-size: 13px; }
.fields { width: 100%; border-collapse: collapse; font-size: 14px; }
.fields th { text-align: left; font-weight: 400; color: var(--s); }
.fields td { text-align: right; }
.fields th, .fields td { border-top: 0.5px solid var(--b); padding: 8px 0; }
.badge { padding: 2px 8px; border-radius: var(--border-radius-md); background: var(--color-background-success); color: var(--color-text-success); font-size: 12px; }
.metric { background: var(--bg2); border-radius: var(--border-radius-lg); padding: 16px; }
.value { font-size: 24px; font-weight: 500; }
</style>
<div class="overview">
  <section class="record" aria-label="Sample team member">
    <div class="record-head">
      <span class="initials">AL</span>
      <div><p class="person">Alex Lee</p><p class="muted">Sample team member</p></div>
    </div>
    <table class="fields">
      <tbody>
        <tr><th scope="row">Role</th><td>Designer</td></tr>
        <tr><th scope="row">Status</th><td><span class="badge">Active</span></td></tr>
      </tbody>
    </table>
  </section>
  <section class="metric" aria-label="Sample completed tasks">
    <p class="muted">Completed tasks</p>
    <p class="value">128</p>
    <p class="muted">Illustrative total</p>
  </section>
</div>
```

## Controls and numbers

Use bare buttons, inputs, selects, textareas, ranges, checkboxes and
radios. Give each input a label, a sensible initial value and bounds.
Lay them out with flex or grid; do not wrap them in a form. Wire events
in the final script. Use `type="button"` for action buttons. Disabled
preview controls may be enabled after their listeners are installed.
If a button cannot do anything in the sandbox, omit it rather than
draw a deceptive Save, Export or Open action.

Round every computed display value using `Intl.NumberFormat`,
`Math.round` or `toFixed` with deliberate precision. Keep raw values
for calculations and sorting. State units and time ranges. Show `0`
when zero is measured, and words such as "Not measured" for absence.
Use enough precision to explain the difference, not floating-point noise.

Check keyboard focus, 44px click targets where practical, contrast in
both themes, long names and an empty-filter result. Keep the main
explanation in the reply, not a paragraph stuffed inside a metric card.
