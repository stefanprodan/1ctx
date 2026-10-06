// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { effect, signal } from "@preact/signals";
import type {
  MailResponse,
  MailTestResponse,
  PutMailRequest,
} from "../../shared/api/mail.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const mail = signal<MailResponse | null>(null);
export const mailError = signal<Failure | null>(null);

let owner: string | null = null;
let turn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  mail.value = null;
  mailError.value = null;
});

export async function loadMail(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  mailError.value = null;
  try {
    const body = await api<MailResponse>("/api/admin/mail");
    if (owner === forUser && turn === mine) mail.value = body;
  } catch (err) {
    if (owner === forUser && turn === mine) mailError.value = failure(err);
  }
}

// the answer is the whole entity, so it supersedes a load in flight
export async function saveMail(body: PutMailRequest): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  const next = await api<MailResponse>("/api/admin/mail", "PUT", body);
  if (owner === forUser && turn === mine) mail.value = next;
}

export async function testMail(): Promise<MailTestResponse["result"]> {
  const answer = await api<MailTestResponse>("/api/admin/mail/test", "POST");
  return answer.result;
}
