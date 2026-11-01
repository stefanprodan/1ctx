// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// One image over the page, fitted to the window on a dimmed ground.
// Escape, a click on the ground or the close button shut it, and the
// focus goes back to what opened it. No download: the browser saves
// the image as it saves any.

import { useEffect, useRef } from "preact/hooks";
import { Icon } from "../lib/icons.tsx";
import { type Focusable, ViewerFocus } from "./Viewer.model.ts";
import "./viewer.css";

export function Viewer({
  src,
  alt,
  from,
  onClose,
}: {
  src: string;
  alt: string;
  // what opened it, given back the focus on close: Safari never focuses
  // a button on a click, so the page's focus cannot tell
  from: Focusable | null;
  onClose: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const focus = new ViewerFocus(from, () => close.current());
    button.current?.focus();
    const keys = (ev: KeyboardEvent) => {
      if (focus.key(ev.key, button.current)) ev.preventDefault();
    };
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("keydown", keys);
      focus.end();
    };
  }, []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes it, from the document's keys
    <div
      class="viewer"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <img class="viewer-image" src={src} alt={alt} />
      <button
        ref={button}
        type="button"
        class="btn-icon viewer-close"
        aria-label="Close"
        title="Close"
        onClick={onClose}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
