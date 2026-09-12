// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The head of a view and its states in one place: a label over the
// title, actions on the right, then either the content, a loading line,
// an empty line or an error. A view composes this, never restyles it.

import type { ComponentChildren } from "preact";
import "./page.css";

export function Page({
  label,
  title,
  aside,
  actions,
  loading,
  empty,
  error,
  children,
}: {
  label?: string;
  title: string;
  aside?: ComponentChildren;
  actions?: ComponentChildren;
  loading?: boolean;
  empty?: string;
  error?: string | null;
  children?: ComponentChildren;
}) {
  return (
    <div class="page">
      <div class="page-head">
        <div class="page-heading">
          {label && <span class="label">{label}</span>}
          <h1 class="page-title">{title}</h1>
        </div>
        {aside && <div class="page-aside">{aside}</div>}
        {actions && <div class="page-actions">{actions}</div>}
      </div>
      {error ? (
        <p class="page-state error">{error}</p>
      ) : loading ? (
        <p class="page-state">Loading</p>
      ) : empty ? (
        <p class="page-state">{empty}</p>
      ) : (
        children
      )}
    </div>
  );
}
