// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The preview's side of its OpenShell gateway, for scripts/preview.sh:
//
//   id <url> <secrets>                        the instance id, from the admin route
//   configure <url> <secrets> <endpoint> <image>  the sandbox shell turned on
//   sweep <tls-dir> <endpoint> <instance id>  every sandbox and provider under
//                                             the instance label deleted
//
// Signs in as admin with the preview's user-admin.key; the password is
// never printed.

import { join } from "node:path";
import { openshellGateway } from "../src/server/sandbox/openshell.ts";
import { gatewayLabel, INSTANCE_LABEL } from "../src/server/sandbox/spec.ts";
import type { SandboxResponse } from "../src/shared/api/sandbox.ts";

// a delete is observed within seconds on Docker; the server's own wait
// for one is 60 s
const DELETE_WAIT_MS = 60_000;
const CALL_MS = 15_000;
// the label OpenShell's Docker driver puts on every container and volume
// of a sandbox, valued with the gateway's sandbox_label
const NAMESPACE_LABEL = "openshell.ai/sandbox-namespace";

function fail(message: string): never {
  console.error(`preview-sandbox: ${message}`);
  process.exit(1);
}

async function signIn(url: string, secrets: string): Promise<string> {
  const password = (
    await Bun.file(join(secrets, "user-admin.key")).text()
  ).trim();
  const res = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });
  if (!res.ok) fail(`admin sign-in answered ${res.status}`);
  const cookie = res.headers.getSetCookie()[0]?.split(";")[0];
  if (cookie === undefined) fail("admin sign-in set no cookie");
  return cookie;
}

async function call(
  url: string,
  cookie: string,
  method: string,
  body?: unknown,
): Promise<SandboxResponse> {
  const res = await fetch(`${url}/api/admin/sandbox`, {
    method,
    headers: {
      origin: url,
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) fail(`${method} /api/admin/sandbox: ${await res.text()}`);
  return (await res.json()) as SandboxResponse;
}

async function sweep(tls: string, endpoint: string, instanceId: string) {
  const read = (path: string) => Bun.file(join(tls, path)).text();
  const gateway = openshellGateway({
    endpoint,
    ca: await read("ca.crt"),
    cert: await read("client/tls.crt"),
    key: await read("client/tls.key"),
  });
  const labels = { [INSTANCE_LABEL]: instanceId };
  // sandboxes first: a provider in use by one is not deleted
  const sandboxes = await gateway.list(labels, AbortSignal.timeout(CALL_MS));
  const results = await Promise.allSettled(
    sandboxes.map(async ({ name }) => {
      await gateway.delete(name, AbortSignal.timeout(CALL_MS));
      await gateway.waitDeleted(name, AbortSignal.timeout(DELETE_WAIT_MS));
    }),
  );
  const stuck = sandboxes
    .filter((_, i) => results[i]!.status === "rejected")
    .map((s) => s.name);
  // A delete OpenShell can never finish (a driver operation left
  // pending) keeps its record in the gateway's own state, which goes
  // with .preview/openshell/. What must not outlive it are the Docker
  // containers and volumes, so the clean goes on only once none is left.
  if (stuck.length > 0) {
    const label = `${NAMESPACE_LABEL}=${gatewayLabel(instanceId)}`;
    if (await dockerLeft(label)) {
      gateway.close();
      fail(
        [
          `the gateway did not delete ${stuck.join(", ")}.`,
          "Remove their containers and volumes, then run the clean again:",
          `  docker ps -a --filter label=${label}`,
          `  docker rm -f $(docker ps -aq --filter label=${label})`,
          `  docker volume rm $(docker volume ls -q --filter label=${label})`,
        ].join("\n"),
      );
    }
    console.log(
      `the gateway kept ${stuck.length} deleted sandboxes with no container left; they go with its state`,
    );
  }
  const providers = await gateway.providers.list(
    labels,
    AbortSignal.timeout(CALL_MS),
  );
  for (const name of providers) {
    await gateway.providers.delete(name, AbortSignal.timeout(CALL_MS));
  }
  gateway.close();
  console.log(
    `deleted ${sandboxes.length} sandboxes and ${providers.length} providers`,
  );
}

// any container or volume of the instance still on the Docker host
async function dockerLeft(label: string): Promise<boolean> {
  for (const args of [
    ["ps", "-aq", "--filter", `label=${label}`],
    ["volume", "ls", "-q", "--filter", `label=${label}`],
  ]) {
    // Docker Desktop's CLI may sit off a non-interactive PATH, as in
    // openshell.sh
    const PATH = `${process.env.PATH ?? ""}:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin`;
    const proc = Bun.spawn(["docker", ...args], {
      stderr: "inherit",
      env: { ...process.env, PATH },
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) fail(`docker ${args[0]} failed`);
    if (out.trim() !== "") return true;
  }
  return false;
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "id": {
    const [url, secrets] = args;
    if (!url || !secrets) fail("usage: id <url> <secrets>");
    const answer = await call(url, await signIn(url, secrets), "GET");
    console.log(answer.settings.instanceId);
    break;
  }
  case "configure": {
    const [url, secrets, endpoint, image] = args;
    if (!url || !secrets || !endpoint || !image) {
      fail("usage: configure <url> <secrets> <endpoint> <image>");
    }
    const answer = await call(url, await signIn(url, secrets), "PUT", {
      shell: "sandbox",
      endpoint,
      image,
    });
    if (!answer.active) fail("the sandbox shell did not turn on");
    console.log(`sandbox shell on, gateway ${endpoint}, image ${image}`);
    break;
  }
  case "sweep": {
    const [tls, endpoint, instanceId] = args;
    if (!tls || !endpoint || !instanceId) {
      fail("usage: sweep <tls-dir> <endpoint> <instance id>");
    }
    await sweep(tls, endpoint, instanceId);
    break;
  }
  default:
    fail("usage: preview-sandbox.ts id|configure|sweep");
}
// the gateway's http2 session would hold the process open
process.exit(0);
