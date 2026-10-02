// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A send's repositories: looked up at its start through the real area
// over a fake host, the commits stored on its first message, the trees
// mounted for its commands, the model told, and every hold released
// however the send ends.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DEFAULT_LIMITS } from "../../../src/server/limits/index.ts";
import {
  adapter,
  type Prepared,
  threadJobs,
} from "../../../src/server/repos/index.ts";
import { repoKey, reposOffLine } from "../../../src/shared/capabilities.ts";
import type { SessionDetail } from "../../../src/shared/contracts/session.ts";
import {
  createAutomation,
  settleRun,
  startRun,
} from "../../helpers/automations.ts";
import {
  type ChatApp,
  chatApp,
  type Script,
  startChat,
  tick,
  waitScript,
} from "../../helpers/chat.ts";
import {
  COMMIT,
  cacheDir,
  fakeHost,
  type HostAnswer,
  NEXT_COMMIT,
  tarball,
  tarResponse,
} from "../../helpers/repos.ts";

const URL = "https://github.com/acme/widgets";
const ARCHIVE = adapter(URL, "github").archiveUrl("");
const HEAD = "Repositories, read-only files with no git history:";
const LINE =
  "/repos/widgets: github.com/acme/widgets at default branch (3e0ff8a)";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const tree = (commit = COMMIT) =>
  tarball(
    [
      { name: "README.md", body: "# widgets\n" },
      // the default rules leave images out
      { name: "logo.png", body: "png" },
    ],
    { comment: commit },
  );

type Counted = {
  chat: ChatApp;
  answers: Record<string, HostAnswer>;
  prepared: Prepared[];
  released: number;
  repoId: string;
};

async function repoChat(answer?: HostAnswer, repo = true): Promise<Counted> {
  const dir = cacheDir();
  dirs.push(dir);
  const answers: Record<string, HostAnswer> = {
    [ARCHIVE]: answer ?? tarResponse(tree(), '"e1"'),
  };
  const host = fakeHost(answers);
  const chat = await chatApp({
    cacheDir: dir,
    repoJobs: threadJobs(host.fetch),
  });
  const counted: Counted = {
    chat,
    answers,
    prepared: [],
    released: 0,
    repoId: "",
  };
  const prepare = chat.app.repos.prepare;
  chat.app.repos.prepare = async (projectId, options) => {
    const prepared = await prepare(projectId, options);
    counted.prepared.push(prepared);
    return {
      ...prepared,
      release: () => {
        counted.released++;
        prepared.release();
      },
    };
  };
  if (repo) {
    counted.repoId = chat.app.repos.store.create(
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
    ).id;
  }
  return counted;
}

async function settled(chat: ChatApp, id: string) {
  for (let i = 0; i < 400; i++) {
    if (chat.app.sessions.byId(id)?.status !== "running") return;
    await tick();
  }
  throw new Error("send did not settle");
}

const bashOf = (script: Script) =>
  (script.body.tools as { function: { name: string; description: string } }[])
    .map((tool) => tool.function)
    .find((tool) => tool.name === "bash")!.description;

const systemOf = (script: Script) =>
  (script.body.messages as { content: string }[])[0]!.content;

const toolOf = (script: Script) =>
  (script.body.messages as { role: string; content: string }[]).findLast(
    (row) => row.role === "tool",
  )!.content;

const firstMounted = (chat: ChatApp, sessionId: string) =>
  chat.app.sessions.mountedRepos(
    chat.app.sessions.messages(sessionId).find((row) => row.kind === "user")!
      .id,
  );

async function bash(chat: ChatApp, script: Script, command: string) {
  const count = chat.scripted.scripts.length + 1;
  script.toolRound([
    {
      id: `call-${count}`,
      name: "bash",
      arguments: JSON.stringify({ command }),
    },
  ]);
  script.end();
  return waitScript(chat.scripted, count);
}

async function message(
  chat: ChatApp,
  sessionId: string,
  text: string,
  capabilities?: { disable?: string[]; enable?: string[] },
) {
  const count = chat.scripted.scripts.length + 1;
  const response = await chat.member.call(
    "POST",
    `/api/sessions/${sessionId}/messages`,
    { body: { message: text, ...(capabilities ? { capabilities } : {}) } },
  );
  expect(response.status).toBe(201);
  return waitScript(chat.scripted, count);
}

