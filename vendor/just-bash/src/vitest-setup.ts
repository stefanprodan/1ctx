/**
 * Vitest setup file: ensures DefenseInDepthBox singleton is reset between
 * test files so process-wide monkey-patches don't leak across tests.
 *
 * With `isolate: false`, test files share the same thread and module state.
 * Without this cleanup, patches from one file's Bash instance persist into
 * the next file's tests.
 */
// (1ctx vitest-shim) vi, to add the stubs Bun lacks
import { afterAll, beforeAll, vi } from "vitest";
import { DefenseInDepthBox } from "./security/defense-in-depth-box.js";

beforeAll(() => {
  DefenseInDepthBox.resetInstance();
});

afterAll(() => {
  DefenseInDepthBox.resetInstance();
});

/**
 * (1ctx vitest-shim) Bun's vi lacks vitest's global and environment stubs,
 * so the tests that stub Buffer, fetch or a variable failed on Bun alone.
 * These keep vitest's meaning: a stub sets the value, and unstubbing puts
 * back what was there before the first stub of each name.
 */
const stubbedGlobals = new Map<string, PropertyDescriptor | undefined>();
const stubbedEnvs = new Map<string, string | undefined>();
const shim = vi as unknown as Record<string, unknown>;
if (typeof shim.stubGlobal !== "function") {
  Object.assign(shim, {
    stubGlobal(name: string, value: unknown) {
      if (!stubbedGlobals.has(name)) {
        stubbedGlobals.set(
          name,
          Object.getOwnPropertyDescriptor(globalThis, name),
        );
      }
      Object.defineProperty(globalThis, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      return vi;
    },
    unstubAllGlobals() {
      for (const [name, descriptor] of stubbedGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
      stubbedGlobals.clear();
      return vi;
    },
    stubEnv(name: string, value: string | undefined) {
      if (!stubbedEnvs.has(name)) stubbedEnvs.set(name, process.env[name]);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      return vi;
    },
    unstubAllEnvs() {
      for (const [name, value] of stubbedEnvs) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      stubbedEnvs.clear();
      return vi;
    },
  });
}
