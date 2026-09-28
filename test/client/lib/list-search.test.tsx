// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import {
  countOf,
  searchList,
  useListSearch,
} from "../../../src/client/lib/search.ts";

const rows = [
  { name: "flux", url: "https://flux.dev", note: null },
  { name: "grafana", url: "https://grafana.com", note: "Dashboards" },
];
const fields = (r: (typeof rows)[number]) => [r.name, r.url, r.note];

test("an empty list says no count; a narrowed one says of how many", () => {
  expect(countOf(0, 0)).toBeUndefined();
  expect(countOf(9, 9)).toBe("9");
  expect(countOf(3, 9)).toBe("3 of 9");
  expect(countOf(0, 9)).toBe("0 of 9");
});

test("a list search keeps the rows whose fields hold the query", () => {
  const names = (q: string) => {
    const { shown, count } = searchList(rows, q, fields);
    return [shown.map((r) => r.name), count];
  };
  expect(names("")).toEqual([["flux", "grafana"], "2"]);
  expect(names("DASH")).toEqual([["grafana"], "1 of 2"]);
  expect(names("nothing")).toEqual([[], "0 of 2"]);
  expect(searchList([], "", fields)).toEqual({ shown: [], count: undefined });
});

test("the hook starts with an empty query", () => {
  function List() {
    const { q, shown, count } = useListSearch(rows, fields);
    return (
      <p>
        {q.value}|{shown.length}|{count}
      </p>
    );
  }
  expect(render(<List />).replaceAll("<!-- -->", "")).toBe("<p>|2|2</p>");
});
