// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Passkeys and their challenges as rows. A challenge row holds only the
// SHA-256 of 32 random bytes and is deleted by the answer that uses it,
// so a replay finds none; every write here runs inside the caller's
// transaction.

import type { Passkey as PasskeyItem } from "../../../shared/api/profile.ts";
import type { Db } from "../../db/index.ts";
import { MINUTE_MS } from "../../lib/clock.ts";
import { newId, newToken, sha256 } from "../../lib/ids.ts";
import type { Bytes } from "./authenticator.ts";
import type { Alg } from "./checks.ts";

// counted across hosts
export const PASSKEYS_PER_USER = 10;
export const CHALLENGE_MS = 2 * MINUTE_MS;

export type Purpose = "add" | "sign_in";

// the origin binds a challenge to the page that asked, port included; an
// add's to the login that asked
export type Scope = {
  purpose: Purpose;
  rpId: string;
  origin: string;
  login: string | null;
};

type Raw = {
  id: string;
  user_id: string;
  rp_id: string;
  origin: string;
  credential_id: string;
  public_key: Uint8Array;
  alg: number;
  sign_count: number;
  transports: string;
  device: string;
  key_digest: string | null;
  created_at: number;
  last_used_at: number | null;
};

export type Passkey = {
  id: string;
  userId: string;
  rpId: string;
  origin: string;
  credentialId: string;
  publicKey: Bytes;
  alg: number;
  signCount: number;
  transports: string[];
  // the provider's name, from the authenticator's AAGUID
  device: string;
  // the admin key's hash of the key login that added it; null by email
  keyDigest: string | null;
  createdAt: number;
  lastUsedAt: number | null;
};

const passkeyOf = (r: Raw): Passkey => ({
  id: r.id,
  userId: r.user_id,
  rpId: r.rp_id,
  origin: r.origin,
  credentialId: r.credential_id,
  publicKey: new Uint8Array(r.public_key),
  alg: r.alg,
  signCount: r.sign_count,
  transports: JSON.parse(r.transports) as string[],
  device: r.device,
  keyDigest: r.key_digest,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

// what the profile lists of each; the credential id lets the page ask
// the browser to forget a removed one, never its key
export const passkeyItem = (p: Passkey): PasskeyItem => ({
  id: p.id,
  credentialId: p.credentialId,
  origin: p.origin,
  device: p.device,
  createdAt: p.createdAt,
  lastUsedAt: p.lastUsedAt,
});

export type NewPasskey = {
  userId: string;
  rpId: string;
  origin: string;
  credentialId: string;
  publicKey: Bytes;
  alg: Alg;
  signCount: number;
  transports: string[];
  device: string;
  keyDigest: string | null;
};

export class PasskeyStore {
  constructor(private readonly db: Db) {}

  // expired rows go in the same write, so anonymous asks never pile up
  newChallenge(scope: Scope, now: number): string {
    this.deleteExpiredChallenges(now);
    const challenge = newToken();
    this.db
      .query(
        `insert into passkey_challenges (id, challenge_hash, purpose,
           login_id, rp_id, origin, expires_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        sha256(challenge),
        scope.purpose,
        scope.login,
        scope.rpId,
        scope.origin,
        now + CHALLENGE_MS,
      );
    return challenge;
  }

  // true once: the unexpired row of this purpose, origin and login,
  // deleted
  takeChallenge(challenge: string, scope: Scope, now: number): boolean {
    return (
      this.db
        .query(
          `delete from passkey_challenges where challenge_hash = ?
             and purpose = ? and rp_id = ? and origin = ? and login_id is ?
             and expires_at > ?`,
        )
        .run(
          sha256(challenge),
          scope.purpose,
          scope.rpId,
          scope.origin,
          scope.login,
          now,
        ).changes === 1
    );
  }

  deleteExpiredChallenges(now: number): number {
    return this.db
      .query("delete from passkey_challenges where expires_at <= ?")
      .run(now).changes;
  }

  forUser(userId: string): Passkey[] {
    return this.db
      .query<Raw, [string]>(
        "select * from passkeys where user_id = ? order by created_at, id",
      )
      .all(userId)
      .map(passkeyOf);
  }

  count(userId: string): number {
    return this.db
      .query<{ n: number }, [string]>(
        "select count(*) as n from passkeys where user_id = ?",
      )
      .get(userId)!.n;
  }

  byCredential(credentialId: string): Passkey | null {
    const r = this.db
      .query<Raw, [string]>("select * from passkeys where credential_id = ?")
      .get(credentialId);
    return r === null ? null : passkeyOf(r);
  }

  // every passkey added from a key login, for the minute's check
  keyPasskeys(): Passkey[] {
    return this.db
      .query<Raw, []>("select * from passkeys where key_digest is not null")
      .all()
      .map(passkeyOf);
  }

  // null when the credential is already a row, whoever's
  insert(p: NewPasskey, now: number): Passkey | null {
    const r = this.db
      .query<Raw, (string | number | Bytes | null)[]>(
        `insert into passkeys (id, user_id, rp_id, origin, credential_id,
           public_key, alg, sign_count, transports, device, key_digest,
           created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (credential_id) do nothing
         returning *`,
      )
      .get(
        newId(),
        p.userId,
        p.rpId,
        p.origin,
        p.credentialId,
        p.publicKey,
        p.alg,
        p.signCount,
        JSON.stringify(p.transports),
        p.device,
        p.keyDigest,
        now,
      );
    return r === null ? null : passkeyOf(r);
  }

  // a sign-in's count and time, only while the row still holds the count
  // the checks read, so two answers racing move it once
  use(id: string, from: number, to: number, now: number): boolean {
    return (
      this.db
        .query(
          `update passkeys set sign_count = ?, last_used_at = ?
           where id = ? and sign_count = ?`,
        )
        .run(to, now, id, from).changes === 1
    );
  }

  remove(userId: string, id: string): boolean {
    return (
      this.db
        .query("delete from passkeys where id = ? and user_id = ?")
        .run(id, userId).changes === 1
    );
  }

  delete(ids: readonly string[]): void {
    const query = this.db.query("delete from passkeys where id = ?");
    for (const id of ids) query.run(id);
  }

  // the user's passkeys added from a key login, as a rename or a demote
  // ends their key logins
  deleteKeyPasskeys(userId: string): number {
    return this.db
      .query(
        "delete from passkeys where user_id = ? and key_digest is not null",
      )
      .run(userId).changes;
  }

  deleteForUser(userId: string): number {
    return this.db.query("delete from passkeys where user_id = ?").run(userId)
      .changes;
  }
}
