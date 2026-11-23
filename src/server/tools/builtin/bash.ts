// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The schema needs no project or session so the agent page can count it;
// execution takes its identity only from the runner's call context.

import type { HttpMethod } from "../../../shared/contracts/credential.ts";
import type { SandboxVariant } from "../../../shared/contracts/sandbox.ts";
import type { SandboxNet } from "../../../shared/sandbox-net.ts";
import type { WebSnapshot } from "../../../shared/web.ts";
import {
  BACKSTOP_MS,
  type BashToolPort,
  type CommandCredential,
  MAX_COMMAND_BYTES,
  type Refusal,
  scrubKeys,
} from "../../bash/index.ts";
import { headerValue, type KeyRead } from "../../credentials/index.ts";
import {
  placeholderValue,
  placement,
  prefixGlob,
  quotable,
} from "../../sandbox/rules.ts";
import type {
  OfferedCredential,
  OfferedShell,
  Tool,
  ToolResult,
} from "../types.ts";
import { domainWords } from "../web.ts";
import { durationWords } from "./automation-text.ts";
import { type ShellTools, shellTools } from "./shell-tools.ts";

// what a command asks of the credentials area: the row as it is now and
// the key its file holds now
export type CredentialKeysPort = {
  byId(
    id: string,
  ):
    | (Pick<
        OfferedCredential,
        "keyName" | "prefix" | "header" | "template" | "methods"
      > & { projectIds: string[] })
    | null;
  readKey(keyName: string): KeyRead;
};

export type BashCredentials = {
  offered: readonly OfferedCredential[];
  off: readonly { name: string; prefix: string; writes?: true }[];
};

const NONE: BashCredentials = { offered: [], off: [] };
const MAX_PREFIX_WORDS = 80;

const prefixWords = (prefix: string) =>
  prefix.length > MAX_PREFIX_WORDS
    ? `${prefix.slice(0, MAX_PREFIX_WORDS - 3)}...`
    : prefix;

// the description is about the docs, the tool's main job, so the
// network gets one sentence: what curl is good for and where it reaches,
// then one clause per credential the send signs with
function networkWords(
  web: WebSnapshot | null,
  credentials: readonly OfferedCredential[],
): string {
  if (web === null) return "No network.";
  const where =
    web.mode === "all" ? "any host" : `these hosts only: ${domainWords(web)}`;
  return [
    `curl calls HTTP APIs on ${where}, JSON in and out with -X, -H, -d and jq. Save downloads in /tmp.`,
    ...credentials.map(
      (credential) =>
        `curl to ${prefixWords(credential.prefix)} (${credential.name}) is signed in${credential.readOnly ? ", GET and HEAD only" : ""}; send no key.`,
    ),
  ].join(" ");
}

const NETWORK_EXAMPLES = ["pypi.org", "registry.npmjs.org", "github.com"];

// the sandbox shell's network: its own hosts, never Web access's, and a
// placeholder the agent places where the built-in shell's curl signs on
// its own
function sandboxNetworkWords(
  net: SandboxNet,
  credentials: readonly OfferedCredential[],
): string {
  if (net.mode === "off") return "No network.";
  const signed = sandboxCredentialWords(credentials);
  // only the examples the admin's list still holds
  const named = NETWORK_EXAMPLES.filter((host) => net.hosts.includes(host));
  const examples = named.length === 0 ? "" : ` (${named.join(", ")}…)`;
  return [
    `Network: HTTP and HTTPS to the admin's list only: package and container registries, code hosts, docs, news and public APIs${examples}; anything else is refused.`,
    ...(signed === "" ? [] : [signed]),
  ].join(" ");
}

// one sentence per credential the sandbox can place, so a subagent's
// replace those alone
function sandboxCredentialWords(
  credentials: readonly OfferedCredential[],
): string {
  return credentials
    .filter(
      (credential) =>
        placement(credential.header, credential.template) !== null &&
        quotable(credential.header, credential.template) &&
        prefixGlob(credential.prefix) !== null,
    )
    .map(
      (credential) =>
        `For ${prefixWords(credential.prefix)} (${credential.name}${credential.readOnly ? ", GET and HEAD only" : ""}) send -H "${credential.header}: ${placeholderValue(credential.template, credential.name)}", a placeholder the key replaces there alone.`,
    )
    .join(" ");
}

