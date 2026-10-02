// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// yq over a multi-document file, against what mikefarah's yq v4.53.3
// prints for the same stream: the filter runs on each document.

import { describe, expect, test } from "bun:test";
import {
  Bash,
  classify,
  type DocumentState,
  evaluateDocument,
  evaluateQuery,
  InMemoryFs,
  parseQuery,
} from "just-bash";
import YAML from "yaml";
import { CASES } from "./jq-paths.cases.ts";

const MANIFESTS = `---
apiVersion: v1
kind: ConfigMap
metadata:
  name: settings
data:
  mode: fast
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
  labels:
    app: backend
spec:
  replicas: 2
---
apiVersion: v1
kind: Service
metadata:
  name: backend
`;

async function yq(
  command: string,
  file = MANIFESTS,
  limits?: { maxQueryElements: number },
) {
  const fs = new InMemoryFs({}, {});
  fs.writeFileSync("/m.yaml", file);
  const bash = new Bash({ fs, executionLimits: limits });
  const result = await bash.exec(command);
  return { ...result, file: await fs.readFile("/m.yaml") };
}

describe("yq over several documents", () => {
  test("an expression runs once per document, results apart by ---", async () => {
    const result = await yq("yq '.metadata.name' /m.yaml");
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("settings\n---\nbackend\n---\nbackend\n");
  });

  test("select keeps the matching documents", async () => {
    const result = await yq(
      `yq 'select(.kind == "Deployment") | .spec.replicas' /m.yaml`,
    );
    expect(result.stdout).toBe("2\n");
  });

  test("whole documents come back apart", async () => {
    const result = await yq("yq '.' /m.yaml");
    expect(result.stdout.split("\n---\n")).toHaveLength(3);
    const again = await yq("yq ea '[.] | length' /m.yaml", result.stdout);
    expect(again.stdout).toBe("3\n");
  });

  test("json output is one value per document", async () => {
    const result = await yq("yq -o json -c '.kind' /m.yaml");
    expect(result.stdout).toBe('"ConfigMap"\n"Deployment"\n"Service"\n');
  });

  test("stdin reads the same way", async () => {
    const result = await yq("cat /m.yaml | yq '.kind'");
    expect(result.stdout).toBe("ConfigMap\n---\nDeployment\n---\nService\n");
  });

  test("eval-all reads the stream as one list", async () => {
    const result = await yq("yq ea '[.] | .[1].spec.replicas' /m.yaml");
    expect(result.stdout).toBe("2\n");
  });

  test("an in-place edit keeps every document", async () => {
    const result = await yq(`yq -i '.metadata.labels.team = "web"' /m.yaml`);
    expect(result.exitCode).toBe(0);
    const teams = await yq(
      "yq ea '[.] | [.[].metadata.labels.team]' -o json -I0 /m.yaml",
      result.file,
    );
    expect(teams.stdout).toBe('["web","web","web"]\n');
    const apps = await yq(
      "yq ea '[.] | [.[].metadata.labels.app]' -o json -I0 /m.yaml",
      result.file,
    );
    expect(apps.stdout).toBe('[null,"backend",null]\n');
  });

  test("scalar results written in place stay separate documents", async () => {
    const result = await yq("yq -i '.a' /m.yaml", "a: 1\n---\na: 2\n");
    expect(result.file).toBe("1\n---\n2\n");
    const again = await yq("yq ea '[.] | length' /m.yaml", result.file);
    expect(again.stdout).toBe("2\n");
  });

  test("every document is read, an empty or a null one included", async () => {
    const result = await yq(
      "yq '.b = 1' /m.yaml",
      "a: 1\n---\n~\n---\n# only a comment\n---\n",
    );
    expect(result.stdout).toBe("a: 1\nb: 1\n---\nb: 1\n---\nb: 1\n---\nb: 1\n");
  });

  test("a single document reads as before", async () => {
    const result = await yq("yq '.' /m.yaml", "a: 1\nb:\n  - x\n");
    expect(result.stdout).toBe("a: 1\nb:\n  - x\n");
  });

  test("a broken document fails the command and leaves the file", async () => {
    const broken = "a: 1\n---\na: [2\n";
    const result = await yq("yq -i '.a = 3' /m.yaml", broken);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("yq:");
    expect(result.file).toBe(broken);
  });

  test("the documents count against the element limit", async () => {
    const result = await yq("yq '.a' /m.yaml", "a: 1\n---\na: 2\n---\na: 3\n", {
      maxQueryElements: 2,
    });
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("document limit exceeded (2)");
  });

  test("json input, a -p json and eval-all go to the built-in", async () => {
    const json = await yq("yq -p json -o json -c '.a' /m.yaml", '{"a":1}');
    expect(json.stdout).toBe("1\n");
    const all = await yq("yq ea '[.] | length' /m.yaml");
    expect(all.stdout).toBe("3\n");
  });

  test("an in-place edit keeps comments, quoting and untouched style", async () => {
    const commented = [
      "# the app, delivered by Flux",
      "kind: ConfigMap",
      "data:",
      '  color: "#34577c" # brand',
      "---",
      "# scaled by the HPA",
      "kind: Deployment",
      "spec:",
      "  replicas: 2 # floor",
      "  ports: [80, 443]",
      "",
    ].join("\n");
    const result = await yq(
      `yq -i '(select(.kind == "Deployment") | .spec.replicas) = 3' /m.yaml`,
      commented,
    );
    expect(result.exitCode).toBe(0);
    expect(result.file).toBe(commented.replace("replicas: 2", "replicas: 3"));
  });

  test("an in-place edit that reorders keys writes the new order", async () => {
    const result = await yq(
      "yq -i 'to_entries | reverse | from_entries' /m.yaml",
      "a: 1 # one\nb: 2\n",
    );
    // each key keeps its comment, as mikefarah's does
    expect(result.file).toBe("b: 2\na: 1 # one\n");
  });

  test("combined flags with -i still write in place", async () => {
    const result = await yq("yq -ie '.a = 5' /m.yaml", "a: 1\n---\na: 2\n");
    expect(result.exitCode).toBe(0);
    expect(result.file).toBe("a: 5\n---\na: 5\n");
  });

  test("eval as a subcommand reads as mikefarah's", async () => {
    const result = await yq("yq eval '.metadata.name' /m.yaml");
    expect(result.stdout).toBe("settings\n---\nbackend\n---\nbackend\n");
    const short = await yq("yq e -i '.a = 2' /m.yaml", "a: 1\n");
    expect(short.file).toBe("a: 2\n");
    const all = await yq("yq ea '[.] | length' /m.yaml");
    expect(all.stdout).toBe("3\n");
  });

  test("several files are read in turn, and -i writes each", async () => {
    const fs = new InMemoryFs({}, {});
    fs.writeFileSync("/a.yaml", "a: 1\n");
    fs.writeFileSync("/b.yaml", "a: 2\n---\na: 3\n");
    const bash = new Bash({ fs });
    const read = await bash.exec("yq '.a' /a.yaml /b.yaml");
    expect(read.stdout).toBe("1\n---\n2\n---\n3\n");
    const json = await bash.exec("yq -o json -I0 '.' /a.yaml /b.yaml");
    expect(json.stdout).toBe('{"a":1}\n{"a":2}\n{"a":3}\n');
    const missing = await bash.exec("yq '.a' /a.yaml /none.yaml");
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stdout).toBe("1\n");
    await bash.exec("yq -i '.b = 1' /a.yaml /b.yaml");
    expect(await fs.readFile("/a.yaml")).toBe("a: 1\nb: 1\n");
    expect(await fs.readFile("/b.yaml")).toBe("a: 2\nb: 1\n---\na: 3\nb: 1\n");
  });

  test("a value joined to its flag, and --version", async () => {
    const joined = await yq("yq -ojson -I0 '.' /m.yaml", "a: 1\n");
    expect(joined.stdout).toBe('{"a":1}\n');
    const version = await yq("yq --version");
    expect(version.stdout).toContain("mikefarah");
  });

  test("-i writes the last of several results for a document", async () => {
    const result = await yq("yq -i '.a = (1, 2)' /m.yaml", "a: 1\n");
    expect(result.file).toBe("a: 2\n");
  });

  test("-i that matches nothing leaves the file and exits 1", async () => {
    for (const filter of [
      'select(.kind == "Nope")',
      'select(type == "!!seq") | .a = 1',
    ]) {
      const result = await yq(`yq -i '${filter}' /m.yaml`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no matches found");
      expect(result.file).toBe(MANIFESTS);
    }
  });

  test("strings a YAML 1.1 reader would retype are quoted", async () => {
    const result = await yq(
      `yq -i '.a = "yes" | .b = "1_000" | .c = "0b101"' /m.yaml`,
      "x: 1 # kept\n",
    );
    expect(result.file).toBe('x: 1 # kept\na: "yes"\nb: "1_000"\nc: "0b101"\n');
  });

  test("a tag that would keep the old type falls back to a plain write", async () => {
    const result = await yq(
      "yq -i '.port = 9090' /m.yaml",
      "port: !!str 8080\n",
    );
    expect(result.file).toBe("port: 9090\n");
  });

  test("-i on JSON writes JSON, a file named twice is edited once", async () => {
    const fs = new InMemoryFs({}, {});
    fs.writeFileSync("/a.json", '{"a":1}\n');
    fs.writeFileSync("/b.yaml", "a: 1\n");
    const bash = new Bash({ fs });
    await bash.exec("yq -i '.b = 2' /a.json");
    expect(JSON.parse(await fs.readFile("/a.json"))).toEqual({ a: 1, b: 2 });
    await bash.exec("yq -i '.a += 1' /b.yaml /b.yaml");
    expect(await fs.readFile("/b.yaml")).toBe("a: 2\n");
    const stdin = await bash.exec("yq -i '.z = 1' /b.yaml -");
    expect(stdin.exitCode).toBe(1);
    expect(await fs.readFile("/b.yaml")).toBe("a: 2\n");
  });

  test("-i keeps every scalar it did not change as written", async () => {
    const source = [
      "spec:",
      "  enabled: yes",
      "  port: 010",
      "  volumes:",
      "    - configMap:",
      "        defaultMode: 0644 # rw-r--r--",
      "  ratio: .5",
      "null: n",
      "1: one",
      "",
    ].join("\n");
    const result = await yq(
      `yq -i '.spec.replicas = 3 | .["1"] = "uno"' /m.yaml`,
      source,
    );
    expect(result.file).toBe(
      source
        .replace("1: one", "1: uno")
        .replace("  ratio: .5\n", "  ratio: .5\n  replicas: 3\n"),
    );
    const same = await yq("yq -i '.' /m.yaml", source);
    expect(same.file).toBe(source);
  });

  test("-i -e with only null results leaves the file", async () => {
    const result = await yq("yq -i -e '.spec.nothing' /m.yaml");
    expect(result.exitCode).toBe(1);
    expect(result.file).toBe(MANIFESTS);
  });

  test("with_entries keeps null values and the file's spelling", async () => {
    const pod =
      "metadata:\n  creationTimestamp: null\n  labels:\n    app: web\nspec:\n  mode: 0644 # rw\n";
    const result = await yq(
      `yq -i '.metadata |= with_entries(select(.key != "labels"))' /m.yaml`,
      pod,
    );
    expect(result.file).toBe(
      "metadata:\n  creationTimestamp: null\nspec:\n  mode: 0644 # rw\n",
    );
  });

  test("an edit that rewrites a document whole is refused when a YAML 1.1 reader would read it differently", async () => {
    const reorder = "yq -i 'to_entries | reverse | from_entries' /m.yaml";
    const refused = await yq(
      "yq -i 'to_entries' /m.yaml",
      "b: 2\nmode: 0644\n",
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("the file is left as it was");
    expect(refused.file).toBe("b: 2\nmode: 0644\n");
    // a reorder moves the nodes, so 0644 stays as written
    expect((await yq(reorder, "b: 2\nmode: 0644\n")).file).toBe(
      "mode: 0644\nb: 2\n",
    );
    const merged = "d: &d {cpu: 1}\na: {<<: *d, x: 1}\n";
    expect((await yq(reorder, merged)).file).toBe(merged);
    const written = await yq(reorder, "b: 2\na: 1 # c\n");
    expect(written.file).toBe("a: 1 # c\nb: 2\n");
  });
});

describe("load", () => {
  test("reads a file outside the working directory through the mount", async () => {
    const fs = new InMemoryFs({}, {});
    fs.writeFileSync("/work/base.yaml", "image: nginx\n");
    fs.writeFileSync("/work/app/web.yaml", "replicas: 2\n");
    const bash = new Bash({ fs, cwd: "/work/app" });
    const result = await bash.exec(
      `yq -o json -I0 '. * load("../base.yaml")' web.yaml`,
    );
    expect(result.stdout).toBe('{"replicas":2,"image":"nginx"}\n');
  });

  test("a file over the string limit is an error", async () => {
    const fs = new InMemoryFs({}, {});
    fs.writeFileSync("/big.yaml", `a: ${"x".repeat(300)}\n`);
    fs.writeFileSync("/m.yaml", "b: 1\n");
    const bash = new Bash({ fs, executionLimits: { maxStringLength: 200 } });
    const result = await bash.exec(`yq 'load("/big.yaml")' /m.yaml`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("failed to load /big.yaml");
  });

  test("a computed file name is refused", async () => {
    const result = await yq(`yq 'load(.name)' /m.yaml`, "name: /m.yaml\n");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("load takes a file name as a string");
  });
});

describe("the document walker", () => {
  const state = (filter: string, input: DocumentState, value?: unknown) =>
    classify(parseQuery(filter), input, value);

  test("a path step goes inside a document and stays computed", () => {
    for (const filter of [".a", ".[0]", ".[]", ".[1:]", ".a?", ".a.b[0]"]) {
      expect(state(filter, "document")).toBe("inside");
      expect(state(filter, "inside")).toBe("inside");
      expect(state(filter, "computed")).toBe("computed");
    }
  });

  test("the same node keeps its state", () => {
    for (const filter of [
      ".",
      "select(.a)",
      "del(.a)",
      "map_values(.)",
      ".a = 1",
      ".a |= 1",
      '{"a": .b}',
    ]) {
      for (const input of ["document", "inside", "computed"] as const) {
        expect(state(filter, input)).toBe(input);
      }
    }
  });

  test("a replacement keeps inside and loses the document", () => {
    for (const filter of [
      "length",
      'has("a")',
      "not",
      ". == 1",
      ". and true",
      "tostring",
      'test("a")',
      "@tsv",
      "to_entries",
      "sort_by(.a)",
      "[.a]",
      "type",
      "unknown_function",
    ]) {
      expect(state(filter, "document")).toBe("computed");
      expect(state(filter, "inside")).toBe("inside");
      expect(state(filter, "computed")).toBe("computed");
    }
  });

  test("a value built from nothing is computed", () => {
    for (const filter of [
      "1",
      '"x"',
      '"\\(.a)"',
      "keys",
      "with_entries(.)",
      "{}",
      "reduce .[] as $x (0; . + $x)",
    ]) {
      expect(state(filter, "inside")).toBe("computed");
    }
  });

  test("map is computed on a list and a replacement on null", () => {
    expect(state("map(.a)", "inside", [1])).toBe("computed");
    expect(state("map(.a)", "inside", null)).toBe("inside");
  });

  test("combinators compose their sides", () => {
    expect(state(".a | length", "document")).toBe("inside");
    expect(state("length | .a", "document")).toBe("computed");
    expect(state('.a // "x"', "document")).toBe("inside");
    expect(state('"x" // .a', "document")).toBe("computed");
    expect(state("(.a)", "document")).toBe("inside");
  });

  // splitting the filter must never change a value, only its tag
  test("the walker answers what the engine answers", async () => {
    const recorded = (await import(
      "../../fixtures/just-bash/yq-mikefarah.json"
    )) as unknown as {
      files: Record<string, string>;
      cases: { args: string[] }[];
    };
    const filters = new Set<string>();
    for (const { args } of recorded.cases) {
      const filter = args.find(
        (a, i) =>
          !a.startsWith("-") && !["-o", "-p", "-I"].includes(args[i - 1]),
      );
      if (filter && !["eval", "e", "eval-all", "ea"].includes(filter)) {
        filters.add(filter);
      }
    }
    for (const filter of [
      "$__loc__",
      "limit(2; .[]?)",
      "first(.[]?)",
      "label $f | .[]?, break $f",
      "[path(..)]",
      ".a as $x | .b as $y | [$x, $y, (.c // $x)]",
      "(.a, .b) as [$x] | $x",
      "if .a then .b else .c end | . // 1",
      "input",
      ".[]? | parent",
    ]) {
      filters.add(filter);
    }
    const own = await Bun.file(import.meta.path).text();
    for (const match of own.matchAll(/yq (?:-\S+ )*'([^']+)'/g)) {
      filters.add(match[1]);
    }
    const documents: unknown[] = [];
    for (const [name, text] of Object.entries(recorded.files)) {
      if (!name.endsWith(".yaml")) continue;
      for (const doc of YAML.parseAllDocuments(text))
        documents.push(doc.toJS());
    }
    const runs: [unknown, string][] = [];
    for (const filter of filters) {
      for (const document of documents) runs.push([document, filter]);
    }
    for (const [input, filter] of CASES) runs.push([input, filter]);
    expect(runs.length).toBeGreaterThan(1000);
    const answer = (run: () => unknown[]) => {
      try {
        return { values: run() };
      } catch {
        return { error: true };
      }
    };
    for (const [input, filter] of runs) {
      let ast: ReturnType<typeof parseQuery>;
      try {
        ast = parseQuery(filter);
      } catch {
        continue;
      }
      // key and path read the paths the walker follows, which is its point
      if (/"name":"(key|path)","args":\[\]/.test(JSON.stringify(ast))) continue;
      const engine = answer(() => evaluateQuery(structuredClone(input), ast));
      const walker = answer(() =>
        evaluateDocument(structuredClone(input), ast, {}).map((r) => r.value),
      );
      expect({ filter, ...walker }).toEqual({ filter, ...engine });
    }
  });
});

describe("an array's entries", () => {
  const limits = { maxArrayElements: 2 };
  // two entries out of each, under keys jq takes
  const WIDEN = "with_entries(.key |= tostring | (., .))";
  const run = (filter: string, input: unknown, dialect?: "yq") =>
    evaluateQuery(input as never, parseQuery(filter), { limits, dialect });

  for (const dialect of [undefined, "yq"] as const) {
    const name = dialect ?? "jq";

    test(`${name}: to_entries holds to the element limit`, () => {
      expect(run("to_entries", ["a", "b"], dialect)).toEqual([
        [
          { key: 0, value: "a" },
          { key: 1, value: "b" },
        ],
      ]);
      expect(() => run("to_entries", ["a", "b", "c"], dialect)).toThrow(
        "query result element limit exceeded (2)",
      );
    });

    test(`${name}: with_entries holds to the element limit`, () => {
      expect(run(WIDEN, ["a"], dialect)).toEqual([{ 0: "a" }]);
      expect(() => run("with_entries(.)", ["a", "b", "c"], dialect)).toThrow(
        "query result element limit exceeded (2)",
      );
      expect(() => run(WIDEN, ["a", "b"], dialect)).toThrow(
        "query result element limit exceeded (2)",
      );
    });
  }

  test("yq: with_entries keys a list by index, null has none", () => {
    expect(run("with_entries(.)", ["a", "b"], "yq")).toEqual([
      { 0: "a", 1: "b" },
    ]);
    expect(run("with_entries(., .)", ["a"], "yq")).toEqual([{ 0: "a" }]);
    expect(run("with_entries(.)", null, "yq")).toEqual([]);
    expect(run("to_entries", null, "yq")).toEqual([]);
  });
});

describe("the dialect's builtins hold to the element limit", () => {
  // a limit error is the shell's 126, never the filter's own failure
  const exec = (command: string) =>
    new Bash({ executionLimits: { maxQueryElements: 3 } }).exec(command);
  const tools = {
    jq: (filter: string) => `jq -n -c '${filter}'`,
    yq: (filter: string) => `yq -n -o json -I0 '${filter}'`,
  };

  for (const [name, command] of Object.entries(tools)) {
    test(`${name}: map over a map`, async () => {
      const at = await exec(command("{a:1,b:2,c:3} | map(.) | length"));
      expect(at).toMatchObject({ stdout: "3\n", exitCode: 0 });
      const fanned = await exec(command("{a:1} | map(.,.,.) | length"));
      expect(fanned).toMatchObject({ stdout: "3\n", exitCode: 0 });
      const over = await exec(command("{a:1,b:2,c:3} | map(.,.,.) | length"));
      expect(over.exitCode).toBe(126);
      expect(over.stderr).toContain("query result element limit exceeded (3)");
    });

    test(`${name}: match past the limit`, async () => {
      const at = await exec(command('"aaa" | [match("a"; "g")] | length'));
      expect(at).toMatchObject({ stdout: "3\n", exitCode: 0 });
      const over = await exec(command('"aaaa" | [match("a"; "g")] | length'));
      expect(over.exitCode).toBe(126);
      expect(over.stderr).toContain("query result element limit exceeded (3)");
    });

    test(`${name}: sub's matches past the limit`, async () => {
      const at = await exec(command('"aaa" | sub("a"; "x"; "g")'));
      expect(at).toMatchObject({ stdout: '"xxx"\n', exitCode: 0 });
      const over = await exec(command('"aaaa" | sub("a"; "x"; "g")'));
      expect(over.exitCode).toBe(126);
      expect(over.stderr).toContain("query result element limit exceeded (3)");
    });
  }

  test("jq: sub's outputs past the limit", async () => {
    const over = await exec(tools.jq('"aa" | [gsub("a"; "x", "y")] | length'));
    expect(over.exitCode).toBe(126);
    expect(over.stderr).toContain("query result element limit exceeded (3)");
  });
});

// (1ctx yq) the walker gathers pipe, comma and eval-all results held to
// the element limit, and tags them with compact paths
describe("yq's result limits", () => {
  // 900 nested maps, each beside 20 scalars; and one list aliased often
  function deep(): string {
    let value: unknown = 1;
    for (let i = 0; i < 900; i++) {
      const level: Record<string, unknown> = { k: value };
      for (let j = 0; j < 20; j++) level[`s${j}`] = j;
      value = level;
    }
    return JSON.stringify(value);
  }
  const shared = `a: &a [${Array.from({ length: 1000 }, (_, i) => i).join(",")}]\nb: [${Array(90).fill("*a").join(",")}]\n`;
  const items = JSON.stringify({
    items: Array.from({ length: 30_000 }, (_, i) => ({ v: [i, i + 1] })),
  });

  function shell(limits: Record<string, number>) {
    const fs = new InMemoryFs();
    fs.writeFileSync("/deep.json", deep());
    fs.writeFileSync("/shared.yaml", shared);
    fs.writeFileSync("/items.json", items);
    fs.writeFileSync(
      "/three.yaml",
      [0, 1, 2]
        .map((d) => `[${Array.from({ length: 300 }, (_, i) => d * 300 + i)}]`)
        .join("\n---\n"),
    );
    return new Bash({ fs, cwd: "/", executionLimits: limits });
  }

  test("a pipe's fan-out stops at the limit", async () => {
    const bash = shell({ maxQueryElements: 1000 });
    const under = await bash.exec(
      "yq -n -o json -I0 '[range(30) | range(30)] | length'",
    );
    expect(under).toMatchObject({ stdout: "900\n", exitCode: 0 });
    const over = await bash.exec("yq -n '[range(40) | range(40)]'");
    expect(over.exitCode).toBe(126);
    expect(over.stderr).toContain("query result element limit exceeded (1000)");
  });

  test("a comma's results stop at the limit", async () => {
    const bash = shell({ maxQueryElements: 1000 });
    const over = await bash.exec("yq -n '[range(600), range(600)]'");
    expect(over.exitCode).toBe(126);
    expect(over.stderr).toContain("query result element limit exceeded (1000)");
  });

  test("results across documents stop at the limit", async () => {
    const bash = shell({ maxQueryElements: 1000 });
    const each = await bash.exec("yq '.[], .[]' /three.yaml");
    expect(each.exitCode).toBe(126);
    expect(each.stderr).toContain("query result element limit exceeded (1000)");
    const all = await bash.exec("yq ea '.[], .[]' /three.yaml");
    expect(all.exitCode).toBe(126);
    expect(all.stderr).toContain("query result element limit exceeded (1000)");
  });

  test("path passes do not spend the user's iterations", async () => {
    const bash = shell({ maxJqIterations: 100_000 });
    const result = await bash.exec(
      "yq -p json '.items[].v[]' /items.json | wc -l",
    );
    expect(result).toMatchObject({ stdout: "60000\n", exitCode: 0 });
  });

  test("shared references stop at the iteration limit", async () => {
    const bash = shell({ maxJqIterations: 100_000 });
    const started = performance.now();
    const result = await bash.exec(
      "yq '[range(1500) as $x | ..[]]' /shared.yaml",
    );
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain("too many iterations (100000)");
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("-s names share the command's iterations", async () => {
    const bash = shell({ maxJqIterations: 100_000 });
    // each name costs well under the limit, all of them well over it
    const name =
      '"o/" + ([range(20000)] | map(.+1) | length | tostring) + "-" + ($index|tostring)';
    const one = await bash.exec(`yq -n -s '${name}' '1'`);
    expect(one).toMatchObject({ stderr: "", exitCode: 0 });
    const many = await bash.exec(`yq -n -s '${name}' 'range(500)'`);
    expect(many.exitCode).toBe(126);
    expect(many.stderr).toContain("too many iterations (100000)");
  });

  test("files share the command's iterations", async () => {
    const bash = shell({ maxJqIterations: 100_000 });
    const filter = "[range(10000)] | map(.+1) | length";
    const one = await bash.exec(`yq '${filter}' /shared.yaml`);
    expect(one).toMatchObject({ stdout: "10000\n", exitCode: 0 });
    const three = await bash.exec(
      `yq '${filter}' /shared.yaml /shared.yaml /shared.yaml`,
    );
    expect(three.exitCode).toBe(126);
    expect(three.stderr).toContain("too many iterations (100000)");
  });

  test("paths and keys over a deep document", async () => {
    const bash = shell({ maxJqIterations: 1_000_000 });
    const count = await bash.exec("yq -p json '[..] | length' /deep.json");
    expect(count).toMatchObject({ stdout: "18901\n", exitCode: 0 });
    const keys = await bash.exec("yq -p json '[.. | key] | length' /deep.json");
    expect(keys).toMatchObject({ stdout: "18900\n", exitCode: 0 });
    const last = await bash.exec(
      "yq -p json -o json -I0 '[.. | path] | [(map(length) | max), .[1], (.[901] | length)]' /deep.json",
    );
    // pre-order: the k chain first, the innermost value at depth 900
    expect(last).toMatchObject({
      stdout: '[900,["k"],900]\n',
      exitCode: 0,
    });
  });

  test("the root has no key", async () => {
    const bash = shell({});
    const root = await bash.exec("echo 'a: {b: 1}' | yq 'key'");
    expect(root).toMatchObject({ stdout: "", exitCode: 0 });
    const inner = await bash.exec("echo 'a: {b: 1}' | yq '.a.b | key'");
    expect(inner).toMatchObject({ stdout: "b\n", exitCode: 0 });
  });
});

// mikefarah's -s, each result to its own file, as his v4.53.3 writes them
describe("split", () => {
  const stack =
    "# stack\n---\nkind: Deployment\nmetadata:\n  name: web\n---\nkind: Service\nmetadata:\n  name: web\n";
  const split = async (command: string) => {
    const fs = new InMemoryFs({}, {});
    fs.writeFileSync("/w/all.yaml", stack);
    const result = await new Bash({ fs, cwd: "/w" }).exec(command);
    return { ...result, fs };
  };

  test("-s writes each document to the file its expression names", async () => {
    const result = await split(
      "yq -s '.kind + \"-\" + .metadata.name' all.yaml",
    );
    expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: 0 });
    expect(await result.fs.readFile("/w/Deployment-web.yml")).toBe(
      "# stack\n---\nkind: Deployment\nmetadata:\n  name: web\n",
    );
    expect(await result.fs.readFile("/w/Service-web.yml")).toBe(
      "---\nkind: Service\nmetadata:\n  name: web\n",
    );
  });

  test("$index counts, folders are made, a name's own extension stays", async () => {
    const result = await split('yq -s \'"out/" + $index + ".yaml"\' all.yaml');
    expect(result.exitCode).toBe(0);
    expect(await result.fs.readdir("/w/out")).toEqual(["0.yaml", "1.yaml"]);
    expect(await result.fs.readFile("/w/out/1.yaml")).toBe(
      "---\nkind: Service\nmetadata:\n  name: web\n",
    );
  });

  test("JSON output is written to .json, -N drops the ---", async () => {
    const json = await split("yq -o json -s '.kind' all.yaml");
    expect(await json.fs.readFile("/w/Service.json")).toBe(
      '{\n  "kind": "Service",\n  "metadata": {\n    "name": "web"\n  }\n}\n',
    );
    const plain = await split("yq -N -s '.kind' all.yaml");
    expect(await plain.fs.readFile("/w/Deployment.yml")).toBe(
      "# stack\nkind: Deployment\nmetadata:\n  name: web\n",
    );
  });

  test("a failing name says Error:, a full disk names the file", async () => {
    const failing = await split("yq -s 'error(\"boom\")' all.yaml");
    expect(failing).toMatchObject({ stderr: "Error: boom\n", exitCode: 1 });
    // room for the stack and 20 bytes more than the shell starts with
    const probe = new InMemoryFs({}, {});
    new Bash({ fs: probe, cwd: "/w" });
    const base = (probe as unknown as { retainedBytes: number }).retainedBytes;
    const fs = new InMemoryFs({}, { maxTotalBytes: base + stack.length + 20 });
    const bash = new Bash({ fs, cwd: "/w" });
    fs.writeFileSync("/w/all.yaml", stack);
    const full = await bash.exec("yq -s '\"out/\" + $index' all.yaml");
    expect(full).toMatchObject({
      stderr: "yq: out/0.yml: No space left on device\n",
      exitCode: 1,
    });
  });

  test("a lone file argument is the file, and mikefarah's refusals", async () => {
    expect((await split("yq all.yaml")).stdout).toBe(stack);
    const inPlace = await split("yq -s '.kind' -i all.yaml");
    expect(inPlace.stderr).toBe(
      "Error: write in place cannot be used with split file\n",
    );
    const nullInput = await split("yq -n all.yaml");
    expect(nullInput.stderr).toBe(
      "Error: cannot pass files in when using null-input flag\n",
    );
  });
});
