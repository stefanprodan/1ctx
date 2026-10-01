// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Upstream's module accessor suites (#443) on Bun: they load through tsx
// under Node, which we do not install, so the vendored copies never run.
// The boxes, main thread and worker, against a host's own accessors for
// Module._load and Module._resolveFilename: fail closed without a setter,
// block and restore, forward a write in audit mode, and survive a host
// setter that redefines, throws or ignores. Each case runs in its own bun
// process, since the box patches process globals.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SECURITY = pathToFileURL(
  join(import.meta.dir, "../../../vendor/just-bash/src/security/"),
).href;

async function run(script: string): Promise<string> {
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`bun exited ${code}: ${stderr}`);
  return stdout;
}

function setupAccessors(setter: boolean): string {
  return `
    const originals = new Map();
    const setterCalls = new Map();
    for (const prop of ["_load", "_resolveFilename"]) {
      let value = Module[prop];
      setterCalls.set(prop, 0);
      Object.defineProperty(Module, prop, {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: ${
          setter
            ? "(next) => { setterCalls.set(prop, setterCalls.get(prop) + 1); value = next; }"
            : "undefined"
        },
      });
      originals.set(prop, Object.getOwnPropertyDescriptor(Module, prop));
    }
  `;
}

// a plain get/set pair, not Bun's native slot, which upstream's
// module-accessor-descriptors.bun.test.ts and defense-in-depth.test.ts cover
describe("module accessor descriptors", () => {
  for (const worker of [false, true]) {
    test(`fails closed when the accessor has no setter to install protection through (worker=${worker})`, async () => {
      const source = new URL(
        worker ? "./worker-defense-in-depth.ts" : "./defense-in-depth-box.ts",
        SECURITY,
      ).href;
      const body = `
        import assert from "node:assert/strict";
        import { Module } from "node:module";
        const api = await import(${JSON.stringify(source)});
        ${setupAccessors(false)}
        assert.throws(
          () => ${worker ? "new api.WorkerDefenseInDepth({})" : "api.DefenseInDepthBox.getInstance(true).activate()"},
          /critical patches failed/,
        );
        // A patch we can't enforce must never be reported as installed: the
        // property must be left exactly as it was found.
        for (const [prop, original] of originals) {
          const current = Object.getOwnPropertyDescriptor(Module, prop);
          assert.equal(current.get, original.get);
          assert.equal(current.set, original.set);
        }
        process.stdout.write("ok");
      `;
      expect(await run(body)).toBe("ok");
    });

    test(`blocks calls, rejects mutation, and restores the accessor on teardown (worker=${worker})`, async () => {
      const source = new URL(
        worker ? "./worker-defense-in-depth.ts" : "./defense-in-depth-box.ts",
        SECURITY,
      ).href;
      const body = `
          import assert from "node:assert/strict";
          import { Module } from "node:module";
          const api = await import(${JSON.stringify(source)});
          ${setupAccessors(true)}
          const box = ${worker ? "new api.WorkerDefenseInDepth({})" : "api.DefenseInDepthBox.getInstance(true)"};
          const handle = ${worker ? "null" : "box.activate()"};
          const errors = [];
          const descriptors = [];
          const replacement = function replacement() {};
          const probe = async () => {
            for (const prop of ["_load", "_resolveFilename"]) {
              descriptors.push(Object.getOwnPropertyDescriptor(Module, prop));
              try { Module[prop]("node:child_process"); }
              catch (error) { errors.push(error.violation?.type); }
              // Mutating the protected slot must fail exactly like it would
              // without protection (never silently accepted, and never
              // routed to the host's setter while blocked).
              assert.throws(() => { Module[prop] = replacement; });
            }
          };
          try {
            ${worker ? "await probe();" : "await handle.run(probe);"}
          } finally {
            ${worker ? "box.deactivate();" : "handle.deactivate();"}
          }
          assert.deepEqual(errors, ["module_load", "module_resolve_filename"]);
          for (const descriptor of descriptors) {
            assert.equal("get" in descriptor, true);
            assert.equal(typeof descriptor.get(), "function");
            assert.equal(descriptor.configurable, true);
            assert.equal(descriptor.enumerable, true);
            assert.equal("value" in descriptor, false);
          }
          for (const [prop, original] of originals) {
            const restored = Object.getOwnPropertyDescriptor(Module, prop);
            assert.equal(restored.get, original.get);
            assert.equal(restored.set, original.set);
            assert.equal(restored.configurable, original.configurable);
            assert.equal(restored.enumerable, original.enumerable);
            // The real setter is called exactly twice across the whole
            // lifecycle: once to install the guarded proxy, and once during
            // teardown to reset the runtime's own override slot back to the
            // original. The blocked mutation attempts in between must never
            // reach it - that's the property under test here.
            assert.equal(setterCalls.get(prop), 2);
          }
          process.stdout.write("ok");
        `;
      expect(await run(body)).toBe("ok");
    });

    test(`forwards a reassignment through the real setter in audit mode, discarding it on teardown like other reversible patches (worker=${worker})`, async () => {
      const source = new URL(
        worker ? "./worker-defense-in-depth.ts" : "./defense-in-depth-box.ts",
        SECURITY,
      ).href;
      const body = `
            import assert from "node:assert/strict";
            import { Module } from "node:module";
            const api = await import(${JSON.stringify(source)});
            ${setupAccessors(true)}
            const originalValues = new Map(
              [...originals].map(([prop, d]) => [prop, d.get()]),
            );
            const box = ${
              worker
                ? "new api.WorkerDefenseInDepth({ auditMode: true })"
                : "api.DefenseInDepthBox.getInstance({ enabled: true, auditMode: true })"
            };
            const handle = ${worker ? "null" : "box.activate()"};
            const replacements = new Map([
              ["_load", function replacementLoad() {}],
              ["_resolveFilename", function replacementResolveFilename() {}],
            ]);
            const probe = async () => {
              for (const prop of ["_load", "_resolveFilename"]) {
                const replacement = replacements.get(prop);
                // Reassigning through the accessor while active must reach
                // the host's real setter (its side effects are preserved),
                // not be silently swallowed by a collapsed data slot.
                Module[prop] = replacement;
                // 1 call from install, 1 from this reassignment.
                assert.equal(setterCalls.get(prop), 2);
                // The new value must still be protected while active, and
                // must be readable as itself immediately (read-your-own-write
                // within the activation window).
                assert.notEqual(Module[prop], replacement);
                assert.equal(typeof Module[prop], "function");
              }
            };
            try {
              ${worker ? "await probe();" : "await handle.run(probe);"}
            } finally {
              ${worker ? "box.deactivate();" : "handle.deactivate();"}
            }
            for (const [prop, original] of originals) {
              const restored = Object.getOwnPropertyDescriptor(Module, prop);
              assert.equal(restored.get, original.get);
              assert.equal(restored.set, original.set);
              // Like every other reversible patch in this box (e.g.
              // protectProcessExecPath), a write that happens *during* the
              // activation window is scoped to that window: teardown
              // restores the pre-activation value exactly, discarding it -
              // it must not leak the replacement (or a wrapper around it)
              // past deactivation.
              assert.equal(Module[prop], originalValues.get(prop));
            }
            process.stdout.write("ok");
          `;
      expect(await run(body)).toBe("ok");
    });
  }
});

