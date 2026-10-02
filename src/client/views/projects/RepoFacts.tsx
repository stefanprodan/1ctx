// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Fragment } from "preact";
import "./repos.css";

// a wrap falls between the state's facts, never inside "26 ignored"
export function StateFacts({ text }: { text: string }) {
  const facts = text.split(", ");
  return (
    <>
      {facts.map((fact, i) => (
        <Fragment key={fact}>
          {i > 0 && ", "}
          <span class="repos-fact">{fact}</span>
        </Fragment>
      ))}
    </>
  );
}
