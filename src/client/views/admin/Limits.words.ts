// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Each limit's label and line on the admin Limits and Storage pages.

import type { LimitName } from "../../../shared/contracts/limit.ts";

export const LIMIT_WORDS: Record<LimitName, { label: string; text: string }> = {
  channelContextFloor: {
    label: "Channel context floor",
    text: "Smallest agent context window allowed in a channel.",
  },
  channelStreamTokens: {
    label: "Channel stream",
    text: "Posts, answers and traces kept in a channel's context.",
  },
  channelDropTokens: {
    label: "Channel drop step",
    text: "Tokens freed at once when a channel's context fills.",
  },
  channelWorkTokens: {
    label: "Channel work room",
    text: "Tokens a channel turn must have free for its own work.",
  },
  rounds: {
    label: "Rounds",
    text: "Provider requests in one turn, the answer included.",
  },
  callsPerRound: {
    label: "Calls per round",
    text: "Tool calls one round may run in parallel.",
  },
  callsPerSend: {
    label: "Calls per turn",
    text: "Tool calls across a turn's rounds.",
  },
  toolMs: {
    label: "Tool time",
    text: "Time in tools over a turn, every round summed.",
  },
  resultBytes: {
    label: "Result bytes",
    text: "Tool results stored over a turn.",
  },
  toolWorkTokens: {
    label: "Tool-work tokens",
    text: "Tokens a turn may spend on tools before it answers.",
  },
  callTimeoutMs: {
    label: "Call timeout",
    text: "How long one tool call may run.",
  },
  resultCut: {
    label: "Result cut",
    text: "What the model reads of one result.",
  },
  maxBashCalls: {
    label: "Bash calls per turn",
    text: "bash calls in one turn. More are refused.",
  },
  maxFetches: {
    label: "Fetches per turn",
    text: "webfetch calls in one turn. More are refused.",
  },
  maxSearches: {
    label: "Searches per turn",
    text: "websearch calls in one turn. More are refused.",
  },
  fetchBodyBytes: {
    label: "Response size",
    text: "Largest answer from webfetch, curl or an MCP tool.",
  },
  searchBodyBytes: {
    label: "Search body",
    text: "The largest answer a search provider may return.",
  },
  visualBytes: {
    label: "Visual size",
    text: "The size one visual may reach.",
  },
  visualSendBytes: {
    label: "Visual bytes per turn",
    text: "The size of all visuals in a turn.",
  },
  maxVisuals: {
    label: "Visuals per turn",
    text: "Tool calls a turn may draw.",
  },
  fetchDeadlineMs: {
    label: "Fetch deadline",
    text: "How long one webfetch or curl request may take.",
  },
  searchDeadlineMs: {
    label: "Search deadline",
    text: "How long one search request may take.",
  },
  contextReserve: {
    label: "Context reserve",
    text: "Tokens kept free in the context window.",
  },
  summaryMaxTokens: {
    label: "Summary tokens",
    text: "The longest a chat summary may be.",
  },
  memoryPhaseMs: {
    label: "Memory time",
    text: "How long a run may spend updating memory.",
  },
  memoryPhaseRounds: {
    label: "Memory rounds",
    text: "Provider requests a run may make updating memory.",
  },
  childrenAtOnce: {
    label: "Subagents at once",
    text: "Subagents of one turn running together. More wait.",
  },
  childrenPerSend: {
    label: "Subagents per turn",
    text: "Subagents one turn may start. More are refused.",
  },
  childAnswerChars: {
    label: "Subagent answer",
    text: "What the agent reads of a subagent's answer.",
  },
  runDeadlineMs: {
    label: "Run deadline",
    text: "How long one run may take.",
  },
  sendDeadlineMs: {
    label: "Chat deadline",
    text: "How long one chat turn may take.",
  },
  knowledgeFileBytes: {
    label: "File size",
    text: "The largest a file may be.",
  },
  knowledgeFiles: {
    label: "Files per project",
    text: "Files one project may hold.",
  },
  knowledgeProjectBytes: {
    label: "Base size",
    text: "A project's files together.",
  },
  knowledgeVersions: {
    label: "Versions per file",
    text: "Past versions kept of one file.",
  },
  knowledgeHistoryBytes: {
    label: "History size",
    text: "Past versions a project keeps, oldest dropped first.",
  },
  knowledgeHistoryDays: {
    label: "History days",
    text: "How long a deleted file's versions stay.",
  },
  scratchBytes: {
    label: "Size",
    text: "A session's scratch files together.",
  },
  scratchFiles: {
    label: "Files",
    text: "Scratch files one session may hold.",
  },
  scratchIdleDays: {
    label: "Idle days",
    text: "How long an unused scratch is kept.",
  },
  uploadBytes: {
    label: "Chat files size",
    text: "The files added to one chat together.",
  },
  uploadFiles: {
    label: "Chat files",
    text: "Files one chat may hold.",
  },
  mcpKeptBytes: {
    label: "Size",
    text: "The results one chat keeps together.",
  },
  mcpKeptFiles: {
    label: "Files",
    text: "Results and resources one chat keeps.",
  },
  sendsPerUser: {
    label: "Per user",
    text: "Turns and runs one user has going at once. Scheduled runs are not counted.",
  },
  sendsPerProject: {
    label: "Per project",
    text: "Turns and runs going at once in one project.",
  },
  sendsPerChannel: {
    label: "Per channel",
    text: "Agent turns going at once in one project channel.",
  },
  sendsRunning: {
    label: "At once",
    text: "Turns and runs going at once, every project counted.",
  },
  queuedPerUser: {
    label: "Waiting per user",
    text: "Messages and channel turns one user may have waiting, failed ones included.",
  },
  queuedMinutes: {
    label: "Waiting time",
    text: "How long a message or channel turn may wait to start.",
  },
  archiveIdleDays: {
    label: "Archive idle chats",
    text: "Days without a turn before a chat is archived.",
  },
  archivedDeleteDays: {
    label: "Delete archived chats",
    text: "Days an archived chat is kept.",
  },
  repoBytes: {
    label: "Size",
    text: "What one repository's files may total.",
  },
  repoFiles: {
    label: "Files",
    text: "Files one repository may keep.",
  },
  repoFileBytes: {
    label: "File size",
    text: "The largest file bash reads from a repository.",
  },
  repoCacheBytes: {
    label: "Cache size",
    text: "Every repository's files on disk together.",
  },
  accessKeysPerUser: {
    label: "Access keys per user",
    text: "Keys one user may make for /mcp. 0 turns it off.",
  },
  externalTaskDays: {
    label: "Delete closed external tasks",
    text: "Days a done or cancelled external task is kept.",
  },
  externalTaskIdleHours: {
    label: "Unclaim idle external tasks",
    text: "Hours without a report before a claimed external task opens again.",
  },
  dictationClipsPerUser: {
    label: "Clips per user",
    text: "Dictation clips one user may turn into text in an hour.",
  },
  imageUploadBytes: {
    label: "Upload size",
    text: "The largest image file a user may add.",
  },
  imageMaxPixels: {
    label: "Pixels",
    text: "The most pixels an added image may have.",
  },
  imageLongSide: {
    label: "Long side",
    text: "An image is made this small on its long side when added.",
  },
  imagesPerMessage: {
    label: "Images per message",
    text: "Images one message may carry.",
  },
  imagesPerRequest: {
    label: "Images per request",
    text: "Images the model is sent at once.",
  },
  imageProjectBytes: {
    label: "Project images",
    text: "What a project's sent images may total. The oldest are removed past it.",
  },
  imagesPerHour: {
    label: "Images per user",
    text: "Images one user may add in an hour.",
  },
  sandboxesMax: {
    label: "Sandboxes",
    text: "Sandboxes kept at once, warm and stuck ones included.",
  },
  sandboxWarm: {
    label: "Warm sandboxes",
    text: "Sandboxes made ahead, so a chat's first command waits less.",
  },
  sandboxIdleMinutes: {
    label: "Idle time",
    text: "How long a chat's sandbox is kept without a command.",
  },
  sandboxCpus: {
    label: "CPUs",
    text: "CPUs one sandbox may use.",
  },
  sandboxMemoryMiB: {
    label: "Memory",
    text: "Memory one sandbox may use, its files included.",
  },
  sandboxHomeMiB: {
    label: "Program files",
    text: "Room for programs' own files and caches in a sandbox.",
  },
};