// a send without web access: no network in the sandbox either
const NO_NET: SandboxNet = { mode: "off", hosts: [] };

export const isReadMethod = (method: HttpMethod) =>
  method === "GET" || method === "HEAD";

// a send signs only as its snapshot says, so a row moved under it, the
// key file it names included, refuses until the next send
const changed = (
  snapshot: OfferedCredential,
  row: NonNullable<ReturnType<CredentialKeysPort["byId"]>>,
) =>
  row.keyName !== snapshot.keyName ||
  row.prefix !== snapshot.prefix ||
  row.header !== snapshot.header ||
  row.template !== snapshot.template ||
  row.methods.join() !== snapshot.methods.join();

// each credential as this command sees it: the row checked by id and the
// key read now, so a replaced file applies to the next command and a
// removed or changed row refuses it
export function commandCredentials(
  credentials: BashCredentials,
  port: CredentialKeysPort | undefined,
  projectId: string,
): CommandCredential[] {
  const refused = (
    credential: { name: string; prefix: string },
    why: Refusal,
  ): CommandCredential => ({
    name: credential.name,
    prefix: credential.prefix,
    refused: why,
  });
  return [
    ...credentials.offered.map((credential) => {
      const row = port?.byId(credential.id) ?? null;
      if (row === null || !row.projectIds.includes(projectId)) {
        return refused(credential, "deleted");
      }
      if (changed(credential, row)) return refused(credential, "changed");
      const read = port!.readKey(row.keyName);
      if (!read.ok) return refused(credential, read.reason);
      return {
        name: credential.name,
        prefix: credential.prefix,
        key: read.key,
        header: credential.header,
        template: credential.template,
        value: headerValue(credential.template, read.key),
        methods: credential.readOnly
          ? credential.methods.filter(isReadMethod)
          : [...credential.methods],
      };
    }),
    ...credentials.off.map((credential) =>
      refused(credential, credential.writes ? "writes" : "off"),
    ),
  ];
}

// the printed output was scrubbed whole before its cut (mount.ts); this
// pass takes the notices and receipts around it. The tail keeps its
// length, the receipts the registry keeps apart
function scrubbed(
  result: ToolResult,
  credentials: readonly CommandCredential[],
): ToolResult {
  if (!credentials.some((credential) => "key" in credential)) return result;
  const tail = result.tail ?? 0;
  const head = scrubKeys(
    result.content.slice(0, result.content.length - tail),
    credentials,
  );
  const end = scrubKeys(
    result.content.slice(result.content.length - tail),
    credentials,
  );
  return {
    ...result,
    content: head + end,
    ...(result.tail === undefined ? {} : { tail: end.length }),
  };
}

export type BashToolOptions = {
  bash?: BashToolPort;
  web?: WebSnapshot | null;
  visuals?: boolean;
  credentials?: BashCredentials;
  keys?: CredentialKeysPort;
  // false while the send has the project docs off
  docs?: boolean;
  // a subagent's: no open, so the description leaves it out
  subagent?: boolean;
  // the sandbox shell runs the commands, under this network: a real
  // shell and OpenShell's rules, so the description says what differs.
  // null is the built-in shell; bash's own word when not given
  sandbox?: SandboxNet | null;
  // the sandbox image's variant, whose tools the description names;
  // null for a custom image. bash's own word when not given
  variant?: SandboxVariant | null;
  // how long a command may run under the sandbox shell; bash's own
  // word when not given
  commandSeconds?: number;
  // how long an unused sandbox is kept; bash's own word when not given
  idleMinutes?: number;
  // the send's deadline: the words never promise a command more
  deadlineMs?: number | null;
};

