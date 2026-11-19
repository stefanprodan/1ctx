// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The sandbox shell's network against a real OpenShell gateway, by
// hand (make sandbox-net-check ARGS="..."): the policy each sandbox
// network makes, credentials as providers and placeholders, and what OpenShell
// refuses. Requests go to public echo services (httpbin.org,
// example.com). The keys are made up here and written to a temporary
// secrets folder; no real key is read. Every sandbox, provider and
// profile it makes carries a fresh instance id and is deleted through
// the gateway at the end; nothing else is touched.
//
//   bun scripts/sandbox-net-check.ts --endpoint https://127.0.0.1:17670 \
//     --ca ca.crt --cert tls.crt --key tls.key [--image 1ctx-shell:dev]

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type Answer,
  type CommandCredential,
  type ShellCall,
  scrubKeys,
} from "../src/server/bash/index.ts";
import {
  headerValue,
  httpKeys,
  readKey,
} from "../src/server/credentials/index.ts";
import { wallClock } from "../src/server/lib/clock.ts";
import { logger } from "../src/server/lib/log.ts";
import { DEFAULT_LIMITS } from "../src/server/limits/index.ts";
import { sandboxBackend } from "../src/server/sandbox/backend.ts";
import {
  type Gateway,
  INSTANCE_LABEL,
  Leases,
  openshellGateway,
  type SandboxHold,
} from "../src/server/sandbox/index.ts";
import { envName } from "../src/server/sandbox/rules.ts";
import { secrets } from "../src/server/secrets/index.ts";
import type { HttpMethod } from "../src/shared/contracts/credential.ts";
import {
  SANDBOX_DEFAULT_HOSTS,
  type SandboxNet,
} from "../src/shared/sandbox-net.ts";

const { values: flags } = parseArgs({
  options: {
    endpoint: { type: "string", default: "https://127.0.0.1:17670" },
    ca: { type: "string" },
    cert: { type: "string" },
    key: { type: "string" },
    image: { type: "string", default: "1ctx-shell:dev" },
  },
});
if (!flags.ca || !flags.cert || !flags.key) {
  console.error(
    "usage: --ca <pem> --cert <pem> --key <pem> [--endpoint] [--image]",
  );
  process.exit(2);
}

const random = (n: number) =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(n)),
    (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36],
  ).join("");
const instanceId = random(12);
const labels = { [INSTANCE_LABEL]: instanceId };

// made-up keys in a folder of their own, read as the server reads them
const dir = mkdtempSync(join(tmpdir(), "sandbox-net-check-"));
const writeKey = (name: string) => {
  const value = `madeup-${random(32)}`;
  writeFileSync(join(dir, `http-${name}.key`), `${value}\n`, { mode: 0o600 });
  return value;
};
const files = secrets(dir);
const keys = httpKeys({
  secret: (kind, name) => files.read(kind, name),
  secretNames: (kind) => files.list(kind),
});

type Row = {
  name: string;
  prefix: string;
  header: string;
  template: string;
  methods: HttpMethod[];
};
const SIGNED: Row = {
  name: "netcheck-a",
  prefix: "https://httpbin.org/anything/signed/",
  header: "Authorization",
  template: "Bearer {key}",
  methods: ["GET", "HEAD"],
};
const HEADER: Row = {
  name: "netcheck-h",
  prefix: "https://httpbin.org/anything/hdr/",
  header: "X-Api-Key",
  template: "{key}",
  methods: ["GET", "POST"],
};
const COOKIE: Row = {
  name: "netcheck-c",
  prefix: "https://httpbin.org/anything/cookie/",
  header: "Cookie",
  template: "s={key}",
  methods: ["GET"],
};
// a prefix without a slash on a host the snapshot does not list
const BARE: Row = {
  name: "netcheck-p",
  prefix: "https://postman-echo.com/headers",
  header: "X-Api-Key",
  template: "{key}",
  methods: ["GET"],
};
let signedKey = writeKey(SIGNED.name);
writeKey(HEADER.name);
const bareKey = writeKey(BARE.name);
writeKey(COOKIE.name);

