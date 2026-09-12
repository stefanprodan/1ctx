// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The page's entry, bundled by Bun from index.html. One root; App
// decides between the login view and the shell around a view.

import "./style/tokens.css";
import "./style/base.css";
import { render } from "preact";
import { App } from "./app/App.tsx";
import { boot } from "./app/router.ts";
import { watchWidth } from "./app/shell.ts";

boot();
watchWidth();
render(<App />, document.getElementById("app")!);
