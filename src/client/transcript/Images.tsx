// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The images a user message carried, under its text, each at its own
// shape inside a fixed box; a click opens it full size in the viewer.
// One the project's budget freed keeps its place as a line.

import { useSignal } from "@preact/signals";
import type { MessageImage } from "../../shared/images.ts";
import { imageSrc } from "../data/images.ts";
import { Viewer } from "../ui/Viewer.tsx";
import { FREED_LINE, fitBox } from "./Images.model.ts";
import "./images.css";

export function MessageImages({
  projectId,
  images,
}: {
  projectId: string;
  images: readonly MessageImage[];
}) {
  const open = useSignal<MessageImage | null>(null);
  if (images.length === 0) return null;
  const shown = open.value;
  return (
    <div class="images">
      {images.map((image) => {
        if (image.freed) {
          return (
            <p key={image.id} class="images-freed" title={image.name}>
              {FREED_LINE}
            </p>
          );
        }
        const size = fitBox(image.width, image.height);
        return (
          <button
            key={image.id}
            type="button"
            class="images-open"
            aria-label={`Open ${image.name}`}
            onClick={() => {
              open.value = image;
            }}
          >
            <img
              class="images-pic"
              src={imageSrc(projectId, image.id)}
              alt={image.name}
              width={size.width}
              height={size.height}
              loading="lazy"
              decoding="async"
            />
          </button>
        );
      })}
      {shown !== null && (
        <Viewer
          src={imageSrc(projectId, shown.id)}
          alt={shown.name}
          onClose={() => {
            open.value = null;
          }}
        />
      )}
    </div>
  );
}