// the shell a description was offered for, never one moved since;
// bash's own word when none is given
export function offeredShell(
  bash: BashToolPort | undefined,
  shell: OfferedShell | undefined,
  // the send's project, whose shell gives the network
  projectId: string | null = null,
): Pick<BashToolOptions, "sandbox" | "variant" | "commandSeconds"> {
  if (shell === undefined) return {};
  return {
    sandbox:
      shell.sandbox === true ? (bash?.sandbox?.(projectId) ?? NO_NET) : null,
    // read with the network, so the words name the sandbox's own tools
    ...(shell.sandbox === true && bash?.sandboxVariant !== undefined
      ? { variant: bash.sandboxVariant(projectId) }
      : {}),
    ...(shell.commandSeconds === undefined
      ? {}
      : { commandSeconds: shell.commandSeconds }),
  };
}

// the limits' defaults, for a tool built without bash's word
const COMMAND_SECONDS = 600;
const IDLE_MINUTES = 30;

const BUILTIN_TOOLS =
  "jq, yq, awk and diff are there, git, python and node are not.";
const BUILTIN_TMP =
  "/tmp is this chat's scratch for any bytes, kept between commands.";

const OPEN_WORDS =
  "open <file> shows a file to the user as it is: HTML and SVG as a visual, Markdown rendered, other text as code. To show a file, open it rather than reading it out. To point to one, write its /knowledge/ path. ";

// the sandbox shell's words, short: a real Linux shell needs few rules
const SANDBOX_OPEN =
  "open <file> shows a file to the user: HTML and SVG as visuals, Markdown rendered. ";

function sandboxWords(
  tools: ShellTools,
  idleMinutes: number,
  promisedMs: number,
  open: boolean,
  network: string,
): string {
  const idle = `${idleMinutes} idle minute${idleMinutes === 1 ? "" : "s"}`;
  return `Run a bash command in this chat's Linux sandbox: ${tools.tools}. /knowledge is the project's shared docs, saved as a new version when the command ends; if someone else changed a file meanwhile, nothing is saved: read it again and retry. /uploads holds the user's attachments, read-only. /tmp and $HOME are yours until the sandbox is recycled (after ${idle}, a restart, a timeout or a failed save), so keep what must last in /knowledge. Search before reading: rg -il 'word' /knowledge, grep -n, sed -n '40,120p'. Never print whole files or trees; long output is cut. Each call is a new shell in the last directory: chain one task's steps in one call, and make independent calls in parallel. A call may run ${durationWords(promisedMs)}; send a background job's output to a file. Install with ${tools.install}. ${open ? SANDBOX_OPEN : ""}${network} Never write secrets.`;
}

// a send's bash description as a subagent's, whatever was added after:
// no open, and the subagent's own credential words
export function asSubagent(
  description: string,
  web: WebSnapshot | null,
  parent: readonly OfferedCredential[],
  own: readonly OfferedCredential[],
): string {
  const out = description
    .replace(OPEN_WORDS, "")
    .replace(SANDBOX_OPEN, "")
    .replace(networkWords(web, parent), () => networkWords(web, own));
  // the network sentence is the parent's, from the setting of when the
  // send began, so only its credential sentences are swapped
  const signed = sandboxCredentialWords(parent);
  if (signed === "") return out;
  const mine = sandboxCredentialWords(own);
  return out.replace(`${signed} `, () => (mine === "" ? "" : `${mine} `));
}

// Refused before either shell: bash ends a command at a NUL, so the
// sandbox would run only its head, and a command past the cap is the
// same plain answer in both shells, never a lost sandbox.
function commandRefusal(command: string): string | null {
  if (command.includes("\u0000")) return "the command holds a NUL byte";
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES)
    return `the command is over ${MAX_COMMAND_BYTES / 1024} KiB, write a large file in parts`;
  return null;
}

