// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { type Signal, useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { address, navigate } from "../app/router.ts";
import { Icon } from "../lib/icons.tsx";
import {
  type Problem,
  type Save,
  useFocusField,
  useSave,
} from "../lib/save.ts";
import { AskDelete, Foot } from "./Foot.tsx";
import "./setting.css";

export function Setting({
  label,
  title,
  count,
  line,
  action,
  danger,
  list,
  foot,
  children,
}: {
  // names the card aloud when it has no title
  label?: string;
  title?: string;
  count?: string;
  line?: ComponentChildren;
  action?: ComponentChildren;
  danger?: boolean;
  list?: boolean;
  foot?: ComponentChildren;
  children?: ComponentChildren;
}) {
  const inner = (
    <>
      {(title !== undefined || action !== undefined) && (
        <div
          class={`setting-head${line === undefined ? " setting-head-one" : ""}`}
        >
          <div class="setting-words">
            {title !== undefined && (
              <h2 class="setting-title">
                {title}
                {count !== undefined && (
                  <span class="setting-count">{count}</span>
                )}
              </h2>
            )}
            {line !== undefined && <p class="setting-line">{line}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </>
  );
  return (
    <section
      class={`card setting${danger ? " setting-danger" : ""}${
        list ? " setting-list" : ""
      }`}
      aria-label={title === undefined ? label : undefined}
    >
      {list ? inner : <div class="setting-body">{inner}</div>}
      {foot !== undefined && <SettingFoot>{foot}</SettingFoot>}
    </section>
  );
}

export function SettingFoot({ children }: { children: ComponentChildren }) {
  return <div class="setting-foot">{children}</div>;
}

export function SettingHint({ children }: { children: ComponentChildren }) {
  return <span class="setting-hint">{children}</span>;
}

export function SettingStack({ children }: { children: ComponentChildren }) {
  return <div class="setting-stack">{children}</div>;
}

export function SettingForm({
  save,
  check,
  class: owner,
  children,
}: {
  save: Save;
  check?: () => Problem | string | null;
  class?: string;
  children: ComponentChildren;
}) {
  const form = useRef<HTMLFormElement>(null);
  useFocusField(save, form);
  return (
    <form
      ref={form}
      class={owner}
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(check?.() ?? null);
      }}
    >
      {children}
    </form>
  );
}

export function SettingFacts({ children }: { children: ComponentChildren }) {
  return <div class="setting-facts">{children}</div>;
}

export function SettingFact({
  label,
  mono,
  bad,
  pre,
  children,
}: {
  label: string;
  mono?: boolean;
  bad?: boolean;
  pre?: boolean;
  children: ComponentChildren;
}) {
  return (
    <>
      <span class="label">{label}</span>
      <span
        class={`setting-fact${mono ? " setting-fact-mono" : ""}${
          pre ? " setting-fact-pre" : ""
        }${bad ? " error" : ""}`}
      >
        {children}
      </span>
    </>
  );
}

export function SettingAlert({ children }: { children: ComponentChildren }) {
  return (
    <p class="setting-alert" role="status">
      <Icon name="alert" size={16} class="setting-alert-icon" />
      <span>{children}</span>
    </p>
  );
}

export function SettingDelete({
  title,
  line,
  ask,
  off,
  onAsk,
  onDelete,
  leaveTo,
}: {
  title: string;
  line: ComponentChildren;
  ask: string;
  // in use, or another card saving
  off?: boolean;
  onAsk?: () => Promise<void>;
  // throws to refuse
  onDelete: () => Promise<void>;
  leaveTo: string;
}) {
  const asking: Signal<boolean> = useSignal(false);
  const save = useSave(async () => {});
  return (
    <Setting
      danger
      title={title}
      line={line}
      foot={
        <Foot save={save}>
          <div class="setting-delete">
            <AskDelete
              save={save}
              asking={asking}
              busy={save.busy || off === true}
              words={ask}
              wordsClass="setting-ask"
              onAsk={onAsk}
              // the list drops the row as the call ends, which takes this
              // card away before act answers: the call leaves
              onDelete={() => {
                void save.act("delete", async () => {
                  const from = address();
                  await onDelete();
                  if (address() === from) navigate(leaveTo);
                });
              }}
            />
          </div>
        </Foot>
      }
    />
  );
}
