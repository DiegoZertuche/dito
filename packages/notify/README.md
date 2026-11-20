# @dito/notify

The rep-side service that owns the two system-outbound rails: the SES
credentials, the web-push identity, a closed catalog of named message types,
and the content-free record of what it sent
([ADR-0022](../../docs/adr/0022-system-outbound-rails-closed-notify-catalog.md)
as amended,
[ADR-0019](../../docs/adr/0019-deployment-envelope-six-egress-flows.md)'s
flows 4 and 6).

**Seven** message types, and they are the whole of what Dito can send:

| Type | Email | Push | The caller binds |
| --- | --- | --- | --- |
| `invitation` | `notify.invitation` | — | `url` |
| `login_code` | `notify.loginCode` | — | `code`, `minutes`, `url` |
| `draft_ready` | — | `notify.push.draftReady` | `body`, `about` |
| `question_asked` | — | `notify.push.questionAsked` | `body`, `about` |
| `reminder` | — | `notify.push.reminder` | `body`, `about` |
| `rail_dropped` | `notify.railDropped` | `notify.push.railDropped` | `url`, `about` |
| `rail_logged_out` | `notify.railLoggedOut` | `notify.push.railLoggedOut` | `url`, `about` |

There is **no digest**: a seat with no push subscription receives nothing for
a routine wait, and the dashboard is then a pull surface like the twin thread
([ADR-0031](../../docs/adr/0031-dashboard-notifies-twin-thread-is-a-pull-surface.md)
as amended).

## The catalog is closed, and it fails at construction

`defineCatalog` runs over its entries when the module loads, so all seven ways
of breaking ADR-0022's rule are import-time errors rather than a refusal in
front of a rep who is waiting to log in: a type outside the closed set, two
entries for one type, a template `@dito/copy` does not hold (or none on either
transport), **a template declaring a free-form slot**, a seat-filled slot the
email template never declares, a type in the set with no entry, and **a
`composed` slot on anything but a push**.

The fourth is where *no free-text parameter exists* actually lives, and the
seventh is its twin: a free-form slot is a hole a CALLER puts its own words
in and is refused everywhere, while a composed slot is a sentence the twin
wrote that code read back out of a sealed post row — admitted on a push and on
nothing else, so no composed text ever leaves through SES. See
`defineCatalog`'s docblock. `catalog.test.ts` is the CI test ADR-0022 asks
for.

## The push rail

`livePushTransport` speaks the three standards a browser's push service
expects, over Node's own `crypto` and no dependency: the payload is encrypted
to the subscription (RFC 8291), framed `aes128gcm` (RFC 8188), and the request
carries a signed VAPID assertion for the endpoint's origin (RFC 8292). A
library would add a supply-chain edge on the one flow that carries the twin's
own sentences, to save about a hundred lines whose correctness is proven from
the other side.

The deployment's push identity is **configuration read by name**, never in the
repo:

| Variable | What it is |
| --- | --- |
| `DITO_VAPID_PUBLIC_KEY` | the uncompressed P-256 point, base64url |
| `DITO_VAPID_PRIVATE_KEY` | its private scalar, base64url |
| `DITO_VAPID_SUBJECT` | a `mailto:` or `https:` contact for the operator |

`generateVapidKeys` mints a pair. It is on the public surface because
provisioning is an operator job and a pair generated one way and consumed
another is where a wrong curve hides until the first 401;
`vapidFingerprint` prints a short digest of the public half so two processes
can be checked to agree without a key in a log. rep-web reads the public half
by the same name and serves it to the page that subscribes (`/avisos/clave`);
the private half is the runtime's alone.

A **push subscription** — the seat, the login session it was granted under,
the endpoint and the two keys — is written and deleted by rep-web under its
role and read here. The values are secrets: never rendered, never logged, and
a `404` or `410` from the push service ends the row in the same breath.

Delivery **joins the granting login** and requires it unended and unexpired,
and ends the subscription of one that is neither. «Cerrar sesiones» ends the
subscriptions it granted; a session that simply expires ends nothing, so
without the join a browser nobody has authenticated on since spring keeps
receiving the twin's own sentences.

Its lane is `push.int.test.ts`: a local HTTP receiver holding the test
subscription's **private** key decrypts what arrived by the RFC rather than by
calling the transport, so the assertion is what a browser would open and not
what the sender believes it sent. No push service is touched in CI.

## Recipients come from seat state

A caller says **which** message and **for which seat**. It never says to whom:
the address comes off `seats.email`. There is no parameter an address could
arrive through, and a seat id that looks like one is refused by name.

The rep's own name is the seat's too — both templates greet them, and the
entry declares which slots notify fills from the seat (`seatSlots`). A caller
that passed the name could put words into a message it does not otherwise
control, and the point of a closed catalog is that a caller chooses the
**occasion** and never the text.

## Every send is recorded, content-free

One `notify_sends` row per **attempt at one destination**: the channel it left
by, and for a push the browser it was addressed to. That is what makes the
record the runtime pass's memory at the grain a fan-out needs — a crash between
two of a seat's browsers resumes with the one it never reached, and a mail
rejection cannot stand for a push nobody tried. The row holds the seat, the
type, the instants, the outcome, a closed reason word, the transport's opaque
id, `channel`, `subscription_id`, and `about_ref`: the post a knock announced
or the rail transition a grave event reported. No address, no endpoint, no
code, no subject, no body — and the store's own CHECKs refuse the `@` every
address carries and bound both references to identifiers this database minted.

