// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's knowledge files changed last, as an aside section: each
// its name leading to its page over who changed it, leading to theirs,
// and when. Left out while the base is empty.

import type { KnowledgeFile } from "../../../shared/contracts/knowledge.ts";
import { ago } from "../../lib/format.ts";
import { useNow } from "../../lib/now.ts";
import { AsideHandle, AsideItem, AsideSection } from "../../ui/Split.tsx";
import { authorOf, fileHref } from "../knowledge/Knowledge.model.ts";

export function LatestAside({
  projectId,
  files,
}: {
  projectId: string;
  files: readonly KnowledgeFile[];
}) {
  const now = useNow(60_000);
  if (files.length === 0) return null;
  return (
    <AsideSection label="Latest knowledge">
      {files.map((file) => {
        const by = authorOf(file.author);
        return (
          <AsideItem
            key={file.id}
            name={file.name.slice(file.name.lastIndexOf("/") + 1)}
            title={file.name}
            href={fileHref(projectId, file.id)}
            sub={
              <>
                <AsideHandle name={by.name} href={by.href} />
                {by.via !== null && ` via ${by.via}`} ·{" "}
                {ago(file.updatedAt, now)}
              </>
            }
          />
        );
      })}
    </AsideSection>
  );
}
