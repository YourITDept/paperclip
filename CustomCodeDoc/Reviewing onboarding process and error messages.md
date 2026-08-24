# Reviewing onboarding process and error messages

Working doc for the invite/onboarding debugging session.
Started 2026-08-24 · branch `W3-CodexChanges-20260823a`

**Two goals:**
1. Be able to validate that somebody has actually been invited and got in correctly.
2. Kill the error message on the invite landing page:
   > Already in this company
   > This account already belongs to Bring Your AI to Life.
   > **Invite not found**

---

## 1. The error message — root cause found and fixed

### What it actually was

The two messages have nothing to do with each other. `Invite not found` was a **stale
client-side error**, set before the invite had even loaded, and still sitting on screen
when the page later rendered the "Already in this company" panel.

Critically: **`acceptInvite` was never called.** The string came from a guard inside the
mutation function in the browser, never from the server. No invite was consumed, no
membership was touched, nothing was reused.

### Mechanism

In [InviteLanding.tsx](ui/src/pages/InviteLanding.tsx), `shouldAutoAcceptHumanInvite`
gates an effect that auto-accepts a human invite for a signed-in user. Every term in it
reads a field off `invite` — and when `invite` is still `undefined`, each one answers the
*permissive* way:

| term | with `invite === undefined` |
|---|---|
| `!showsAgentForm` | `undefined === "agent"` is false → `showsAgentForm` false → passes |
| `invite?.inviteType !== "bootstrap_ceo"` | `undefined !== "bootstrap_ceo"` → passes |
| `!inviteJoinRequestStatus` | `null` → passes |
| `!isCheckingExistingMembership` | needs `invite?.companyId` → false → passes |
| `!isCurrentMember` | needs `invite?.companyId` → false → passes |

So the whole gate opened on an invite that had not arrived.

The real-world trigger is the ordinary one: **an already signed-in member opens the invite
link.** Session and health are warm in the SPA query cache, the invite fetch is still in
flight. The effect fires, `acceptMutation` runs, hits its own first line —
`if (!invite) throw new Error("Invite not found")` — and stores that in `error` state.

`autoAcceptStarted` is then latched true, so it never retries. The invite lands, the
company list lands, `isCurrentMember` flips true, and the panel renders the correct
"Already in this company" heading with the dead error still painted underneath it.

### The fix

