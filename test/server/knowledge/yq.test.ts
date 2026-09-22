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
});
