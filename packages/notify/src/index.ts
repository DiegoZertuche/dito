/**
 * @dito/notify — the rep-side service that owns the email rail (ticket #219;
 * spec #214 *Notify, in detail*; ADR-0022, ADR-0019's flow 4, ADR-0013
 * class 4).
 *
 * A closed catalog of named message types, each bound to a template in
 * `@dito/copy` with typed slots and no free-text parameter; recipients
 * resolved from seat state, so a caller passes a seat id and never an
 * address; every send recorded content-free in `notify_sends`.
 *
 * 6a SENDS TWO MESSAGES: the invitation that starts link day, and the
 * six-digit code that logs a rep in on a second device. The tiering that
 * adds more is decided and not built (spec #214 decision 10).
 *
 * IT IS NEVER ON A TOOL SURFACE. Class 4 of ADR-0013, held mechanically by
 * `packages/execution/src/dependency-wall.test.ts`: no module that
 * constructs an automation registry can reach this package, directly or
 * transitively.
 *
 * NOTHING THAT CAN SEND IS ON THIS SURFACE (Codex r1). The only door into
 * SES from outside is `createLiveNotify`, which takes a connection and a
 * sender and hands back a service whose one verb takes a seat id and a
 * message type. Two things are internal for the same reason and it is worth
 * naming both:
 *
 *   `sesTransport` — its `send({ to, subject, body })` is a caller naming an
 *   arbitrary address and arbitrary text with every guard here bypassed.
 *
 *   `createNotify` — it takes a TRANSPORT, so a caller could hand it one of
 *   its own and see the address notify resolved. Every other guard would
 *   still hold, which is why this is a narrowing rather than a fix, and it
 *   costs nothing: the suites that inject a transport live inside this
 *   package, where being able to send is the thing under test.
 *
 * `renderNotification` STAYS, and it cannot send: it returns a subject and a
 * body. The operator script needs it to print the message it would have
 * sent when the rail is unconfigured, and a caller who fabricates the name
 * is still bounded by the `name` slot's own rules (no address, no phone
 * number, one short line).
 *
 * THE PUSH TRANSPORT IS INTERNAL FOR THE SAME REASON `sesTransport` IS
 * (ticket #262): its `send(subscription, payload)` is a caller naming a device
 * and arbitrary text with every guard here bypassed. What IS on the surface is
 * the VAPID pair's own two helpers — generating one and fingerprinting the
 * public half — because provisioning a deployment and checking two processes
 * agree about its identity are operator jobs, and neither can send anything.
 */

export {
  callerSlots,
  defineCatalog,
  NOTIFY_CATALOG,
  NOTIFY_MESSAGE_TYPES,
  NotifyError,
  SEAT_SLOT_SOURCES,
  type CatalogEntry,
  type NotifyCatalog,
  type NotifyMessageType,
  type PushDelivery,
  type SeatSlotSource,
} from "./catalog.js";
export {
  createLiveNotify,
  renderNotification,
  type Notify,
  type NotifyRequest,
  type NotifySeat,
  type NotifySendRecord,
} from "./notify.js";
export {
  generateVapidKeys,
  vapidFingerprint,
  type VapidKeys,
} from "./push.js";
export {
  NOTIFY_CHANNELS,
  NOTIFY_OUTCOMES,
  NOTIFY_REFUSAL_REASONS,
  type NotifyChannel,
} from "./record.js";