describe("a send's repositories", () => {
  test("a project without repositories adds nothing", async () => {
    const { chat, prepared } = await repoChat(undefined, false);
    try {
      const { script, sessionId } = await startChat(chat);
      expect(bashOf(script)).not.toContain("/repos");
      expect(bashOf(script)).not.toContain(HEAD);
      expect(prepared).toHaveLength(1);
      expect(prepared[0]!.mounts).toEqual([]);
      const answer = await bash(chat, script, "ls / | grep -c repos");
      expect(toolOf(answer)).toStartWith("0\n");
      answer.reply("done");
      await settled(chat, sessionId);
      expect(firstMounted(chat, sessionId)).toBeNull();
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a mounted repository is described, stored, read and released", async () => {
    const counted = await repoChat();
    const { chat } = counted;
    try {
      const { script, sessionId } = await startChat(chat);
      expect(bashOf(script)).toEndWith(`\n${HEAD}\n${LINE}`);
      expect(firstMounted(chat, sessionId)).toEqual({
        [counted.repoId]: COMMIT,
      });
      const answer = await bash(chat, script, "cat /repos/widgets/README.md");
      expect(toolOf(answer)).toStartWith("# widgets\n");
      answer.reply("done");
      await settled(chat, sessionId);
      expect(counted.released).toBe(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a run mounts them as a turn does", async () => {
    const counted = await repoChat();
    const { chat } = counted;
    try {
      const automation = await createAutomation(chat);
      const run = await startRun(chat, automation.id);
      expect(bashOf(run.main)).toEndWith(`\n${HEAD}\n${LINE}`);
      run.main.reply("done");
      await settleRun(chat, run.sessionId);
      expect(firstMounted(chat, run.sessionId)).toEqual({
        [counted.repoId]: COMMIT,
      });
      expect(counted.released).toBe(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a moved branch is said once, in the turn that sees it", async () => {
    const counted = await repoChat();
    const { chat, answers } = counted;
    try {
      const { script, sessionId } = await startChat(chat);
      script.reply("first");
      await settled(chat, sessionId);
      chat.app.now.value += 61_000;
      answers[ARCHIVE] = tarResponse(tree(NEXT_COMMIT), '"e2"');
      const second = await message(chat, sessionId, "again");
      expect(systemOf(second)).toContain(
        "repo widgets: default branch moved from 3e0ff8a to 8d01e44",
      );
      expect(bashOf(second)).toContain("at default branch (8d01e44)");
      second.reply("second");
      await settled(chat, sessionId);
      const third = await message(chat, sessionId, "once more");
      expect(systemOf(third)).not.toContain("moved");
      third.reply("third");
      await settled(chat, sessionId);
      expect(counted.released).toBe(3);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a moved branch is said though the last turn left it out", async () => {
    const counted = await repoChat();
    const { chat, answers } = counted;
    try {
      const other = "https://github.com/acme/gadgets";
      const otherArchive = adapter(other, "github").archiveUrl("");
      answers[otherArchive] = tarResponse(tree(), '"g1"');
      const gadgets = chat.app.repos.store.create(
        chat.projectId,
        {
          name: "gadgets",
          url: other,
          kind: "github",
          ref: "",
          keyName: null,
          ignore: "",
        },
        chat.app.now.value,
      ).id;
      const { script, sessionId } = await startChat(chat);
      script.reply("first");
      await settled(chat, sessionId);
      // a turn with gadgets off stores widgets alone
      const second = await message(chat, sessionId, "again", {
        disable: [repoKey(gadgets)],
      });
      second.reply("second");
      await settled(chat, sessionId);
      chat.app.now.value += 61_000;
      answers[otherArchive] = tarResponse(tree(NEXT_COMMIT), '"g2"');
      const third = await message(chat, sessionId, "once more", {
        enable: [repoKey(gadgets)],
      });
      expect(systemOf(third)).toContain(
        "repo gadgets: default branch moved from 3e0ff8a to 8d01e44",
      );
      expect(systemOf(third)).not.toContain("repo widgets:");
      third.reply("third");
      await settled(chat, sessionId);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a repository turned off after a turn read it gets the line", async () => {
    const counted = await repoChat();
    const { chat } = counted;
    try {
      const { script, sessionId } = await startChat(chat);
      script.reply("first");
      await settled(chat, sessionId);
      const second = await message(chat, sessionId, "again", {
        disable: [repoKey(counted.repoId)],
      });
      expect(systemOf(second)).toContain(reposOffLine(["widgets"]));
      expect(bashOf(second)).not.toContain("/repos/widgets");
      const answer = await bash(chat, second, "ls /repos");
      expect(toolOf(answer)).toContain("No such file or directory");
      answer.reply("second");
      await settled(chat, sessionId);
      expect(firstMounted(chat, sessionId)).toEqual({
        [counted.repoId]: COMMIT,
      });
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a repository off from the start is never named", async () => {
    const counted = await repoChat();
    const { chat } = counted;
    try {
      const response = await chat.member.call("POST", "/api/sessions", {
        body: {
          projectId: chat.projectId,
          agentId: chat.agentId,
          message: "hello",
          capabilities: { disable: [repoKey(counted.repoId)] },
        },
      });
      const detail = (await response.json()) as SessionDetail;
      const script = await waitScript(chat.scripted, 1);
      expect(JSON.stringify(script.body)).not.toContain("widgets");
      script.reply("done");
      await settled(chat, detail.session.id);
      expect(firstMounted(chat, detail.session.id)).toBeNull();
    } finally {
      await chat.app.shutdown();
    }
  });

  test("an unavailable repository is said by the first command only", async () => {
    const counted = await repoChat(new Response("gone", { status: 404 }));
    const { chat } = counted;
    try {
      const { script, sessionId } = await startChat(chat);
      expect(bashOf(script)).not.toContain("/repos");
      expect(bashOf(script)).not.toContain(HEAD);
      const first = await bash(chat, script, "echo one");
      expect(toolOf(first)).toBe(
        "repo widgets is unavailable: not found\none\n\nexit 0",
      );
      const second = await bash(chat, first, "echo two");
      expect(toolOf(second)).toBe("two\n\nexit 0");
      second.reply("done");
      await settled(chat, sessionId);
      expect(counted.released).toBe(1);
    } finally {
      await chat.app.shutdown();
    }
  });

  test("regenerate mounts the commit the turn first read, while it is cached", async () => {
    const counted = await repoChat();
    const { chat, answers } = counted;
    try {
      const { script, sessionId } = await startChat(chat);
      script.reply("first");
      await settled(chat, sessionId);
      // the branch moves and its tree is fetched by another turn
      chat.app.now.value += 61_000;
      answers[ARCHIVE] = tarResponse(tree(NEXT_COMMIT), '"e2"');
      const other = await chat.app.repos.prepare(chat.projectId, {});
      other.release();

      const regenerate = async () => {
        const count = chat.scripted.scripts.length + 1;
        const response = await chat.member.call(
          "POST",
          `/api/sessions/${sessionId}/regenerate`,
          { body: {} },
        );
        expect(response.status).toBe(201);
        return waitScript(chat.scripted, count);
      };
      const again = await regenerate();
      expect(bashOf(again)).toContain("at default branch (3e0ff8a)");
      expect(systemOf(again)).not.toContain("moved");
      again.reply("again");
      await settled(chat, sessionId);
      expect(firstMounted(chat, sessionId)).toEqual({
        [counted.repoId]: COMMIT,
      });

      // a pinned commit no longer cached mounts the lookup's, said once
      const user = chat.app.sessions
        .messages(sessionId)
        .find((row) => row.kind === "user")!;
      chat.app.sessions.setMountedRepos(user.id, {
        [counted.repoId]: "a".repeat(40),
      });
      const missed = await regenerate();
      expect(bashOf(missed)).toContain("at default branch (8d01e44)");
      const read = await bash(chat, missed, "echo ok");
      expect(toolOf(read)).toStartWith(
        "repo widgets: aaaaaaa is no longer cached, mounted 8d01e44\nok\n",
      );
      read.reply("done");
      await settled(chat, sessionId);
      expect(firstMounted(chat, sessionId)).toEqual({
        [counted.repoId]: NEXT_COMMIT,
      });
    } finally {
      await chat.app.shutdown();
    }
  });
});

describe("a send's trees are released however it ends", () => {
  test("a stop while the tree is still fetched", async () => {
    let answered = () => {};
    const counted = await repoChat(
      () =>
        new Promise<Response>((resolve) => {
          answered = () => resolve(tarResponse(tree()));
        }),
    );
    const { chat } = counted;
    try {
      const response = await chat.member.call("POST", "/api/sessions", {
        body: {
          projectId: chat.projectId,
          agentId: chat.agentId,
          message: "hello",
        },
      });
      const detail = (await response.json()) as SessionDetail;
      await tick();
      const stop = await chat.member.call(
        "POST",
        `/api/sessions/${detail.session.id}/stop`,
      );
      expect(stop.status).toBe(200);
      await settled(chat, detail.session.id);
      expect(counted.prepared[0]!.notices).toEqual([
        { repoId: counted.repoId, name: "widgets", reason: "fetching" },
      ]);
      expect(counted.released).toBe(1);
      answered();
    } finally {
      await chat.app.shutdown();
    }
  });

  test("a stop, a failure, a deadline and a shutdown", async () => {
    const counted = await repoChat();
    const { chat } = counted;
    let down = false;
    try {
      const stopped = await startChat(chat);
      await chat.member.call("POST", `/api/sessions/${stopped.sessionId}/stop`);
      await settled(chat, stopped.sessionId);
      expect(counted.released).toBe(1);

      chat.scripted.refuse(400, "bad request", { times: 1 });
      const response = await chat.member.call(
        "POST",
        `/api/sessions/${stopped.sessionId}/messages`,
        { body: { message: "again" } },
      );
      expect(response.status).toBe(201);
      await settled(chat, stopped.sessionId);
      expect(chat.app.sessions.byId(stopped.sessionId)?.status).toBe("failed");
      expect(counted.released).toBe(2);

      await message(chat, stopped.sessionId, "slow");
      chat.app.now.value += DEFAULT_LIMITS.sendDeadlineMs + 1;
      await settled(chat, stopped.sessionId);
      expect(counted.released).toBe(3);

      await message(chat, stopped.sessionId, "last");
      down = true;
      await chat.app.shutdown();
      expect(counted.prepared).toHaveLength(4);
      expect(counted.released).toBe(4);
    } finally {
      if (!down) await chat.app.shutdown();
    }
  });
});
