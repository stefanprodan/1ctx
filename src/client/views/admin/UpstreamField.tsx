// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The agent form's Preferred provider, for a model behind OpenRouter: which of
// the providers serving it is tried first. The list is asked for each
// model picked; any provider leaves the choice to OpenRouter.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type {
  CatalogMatch,
  Endpoint,
} from "../../../shared/contracts/provider.ts";
import { listEndpoints } from "../../data/providers.ts";
import { says } from "../../lib/format.ts";
import type { Save } from "../../lib/save.ts";
import { FieldError } from "../../ui/FieldError.tsx";
import { Select } from "../../ui/Select.tsx";
import { upstreamOptions } from "./Agents.model.ts";
import "./agents.css";

export function UpstreamField({
  providerId,
  model,
  value,
  busy,
  save,
  onChange,
}: {
  providerId: string;
  model: CatalogMatch;
  value: string | null;
  busy: boolean;
  save: Pick<Save, "fieldError">;
  onChange: (value: string | null) => void;
}) {
  const endpoints = useSignal<Endpoint[] | null>(null);
  const problem = useSignal<string | null>(null);
  useEffect(() => {
    // an answer for a model picked before is dropped
    let current = true;
    endpoints.value = null;
    problem.value = null;
    listEndpoints(providerId, model.id).then(
      (list) => {
        if (current) endpoints.value = list;
      },
      (err) => {
        if (current) problem.value = says(err);
      },
    );
    return () => {
      current = false;
    };
  }, [providerId, model.id]);
  const loading = endpoints.value === null && problem.value === null;
  return (
    <div class="field pair-wide">
      <span class="label">Preferred provider</span>
      <Select
        label="Preferred provider"
        name="upstream"
        search
        invalid={save.fieldError("upstream") !== null}
        disabled={busy || loading}
        placeholder={loading ? "Loading" : "Any provider"}
        value={value ?? ""}
        options={
          loading ? [] : upstreamOptions(endpoints.value, model.tools, value)
        }
        onChange={(picked) => onChange(picked === "" ? null : picked)}
      />
      {save.fieldError("upstream") !== null ? (
        <FieldError save={save} field="upstream" />
      ) : (
        problem.value !== null && <span class="hint">{problem.value}</span>
      )}
    </div>
  );
}
