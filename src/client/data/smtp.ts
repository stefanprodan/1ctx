// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { effect, signal } from "@preact/signals";
import type {
  PutSmtpRequest,
  SmtpResponse,
  SmtpTestResponse,
} from "../../shared/api/smtp.ts";
import { type Failure, failure } from "../lib/format.ts";
import { api } from "./api.ts";
import { me } from "./me.ts";

export const smtp = signal<SmtpResponse | null>(null);
export const smtpError = signal<Failure | null>(null);

let owner: string | null = null;
let turn = 0;

effect(() => {
  const id = me.value?.id ?? null;
  if (id === owner) return;
  owner = id;
  smtp.value = null;
  smtpError.value = null;
});

export async function loadSmtp(): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  smtpError.value = null;
  try {
    const body = await api<SmtpResponse>("/api/admin/smtp");
    if (owner === forUser && turn === mine) smtp.value = body;
  } catch (err) {
    if (owner === forUser && turn === mine) smtpError.value = failure(err);
  }
}

// the answer is the whole entity, so it supersedes a load in flight
export async function saveSmtp(body: PutSmtpRequest): Promise<void> {
  const forUser = owner;
  const mine = ++turn;
  const next = await api<SmtpResponse>("/api/admin/smtp", "PUT", body);
  if (owner === forUser && turn === mine) smtp.value = next;
}

export async function sendTestEmail(): Promise<SmtpTestResponse["result"]> {
  const answer = await api<SmtpTestResponse>("/api/admin/smtp/test", "POST");
  return answer.result;
}
