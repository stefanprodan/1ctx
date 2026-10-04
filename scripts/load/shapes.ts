// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The shapes the harness loads with, as numbers: what a turn, a run and
// an incident do, how fast the fakes answer, and the MVP's busiest hour.
// The fakes, the database builder and the driver read them from here.

// the fakes' addresses on one machine; in a cluster they are Services
export const FAKE = {
  modelPort: 1241,
  mcpPort: 1250,
  model: "fake-chat",
  // the provider every built or fenced database points at
  provider: "fake",
} as const;

export const fakeModelUrl = (host = "127.0.0.1") =>
  `http://${host}:${FAKE.modelPort}/v1`;
export const fakeMcpUrl = (server: string, host = "127.0.0.1") =>
  `http://${host}:${FAKE.mcpPort}/${server}/mcp`;

// The model's timing: the first token, then ~40 tokens a second
export const TIMING = {
  paceMs: 25,
  // the day shape: a chat or incident turn, and a run, each +- spread
  firstTokenMs: { chat: 4_000, run: 8_000 },
  firstTokenSpreadMs: 2_000,
  // the bash, text and markdown shapes: a fast model
  quickFirstTokenMs: 400,
  quickReplyTokens: 400,
  // work text streamed before a round's calls
  workTokens: [20, 40],
} as const;

// tool calls in a chat turn, cumulative: mean ~4.3
export const CHAT_CALLS: readonly (readonly [number, number])[] = [
  [0.04, 0],
  [0.09, 1],
  [0.19, 2],
  [0.41, 3],
  [0.63, 4],
  [0.8, 5],
  [0.89, 6],
  [0.93, 7],
  [0.97, 9],
  [0.99, 13],
  [1, 18],
];

// bash commands in a turn of the bash shape, cumulative: ~4.2 rounds
export const BASH_CALLS: readonly (readonly [number, number])[] = [
  [0.04, 0],
  [0.07, 1],
  [0.13, 2],
  [0.33, 3],
  [0.55, 4],
  [0.75, 5],
  [0.85, 6],
  [0.89, 7],
  [0.94, 9],
  [0.97, 13],
  [1, 22],
];

export type Kind = "chat" | "run" | "incident" | "hourly" | "daily";

// the tool mix per kind: MCP half, bash a fifth, memory a quarter
export const MIX = {
  chat: { mcp: 0.5, bash: 0.2, memory: 0.25, describe: 0.05 },
  incident: { mcp: 0.65, bash: 0.2, memory: 0.1, describe: 0.05 },
  // a run leans further on MCP
  runMcpExtra: 0.15,
} as const;

export const ROUNDS = {
  // a quarter of chat rounds take two calls at once; runs pair more
  pairChat: 0.25,
  pairRun: 0.55,
  hourly: { rounds: [4, 6], calls: [2, 2] },
  daily: { rounds: [8, 14], calls: [2, 4] },
  incident: { rounds: [7, 14], calls: [2, 6] },
  // the MCP calls asking for everything: every sixth, from the third
  largeEvery: 6,
  largeAt: 3,
  // a read tool rather than any tool
  readShare: 0.92,
  // a chat turn saves a report to /knowledge/reports
  saveReport: 0.05,
  // daily runs grep their kept results half the time
  dailyMcpGrep: 0.5,
  // incident bash reads /mcp rather than /tmp
  incidentMcpBash: 0.8,
} as const;

// reply tokens per kind, [min, max]
export const REPLY = {
  chat: [120, 500],
  run: [60, 180],
  scheduled: [120, 320],
  incident: [250, 600],
  noTools: { chat: [120, 500], run: [80, 200] },
  memoryPhase: 20,
} as const;

// /tmp bodies of the bash shape: lines of ~80 bytes, ~85 KB on average
// with a tail to ~900 KB
export const SCRATCH = { baseLines: 200, tailLines: 11_000, tailPower: 12 };

// MCP latency per call: half fast, two fifths up to 1.3 s, a tail to 3 s
export const MCP_LATENCY = {
  fastShare: 0.5,
  fastMs: [10, 50],
  midShare: 0.4,
  midBaseMs: 50,
  midFactor: 26,
  tailMs: [1_300, 3_000],
} as const;

// MCP result sizes in bytes; large ones pass the 50,000-character cut,
// so the server keeps them under /mcp
export const MCP_RESULT = {
  small: [100, 7_000],
  tailShare: 0.1,
  tail: [14_000, 23_000],
  large: [60_000, 200_000],
} as const;

// the team docs in each team project
export const KNOWLEDGE_FILES = 150;

// The MVP at its top end
export const MVP = {
  admins: 15,
  members: 500,
  teams: 100,
  agents: 30,
  automations: 500,
  // a member is in 2 to 5 teams; a team has at least 5 members
  teamsPerMember: [2, 5],
  minMembers: 5,
} as const;

// The busiest hour, 09:00 to 10:00, at 1x. A step replays its first
// minutes with every count scaled by the step.
export const HOUR = {
  stepMinutes: 20,
  chats: 250,
  // turns per chat, 1 to 6, ~3.4 on average
  turnsPerChat: [0.1, 0.17, 0.25, 0.25, 0.15, 0.08],
  thinkMs: [60_000, 180_000],
  incidentStartMs: [10_000, 60_000],
  incidentGapMs: [120_000, 240_000],
  incidentUsers: 4,
  hourly: 100,
  daily: 400,
  // half the dailies fire in the burst, at the hour's start
  burst: 200,
  burstMinutes: 5,
  // the dailies spread over the rest of the hour
  laterPerHour: 25,
  watchers: 100,
  watcherAdmins: 10,
  // a watching member opens a running chat now and then
  lookShare: 0.2,
  automationsPerTeam: 5,
  maxPerProject: 20,
  tailMs: 180_000,
  // from this step on the send caps are raised to their maximums
  maxCapsFrom: 4,
} as const;
