// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The trace another agent reads of a turn: calls only, one line each,
// on the fixture of a summoned turn.

import { describe, expect, test } from "bun:test";
import {
  NOT_YOURS,
  summary,
  TRACE_HEADING,
  TRACE_LINE_CHARS,
  TRACE_LINES,
  type TraceCall,
  trace,
  traceCalls,
  traceLine,
  yoursOf,
} from "../../../src/server/runner/trace.ts";
import { savedDocs } from "../../../src/server/sessions/messages.ts";
import type { Offered } from "../../../src/server/tools/index.ts";
import { TRACE, TURN, YOURS } from "../../fixtures/runner/trace.ts";

const done = (
  name: string,
  args: unknown,
  saved: string[] = [],
): TraceCall => ({
  name,
  arguments: JSON.stringify(args),
  status: "done",
  saved: saved.length === 0 ? null : savedDocs(saved),
});

describe("the trace", () => {
  test("a turn's calls, never their results, reasoning or signatures", () => {
    const text = trace(traceCalls(TURN), YOURS);
    expect(text).toBe(TRACE);
    expect(text).not.toContain("result the trace never carries");
    expect(text).not.toContain("thinking");
    expect(text).not.toContain("sig-never-shown");
    expect(text).not.toContain("It is true");
    expect(text).not.toContain("memory text");
  });

  test("the same calls give the same bytes", () => {
    expect(trace(traceCalls(structuredClone(TURN)), YOURS)).toBe(
      trace(traceCalls(TURN), YOURS),
    );
  });

  test("a turn without calls has no trace", () => {
    expect(trace([], YOURS)).toBe("");
    expect(
      trace(traceCalls(TURN.filter((row) => row.slot !== "work")), YOURS),
    ).toBe("");
  });

  test("a visual and a catalog lookup are no calls", () => {
    const names = traceCalls(TURN).map((call) => call.name);
    expect(names).not.toContain("visualize");
    expect(names).not.toContain("mcp_describe");
    const looks = TURN.map((row) =>
      row.id === "w1" || row.id === "w2"
        ? {
            ...row,
            toolCalls: (row.toolCalls ?? []).filter((call) =>
              ["visualize", "mcp_describe"].includes(call.name),
            ),
          }
        : row,
    );
    expect(trace(traceCalls(looks), YOURS)).toBe("");
  });

  test("each tool is identified by what it was asked", () => {
    expect(summary(done("bash", { command: "ls /knowledge\nwc -l x" }))).toBe(
      "ls /knowledge",
    );
    expect(summary(done("websearch", { query: "q", domain: "d" }))).toBe("q");
    expect(summary(done("webfetch", { url: "https://x.io", start: 3 }))).toBe(
      "https://x.io",
    );
    expect(summary(done("skill_file", { name: "s", path: "a.md" }))).toBe("s");
    expect(summary(done("skill", { name: "flux-ops" }))).toBe("flux-ops");
    expect(summary(done("notes", { path: "/knowledge/a.md", n: 1 }))).toBe(
      "/knowledge/a.md",
    );
    expect(summary(done("mcp__fs__read", { path: "/a", lines: 3 }))).toBe(
      "path=/a lines=3",
    );
    expect(summary({ name: "bash", arguments: "not json" })).toBe("not json");
    const continued =
      "mkdir -p /knowledge/notes && \\\n  cat > \"$F\" <<'EOF'\nhi\nEOF";
    expect(summary(done("bash", { command: continued }))).toBe(
      `mkdir -p /knowledge/notes && cat > "$F" <<'EOF'`,
    );
  });

  test("a tool name with a newline stays on one line", () => {
    expect(traceLine(done("mcp__a\nb", { q: "x" }), YOURS)).toBe(
      "mcp__a b q=x ok (not your tool)",
    );
  });

  test("a memory edit shows its action and topic, never its text", () => {
    const set = { action: "set", topic: "db", text: "the password is x" };
    expect(summary(done("memory_edit", set))).toBe("action=set topic=db");
    expect(
      summary(done("memory_edit", { text: "x", action: "remove", topic: "" })),
    ).toBe("action=remove");
    expect(summary(done("memory_edit", { action: "append", text: "y" }))).toBe(
      "action=append",
    );
    const broken = { name: "memory_edit", arguments: '{"text":"secret' };
    expect(summary(broken)).toBe("");
    expect(traceLine({ ...broken, status: "done", saved: null }, YOURS)).toBe(
      "memory_edit ok",
    );
  });

  test("a doc written past the first line shows as saved", () => {
    const command = 'F=/knowledge/x.md\ncat > "$F" <<EOF\nhi\nEOF';
    const write = (paths: string[]) =>
      traceLine(done("bash", { command }, paths), YOURS);
    expect(write(["/knowledge/x.md"])).toBe(
      "bash F=/knowledge/x.md ok saved /knowledge/x.md",
    );
    expect(write(["/knowledge/notes/a.md", "/knowledge/notes/b.md"])).toBe(
      "bash F=/knowledge/x.md ok saved 2 files in /knowledge/notes/",
    );
    expect(
      write(["/knowledge/a.md", "/knowledge/notes/b.md", "/knowledge/c.md"]),
    ).toBe("bash F=/knowledge/x.md ok saved /knowledge/a.md and 2 more");
    expect(write([])).toBe("bash F=/knowledge/x.md ok");
  });

  test("a save of hundreds is stored bounded and read short", () => {
    const paths = Array.from(
      { length: 500 },
      (_, i) => `/knowledge/d${i % 7}/note-${i}.md`,
    );
    const docs = savedDocs(paths);
    expect(docs.paths).toHaveLength(50);
    expect(docs.paths[0]).toBe(paths[0]);
    expect(docs.count).toBe(500);
    expect(docs.dir).toBeNull();
    expect(JSON.stringify(docs).length).toBeLessThan(2_000);
    expect(traceLine(done("bash", { command: "gen" }, paths), YOURS)).toBe(
      "bash gen ok saved /knowledge/d0/note-0.md and 499 more",
    );
    const one = savedDocs(
      paths.filter((path) => path.startsWith("/knowledge/d3/")),
    );
    expect(one.dir).toBe("/knowledge/d3");
    expect(one.count).toBe(71);
  });

  test("a long line keeps its status, mark and saved docs", () => {
    const long = `/knowledge/${"d/".repeat(20)}notes.md`;
    const write = done("bash", { command: "x".repeat(500) }, [long]);
    const line = traceLine(write, YOURS);
    expect(line.length).toBe(TRACE_LINE_CHARS);
    expect(line).toEndWith(`x… ok saved ${long}`);
    const theirs = traceLine(
      done("mcp__gh__x", { q: "y".repeat(500) }, [long]),
      YOURS,
    );
    expect(theirs.length).toBe(TRACE_LINE_CHARS);
    expect(theirs).toEndWith(`y… ok saved ${long}${NOT_YOURS}`);
    // a path that cannot fit gives way to a shorter form, never to none
    const deep = `/knowledge/${"p".repeat(191)}`;
    expect(traceLine(done("bash", { command: "ls" }, [deep]), YOURS)).toBe(
      "bash ls ok saved 1 file in /knowledge/",
    );
    const path = `/knowledge/notes/${"q".repeat(190)}.md`;
    const both = traceLine(
      done("bash", { command: "x".repeat(300) }, [path]),
      YOURS,
    );
    expect(both.length).toBeLessThanOrEqual(TRACE_LINE_CHARS);
    expect(both).toEndWith("x… ok saved 1 file in /knowledge/notes/");
    const deepDir = `/knowledge/${"d".repeat(190)}`;
    const many = traceLine(
      done("bash", { command: "x".repeat(300) }, [
        `${deepDir}/a.md`,
        `${deepDir}/b.md`,
      ]),
      YOURS,
    );
    expect(many).toEndWith("x… ok saved 2 files");
    const named = traceLine(
      done("x".repeat(300), {}, [`${deepDir}/a.md`]),
      YOURS,
    );
    expect(named.length).toBe(TRACE_LINE_CHARS);
    expect(named).toEndWith("x… ok saved …");
  });

  test("a long line is cut before its status, at a code point", () => {
    const long = traceLine(done("bash", { command: "x".repeat(500) }), YOURS);
    expect(long.length).toBe(TRACE_LINE_CHARS);
    expect(long).toEndWith("x… ok");
    const emoji = traceLine(done("bash", { command: "😀".repeat(300) }), YOURS);
    expect(emoji.length).toBeLessThanOrEqual(TRACE_LINE_CHARS);
    expect(emoji).toEndWith("… ok");
    expect(emoji).not.toMatch(/[\ud800-\udbff]…/);
    const named = traceLine(done("x".repeat(300), { a: 1 }), YOURS);
    expect(named.length).toBe(TRACE_LINE_CHARS);
    expect(named).toEndWith("x… ok");
  });

  test("a tool the reader lacks is marked, its own and builtins are not", () => {
    const line = (call: TraceCall) => traceLine(call, YOURS);
    expect(line(done("mcp__github__search", { q: "x" }))).toBe(
      "mcp__github__search q=x ok (not your tool)",
    );
    expect(line(done("mcp__fs__read", { path: "/a" }))).toBe(
      "mcp__fs__read path=/a ok",
    );
    expect(line(done("skill", { name: "flux-ops" }))).toBe(
      "skill flux-ops ok (not your tool)",
    );
    expect(line(done("skill_file", { name: "flux-ops", path: "a" }))).toBe(
      "skill_file flux-ops ok (not your tool)",
    );
    expect(line(done("skill", { name: "kube-ops" }))).toBe("skill kube-ops ok");
    for (const name of ["bash", "websearch", "webfetch", "datetime"]) {
      expect(line(done(name, { query: "q" }))).not.toContain(NOT_YOURS);
    }
    expect(line(done("memory_edit", { action: "set" }))).not.toContain(
      NOT_YOURS,
    );
  });

  test("the reader's tools are its MCP wire names and skill names", () => {
    const offered = {
      mcp: [
        { tools: [{ wireName: "mcp__gh__a" }, { wireName: "mcp__gh__b" }] },
      ],
      skills: { block: "", skills: [{ name: "flux-ops" }] },
    } as unknown as Pick<Offered, "mcp" | "skills">;
    const yours = yoursOf(offered);
    expect([...yours.mcp]).toEqual(["mcp__gh__a", "mcp__gh__b"]);
    expect([...yours.skills]).toEqual(["flux-ops"]);
    // the same turn read by an agent that has the skill marks only the
    // MCP tool it lacks
    const lines = trace(traceCalls(TURN), yours).split("\n");
    expect(lines).toContain("skill flux-ops failed");
    expect(lines).toContain(
      `mcp__github__search_issues q=is:open crash per_page=5 ok${NOT_YOURS}`,
    );
  });

  test("past the cap one line counts the calls left", () => {
    const calls = Array.from({ length: TRACE_LINES + 3 }, (_, i) =>
      done("bash", { command: `echo ${i}` }),
    );
    calls.push(done("bash", { command: "echo 0" }));
    calls.push(done("bash", { command: `echo ${TRACE_LINES + 1}` }));
    const lines = trace(calls, YOURS).split("\n");
    expect(lines[0]).toBe(TRACE_HEADING);
    expect(lines[1]).toBe("bash echo 0 ok ×2");
    expect(lines).toHaveLength(TRACE_LINES + 2);
    expect(lines.at(-1)).toBe("and 4 more calls");
  });
});
