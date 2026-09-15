// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A time zone as a searchable select, the one picker an automation,
// a user and the profile share.

import { useMemo } from "preact/hooks";
import { Select } from "./Select.tsx";
import { zoneOptions } from "./Zone.model.ts";

// the zones the runtime knows; the server also takes the links this
// list leaves out
const ZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
})();

export function ZoneSelect({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (tz: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const options = useMemo(() => zoneOptions(ZONES, value, Date.now()), [value]);
  return (
    <Select
      label="Time zone"
      value={value}
      options={options}
      disabled={disabled}
      placeholder={placeholder}
      search
      onChange={onChange}
    />
  );
}
