// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A command worker gone wrong, as a command able to post would make it,
// picked by the job's command. forge: answers for another id, a phase
// and a type outside the protocol, a read past the kept list and one
// request number sent twice, then one well-formed answer that says how
// many kept replies came back, and a second answer after it. malformed:
// an answer of this job in the wrong shape. close: the worker ends
// itself mid-job. prompt: a good answer at once.

declare var self: Worker;

let replies = 0;

const answer = (stdout: string) => ({
  stdout,
  stderr: "",
  exitCode: 0,
  notice: "",
  opened: [],
  changes: null,
  refused: null,
});

self.onmessage = (event: MessageEvent) => {
  const message = event.data as {
    type: string;
    id: string;
    job?: { command: string };
  };
  const id = message.id;
  if (message.type === "kept") {
    replies++;
    return;
  }
  const empty = { knowledge: [], written: [], removed: [], cwd: "/tmp" };
  if (message.type === "fetched") {
    const reply = message as unknown as {
      result?: { body: Uint8Array };
      error?: unknown;
    };
    self.postMessage({
      type: "done",
      id,
      answer: {
        ...answer(
          reply.result
            ? new TextDecoder().decode(reply.result.body)
            : JSON.stringify(reply.error),
        ),
        changes: empty,
      },
    });
    return;
  }
  if (message.type !== "job") return;
  const command = message.job?.command ?? "";
  if (command.startsWith("fetch ")) {
    const url = command.slice("fetch ".length);
    self.postMessage({ type: "fetch", id, request: 0, url, options: {} });
    return;
  }
  const doc = {
    ...empty,
    knowledge: [{ name: "worker-created.md", text: "forged\n" }],
  };
  if (command === "docs" || command === "exit124") {
    self.postMessage({
      type: "done",
      id,
      answer: {
        ...answer(""),
        exitCode: command === "exit124" ? 124 : 0,
        changes: doc,
      },
    });
    return;
  }
  if (command.startsWith("opened ")) {
    // opened <count> <kind> <bytes claimed>
    const [, count, kind, bytes] = command.split(" ");
    const text = "<p>page</p>";
    const opened = Array.from({ length: Number(count) }, (_, i) => ({
      path: `/tmp/p${i}.html`,
      kind,
      language: kind === "code" ? "html" : null,
      bytes: Number(bytes),
      lines: 1,
      title: kind === "visual" ? `p${i}.html` : null,
      text,
    }));
    self.postMessage({
      type: "done",
      id,
      answer: { ...answer(""), opened, changes: empty },
    });
    return;
  }
  if (command === "prompt") {
    self.postMessage({ type: "done", id, answer: answer("prompt") });
    return;
  }
  if (command === "malformed") {
    self.postMessage({ type: "phase", id, phase: "run", notice: "" });
    self.postMessage({ type: "done", id, answer: { stdout: 1 } });
    return;
  }
  if (command === "close") {
    self.postMessage({ type: "phase", id, phase: "run", notice: "" });
    setTimeout(() => process.exit(0), 50);
    return;
  }
  self.postMessage({ type: "done", id: "another", answer: answer("other") });
  self.postMessage({ type: "phase", id, phase: "commit", notice: "" });
  self.postMessage({ type: "shout", id });
  self.postMessage({ type: "kept", id, request: 0, index: 99 });
  self.postMessage({ type: "kept", id, request: 1, index: 0 });
  self.postMessage({ type: "kept", id, request: 1, index: 0 });
  // the replies land before the answer that counts them
  setTimeout(() => {
    self.postMessage({ type: "done", id, answer: answer(`${replies}`) });
    self.postMessage({ type: "done", id, answer: answer("late") });
  }, 200);
};