The row is **written before the send and settled after**
(`runtime_requests`' shape); an unsettled row means *this may have gone out*,
about the one destination it was opened for. The argument is in `notify.ts`'s
header.

An ask that names what it is **about** is therefore idempotent: `send` reads
what already stands, attempts exactly the destinations that have none, and
returns the records it wrote — an empty list when nothing was owed. An attempt
stands unless it failed, and a failed one stands for five minutes, so a
provider that says no is tried again without a request on every tick. An ask
with no `about` — the invitation, the login code — dedupes against nothing.

Which failures are rows is a line drawn on purpose:

- a **caller's** bug — a type outside the catalog, an address where a seat id
  belongs, a slot the template refuses — throws and writes nothing;
- a **state's** refusal — the seat has no address yet, no browser of theirs
  has accepted notifications — is a row, because the ask was legitimate;
- an **email transport** failure is a row *and* a throw;
- a **push** failure is a row alone: there is nothing a caller can do about a
  push service that said no, and a throw would stop the runtime's pass over a
  notification.

## Both transports carry a deadline

Five seconds each, argued where the transport is (`PUSH_DEADLINE_MS`,
`SES_DEADLINE_MS`). The number is about the caller rather than the provider:
the runtime awaits these inside its own two-second poll, so a service that
accepts a connection and goes quiet holds drafting behind it. A cut-off call
is a recorded `failed / transport_failed` and never a wait with no end. The
push side hands `fetch` an `AbortSignal`, which Node enforces; the SES side
both signals the SDK — so nothing leaves on a call nobody awaits any more —
and races the promise, so a client that ignores a signal still settles.

## The SES lane

`sesTransport` wraps the SDK's own `SESv2Client` in one command shape,
pinned by `ses.test.ts` — the wrong command class, an ignored destination or
a missing charset are what would be wrong without credentials, and none of
them needs a network call to catch.

The real lane is `ses.int.test.ts`, gated the way the KMS lane is:

```sh
DITO_REQUIRE_SES=1 DITO_SES_FROM=… DITO_SES_DEV_MAILBOX=… pnpm test:integration
```

Also: an error from the transport is never repeated. SES names the identity
that failed its check, so what notify throws carries the type, the seat and
the failure's **class** — not even as a `cause`, because Node's own
formatting walks the chain and every logger prints it.

Without them the suite is **skipped, never mocked**
([ADR-0028](../../docs/adr/0028-testing-evals-local-development.md)), and CI
annotates the run. With `DITO_REQUIRE_SES=1` and anything missing it
**fails**, naming what is unset — a run told to prove the rail works and
quietly proving nothing is the silent green the invariants exist to refuse.

Its evidence is content-free: the `notify_sends` row, and one printed line
naming the provider's id so an operator can find the message in the
provider's console.

## Two things a caller cannot decide

**Where a link goes.** Every character rule `@dito/copy` holds on a `url`
slot still leaves `https://attacker.example/entrar/8f2c` — a phishing link
inside a message Dito really sent — because a host is not something a bounded
character set can decide. So `createLiveNotify` takes the
**`dashboardOrigin`** and refuses any `url` slot whose origin differs. The
operator script reads it from `DITO_DASHBOARD_ORIGIN`, separately from the
`--url` it was given, so the refusal cannot agree with itself.

**When the record is durable.** The row is written before the send so a crash
cannot lose the fact of it — but on a caller's own client, inside a caller's
`BEGIN`, that insert is uncommitted while SES sends, and the caller's
rollback erases the record of a message that has already left. So notify
takes something it can check a **session** out of (`NotifySessions`; a
`pg.Pool` is one) and each send gets its own: autocommit, nobody else's
transaction. The integration suite proves it from a third connection while
the caller's transaction is still open.

## The public surface is one door

`createLiveNotify(db, from, dashboardOrigin, now, vapid?)` and nothing else
that can send. Both transports are internal — `sesTransport`'s
`send({ to, subject, body })` and `livePushTransport`'s
`send(subscription, payload)` are each a caller naming a destination and
arbitrary text with every guard here bypassed — and so is `createNotify`,
which takes them a caller could supply. Node's own resolver holds the same
line: the manifest pins `exports` to `.`, so `@dito/notify/dist/ses.js`
answers `ERR_PACKAGE_PATH_NOT_EXPORTED`.

`renderNotification` stays on the surface and cannot send: it returns a
subject and a body, which is what the operator script prints when the rail is
unconfigured.

## Never on a tool surface

Class 4 of [ADR-0013](../../docs/adr/0013-closed-effect-taxonomy.md), held
mechanically rather than by convention: `dependency-wall.test.ts` in
`@dito/execution` walks the import graph out of every module that constructs
an automation registry and fails if any path reaches this package.

## The operator's demo path

```sh
./rig.sh node --experimental-strip-types \
  packages/twin-runtime/scripts/rig-notify.ts <seat-id> invitation \
  --url https://…
```

With `DITO_SES_FROM` and `DITO_DASHBOARD_ORIGIN` both set it sends; without
either, it renders the very same message and prints it, with the lane's loud
skip and no record written. This script RENDERS
a message and takes the URL as an argument; the invitation token is
`rig-invite.ts`', which mints one and sends this same template itself
([#223](https://github.com/Dito-Core/dito/issues/223)).
