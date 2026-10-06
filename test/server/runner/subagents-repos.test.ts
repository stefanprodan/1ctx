// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A subagent's repositories: its bash names the ones its parent
// mounted, and the parent's mount notices stay the parent's.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { adapter, threadJobs } from "../../../src/server/repos/index.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  startChat,
  waitScript,
} from "../../helpers/chat.ts";
import {
  COMMIT,
  cacheDir,
  fakeHost,
  type HostAnswer,
  tarball,
  tarResponse,
} from "../../helpers/repos.ts";
import {
  allowSubagents,
  bashCall,
  delegateCall,
  isChild,
  lastResult,
  settled,
} from "../../helpers/subagents.ts";

const URL = "https://github.com/acme/widgets";
const ARCHIVE = adapter(URL, "github").archiveUrl("");
const HEAD = "Repositories, read-only files with no git history:";
const LINE =
  "/repos/widgets: github.com/acme/widgets at default branch (3e0ff8a)";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function repoChat(answer: HostAnswer): Promise<ChatApp> {
  const dir = cacheDir();
  dirs.push(dir);
  const chat = await chatApp({
    cacheDir: dir,
    repoJobs: threadJobs(fakeHost({ [ARCHIVE]: answer }).fetch),
  });
  chat.app.automationScheduler.stop();
  allowSubagents(chat, chat.agentId);
  chat.app.repos.store.create(
    chat.projectId,
    {
      name: "widgets",
      url: URL,
      kind: "github",
      ref: "",
      keyName: null,
      ignore: "",
    },
    chat.app.now.value,
  );
  return chat;
}

const bashOf = (script: Script) =>
  (script.body.tools as { function: { name: string; description: string } }[])
    .map((tool) => tool.function)
    .find((tool) => tool.name === "bash")!.description;

describe("a subagent's repositories", () => {
  test("its bash names the repositories its parent mounted, open left out", async () => {
    const chat = await repoChat(
      tarResponse(
        tarball([{ name: "README.md", body: "# widgets\n" }], {
          comment: COMMIT,
        }),
        '"e1"',
      ),
    );
    try {
      const { script, sessionId } = await startChat(chat);
      expect(bashOf(script)).toContain(`${HEAD}\n${LINE}`);
      script.toolRound([delegateCall("d1", "Read the README.")]);
      script.end();
      const child = await waitScript(chat.scripted, 2);
      expect(isChild(child)).toBe(true);
      expect(bashOf(child)).toContain(`${HEAD}\n${LINE}`);
      expect(bashOf(child)).not.toContain("open <file>");
      child.toolRound([bashCall("c1", "cat /repos/widgets/README.md")]);
      child.end();
      const read = await waitScript(chat.scripted, 3);
      expect(lastResult(read)).toContain("# widgets");
      read.reply("a widgets readme");
      (await waitScript(chat.scripted, 4)).reply("done");
      await settled(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a child's command never takes the parent's mount notice", async () => {
    const chat = await repoChat(new Response("gone", { status: 404 }));
    try {
      const { script, sessionId } = await startChat(chat);
      script.toolRound([delegateCall("d1", "Echo something.")]);
      script.end();
      const child = await waitScript(chat.scripted, 2);
      child.toolRound([bashCall("c1", "echo child")]);
      child.end();
      const after = await waitScript(chat.scripted, 3);
      expect(lastResult(after)).toBe("child\n\nexit 0");
      after.reply("echoed");
      const parent = await waitScript(chat.scripted, 4);
      parent.toolRound([bashCall("b1", "echo parent")]);
      parent.end();
      const last = await waitScript(chat.scripted, 5);
      expect(lastResult(last)).toBe(
        "repo widgets is unavailable: not found\nparent\n\nexit 0",
      );
      last.reply("done");
      await settled(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });
});