// each row as a command sees it: its key read now
const credentialsOf = (rows: Row[]): CommandCredential[] =>
  rows.map((row) => {
    const read = readKey(keys, `http-${row.name}`);
    if (!read.ok) return { ...row, refused: read.reason };
    return {
      ...row,
      key: read.key,
      value: headerValue(row.template, read.key),
    };
  });

const real = openshellGateway({
  endpoint: flags.endpoint!,
  ca: readFileSync(flags.ca, "utf8"),
  cert: readFileSync(flags.cert, "utf8"),
  key: readFileSync(flags.key, "utf8"),
});
let policyLoads = 0;
const gateway: Gateway = {
  ...real,
  setPolicy(...args) {
    policyLoads++;
    return real.setPolicy(...args);
  },
};
const limits = { ...DEFAULT_LIMITS };
const log = logger("sandbox-net-check");
const leases = new Leases({
  clock: wallClock,
  log,
  gateway,
  instanceId,
  image: flags.image!,
  limits: () => limits,
  repos: { hold: () => () => {} },
  net: () => net,
});
const backend = sandboxBackend({ clock: wallClock, log, limits: () => limits });

const LISTED: SandboxNet = {
  mode: "hosts",
  hosts: ["example.com", "httpbin.org"],
};
const WILD: SandboxNet = {
  mode: "hosts",
  hosts: ["**.hf.co", "*.githubusercontent.com", "httpbin.org"],
};
const OFF: SandboxNet = { mode: "off", hosts: LISTED.hosts };
const DEFAULTS: SandboxNet = {
  mode: "hosts",
  hosts: [...SANDBOX_DEFAULT_HOSTS],
};
// what the leases read at each command, as the settings row would say
let net: SandboxNet = LISTED;

// the workspace's scratch as the database would hold it, so a command
// that lands keeps its sandbox
const scratch = new Map<string, { data: Uint8Array; mode: number }>();
let revision = 0;
let usedAt: number | null = null;

let sendSerial = 0;
async function command(
  given: SandboxNet,
  rows: Row[],
  text: string,
  send = `send-${++sendSerial}`,
) {
  net = given;
  const credentials = credentialsOf(rows);
  const call: ShellCall = {
    projectId: "net-check",
    workspace: { id: "net-check", sessionId: "net-check" },
    sendId: send,
    subagent: false,
    repos: [],
    repoFileBytes: 0,
    network: true,
    credentials,
  };
  const loads = policyLoads;
  const started = performance.now();
  const hold = (await leases.acquire(
    call,
    Date.now() + 60_000,
    new AbortController().signal,
  )) as SandboxHold;
  const now = Date.now();
  const ran = await backend.run(
    {
      command: text,
      endsAt: now + 60_000,
      docs: true,
      visuals: true,
      network: given.mode === "hosts",
      cwd: "/tmp",
      knowledgeFileBytes: limits.knowledgeFileBytes,
      mountBytes: 64 << 20,
      ioBytes: 1 << 20,
      iterations: 10_000,
      knowledge: [],
      scratch: [...scratch].map(([name, file]) => ({
        name,
        ...file,
        mtime: usedAt ?? 0,
      })),
      uploads: [],
      kept: [],
      repos: [],
      repoFileBytes: 0,
    },
    {
      ...call,
      mounted: {
        docs: [],
        scratch: { revision, usedAt },
        uploads: { sessionId: "net-check", revision: 0 },
        kept: [],
      },
      hold,
    },
    { kept: () => new Uint8Array(), fetch: null },
    {
      signal: new AbortController().signal,
      deadline: new AbortController().signal,
      chat: "net-check",
    },
  );
  const answer: Answer | null = ran.settled.ok ? ran.settled.answer : null;
  const changes = answer?.changes ?? null;
  if (changes !== null && answer?.exitCode !== 124) {
    for (const name of changes.removed) scratch.delete(name);
    for (const file of changes.written)
      scratch.set(file.path, { data: file.data, mode: file.mode });
    revision++;
    usedAt = Date.now();
    ran.settle({ landed: true, docs: [], scratch: { revision, usedAt } });
  } else ran.settle({ landed: false, why: "skipped" });
  await backend.idle();
  const raw = `${answer?.stdout ?? ""}${answer?.stderr ?? ""}`;
  return {
    sandbox: hold.sandbox,
    notice: answer?.notice ?? "",
    raw,
    // what the bash tool hands the agent: every key the send read replaced
    shown: scrubKeys(raw, credentials),
    changes,
    loaded: policyLoads - loads,
    ms: Math.round(performance.now() - started),
    error: ran.settled.ok ? null : ran.settled.error?.message,
  };
}

