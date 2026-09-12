// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Home: the greeting. The composer, the filter bar and the stream land
// with sessions; until then the head stands alone.

import { me } from "../../data/me.ts";
import { Page } from "../../ui/Page.tsx";
import { dateLine, greeting } from "./Home.model.ts";
import "./home.css";

export function Home() {
  const user = me.value!;
  const now = new Date();
  return (
    <Page label={dateLine(now)} title={greeting(now, user.fullName)}>
      <div class="home-stream" />
    </Page>
  );
}
