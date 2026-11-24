// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Passkeys: the profile's list, an add from a signed-in browser and its
// removal, and the sign-in with one. The relying party is the browser's
// Origin. Every failed sign-in is one 401 but an unknown passkey's,
// which carries a code so the page can ask the browser to forget it.
// Options have their own limit per address; the answers share the
// login limit.

import { isIP } from "node:net";
import {
  type PasskeyRequestOptions,
  type PasskeySignInResponse,
  UNKNOWN_PASSKEY,
} from "../../../shared/api/access.ts";
import type {
  PasskeyCreationOptions,
  PasskeysResponse,
} from "../../../shared/api/profile.ts";
import { isRecord } from "../../../shared/words.ts";
import { type Db, transact } from "../../db/index.ts";
import { isForm, jsonBody } from "../../lib/body.ts";
import { type BusEvent, loginRevoked } from "../../lib/bus.ts";
import type { Clock } from "../../lib/clock.ts";
import { BadRequest, Conflict, Forbidden, NotFound } from "../../lib/errors.ts";
import {
  json,
  loginOf,
  type RouteContext,
  type RouteDescriptor,
} from "../../lib/http.ts";
import { ID_SHAPE } from "../../lib/ids.ts";
import type { Log } from "../../lib/log.ts";
import { meOf, type UserRow } from "../../users/index.ts";
import { actingWrite } from "../acting.ts";
import { type AdminKeys, loginHolds } from "../admin-keys.ts";
import type { Auth } from "../auth.ts";
import { passkeyEmail } from "../emails.ts";
import type { EmailPort } from "../links.ts";
import type { LoginStore } from "../store.ts";
import { toB64url } from "./authenticator.ts";
import {
  ALGS,
  assertionOf,
  checkAssertion,
  checkRegistration,
  type Reason,
  registrationOf,
  relyingParty,
} from "./checks.ts";
import { providerOf, UNKNOWN_PROVIDER } from "./provider.ts";
import {
  CHALLENGE_MS,
  PASSKEYS_PER_USER,
  type Passkey,
  type PasskeyStore,
  passkeyItem,
} from "./store.ts";

// the name the browser shows beside a passkey
const RP_NAME = "1ctx";
// where a sign-in by passkey lands
const LANDING = "/";
// a credential id may be 1,023 bytes, and an answer carries it four times
const PASSKEY_BODY_BYTES = 16 * 1024;
const PASSKEY_ID = new RegExp(`^${ID_SHAPE}$`);

export type PasskeyRoutesDeps = {
  db: Db;
  store: PasskeyStore;
  auth: Pick<Auth, "open" | "close">;
  logins: Pick<LoginStore, "byId" | "delete">;
  users: { byId(id: string): UserRow | null };
  adminKeys: Pick<AdminKeys, "digestOf">;
  email: Pick<EmailPort, "enabled" | "link" | "enqueue">;
  clock: Clock;
  log: Log;
  // the login limit per address, which the answers share
  guard(ctx: RouteContext): void;
  // the options' own limit, so a page that keeps them fresh never spends
  // the sign-in's
  optionsGuard(ctx: RouteContext): void;
};

