// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A folder tree as rows of one line inside a RowsCard, kept apart from
// Rows.tsx for its size and exported through it. A folder is a
// disclosure button with its count of files, opening in place; a file
// is a link with its meta at the right; a folder too long to list whole
// ends in a Show more row. The view gives the nodes in their order
// (lib/tree.ts lays them out) and keeps which folders are open.

import { useId } from "preact/hooks";
import { count } from "../lib/format.ts";
import { Icon, type IconName } from "../lib/icons.tsx";
import "./rows.css";

export type RowsTreeNode =
  | {
      kind: "folder";
      key: string;
      name: string;
      // the files under it at any depth
      count: number;
      open: boolean;
      onToggle: () => void;
      // drawn only while open
      children: RowsTreeNode[];
    }
  | {
      kind: "file";
      key: string;
      name: string;
      href: string;
      // at the right, when it last changed; a phone leaves it out
      meta?: string;
      // the meta in the accent: an agent changed it lately
      lit?: boolean;
      // the whole path, for the pointer
      title?: string;
      // what kind of file, a plain page when not given
      icon?: IconName;
    }
  | { kind: "more"; key: string; label: string; onPick: () => void };

const depthOf = (depth: number) => ({ "--rows-depth": depth });

function Folder({
  node,
  depth,
}: {
  node: Extract<RowsTreeNode, { kind: "folder" }>;
  depth: number;
}) {
  const id = useId();
  return (
    <li>
      <button
        type="button"
        class="rows-tree-node rows-tree-folder"
        style={depthOf(depth)}
        aria-expanded={node.open}
        aria-controls={node.open ? id : undefined}
        onClick={node.onToggle}
      >
        <Icon
          name="chevron"
          size={14}
          class={`rows-tree-chevron${node.open ? " rows-tree-chevron-open" : ""}`}
        />
        <Icon name="folder" size={14} class="rows-tree-icon" />
        <span class="rows-tree-name">{node.name}</span>
        <span class="rows-tree-meta">
          {count(node.count)} {node.count === 1 ? "file" : "files"}
        </span>
      </button>
      {node.open && (
        <ul class="rows-tree" id={id}>
          <Nodes nodes={node.children} depth={depth + 1} />
        </ul>
      )}
    </li>
  );
}

function Nodes({ nodes, depth }: { nodes: RowsTreeNode[]; depth: number }) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === "folder" ? (
          <Folder key={node.key} node={node} depth={depth} />
        ) : node.kind === "file" ? (
          <li key={node.key}>
            <a
              class="rows-tree-node rows-tree-file"
              style={depthOf(depth)}
              href={node.href}
              title={node.title}
            >
              <span class="rows-tree-gap" />
              <Icon
                name={node.icon ?? "file"}
                size={14}
                class="rows-tree-icon"
              />
              <span class="rows-tree-name">{node.name}</span>
              {node.meta !== undefined && (
                <span
                  class={`rows-tree-meta${node.lit ? " rows-tree-lit" : ""}`}
                >
                  {node.meta}
                </span>
              )}
            </a>
          </li>
        ) : (
          <li key={node.key}>
            <button
              type="button"
              class="rows-tree-node rows-tree-more"
              style={depthOf(depth)}
              onClick={node.onPick}
            >
              <span class="rows-tree-gap" />
              {node.label}
            </button>
          </li>
        ),
      )}
    </>
  );
}

export function RowsTree({
  label,
  nodes,
}: {
  // names the list to a screen reader
  label: string;
  nodes: RowsTreeNode[];
}) {
  return (
    <ul class="rows-tree" aria-label={label}>
      <Nodes nodes={nodes} depth={0} />
    </ul>
  );
}
