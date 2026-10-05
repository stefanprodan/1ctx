// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The pure rules of the docs, for an area that needs them without the
// store: the command worker loads this, never index.ts, so a command's
// worker starts without the database, the archives or the renderer.

export { textFromBytes } from "../../shared/knowledge.ts";
export { checkFile, checkNames, checkUsage } from "./check.ts";
export { languageOf } from "./languages.ts";
export { parseName } from "./parse.ts";
export { lineCount } from "./text.ts";
