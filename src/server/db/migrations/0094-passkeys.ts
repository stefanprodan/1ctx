// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// A passkey is bound to the origin it was added at, port included, so
// each row keeps it beside its rp_id; its key is the SPKI the browser's
// getPublicKey() gives. One added from an admin key login keeps that
// login's key_digest, so a changed key file ends it too. A challenge
// keeps only its hash; an add's goes with the login that asked, so a
// sign out leaves none to answer.
export const m0094: Migration = {
  id: "0094-passkeys",
  up(db) {
    db.exec(`
      create table passkeys (
        id text primary key,
        user_id text not null references users(id) on delete cascade,
        rp_id text not null,
        origin text not null,
        credential_id text not null unique,
        public_key blob not null,
        alg integer not null check (alg in (-7, -257)),
        sign_count integer not null,
        transports text not null,
        device text not null,
        key_digest text,
        created_at integer not null,
        last_used_at integer
      );
      create index passkeys_user on passkeys(user_id);
      create index passkeys_key on passkeys(key_digest)
        where key_digest is not null;

      create table passkey_challenges (
        id text primary key,
        challenge_hash text not null unique,
        purpose text not null check (purpose in ('add', 'sign_in')),
        login_id text references logins(id) on delete cascade,
        rp_id text not null,
        origin text not null,
        expires_at integer not null,
        check ((purpose = 'add') = (login_id is not null))
      );
      create index passkey_challenges_expiry
        on passkey_challenges(expires_at);
      create index passkey_challenges_login on passkey_challenges(login_id);
    `);
  },
};
