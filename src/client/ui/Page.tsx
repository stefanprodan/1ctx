// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The head of a view and its states in one place: a label over the
// title, or a crumb with the title on one line for a page whose title
// is a noun, actions on the right, then either the content, a loading
// line, an empty line or an error. A view composes this, never
// restyles it.

import type { ComponentChildren } from "preact";
import "./page.css";

export function Page({
  label,
  crumb,
  crumbHref,
  title,
  aside,
  actions,
  loading,
  empty,
  error,
  children,
}: {
  label?: string;
  // "Account / Profile" on one line, the title in the foreground; an
  // empty crumb is the one-line head with the title alone
  crumb?: string;
  // where the crumb's parent leads, when it is a page
  crumbHref?: string;
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
        {crumb !== undefined ? (
          <h1 class="page-crumb label">
            {crumb !== "" && (
              <>
                {crumbHref ? (
                  <a class="page-crumb-up" href={crumbHref}>
                    {crumb}
                  </a>
                ) : (
                  <span>{crumb}</span>
                )}
                <span class="page-crumb-sep">/</span>
              </>
            )}
            <span class="page-crumb-on">{title}</span>
          </h1>
        ) : (
          <div class="page-heading">
            {label && <span class="label">{label}</span>}
            <h1 class="page-title">{title}</h1>
          </div>
        )}
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
