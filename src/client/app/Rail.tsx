// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { Me } from "../../shared/contracts/user.ts";
import { automationProject } from "../data/automations.ts";
import { taskPage } from "../data/external-task.ts";
import { projects } from "../data/projects.ts";
import { session } from "../data/sessions.ts";
import { initials } from "../lib/format.ts";
import { Icon, type IconName, Logo, projectIcon } from "../lib/icons.tsx";
import { PathName } from "../ui/PathName.tsx";
import {
  adminFace,
  navLit,
  onPage,
  projectHere,
  zoneLit,
} from "./Rail.model.ts";
import {
  type RecentRow,
  recentHref,
  recentKey,
  recentLook,
  recentText,
  statusKey,
} from "./Recent.model.ts";
import { pickRecent, recent, recentStatus } from "./Recent.state.ts";
import { path } from "./router.ts";
import { navEntries } from "./routes.ts";
import { lastAdmin, lastWork } from "./shell.ts";
import { toggleUserMenu, UserMenu, userMenuOpen } from "./UserMenu.tsx";
import { ZONES } from "./zones.ts";
import "./rail.css";

// the project of the page on screen, which a chat, a run, an
// automation and an external task name only once their row is read
export function projectOnScreen(here: string): string | null {
  const task = taskPage.value;
  return projectHere(
    here,
    session.value,
    automationProject.value,
    task && { id: task.id, projectId: task.detail.task.projectId },
  );
}

function Sub({
  href,
  here,
  on = onPage(here, href),
  icon,
  follow,
  children,
}: {
  href: string;
  here: string;
  // inside the link's page, not only on it
  on?: boolean;
  icon?: IconName;
  follow?: () => void;
  children: string;
}) {
  return (
    <a
      href={href}
      class={`rail-sub${icon ? " rail-sub-icon" : ""}${on ? " rail-sub-on" : ""}`}
      aria-current={here === href ? "page" : undefined}
      onClick={follow}
    >
      {icon ? (
        <>
          <Icon name={icon} size={14} class="rail-sub-glyph" />
          <span class="rail-sub-name">{children}</span>
        </>
      ) : (
        children
      )}
    </a>
  );
}

// the pages opened last, under the entries' icons; a title is a
// sentence, cut to the rail with the whole of it on hover. The icon
// takes the row's live status, coloured as its own list draws it
function Recent({ here, follow }: { here: string; follow?: () => void }) {
  const rows = recent.value;
  const statuses = recentStatus.value;
  if (rows.length === 0) return null;
  return (
    <>
      <span class="rail-label">Recent</span>
      {rows.map((row: RecentRow) => {
        const href = recentHref(row);
        const text = recentText(row);
        const look = recentLook(row, statuses[statusKey(row)]);
        return (
          <a
            key={recentKey(row)}
            href={href}
            class={`rail-sub rail-sub-icon rail-recent${onPage(here, href) ? " rail-sub-on" : ""}`}
            aria-current={here === href ? "page" : undefined}
            title={text}
            onClick={(e) => {
              pickRecent(row, e);
              follow?.();
            }}
          >
            <Icon
              name={look.icon}
              size={14}
              class={`rail-sub-glyph${look.tone ? ` status-${look.tone}` : ""}`}
            />
            <span class="rail-sub-name">
              {row.kind === "file" ? <PathName name={text} /> : text}
            </span>
          </a>
        );
      })}
    </>
  );
}

function Zones({ here, follow }: { here: string; follow?: () => void }) {
  const lit = zoneLit(here);
  return (
    <>
      {ZONES.map((z) => (
        <Fragment key={z.href}>
          <a
            href={z.href}
            class={`rail-item rail-zone${lit === z.href ? " rail-item-on" : ""}${
              lit !== null && onPage(lit, z.href) ? " rail-item-in" : ""
            }`}
            aria-current={here === z.href ? "page" : undefined}
            onClick={follow}
          >
            <Icon name={z.icon} />
            <span>{z.label}</span>
          </a>
          {z.pages.map((p) => (
            <Sub
              key={p.href}
              href={p.href}
              here={here}
              on={p.href === lit}
              follow={follow}
            >
              {p.label}
            </Sub>
          ))}
        </Fragment>
      ))}
    </>
  );
}

export function Rail({
  user,
  narrow,
  onHide,
}: {
  user: Me;
  narrow: boolean;
  onHide: () => void;
}) {
  const here = path.value;
  const admin = adminFace(here);
  const inProject = projectOnScreen(here);
  const hide = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    if (narrow) hide.current?.focus();
  }, [narrow]);
  // the list scrolls inside the rail, so the project on screen is kept in
  // view when it sits below the fold, after a reload or a link elsewhere
  useEffect(() => {
    nav.current
      ?.querySelector(".rail-sub-on:not(.rail-recent)")
      ?.scrollIntoView({ block: "nearest" });
  }, [here, inProject, projects.value]);
  // a link to the page on screen is no navigation, so the link closes
  // the drawer itself
  const follow = narrow ? onHide : undefined;
  return (
    <aside class={`rail${narrow ? " rail-drawer" : ""}`}>
      <div class="rail-top">
        <div class="rail-head">
          <a class="rail-logo" href="/" aria-label="Home" onClick={follow}>
            <Logo height={26} />
          </a>
          {admin && <span class="rail-face">Admin</span>}
          <button
            ref={hide}
            type="button"
            class="btn-icon rail-hide"
            aria-label={narrow ? "Close the menu" : "Hide the menu"}
            onClick={onHide}
          >
            <Icon name={narrow ? "close" : "sidebar"} />
          </button>
        </div>
        <nav ref={nav} class="rail-nav">
          {admin ? (
            <Zones here={here} follow={follow} />
          ) : (
            // Projects comes last in the table, so Recent sits above its
            // long list
            navEntries().map((route) => (
              <Fragment key={route.path}>
                {route.path === "/projects" && (
                  <Recent here={here} follow={follow} />
                )}
                <a
                  href={route.path}
                  class={`rail-item${navLit(here, route.path) ? " rail-item-on" : ""}`}
                  aria-current={here === route.path ? "page" : undefined}
                  onClick={follow}
                >
                  <Icon name={route.nav!.icon} />
                  <span>{route.nav!.label}</span>
                </a>
                {route.path === "/projects" &&
                  (projects.value ?? []).map((p) => (
                    <Sub
                      key={p.id}
                      href={`/projects/${p.id}`}
                      here={here}
                      on={p.id === inProject}
                      icon={projectIcon(p.kind)}
                      follow={follow}
                    >
                      {p.name}
                    </Sub>
                  ))}
              </Fragment>
            ))
          )}
        </nav>
      </div>
      {user.role === "admin" && (
        <a
          class="rail-band"
          href={admin ? lastWork.value : lastAdmin.value}
          onClick={follow}
        >
          <Icon name={admin ? "home" : "panel"} />
          <span>{admin ? "Exit admin panel" : "Admin panel"}</span>
          <Icon name="open" size={14} class="rail-band-open" />
        </a>
      )}
      <UserMenu wrap="rail-user" place="rail-menu" follow={follow}>
        <button
          type="button"
          class="rail-user-row"
          aria-expanded={userMenuOpen.value}
          onClick={toggleUserMenu}
        >
          <span class="avatar">{initials(user.fullName)}</span>
          <span class="rail-user-name cut">{user.fullName}</span>
          <Icon name="chevron" size={14} class="rail-user-chevron" />
        </button>
      </UserMenu>
    </aside>
  );
}
