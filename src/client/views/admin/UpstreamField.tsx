// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

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
import { RowsSwitch } from "../../ui/Rows.tsx";
import { Select } from "../../ui/Select.tsx";
import { skip4BitLock, upstreamOptions } from "./Agents.model.ts";

// Preferred provider and Skip 4-bit providers share the model's
// endpoints, fetched once per model
export function UpstreamField({
  providerId,
  model,
  value,
  skip4Bit,
  busy,
  save,
  onChange,
  onSkip4Bit,
}: {
  providerId: string;
  model: CatalogMatch;
  value: string | null;
  skip4Bit: boolean;
  busy: boolean;
  save: Pick<Save, "fieldError">;
  onChange: (value: string | null) => void;
  onSkip4Bit: (value: boolean) => void;
}) {
  const endpoints = useSignal<Endpoint[] | null>(null);
  const problem = useSignal<string | null>(null);
  useEffect(() => {
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
    <>
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
            loading
              ? []
              : upstreamOptions(endpoints.value, model.tools, value, skip4Bit)
          }
          onChange={(picked) => onChange(picked === "" ? null : picked)}
        />
        {save.fieldError("upstream") !== null ? (
          <FieldError save={save} field="upstream" />
        ) : (
          problem.value !== null && <span class="hint">{problem.value}</span>
        )}
      </div>
      <Skip4BitField
        on={skip4Bit}
        lock={
          loading ? null : skip4BitLock(endpoints.value, model.tools, value)
        }
        busy={busy || loading}
        save={save}
        onChange={onSkip4Bit}
      />
    </>
  );
}

// a lock says why the filter cannot be turned on; one already on may
// still be turned off
export function Skip4BitField({
  on,
  lock,
  busy,
  save,
  onChange,
}: {
  on: boolean;
  lock: string | null;
  busy: boolean;
  save: Pick<Save, "fieldError">;
  onChange: (value: boolean) => void;
}) {
  const locked = lock !== null && !on;
  return (
    <div class="field agent-page-skip">
      <span class="label">Skip 4-bit providers</span>
      <RowsSwitch
        on={on}
        label="Skip 4-bit providers"
        name="skip4Bit"
        disabled={busy || locked}
        title={locked ? lock : undefined}
        onClick={() => onChange(!on)}
      />
      <FieldError save={save} field="skip4Bit" />
    </div>
  );
}