const results: { step: string; ok: boolean }[] = [];
function report(step: string, ok: boolean, detail: string) {
  results.push({ step, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}: ${detail}`);
}
const brief = (text: string) =>
  text.trim().replaceAll("\n", " | ").slice(0, 240);
// curl's status and body head, for a line each
const probe = (label: string, args: string) =>
  `: > /tmp/b; printf '%s ' ${label}; curl -s -m 15 -o /tmp/b -w '%{http_code}' ${args}; printf ' '; head -c 160 /tmp/b | tr '\\n' ' '; echo`;
const lineOf = (out: string, label: string) =>
  out.split("\n").find((line) => line.startsWith(`${label} `)) ?? "";
const status = (out: string, label: string) =>
  lineOf(out, label).split(" ")[1] ?? "";

async function main() {
  const A = `$${envName(SIGNED.name)}`;
  const H = `$${envName(HEADER.name)}`;
  const P = `$${envName(BARE.name)}`;
  const listed = [SIGNED, HEADER, COOKIE, BARE];

  const first = await command(
    LISTED,
    listed,
    [
      `env | grep -c '^ONECTX_CRED_'`,
      probe(
        "signed",
        `-H "Authorization: Bearer ${A}" https://httpbin.org/anything/signed/x`,
      ),
      probe(
        "header",
        `-H "X-Api-Key: ${H}" https://httpbin.org/anything/hdr/x`,
      ),
      probe("unsigned", "https://httpbin.org/anything/signed/y"),
      probe("sibling", "https://httpbin.org/anything/other"),
      probe(
        "post-denied",
        `-X POST -H "Authorization: Bearer ${A}" https://httpbin.org/anything/signed/x`,
      ),
      probe(
        "off-binding",
        `-H "Authorization: Bearer ${A}" https://httpbin.org/anything/other`,
      ),
      probe(
        "wrong-header",
        `-H "X-Other: ${H}" https://httpbin.org/anything/hdr/x`,
      ),
      `curl -s -m 15 -H "Authorization: Bearer ${A}" https://httpbin.org/anything/signed/echo > /knowledge/echo.json`,
    ].join("\n"),
  );
  const out = first.raw;
  report(
    "listed: placeholders in the exec, signed and unsigned",
    out.startsWith("3\n") &&
      status(out, "signed") === "200" &&
      out.includes(`Bearer ${signedKey}`) &&
      status(out, "header") === "200" &&
      status(out, "unsigned") === "200" &&
      !lineOf(out, "unsigned").includes("Bearer") &&
      status(out, "sibling") === "200",
    `${first.sandbox} in ${first.ms}ms, ${first.loaded} policy load; ${brief(first.shown)}`,
  );
  report(
    "a method the credential lacks is denied on its prefix",
    status(out, "post-denied") === "403",
    lineOf(first.shown, "post-denied").slice(0, 160),
  );
  report(
    "a placeholder off its binding is refused",
    status(out, "off-binding") === "403" &&
      lineOf(out, "off-binding").includes("credential_endpoint_mismatch"),
    lineOf(first.shown, "off-binding"),
  );
  report(
    "a placeholder in another header is refused",
    status(out, "wrong-header") === "403",
    lineOf(first.shown, "wrong-header"),
  );
  report(
    "an echoed key is scrubbed from the output and the pulled file",
    !first.shown.includes(signedKey) &&
      first.shown.includes(`[credential ${SIGNED.name}]`) &&
      first.changes?.knowledge.some((doc) => doc.name === "echo.json") ===
        true &&
      first.changes.knowledge.every(
        (doc) => doc.text === null || !doc.text.includes(signedKey),
      ),
    `saved ${first.changes?.knowledge.map((doc) => doc.name).join(", ")}`,
  );
  report(
    "a credential OpenShell cannot place is left out and named",
    first.notice.includes(`credential ${COOKIE.name} goes in a Cookie header`),
    brief(first.notice),
  );

  const again = await command(
    LISTED,
    listed,
    [
      probe(
        "redirect-listed",
        `-L "https://httpbin.org/redirect-to?url=https://example.com/"`,
      ),
      probe(
        "redirect-unlisted",
        `-L "https://httpbin.org/redirect-to?url=https://example.org/"`,
      ),
      probe("encoded", "https://httpbin.org/anything/a%2Fb"),
      probe("unlisted", "https://www.example.org/"),
      `printf 'raw-socket '; (exec 3<>/dev/tcp/1.1.1.1/443 && echo connected) 2>&1 | head -1`,
      `printf 'python '; python3 -c "import urllib.request as u;print(u.urlopen('https://httpbin.org/get',timeout=10).status)" 2>&1 | tail -1`,
      `(python3 -m http.server 8099 --bind 127.0.0.1 >/dev/null 2>&1 &); sleep 1`,
      probe("loopback", "http://127.0.0.1:8099/"),
    ].join("\n"),
    "send-1",
  );
  const two = again.raw;
  report(
    "an unchanged policy is not loaded again, and the notice is not repeated",
    again.sandbox === first.sandbox &&
      again.loaded === 0 &&
      again.notice === "",
    `${again.ms}ms, ${again.loaded} loads, notice ${JSON.stringify(again.notice)}`,
  );
  report(
    "redirects are new requests: a listed target passes, another is refused",
    status(two, "redirect-listed") === "200" &&
      // curl reports the 302 it got when the next hop is refused
      status(two, "redirect-unlisted") === "302",
    `${lineOf(two, "redirect-listed").slice(0, 60)} / ${lineOf(two, "redirect-unlisted").slice(0, 60)}`,
  );
  report(
    "an encoded path and an unlisted host are refused",
    status(two, "encoded") !== "200" && status(two, "unlisted") === "000",
    `${lineOf(two, "encoded").slice(0, 120)} / ${lineOf(two, "unlisted")}`,
  );
  report(
    "a raw socket is refused",
    !lineOf(two, "raw-socket").includes("connected"),
    lineOf(two, "raw-socket"),
  );
  report(
    "python, started by the wrapper's bash, reaches a listed host",
    lineOf(two, "python") === "python 200",
    lineOf(two, "python"),
  );
  report(
    "the sandbox's own loopback is reachable",
    status(two, "loopback") === "200",
    lineOf(two, "loopback").slice(0, 60),
  );

  // the bare prefix: the endpoint's glob selects it, so its rules must
  // name it, or another rule on the host admits any method with the key
  const bare = await command(
    LISTED,
    listed,
    [
      probe(
        "bare-get",
        `-H "Authorization: Bearer ${A}" https://httpbin.org/anything/signed`,
      ),
      probe(
        "bare-post",
        `-X POST -H "Authorization: Bearer ${A}" https://httpbin.org/anything/signed`,
      ),
      probe(
        "bare-delete",
        `-X DELETE -H "Authorization: Bearer ${A}" https://httpbin.org/anything/signed`,
      ),
      probe(
        "bare-put-query",
        `-X PUT -H "Authorization: Bearer ${A}" "https://httpbin.org/anything/signed?a=b"`,
      ),
      probe(
        "bare-delete-unsigned",
        "-X DELETE https://httpbin.org/anything/signed",
      ),
      probe(
        "matrix-delete",
        `-X DELETE -H "Authorization: Bearer ${A}" "https://httpbin.org/anything/signed;x"`,
      ),
      probe(
        "matrix-get",
        `-H "Authorization: Bearer ${A}" "https://httpbin.org/anything/signed;x"`,
      ),
      probe(
        "matrix-under-delete",
        `-X DELETE -H "Authorization: Bearer ${A}" "https://httpbin.org/anything/signed/x;y"`,
      ),
      probe(
        "unlisted-bare",
        `-H "X-Api-Key: ${P}" https://postman-echo.com/headers`,
      ),
      probe(
        "unlisted-bare-post",
        `-X POST -H "X-Api-Key: ${P}" https://postman-echo.com/headers`,
      ),
      probe("unlisted-sibling", "https://postman-echo.com/get"),
      // whole bodies, so the echoed key is found wherever it sits
      `printf 'echo-bare '; curl -s -m 15 -H "Authorization: Bearer ${A}" https://httpbin.org/anything/signed | tr '\\n' ' '; echo`,
      `printf 'echo-unlisted '; curl -s -m 15 -H "X-Api-Key: ${P}" https://postman-echo.com/headers | tr '\\n' ' '; echo`,
    ].join("\n"),
    "send-1",
  );
  const b = bare.raw;
  const carries = (label: string) => lineOf(b, label).includes(signedKey);
  report(
    "the bare prefix takes the credential's methods alone",
    status(b, "bare-get") === "200" &&
      carries("echo-bare") &&
      [
        "bare-post",
        "bare-delete",
        "bare-put-query",
        "bare-delete-unsigned",
      ].every((label) => status(b, label) === "403" && !carries(label)),
    [
      "bare-get",
      "bare-post",
      "bare-delete",
      "bare-put-query",
      "bare-delete-unsigned",
    ]
      .map((label) => `${label} ${status(b, label)}`)
      .join(", "),
  );
  report(
    "a matrix parameter never carries the key past the methods",
    ["matrix-delete", "matrix-under-delete"].every(
      (label) => status(b, label) === "403" && !carries(label),
    ),
    ["matrix-delete", "matrix-get", "matrix-under-delete"]
      .map(
        (label) =>
          `${label} ${status(b, label)}${carries(label) ? " signed" : ""}`,
      )
      .join(", "),
  );
  report(
    "a prefix on an unlisted host signs its bare path and nothing else",
    status(b, "unlisted-bare") === "200" &&
      lineOf(b, "echo-unlisted").includes(bareKey) &&
      status(b, "unlisted-bare-post") === "403" &&
      status(b, "unlisted-sibling") !== "200",
    ["unlisted-bare", "unlisted-bare-post", "unlisted-sibling"]
      .map((label) => `${label} ${status(b, label)}`)
      .join(", "),
  );

  signedKey = writeKey(SIGNED.name);
  const rotated = await command(
    LISTED,
    listed,
    probe(
      "signed",
      `-H "Authorization: Bearer ${A}" https://httpbin.org/anything/signed/x`,
    ),
  );
  report(
    "a rotated key recycles the sandbox and signs with the new key",
    rotated.sandbox !== first.sandbox &&
      rotated.raw.includes(`Bearer ${signedKey}`),
    `${first.sandbox} -> ${rotated.sandbox}, ${rotated.ms}ms`,
  );

  const removed = await command(
    LISTED,
    [HEADER],
    "env | grep -c '^ONECTX_CRED_'",
  );
  report(
    "a removed credential recycles the sandbox",
    removed.sandbox !== rotated.sandbox && removed.raw.startsWith("1\n"),
    `${rotated.sandbox} -> ${removed.sandbox}; ${brief(removed.raw)}`,
  );

  const wild = await command(
    WILD,
    [HEADER],
    [
      `env | grep -c '^ONECTX_CRED_'`,
      probe(
        "wildcard",
        "https://raw.githubusercontent.com/github/gitignore/main/README.md",
      ),
      // any answer at all, which a refused name never gets
      probe("deep-wildcard", "https://us.aws.cdn.hf.co/"),
      probe("listed", "https://httpbin.org/get"),
      probe("two-label", "https://example.org/"),
      probe("unlisted", "https://www.example.com/"),
      probe("literal", "https://1.1.1.1/"),
      probe("port-8443", "https://httpbin.org:8443/get"),
      probe("metadata", "http://169.254.169.254/latest/meta-data/"),
    ].join("\n"),
  );
  const w = wild.raw;
  report(
    "a wildcard host reaches a name under it, ** any depth, beside the listed hosts",
    wild.sandbox === removed.sandbox &&
      w.startsWith("1\n") &&
      status(w, "wildcard") === "200" &&
      !["", "000"].includes(status(w, "deep-wildcard")) &&
      status(w, "listed") === "200",
    `${wild.loaded} load; ${["wildcard", "deep-wildcard", "listed"].map((label) => `${label} ${status(w, label)}`).join(", ")}`,
  );
  report(
    "unlisted names, raw addresses, metadata and other ports are refused",
    ["two-label", "unlisted", "literal", "port-8443", "metadata"].every(
      (label) => status(w, label) === "000",
    ),
    ["two-label", "unlisted", "literal", "port-8443", "metadata"]
      .map((label) => `${label} ${status(w, label)}`)
      .join(", "),
  );

  // a scoped package too: its registry path holds an encoded slash
  const bun = await command(
    DEFAULTS,
    [],
    [
      `mkdir -p "$HOME/bun-check" && cd "$HOME/bun-check"`,
      `printf '{"name":"bun-check","private":true}' > package.json`,
      `printf 'import { z } from "zod";\\nconsole.log(z.string().parse("zod-ok"));\\n' > x.ts`,
      `bun add zod @types/node > "$HOME/bun-add.log" 2>&1; echo "add $?"`,
      `grep -iE 'error|403|denied|refused' "$HOME/bun-add.log" | head -5`,
      `printf 'types '; cat node_modules/@types/node/package.json | jq -r .name`,
      `printf 'run '; bun run x.ts 2>&1 | tail -1`,
      `printf 'cache '; ls "$HOME/.bun/install/cache" | grep -c .`,
      `printf 'npm-encoded '; curl -s -m 15 -o /dev/null -w '%{http_code}' 'https://registry.npmjs.org/@types%2fnode'; echo`,
    ].join("\n"),
  );
  const n = bun.raw;
  report(
    "an encoded slash passes on the npm registry",
    lineOf(n, "npm-encoded") === "npm-encoded 200",
    lineOf(n, "npm-encoded"),
  );
  report(
    "bun adds a package and a scoped one from the defaults, and runs TypeScript",
    lineOf(n, "add") === "add 0" &&
      lineOf(n, "types") === "types @types/node" &&
      lineOf(n, "run") === "run zod-ok" &&
      Number(lineOf(n, "cache").split(" ")[1]) > 0 &&
      (bun.changes?.written.length ?? 0) === 0,
    `${bun.ms}ms; ${brief(n)}; /tmp written ${bun.changes?.written.length ?? 0}`,
  );

  const off = await command(
    OFF,
    [HEADER],
    [
      `env | grep -c '^ONECTX_CRED_'`,
      probe("off", "https://httpbin.org/get"),
    ].join("\n"),
  );
  report(
    "off recycles, attaches nothing and nothing reaches out",
    off.sandbox !== bun.sandbox &&
      off.raw.startsWith("0\n") &&
      status(off.raw, "off") === "000",
    `${bun.sandbox} -> ${off.sandbox} (${off.loaded} load); ${lineOf(off.raw, "off")}`,
  );
}