describe("module accessor host setter side effects", () => {
  for (const worker of [false, true]) {
    for (const scenario of [
      "redefine",
      "throw-install",
      "throw-write",
      "ignore-install",
      "ignore-write",
    ]) {
      test(`preserves protection and rollback after ${scenario} (worker=${worker})`, async () => {
        const source = new URL(
          worker ? "./worker-defense-in-depth.ts" : "./defense-in-depth-box.ts",
          SECURITY,
        ).href;
        const script = `
          import assert from "node:assert/strict";
          import { Module } from "node:module";
          const api = await import(${JSON.stringify(source)});
          const scenario = ${JSON.stringify(scenario)};
          const originals = new Map();
          const slots = new Map();
          for (const prop of ["_load", "_resolveFilename"]) {
            const original = Module[prop];
            let calls = 0;
            slots.set(prop, original);
            Object.defineProperty(Module, prop, {
              configurable: true,
              enumerable: true,
              get() { return slots.get(prop); },
              set(next) {
                calls++;
                if (scenario === "ignore-install" ||
                    (scenario === "ignore-write" && calls === 2)) return;
                slots.set(prop, next);
                Object.defineProperty(Module, prop, {
                  configurable: true, enumerable: true, writable: true, value: next,
                });
                if ((scenario === "throw-install" && calls === 1) ||
                    (scenario === "throw-write" && calls === 2)) {
                  throw new Error("host setter failed after mutation");
                }
              },
            });
            originals.set(prop, { value: original, descriptor: Object.getOwnPropertyDescriptor(Module, prop) });
          }
          const activate = () => {
            const box = ${
              worker
                ? "new api.WorkerDefenseInDepth({ auditMode: true })"
                : "api.DefenseInDepthBox.getInstance(true)"
            };
            return ${worker ? "box" : "box.activate()"};
          };
          if (scenario === "throw-install" || scenario === "ignore-install") {
            assert.throws(activate, /critical patches failed/);
          } else {
            const handle = activate();
            try {
              for (const prop of ["_load", "_resolveFilename"]) {
                const guard = Object.getOwnPropertyDescriptor(Module, prop);
                const previous = slots.get(prop);
                const replacement = () => "replacement";
                if (scenario === "throw-write" || scenario === "ignore-write") {
                  assert.throws(() => { Module[prop] = replacement; },
                    /host setter failed|accessor verification/);
                  assert.equal(slots.get(prop), previous);
                } else {
                  Module[prop] = replacement;
                  assert.notEqual(slots.get(prop), replacement);
                }
                const installed = Object.getOwnPropertyDescriptor(Module, prop);
                assert.equal(installed.get, guard.get);
                assert.equal(installed.set, guard.set);
                // A second write must still pass through the guard.
                Module[prop] = replacement;
                assert.notEqual(slots.get(prop), replacement);
                ${
                  worker
                    ? "const before = handle.getStats().violations.length; Module[prop](); assert.equal(handle.getStats().violations.length, before + 1);"
                    : "await handle.run(async () => { assert.throws(() => Module[prop](), /blocked/); assert.throws(() => { Module[prop] = replacement; }, /blocked/); });"
                }
              }
            } finally {
              handle.deactivate();
            }
          }
          for (const [prop, original] of originals) {
            assert.equal(slots.get(prop), original.value);
            assert.deepEqual(Object.getOwnPropertyDescriptor(Module, prop), original.descriptor);
          }
          process.stdout.write("ok");
        `;
        expect(await run(script)).toBe("ok");
      });
    }
  }
});
