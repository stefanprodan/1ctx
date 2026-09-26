// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The open row of an admin list, seeded from `?open=<id>`: a Manage
// link starts that row open.

import { type Signal, useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { query } from "../../app/router.ts";

export function useOpenParam(): Signal<string | null> {
  const asked = new URLSearchParams(query.value).get("open");
  const open = useSignal<string | null>(asked);
  // a Manage link followed while the page is up names another row
  useEffect(() => {
    if (asked !== null) open.value = asked;
  }, [asked, open]);
  return open;
}
