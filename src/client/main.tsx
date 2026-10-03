// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The page's entry, bundled by Bun from index.html. One root; App
// decides between the login view and the shell around a view.

import "./style/tokens.css";
import "./style/base.css";
import { render } from "preact";
import { App } from "./app/App.tsx";
import { reload, startLoading } from "./app/loading.ts";
import { boot } from "./app/router.ts";
import { match } from "./app/routes.ts";
import { watchPages, watchScreen, watchViewport } from "./app/shell.ts";
import { watchTheme } from "./app/theme.ts";
import { startSocket } from "./data/socket.ts";

watchTheme();
boot();
watchScreen();
watchViewport();
watchPages((pathname) => match(pathname) !== null);
startLoading();
startSocket({ reload });
render(<App />, document.getElementById("app")!);