export function makeBashTool({
  bash,
  web = null,
  visuals = true,
  credentials = NONE,
  keys,
  docs = true,
  subagent = false,
  sandbox = bash?.sandbox?.() ?? null,
  variant = bash?.sandboxVariant ? bash.sandboxVariant() : "python",
  commandSeconds = bash?.sandboxCommandSeconds?.() ?? COMMAND_SECONDS,
  idleMinutes = bash?.sandboxIdleMinutes?.() ?? IDLE_MINUTES,
  deadlineMs = null,
}: BashToolOptions = {}): Tool<ToolResult> {
  // a real shell's work takes minutes: under the sandbox a command has
  // its own time, the built-in shell keeps the call timeout
  const commandMs = sandbox !== null ? commandSeconds * 1000 : null;
  // a run's deadline may be shorter than a command's own time
  const promisedMs =
    deadlineMs === null
      ? commandSeconds * 1000
      : Math.min(commandSeconds * 1000, deadlineMs);
  return {
    name: "bash",
    ...(commandMs === null ? {} : { timeoutMs: commandMs }),
    // past the mount's own backstop, so its words end a stuck command
    graceMs: BACKSTOP_MS + 500,
    description:
      sandbox !== null
        ? sandboxWords(
            shellTools(variant),
            idleMinutes,
            promisedMs,
            !subagent,
            sandboxNetworkWords(
              web === null ? NO_NET : sandbox,
              credentials.offered,
            ),
          )
        : `Run a bash command in a sandbox over the project's files. /knowledge holds the project docs: UTF-8 text shared with everyone in the project, often many large files. ${BUILTIN_TMP} /uploads holds the files the user attached, read-only. Navigate, never dump, since a long result is cut. Find the file first: ls and find for names, rg -il 'word' /knowledge for the files that mention a word. Then grep -n in that file for the line, grep -n '^#' for its outline, and read around a line with sed -n '40,120p'. Check wc -l before reading. Never cat a big file or print matching lines from the whole tree. Edit in place with sed -i, create a file with cat > file <<'EOF', read a file before replacing it whole, and print the changed lines after. Changes are saved as a new version when the command ends. If someone else changed the file meanwhile nothing is saved and the result says so: read again and retry. Prefer small Markdown files whose first line says their purpose, named with letters, digits, dot, dash and underscore. Each command is a new shell that starts in the last directory, so variables do not carry over. Put the steps of one task in one command, and independent commands in one round, where they run in parallel. ${BUILTIN_TOOLS} Never write secrets, since others can read this chat and the project. ` +
          (subagent ? "" : OPEN_WORDS) +
          networkWords(web, credentials.offered),
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command line, as for bash -c.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const actor = ctx.actor;
      if (actor === null) return { content: "no project", error: true };
      if (Object.keys(args).some((name) => name !== "command")) {
        throw new Error("bash accepts only command");
      }
      if (typeof args.command !== "string") {
        throw new Error("command must be a string");
      }
      if (bash === undefined) {
        throw new Error("knowledge is not configured");
      }
      const refused = commandRefusal(args.command);
      if (refused !== null) return { content: refused, error: true };
      if (ctx.budget.bashCalls >= ctx.caps.maxBashCalls) {
        return {
          content: "the bash budget for this reply is spent",
          error: true,
        };
      }
      ctx.budget.bashCalls++;
      const repos = ctx.repos ?? null;
      const caps = {
        callTimeoutMs: ctx.caps.callTimeoutMs,
        ...(commandMs === null ? {} : { sandboxCommandMs: commandMs }),
        resultCut: ctx.caps.resultCut,
        visuals,
        knowledge: docs,
        ...(ctx.subagent ? { subagent: ctx.subagent } : {}),
        ...(repos === null
          ? {}
          : {
              repos: {
                mounts: repos.mounts,
                fileBytes: repos.fileBytes,
                notice: repos.notice(),
              },
            }),
      };
      const signing =
        ctx.web === null
          ? []
          : commandCredentials(credentials, keys, actor.projectId);
      const result = await bash.run(
        actor.projectId,
        actor.workspace,
        {
          kind: "agent",
          id: actor.agentId,
          name: actor.agentName,
          sessionId: actor.sessionId,
          origin: actor.origin,
          keyName: null,
        },
        args.command,
        ctx.web === null
          ? caps
          : {
              ...caps,
              web: ctx.web,
              fetchDeadlineMs: ctx.caps.fetchDeadlineMs,
              fetchBodyBytes: ctx.caps.fetchBodyBytes,
              ...(signing.length === 0 ? {} : { credentials: signing }),
            },
        ctx.signal,
        ctx.sendId,
      );
      return scrubbed(result, signing);
    },
  };
}
