// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// yq the way agents use it on Kubernetes manifests (a multi-document
// stack, a kustomization, a HelmRelease, kubectl output), against what
// mikefarah's yq v4.53.3 answered, recorded by scripts/yq-record.ts. A
// case with `accept` pins our answer where we differ on purpose.

import { describe } from "bun:test";
import type { Fixture } from "../../../scripts/record-cases.ts";
import recorded from "../../fixtures/just-bash/yq-kube.json" with {
  type: "json",
};
import { recordedCases } from "./recorded.ts";

// Cases we still answer differently; a listed case that passes fails.
const KNOWN = new Set<string>([
  // head_comment and line_comment are refused
  "-i head comment",
  "-i line comment",
  // -i keeps the file's indentation, where -I reindents it
  "-i indent 4",
]);

describe("yq on Kubernetes manifests as mikefarah's", () => {
  recordedCases("yq", recorded as Fixture, KNOWN);
});
