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
  if (message.type !== "job") return;
  const command = message.job?.command;
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
