// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A project's MCP servers: a section on every project's Settings tab and
// a card on a team project's admin page, drawn as Repos.tsx draws its
// rows, each with the project's side of it. No URL and no key file,
// which a member's answer never carries.

import { type Signal, useSignal } from "@preact/signals";
import type { ProjectMcpServer } from "../../../shared/api/mcp.ts";
import {
  addProjectMcp,
  projectMcpErrorOf,
  projectMcpOf,
  removeProjectMcp,
  setProjectMcpSide,
} from "../../data/project-mcp.ts";
import { configMcpHref } from "../../lib/hrefs.ts";
import { useAction, useSave } from "../../lib/save.ts";
import { countOf } from "../../lib/search.ts";
import { Finder } from "../../ui/Finder.tsx";
import { AskDelete, Foot } from "../../ui/Foot.tsx";
import {
  RowsEnd,
  RowsFailed,
  RowsGo,
  RowsLine,
  RowsList,
  RowsNew,
  RowsNote,
  RowsTitle,
} from "../../ui/Rows.tsx";
import { Section } from "../../ui/Section.tsx";
import { Select } from "../../ui/Select.tsx";
import { Setting } from "../../ui/Setting.tsx";
import { MoreMenu } from "../knowledge/file/DocMenus.tsx";
import {
  mcpText,
  type OpenServer,
  openOf,
  pickOptions,
  pickValue,
  removable,
  removeAsk,
  rowKind,
  rowLine,
  sideWord,
} from "./McpServers.model.ts";
import "./mcp-servers.css";

export function McpServers({
  projectId,
  projectName,
  personal,
  section,
  admin,
}: {
  projectId: string;
  projectName: string;
  personal: boolean;
  // a Settings tab's section rather than the admin page's card
  section: boolean;
  admin: boolean;
}) {
  const open = useSignal<OpenServer>(null);
  const adding = useAction();
  const answer = projectMcpOf(projectId);
  const list = answer?.servers ?? null;
  const addable = answer?.addable ?? [];
  const add = admin && !personal && addable.length > 0 && (
    <Finder
      label="MCP Servers"
      add="Add server"
      disabled={
        adding.busy.value ||
        (list !== null && openOf(open.value, list) !== null)
      }
      options={addable.map((s) => ({ value: s.id, label: s.name }))}
      mono
      placeholder="Find a server"
      none="No server matches"
      onPick={(id) => void adding.run(() => addProjectMcp(projectId, id))}
    />
  );
  const failed = adding.failure.value !== null && (
    <span class="hint error">{adding.failure.value}</span>
  );
  const rows = (
    <ServerRows
      projectId={projectId}
      projectName={projectName}
      personal={personal}
      admin={admin}
      list={list}
      open={open}
    />
  );
  if (section) {
    return (
      <Section title="MCP Servers" text={mcpText(personal)}>
        <div class="field">
          {add && <div class="mcp-servers-head">{add}</div>}
          {list !== null || projectMcpErrorOf(projectId) !== null ? (
            <RowsList>{rows}</RowsList>
          ) : null}
          {failed}
        </div>
      </Section>
    );
  }
  return (
    <Setting
      title="MCP Servers"
      count={list === null ? undefined : countOf(list.length, list.length)}
      line={failed || undefined}
      list
      action={add || undefined}
    >
      {rows}
    </Setting>
  );
}