export function passkeyRoutes(deps: PasskeyRoutesDeps): RouteDescriptor[] {
  const party = (req: Request) => {
    const found = relyingParty(req.headers.get("origin"));
    if (found === null) {
      throw new Forbidden("passkeys need an https origin or localhost");
    }
    return found;
  };
  const refused = (reason: Reason | "challenge" | "count", addr: string) =>
    deps.log.info("passkey refused", {
      reason,
      addr: isIP(addr) === 0 ? "invalid" : addr,
    });
  // every failed sign-in, whatever failed
  const notAccepted = () => json({ error: "passkey not accepted" }, 401);
  const badPasskey = () =>
    json({ error: "the passkey did not check out" }, 400);
  // the answer's object; null for a form, a bad body or none
  const answer = async (req: Request) => {
    if (isForm(req)) return null;
    try {
      const body = await jsonBody(req, PASSKEY_BODY_BYTES);
      return isRecord(body) ? body : null;
    } catch (error) {
      // a body past the cap keeps its 413
      if (error instanceof BadRequest) return null;
      throw error;
    }
  };
  const acting = {
    db: deps.db,
    logins: deps.logins,
    users: deps.users,
    adminKeys: deps.adminKeys,
    clock: deps.clock,
  };
  const full = () =>
    new Conflict(`at most ${PASSKEYS_PER_USER} passkeys a user`);

  return [
    {
      // every origin's, so none added elsewhere hides
      method: "GET",
      path: "/api/profile/passkeys",
      policy: "authenticated",
      handle(_req, ctx) {
        const body: PasskeysResponse = {
          passkeys: deps.store.forUser(ctx.principal!.userId).map(passkeyItem),
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/profile/passkeys/options",
      policy: "authenticated",
      handle(req, ctx) {
        const rp = party(req);
        deps.optionsGuard(ctx);
        const principal = ctx.principal!;
        const made = actingWrite(acting, principal, null, (user) => {
          const held = deps.store.forUser(user.id);
          if (held.length >= PASSKEYS_PER_USER) throw full();
          const challenge = deps.store.newChallenge(
            { purpose: "add", ...rp, login: loginOf(principal) },
            deps.clock(),
          );
          // the keychain keys a passkey by host and user, so one of
          // another port of this host would be replaced
          const own = held.filter((p) => p.rpId === rp.rpId);
          return { result: { user, challenge, own } };
        });
        const body: PasskeyCreationOptions = {
          challenge: made.challenge,
          rp: { id: rp.rpId, name: RP_NAME },
          user: {
            id: toB64url(new TextEncoder().encode(made.user.id)),
            name: made.user.emailPlaceholder
              ? made.user.username
              : made.user.email,
            displayName: made.user.fullName,
          },
          pubKeyCredParams: ALGS.map((alg) => ({ type: "public-key", alg })),
          timeout: CHALLENGE_MS,
          attestation: "none",
          authenticatorSelection: {
            residentKey: "required",
            requireResidentKey: true,
            userVerification: "required",
          },
          excludeCredentials: made.own.map((p) => ({
            type: "public-key",
            id: p.credentialId,
            transports: p.transports,
          })),
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/profile/passkeys",
      policy: "authenticated",
      async handle(req, ctx) {
        const rp = party(req);
        deps.guard(ctx);
        const b = await answer(req);
        const sent = b === null ? null : registrationOf(b);
        if (sent === null) {
          refused("body", ctx.address);
          return badPasskey();
        }
        const checked = await checkRegistration(sent, {
          type: "webauthn.create",
          ...rp,
        });
        if ("refused" in checked) {
          refused(checked.refused, ctx.address);
          return badPasskey();
        }
        const device = providerOf(checked.aaguid);
        const principal = ctx.principal!;
        const loginId = loginOf(principal)!;
        // an answer landing after a sign out everywhere adds nothing
        const added = actingWrite<
          "challenge" | { user: UserRow; passkey: Passkey }
        >(acting, principal, null, (user) => {
          const now = deps.clock();
          const scope = { purpose: "add" as const, ...rp, login: loginId };
          if (!deps.store.takeChallenge(checked.challenge, scope, now)) {
            return { result: "challenge" as const };
          }
          if (deps.store.count(user.id) >= PASSKEYS_PER_USER) throw full();
          const passkey = deps.store.insert(
            {
              userId: user.id,
              ...rp,
              credentialId: checked.credentialId,
              publicKey: checked.publicKey,
              alg: checked.alg,
              signCount: checked.signCount,
              transports: checked.transports,
              device,
              // the passkey keeps the trust of the login that added it
              keyDigest: deps.logins.byId(loginId)?.keyDigest ?? null,
            },
            now,
          );
          if (passkey === null) {
            throw new Conflict("this passkey is already added");
          }
          const events: BusEvent[] = [];
          if (deps.email.enabled() && !user.emailPlaceholder) {
            const { subject, text } = passkeyEmail(
              device === UNKNOWN_PROVIDER ? null : device,
              now,
              user.tz,
              deps.email.link("/"),
            );
            events.push(
              ...deps.email.enqueue({
                kind: "notice",
                userId: user.id,
                subject,
                body: text,
              }),
            );
          }
          return { result: { user, passkey }, events };
        });
        if (added === "challenge") {
          refused("challenge", ctx.address);
          return badPasskey();
        }
        deps.log.info("passkey added", {
          user: added.user.username,
          passkey: added.passkey.id,
        });
        return json(passkeyItem(added.passkey), 201);
      },
    },
    {
      method: "DELETE",
      path: "/api/profile/passkeys/:id",
      policy: "authenticated",
      handle(_req, ctx) {
        const id = ctx.params.id;
        // a sign out landing first removes nothing
        const removed = actingWrite(acting, ctx.principal!, null, (user) => ({
          result: PASSKEY_ID.test(id) && deps.store.remove(user.id, id),
        }));
        if (!removed) throw new NotFound("no such passkey");
        deps.log.info("passkey removed", {
          user: ctx.principal!.username,
          passkey: id,
        });
        return new Response(null, { status: 204 });
      },
    },
    {
      // discoverable, so no user is named before the tap
      method: "POST",
      path: "/api/login/passkey/options",
      policy: "public",
      handle(req, ctx) {
        const rp = party(req);
        deps.optionsGuard(ctx);
        const challenge = transact(deps.db, () => ({
          result: deps.store.newChallenge(
            { purpose: "sign_in", ...rp, login: null },
            deps.clock(),
          ),
        }));
        const body: PasskeyRequestOptions = {
          challenge,
          rpId: rp.rpId,
          timeout: CHALLENGE_MS,
          userVerification: "required",
          allowCredentials: [],
        };
        return json(body);
      },
    },
    {
      method: "POST",
      path: "/api/login/passkey",
      policy: "public",
      async handle(req, ctx) {
        const rp = party(req);
        deps.guard(ctx);
        const b = await answer(req);
        const sent = b === null ? null : assertionOf(b);
        if (sent === null) {
          refused("body", ctx.address);
          return notAccepted();
        }
        const passkey = deps.store.byCredential(sent.id);
        if (passkey === null) {
          refused("credential", ctx.address);
          return json(
            { error: "passkey not accepted", code: UNKNOWN_PASSKEY },
            401,
          );
        }
        // held, at another address: never one the browser should forget
        if (passkey.rpId !== rp.rpId || passkey.origin !== rp.origin) {
          refused("credential", ctx.address);
          return notAccepted();
        }
        const checked = await checkAssertion(
          sent,
          { type: "webauthn.get", ...rp },
          {
            user: passkey.userId,
            publicKey: passkey.publicKey,
            alg: passkey.alg,
            signCount: passkey.signCount,
          },
        );
        if ("refused" in checked) {
          refused(checked.refused, ctx.address);
          return notAccepted();
        }
        const principal = ctx.principal;
        const made = transact<
          | "challenge"
          | "user"
          | "admin_key"
          | "count"
          | { user: UserRow; setCookie: string }
        >(deps.db, () => {
          const now = deps.clock();
          const scope = { purpose: "sign_in" as const, ...rp, login: null };
          if (!deps.store.takeChallenge(checked.challenge, scope, now)) {
            return { result: "challenge" as const };
          }
          // read in the write, so a disable, a demote, a rename or a
          // changed key file meanwhile opens nothing: one added from a key
          // login holds only while that key does, as the login did
          const user = deps.users.byId(passkey.userId);
          if (user === null || user.disabled)
            return { result: "user" as const };
          if (!loginHolds(deps.adminKeys, passkey, user)) {
            return { result: "admin_key" as const };
          }
          // a removal, a sign out everywhere or another answer of this
          // passkey since the checks
          if (
            !deps.store.use(
              passkey.id,
              passkey.signCount,
              checked.signCount,
              now,
            )
          ) {
            return { result: "count" as const };
          }
          // the tab's login is replaced, never kept beside the new one
          const events: BusEvent[] = [];
          const old = principal === null ? null : loginOf(principal);
          if (principal !== null && old !== null) {
            deps.auth.close(old);
            events.push(loginRevoked(principal.userId, old));
          }
          const { setCookie } = deps.auth.open(user, passkey.keyDigest);
          return { result: { user, setCookie }, events };
        });
        if (typeof made === "string") {
          refused(made, ctx.address);
          return notAccepted();
        }
        deps.log.info("passkey used", {
          user: made.user.username,
          passkey: passkey.id,
        });
        const body: PasskeySignInResponse = {
          user: meOf(made.user),
          landing: LANDING,
        };
        return json(body, 200, { "set-cookie": made.setCookie });
      },
    },
  ];
}
