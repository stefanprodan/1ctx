// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// yq over a multi-document file, against what mikefarah's yq v4.53.3
// prints for the same stream: the filter runs on each document.

import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs } from "just-bash";

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
    const again = await yq("yq -s 'length' /m.yaml", result.stdout);
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

  test("slurp still reads one array", async () => {
    const result = await yq("yq -s '.[1].spec.replicas' /m.yaml");
    expect(result.stdout).toBe("2\n");
  });

  test("an in-place edit keeps every document", async () => {
    const result = await yq(`yq -i '.metadata.labels.team = "web"' /m.yaml`);
    expect(result.exitCode).toBe(0);
    const teams = await yq(
      "yq -s '[.[].metadata.labels.team]' -o json -c /m.yaml",
      result.file,
    );
    expect(teams.stdout).toBe('["web","web","web"]\n');
    const apps = await yq(
      "yq -s '[.[].metadata.labels.app]' -o json -c /m.yaml",
      result.file,
    );
    expect(apps.stdout).toBe('[null,"backend",null]\n');
  });

  test("scalar results written in place stay separate documents", async () => {
    const result = await yq("yq -i '.a' /m.yaml", "a: 1\n---\na: 2\n");
    expect(result.file).toBe("1\n---\n2\n");
    const again = await yq("yq -s 'length' /m.yaml", result.file);
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

  test("json input, a -p json and slurp go to the built-in", async () => {
    const json = await yq("yq -p json -o json -c '.a' /m.yaml", '{"a":1}');
    expect(json.stdout).toBe("1\n");
    const slurp = await yq("yq -s 'length' /m.yaml");
    expect(slurp.stdout).toBe("3\n");
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
    expect(result.file).toBe("b: 2\na: 1\n");
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
    const all = await yq("yq ea '.' /m.yaml");
    expect(all.exitCode).toBe(1);
    expect(all.stderr).toContain("-s reads every document");
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
      'select(type == "!!map") | .a = 1',
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
    const refused = await yq(reorder, "b: 2\nmode: 0644\n");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("the file is left as it was");
    expect(refused.file).toBe("b: 2\nmode: 0644\n");
    const merged = "d: &d {cpu: 1}\na: {<<: *d, x: 1}\n";
    expect((await yq(reorder, merged)).file).toBe(merged);
    const written = await yq(reorder, "b: 2\na: 1 # c\n");
    expect(written.file).toBe("a: 1\nb: 2\n");
  });
});
