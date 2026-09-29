// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A command worker gone wrong, as a command able to post would make it:
// answers for another id, of a wrong shape, a request past the kept list
// and one request number sent twice, then one well-formed answer that
// says how many kept replies came back, and a second answer after it.

declare var self: Worker;

let replies = 0;

self.onmessage = (event: MessageEvent) => {
  const message = event.data as { type: string; id: string };
  const id = message.id;
  if (message.type === "kept") {
    replies++;
    return;
  }
  if (message.type !== "job") return;
  const answer = (stdout: string) => ({
    stdout,
    stderr: "",
    exitCode: 0,
    notice: "",
    opened: [],
    changes: null,
  });
  self.postMessage({ type: "done", id: "another", answer: answer("other") });
  self.postMessage({ type: "done", id, answer: { stdout: 1 } });
  self.postMessage({ type: "done", id, answer: answer("x"), extra: true });
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