Added `Boolean(invite) &&` as the first term of `shouldAutoAcceptHumanInvite`
([InviteLanding.tsx:322](ui/src/pages/InviteLanding.tsx#L322)), with a comment recording
why order matters here. The gate can no longer open on an absent invite.

### Proof

A regression test was written first and reproduced the screen **verbatim**, company name
and all:

```
...Signed in as Jane Example.Already in this companyThis account already belongs to
Bring Your AI to Life.Invite not foundOpen company
acceptInvite calls >>> 0
```

It now lives in [InviteLanding.test.tsx](ui/src/pages/InviteLanding.test.tsx) as
_"shows no stale 'Invite not found' when a member opens the link with a warm session"_.
Verified as a real guard: it fails with the fix removed, passes with it in place.
Full file — 18 tests — green.

---

## 2. Validating that somebody got in correctly

### What exists today

| Surface | Where | Permission | Tells you |
|---|---|---|---|
| Invite history table | Company Invites page → "Invite history" | `users:invite` | State badge — Active / Accepted / Expired / Revoked — plus audience, inviter, created date, link to the join request |
| `GET /api/companies/:companyId/invites?state=` | [access.ts:4166](server/src/routes/access.ts#L4166) | `users:invite` | Same data, filterable by state |
| Join request queue | `/inbox/requests` | `joins:approve` | Status per request: pending_approval / approved / rejected |
| `GET /api/companies/:companyId/join-requests` | [access.ts:4173](server/src/routes/access.ts#L4173) | `joins:approve` | Filter by `status` and `requestType` |
| Activity log | `join.approved` event | — | The audit record of a grant, carrying `details.inviteId` and `details.source: "human_invite_accept"` — this is the one entry that ties *this* invite to *that* membership |

**The check, in practice:** invite state reads `Accepted` → its linked join request reads
`approved` → an activity entry `join.approved` exists with that `inviteId` and
`source: "human_invite_accept"`. That trio means the person is in, by way of that invite.

### Gap worth noting

There is **no `invite.accepted` activity event.** Logged invite actions are
`invite.created`, `invite.revoked`, `invite.openclaw_prompt_created`. Acceptance itself is
only inferable from `invites.acceptedAt` plus the linked `join.approved`. For human invites
that chain holds; for an agent invite left pending approval there is no activity-log trace
of the acceptance at all.

---

## 3. Has the invite been reused?

Short answer: **it cannot be, by a different person.** Enforcement is server-side in
`POST /api/invites/:token/accept` ([access.ts:3636](server/src/routes/access.ts#L3636)).

- Token is 256-bit entropy, stored only as a sha256 `tokenHash`; the raw value is returned
  once at creation. 72-hour TTL.
- Missing / revoked / expired → `404 Invite not found`.
- Once `acceptedAt` is set the invite is consumed. A replay is refused with
  `404 Invite not found` **unless** one of exactly two narrow cases applies:
  1. **Same human invitee repairing their own membership** — matched on `requestingUserId`,
     falling back to a lowercased email snapshot
     ([join-request-dedupe.ts](server/src/lib/join-request-dedupe.ts)), and only while their
     join request is `pending_approval` or `approved`. This grants nothing new; it re-ensures
     the membership that invite already authorised.
  2. **`openclaw_gateway` agent replay** for an existing pending/approved request, so a
     gateway can refresh its adapter defaults.
- `bootstrap_ceo` invites are hard single-use with no replay path, and the consume is a
  conditional update guarded on `isNull(acceptedAt)` — race-safe against two simultaneous
  claims.
- Public invite endpoints are rate-limited ([invite-rate-limit.ts](server/src/services/invite-rate-limit.ts)).

So a stranger with a consumed link gets a 404. The reuse question is answered by the invite
state itself: `Accepted` + exactly one linked join request = used once, as intended.

### Observation: `Invite not found` is overloaded

That one string covers ~14 call sites and at least three different situations: token never
existed, token consumed by someone else, and token expired/revoked. That is deliberate and
correct for enumeration resistance on a public endpoint — but it is genuinely confusing for
support, because a legitimately invited person who arrives late sees the same words as an
attacker guessing tokens.

Worth noting the client *can* safely disambiguate without weakening the server:
`GET /api/invites/:token` still resolves an accepted invite when it has a linked join
request, and returns `joinRequestStatus` / `joinRequestType`. The landing page already uses
this for its "This invite has already been used." panel.

---

## Open items / candidates for next

- [ ] **Copy pass on consumed-vs-unknown invites.** Decide whether the landing page should
      say "this invite has already been used — ask for a new one" where it currently falls
      through to the generic "Invite not available".
- [ ] **Add an `invite.accepted` activity event** so acceptance is auditable directly rather
      than inferred, and so agent invites left pending leave a trace.
- [ ] **Dead guard.** `if (!invite) throw new Error("Invite not found")` in the mutation is
      now unreachable — the only two callers both run with `invite` present. Either make it a
      non-user-facing assertion or drop it, so it can't resurface as UI text again.
- [ ] **Audit the same permissive-when-undefined pattern elsewhere** on this page —
      `requiresHumanAccount` and `showsAgentForm` are built the same way and were only safe
      here by luck of the render guards.
- [ ] Walk the end-to-end onboarding flow live once, against the running instance, to confirm
      nothing else stale renders between "Loading invite..." and the accept panel.

---

## Changed so far this session

- [ui/src/pages/InviteLanding.tsx](ui/src/pages/InviteLanding.tsx) — `Boolean(invite) &&` guard on `shouldAutoAcceptHumanInvite`
- [ui/src/pages/InviteLanding.test.tsx](ui/src/pages/InviteLanding.test.tsx) — regression test for the stale error
- [ReverseProxyCustomChanges.md](CustomCodeDoc/ReverseProxyCustomChanges.md) — registered the guard in the new §0.1 (fork changes a re-branch would silently lose) and logged the session as Session 6

**Nothing is committed yet.** §0.1 #1 has no SHA recorded against it until it is.

## Reference

- [doc/spec/invite-flow.md](doc/spec/invite-flow.md) — full state map, sequence diagrams, notes on the reload/repair paths
- [ReverseProxyCustomChanges.md §0.1](CustomCodeDoc/ReverseProxyCustomChanges.md) — where the guard is registered so a future upstream re-branch doesn't drop it; §8 Session 6 carries the same findings in log form