function ServerRows({
  projectId,
  projectName,
  personal,
  admin,
  list,
  open,
}: {
  projectId: string;
  projectName: string;
  personal: boolean;
  admin: boolean;
  list: ProjectMcpServer[] | null;
  open: Signal<OpenServer>;
}) {
  const error = projectMcpErrorOf(projectId);
  if (list === null) {
    return error === null ? null : <RowsFailed failure={error} />;
  }
  const kind = rowKind(admin, personal);
  const opened = kind === "admin" ? openOf(open.value, list) : null;
  const close = () => {
    open.value = null;
  };
  return (
    <>
      {error !== null && <RowsFailed failure={error} />}
      {list.length === 0 && <RowsNote>No MCP Servers.</RowsNote>}
      {list.map((server) => {
        if (opened !== null && opened.id === server.id) {
          return (
            <RowsNew key={server.id}>
              <RemoveForm
                projectId={projectId}
                projectName={projectName}
                personal={personal}
                row={server}
                onClose={close}
              />
            </RowsNew>
          );
        }
        const title = (
          <RowsTitle
            name={server.name}
            mono
            prose
            wrap
            sub={rowLine(server, personal)}
          />
        );
        if (kind === "read") {
          return (
            <RowsLine key={server.id} flush>
              {title}
              <span class="mcp-servers-end">
                <SideWord row={server} />
              </span>
            </RowsLine>
          );
        }
        const end = (
          <SideEnd
            projectId={projectId}
            personal={personal}
            row={server}
            locked={opened !== null}
            // an admin's rows keep the menu's room, so every pick lines up
            menu={kind === "admin"}
            onRemove={
              removable(kind, server)
                ? () => {
                    open.value = server;
                  }
                : undefined
            }
          />
        );
        // an admin follows the row to the server's page, where its grants
        // change; an owner's row has no link
        return kind === "admin" ? (
          <RowsGo key={server.id} href={configMcpHref(server.name)} end={end}>
            {title}
          </RowsGo>
        ) : (
          <RowsLine key={server.id} flush>
            {title}
            {end}
          </RowsLine>
        );
      })}
    </>
  );
}

// the side, in the pick's column whether or not it can change
function SideWord({ row }: { row: ProjectMcpServer }) {
  return (
    <span class="mcp-servers-pick">
      <span class="mcp-servers-word">{sideWord(row)}</span>
    </span>
  );
}

// the project's pick of the row's side, written at once, and Remove in
// the More menu of a listed row; a row with nothing to pick but Off says
// its word
function SideEnd({
  projectId,
  personal,
  row,
  locked,
  menu,
  onRemove,
}: {
  projectId: string;
  personal: boolean;
  row: ProjectMcpServer;
  locked: boolean;
  menu: boolean;
  onRemove?: () => void;
}) {
  const picking = useAction();
  const options = pickOptions(row);
  const busy = picking.busy.value || locked;
  return (
    <RowsEnd error={picking.failure.value}>
      <span class="mcp-servers-end">
        {options.length > 1 ? (
          <span class="mcp-servers-pick">
            <Select
              label={`Side of ${row.name}`}
              small
              value={pickValue(row)}
              options={options}
              disabled={busy}
              onChange={(value) => {
                const side = options.find((o) => o.value === value)?.value;
                if (side === undefined || side === pickValue(row)) return;
                void picking.run(() =>
                  setProjectMcpSide(projectId, row.id, side, personal),
                );
              }}
            />
          </span>
        ) : (
          <SideWord row={row} />
        )}
        {onRemove !== undefined ? (
          <MoreMenu
            label={`More for ${row.name}`}
            disabled={busy}
            actions={[
              {
                label: "Remove",
                icon: "close",
                danger: true,
                onPick: onRemove,
              },
            ]}
          />
        ) : (
          menu && <span class="mcp-servers-gap" />
        )}
      </span>
    </RowsEnd>
  );
}

function RemoveForm({
  projectId,
  projectName,
  personal,
  row,
  onClose,
}: {
  projectId: string;
  projectName: string;
  personal: boolean;
  row: ProjectMcpServer;
  onClose: () => void;
}) {
  const asking = useSignal(false);
  const save = useSave(async () => {});
  const remove = (
    <AskDelete
      save={save}
      asking={asking}
      busy={save.busy}
      words={removeAsk(row, projectName)}
      wordsClass="mcp-servers-ask"
      label="Remove"
      ask="Remove"
      action="remove"
      going="Removing"
      onDelete={() => {
        void save.act("remove", async () => {
          await removeProjectMcp(projectId, row.id);
          onClose();
        });
      }}
    />
  );
  return (
    <div class="mcp-servers-form">
      <RowsTitle name={row.name} mono prose sub={rowLine(row, personal)} />
      {asking.value ? (
        <Foot save={save}>
          <div class="mcp-servers-remove">{remove}</div>
        </Foot>
      ) : (
        <Foot save={save} start={remove}>
          <button
            type="button"
            class="btn"
            disabled={save.busy}
            onClick={onClose}
          >
            Cancel
          </button>
        </Foot>
      )}
    </div>
  );
}