async function cleanup() {
  leases.drain();
  const deadline = Date.now() + 120_000;
  for (;;) {
    const left = await real
      .list(labels, AbortSignal.timeout(10_000))
      .catch(() => []);
    if (left.length === 0) break;
    if (Date.now() > deadline) {
      console.log(
        `FAIL cleanup: ${left.map((s) => s.name).join(", ")} still listed`,
      );
      return;
    }
    for (const box of left)
      await real.delete(box.name, AbortSignal.timeout(10_000)).catch(() => {});
    await Bun.sleep(1000);
  }
  // a provider goes once no sandbox names it, then its profile
  for (let tries = 0; tries < 10; tries++) {
    const providers = await real.providers
      .list(labels, AbortSignal.timeout(10_000))
      .catch(() => []);
    for (const name of providers)
      await real.providers
        .delete(name, AbortSignal.timeout(10_000))
        .catch(() => {});
    const profiles = await real.providers
      .profiles(labels, AbortSignal.timeout(10_000))
      .catch(() => []);
    for (const id of profiles)
      await real.providers
        .deleteProfile(id, AbortSignal.timeout(10_000))
        .catch(() => {});
    if (providers.length === 0 && profiles.length === 0) break;
    await Bun.sleep(1000);
  }
  console.log(
    `cleanup: every sandbox, provider and profile of instance ${instanceId} deleted`,
  );
}

try {
  await main();
} catch (error) {
  report("run", false, error instanceof Error ? error.message : String(error));
} finally {
  await cleanup();
  real.close();
}
const failed = results.filter((each) => !each.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
