// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The images added to the draft: a square thumbnail each once staged,
// its progress while it uploads, an X on each, the server's words for
// one it refused, and a hint when the agent reads none. The hint never
// stops Send: the agent may change before it goes, and the server
// refuses at the claim.

import type { Signal } from "@preact/signals";
import { useEffect, useLayoutEffect, useMemo } from "preact/hooks";
import type { AgentSummary } from "../../shared/contracts/agent.ts";
import { CANNOT_READ_IMAGES } from "../../shared/images.ts";
import {
  checkImage,
  deleteImage,
  imageSrc,
  stageImage,
} from "../data/images.ts";
import { me } from "../data/me.ts";
import { inUploadLine } from "../data/upload-line.ts";
import { sentence } from "../lib/format.ts";
import { Icon } from "../lib/icons.tsx";
import { RowsLog, RowsLogLine } from "../ui/Rows.tsx";
import { readDraft, writeDraftImages } from "./draft.ts";
import { type ImageItem, NO_IMAGES, percentOf } from "./Images.model.ts";
import { ImageState } from "./Images.state.ts";
import "./staged.css";

const THUMB = 56;

// the draft's images for a scope, shown for the project a send goes to
export function useImages(key: string, projectId: string): ImageState {
  const state = useMemo(
    () =>
      new ImageState(
        {
          stage: (projectId, file, options) =>
            inUploadLine(
              () => stageImage(projectId, file, options),
              options.signal,
            ),
          remove: deleteImage,
          check: checkImage,
          wait: (ms) => new Promise((done) => setTimeout(done, ms)),
          currentUser: () => me.value?.id ?? null,
          save: (images) => writeDraftImages(key, images),
        },
        readDraft(key).images ?? [],
      ),
    [key],
  );
  useEffect(() => () => state.dispose(), [state]);
  // before the paint, so Send is never drawn on for an image unchecked
  useLayoutEffect(() => state.show(projectId), [state, projectId]);
  return state;
}

const REFUSED = sentence(CANNOT_READ_IMAGES);

// whether the picked agent reads no images, for the hint; false while
// the failure slot shows the claim's refusal of them, which goes when
// the agent changes, since it was that agent's
export function useUnread(
  failure: Signal<string | null>,
  agents: readonly AgentSummary[],
  agent: string | null,
): boolean {
  useEffect(() => {
    if (failure.value === REFUSED) failure.value = null;
  }, [agent, failure]);
  return (
    failure.value !== REFUSED &&
    agents.find((a) => a.id === agent)?.images === false
  );
}

function Thumb({
  item,
  locked,
  onRemove,
}: {
  item: ImageItem;
  locked: boolean;
  onRemove: () => void;
}) {
  return (
    <div class="staged-item" title={item.name}>
      {item.phase === "staged" && item.id !== null ? (
        <img
          class="staged-pic"
          src={imageSrc(item.projectId, item.id)}
          alt={item.name}
          width={THUMB}
          height={THUMB}
        />
      ) : (
        <span class="staged-wait">
          <Icon name="spinner" size={14} class="staged-spin" />
          {item.phase === "sending" && (
            <span class="staged-percent">{percentOf(item)}%</span>
          )}
        </span>
      )}
      <button
        type="button"
        class="btn-icon staged-x"
        aria-label={`Remove ${item.name}`}
        title={`Remove ${item.name}`}
        disabled={locked}
        onClick={onRemove}
      >
        <Icon name="close" size={10} />
      </button>
    </div>
  );
}

export function StagedImages({
  items,
  unread,
  locked = false,
  onRemove,
}: {
  items: readonly ImageItem[];
  // the agent picked reads no images
  unread: boolean;
  // a send is on its way: what it names stays
  locked?: boolean;
  onRemove: (key: number) => void;
}) {
  if (items.length === 0) return null;
  const shown = items.filter((item) => item.phase !== "refused");
  const refused = items.filter((item) => item.phase === "refused");
  return (
    <div class="staged">
      {shown.length > 0 && (
        <div class="staged-row">
          {shown.map((item) => (
            <Thumb
              key={item.key}
              item={item}
              locked={locked}
              onRemove={() => onRemove(item.key)}
            />
          ))}
        </div>
      )}
      {refused.length > 0 && (
        <RowsLog ends>
          {refused.map((item) => (
            <RowsLogLine
              key={item.key}
              name={item.name}
              note={item.words ?? ""}
              status={item.status}
              onRemove={() => onRemove(item.key)}
            />
          ))}
        </RowsLog>
      )}
      {unread && shown.length > 0 && (
        <p class="hint staged-hint">{NO_IMAGES}</p>
      )}
    </div>
  );
}
