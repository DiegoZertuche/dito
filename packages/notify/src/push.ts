/**
 * THE WEB PUSH TRANSPORT — the one place Dito speaks to a browser's push
 * service (ticket #262; spec #258 *Notification end to end*; ADR-0022 as
 * amended, ADR-0019's sixth egress flow, ADR-0028).
 *
 * ADR-0019's sixth flow is «browser push services, end to end encrypted», and
 * this module is what that means. Three standards, in the order a request
 * uses them:
 *
 *   RFC 8291 — the payload is encrypted TO THE SUBSCRIPTION, with a key
 *   agreement between an ephemeral P-256 pair and the browser's own public
 *   key, salted with the browser's auth secret. The push service carries
 *   bytes it cannot read, which is what makes the flow's content class
 *   («the twin's post parts to the rep's own devices») survive a third party
 *   on the wire.
 *
 *   RFC 8188 — those bytes are framed as `aes128gcm`: a header carrying the
 *   salt, the record size and the sender's public key, then one AEAD record.
 *
 *   RFC 8292 — the request identifies DITO to the push service, with a signed
 *   JWT under the deployment's VAPID key. It is not authentication of the
 *   rep and it is not a secret about them; it is how a push service knows who
 *   is sending and whom to throttle.
 *
 * NODE'S OWN `crypto` AND NOT A DEPENDENCY. Everything above is ECDH over
 * prime256v1, HKDF-SHA256, AES-128-GCM and an ES256 signature, and Node has
 * all four. A library would add a supply-chain edge on the one flow that
 * carries the twin's own sentences, to save about a hundred lines whose
 * correctness is proven from the other side by a receiver that decrypts what
 * this produced (`push.int.test.ts`).
 *
 * WHAT THIS MODULE DOES NOT DECIDE. It does not read the environment — the
 * VAPID pair arrives as a value, read at the runtime's own boundary — it
 * holds no database, it writes no record, and it never chooses a recipient:
 * it is handed one subscription and one payload and posts to the endpoint on
 * the row. Everything about WHICH message and FOR WHICH SEAT is `notify.ts`'s
 * (ADR-0022's closed catalog).
 *
 * A STATUS IS AN ANSWER AND NOT A FAILURE. A push service says `410 Gone` when
 * a browser has thrown its registration away, which is ordinary and frequent —
 * so the status comes back as a value the caller acts on, and only a request
 * that could not be made at all throws.
 *
 * AND A REQUEST THAT IS NEVER ANSWERED IS ONE OF THOSE (ticket #276). The
 * runtime awaits this transport inside its own poll, so a service that accepts
 * a connection and goes quiet would hold drafting behind it for as long as the
 * socket stays open. `PUSH_DEADLINE_MS` is the bound, `fetch` enforces it, and
 * what the caller gets is a throw it records as that browser's failed
 * attempt.
 */
import {
  createCipheriv,
  createECDH,
  createHash,
  createSign,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/** One browser's registration, as the transport needs it. */
export interface PushSubscription {
  /** The push service's own address for this browser. */
  readonly endpoint: string;
  /** Its P-256 public key, base64url, as the Push API hands it over. */
  readonly p256dh: string;
  /** Its authentication secret, base64url. */
  readonly auth: string;
}

/**
 * WHAT A BROWSER IS SHOWN — the whole of it, and it is three fields.
 *
 * THE SERVICE WORKER READS THIS AND NOTHING ELSE (`apps/rep-web/public/sw.js`).
 * `title` is the product's name, `body` is the twin's own sentence or the
 * code-written one, and `url` is where a tap lands — built by `notify.ts`
 * from the deployment's dashboard origin, never by a caller and never by a
 * template.
 */
export interface PushPayload {
  readonly title: string;
  readonly body: string;
  readonly url: string;
}

/**
 * The deployment's own push identity (RFC 8292).
 *
 * BY NAME AT THE BOUNDARY, BY VALUE HERE. `DITO_VAPID_PUBLIC_KEY`,
 * `DITO_VAPID_PRIVATE_KEY` and `DITO_VAPID_SUBJECT` are read where the
 * runtime reads every other deployment value, and this package holds no
 * opinion about an environment (README).
 *
 * THE SUBJECT IS A CONTACT, not a rep and not a customer: a `mailto:` or an
 * `https:` URL a push service's operator can use to reach whoever is sending.
 */
export interface VapidKeys {
  /** The uncompressed P-256 public point, base64url — 65 bytes. */
  readonly publicKey: string;
  /** Its private scalar, base64url — 32 bytes. */
  readonly privateKey: string;
  readonly subject: string;
}

/** What one request to a push service came back with. */
export interface PushResult {
  readonly status: number;
}

/**
 * The second boundary this service has: something that puts an encrypted
 * payload in front of one browser.
 *
 * AN INTERFACE SO THE PUSH IDENTITY IS A VALUE, not so it can be faked away —
 * `EmailTransport`'s own argument, one transport along. The real one is
 * `livePushTransport`; the suite that drives the seam holds one that records,
 * and the real path is proven against a local receiver that decrypts what
 * arrived with the test subscription's own keys (ADR-0028: never emulated,
 * and a push service is never touched in CI).
 */
export interface PushTransport {
  send(
    subscription: PushSubscription,
    payload: PushPayload,
  ): Promise<PushResult>;
}

/**
 * HOW LONG THE PUSH SERVICE MAY HOLD A MESSAGE, in seconds.
 *
 * FOUR HOURS, AND IT IS A PRODUCT DECISION. A knock says a draft is waiting;
 * a phone that comes back online tomorrow and shows yesterday's tap on the
 * shoulder is worse than one that shows nothing, because the rep has already
 * seen the card. Long enough for a commute and a meeting, short enough that
 * nothing stale arrives.
 */
const TTL_SECONDS = 4 * 60 * 60;

/**
 * HOW LONG A VAPID ASSERTION IS GOOD FOR, in seconds.
 *
 * TWELVE HOURS, WHICH IS THE STANDARD'S CEILING (RFC 8292 §2: `exp` must not
 * be more than 24 hours out, and every major service rejects longer). A fresh
 * one is signed per request — signing is microseconds — so nothing here caches
 * a credential whose expiry it would then have to reason about.
 */
const ASSERTION_SECONDS = 12 * 60 * 60;

/** The record size `aes128gcm` declares, for a payload that fits one record. */
const RECORD_SIZE = 4096;

/** The longest payload this transport will frame into that one record. */
const PAYLOAD_MAX = 3000;

/**
 * HOW LONG ONE REQUEST TO A PUSH SERVICE MAY TAKE, in milliseconds.
 *
 * FIVE SECONDS, AND THE NUMBER IS ABOUT THE RUNTIME'S PASS (ticket #276; Codex
 * on PR #274, finding 2). The at-once tier and the near-expiry tier are both
 * awaited inside the lease holder's poll, once per registration the seat has,
 * so a service that accepts a connection and never answers holds drafting
 * behind it for as long as the socket stays open — and Node's `fetch` has no
 * timeout of its own.
 *
 * A KNOCK THAT TAKES LONGER THAN THIS IS LATE ANYWAY. A push service answers
 * in a fraction of a second when it answers at all, and the thing being
 * delivered is «something is waiting on you» — so five seconds is generous to
 * the provider and still bounds the tick in seconds. `SES_DEADLINE_MS` carries
 * the same number for the same reason on the other transport: what both bound
 * is one tick of one loop, and moving delivery off that loop is the horizon's
 * fix (#117) rather than this ticket's.
 *
 * WHAT IT COSTS is a notification a slow service would have accepted: the
 * attempt is recorded `failed / transport_failed`, the pass goes on, and the
 * next pass tries that browser again (`notify.ts`).
 */
const PUSH_DEADLINE_MS = 5_000;

/** The transport, over Node's own `fetch`. */
export function livePushTransport(vapid: VapidKeys): PushTransport {
  return {
    async send(
      subscription: PushSubscription,
      payload: PushPayload,
    ): Promise<PushResult> {
      const body = encryptPushPayload(subscription, JSON.stringify(payload));
      const response = await fetch(subscription.endpoint, {
        method: "POST",
        headers: {
          Authorization: vapidAuthorization(subscription.endpoint, vapid),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: String(TTL_SECONDS),
          // URGENCY IS THE ONE HINT THAT CHANGES DELIVERY (RFC 8030 §5.3): a
          // service may hold a `low` message until a device wakes on its own.
          // A knock is the rep being told something waits on them, which is
          // the case `normal` describes.
          Urgency: "normal",
        },
        // COPIED INTO A PLAIN VIEW because `fetch`'s `BodyInit` is typed
        // against the DOM's `ArrayBuffer` and Node's `Buffer` carries an
        // `ArrayBufferLike` — a difference the app that renders this package's
        // types sees and this one does not. Copying a payload capped at three
        // kilobytes is free; a cast would hide the real disagreement.
        body: new Uint8Array(body),
        // THE DEADLINE, AND `fetch` ENFORCES IT ITSELF (ticket #276): the
        // request is aborted, the socket closes and what is thrown is an
        // error the caller records as this browser's own failed attempt. No
        // race is needed here, unlike the SES transport, because the one
        // boundary is Node's and it honours a signal.
        signal: AbortSignal.timeout(PUSH_DEADLINE_MS),
        // A PUSH SERVICE NEVER REDIRECTS (RFC 8030 has no redirect in it), so
        // one that answers with a redirect is an endpoint that is not a push
        // service — and following it would let whoever wrote the row send
        // this process's POST wherever the redirect points, loopback
        // included. It throws, and the attempt is recorded as failed
        // (ticket #269, Codex r1).
        redirect: "error",
      });
      return { status: response.status };
    },
  };
}

/**
 * ONE PAYLOAD, ENCRYPTED TO ONE SUBSCRIPTION (RFC 8291 §3, framed per RFC
 * 8188 §2).
 *
 * THE EPHEMERAL PAIR IS PER MESSAGE, which is the whole of what makes this
 * forward-secret: the shared secret is derived from a key this process throws
 * away, so a later compromise of anything Dito holds decrypts nothing already
 * sent. The browser's own key is long-lived and is the row's.
 *
 * THE SALT IS RANDOM PER MESSAGE for the reason every AEAD needs one: the key
 * and the nonce are derived from it, and two messages under one key and one
 * nonce hand an attacker the XOR of the two plaintexts.
 *
 * EXPORTED FOR THE SUITE THAT READS IT BACK. `push.int.test.ts` runs a local
 * receiver holding the test subscription's PRIVATE key and decrypts what this
 * produced by the RFC rather than by calling anything here, which is what
 * makes the proof a proof rather than a tautology.
 */
export function encryptPushPayload(
  subscription: PushSubscription,
  plaintext: string,
): Buffer {
  const body = Buffer.from(plaintext, "utf8");
  if (body.length > PAYLOAD_MAX) {
    throw new Error(
      `a push payload of ${String(body.length)} bytes is past the one record this transport frames — a notification is a title, a sentence and a link (ticket #262)`,
    );
  }
  const clientPublic = fromBase64Url(subscription.p256dh);
  const authSecret = fromBase64Url(subscription.auth);
  const ephemeral = createECDH("prime256v1");
  ephemeral.generateKeys();
  const serverPublic = ephemeral.getPublicKey();
  const shared = ephemeral.computeSecret(clientPublic);
  const salt = randomBytes(16);

  // THE «WebPush: info» STEP (RFC 8291 §3.3): the shared secret is stretched
  // with the auth secret as the salt and a context naming BOTH public keys, so
  // a key agreement that was replayed against a different browser derives a
  // different secret.
  const prk = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      authSecret,
      Buffer.concat([
        Buffer.from("WebPush: info\0", "utf8"),
        clientPublic,
        serverPublic,
      ]),
      32,
    ),
  );
  const contentKey = Buffer.from(
    hkdfSync("sha256", prk, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", prk, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12),
  );

  // ONE RECORD, SO THE PADDING DELIMITER IS `0x02` (RFC 8188 §2): the last
  // record of a body says so in its own plaintext, and a receiver that read a
  // `0x01` here would wait for a record that never arrives.
  const cipher = createCipheriv("aes-128-gcm", contentKey, nonce);
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([body, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(serverPublic.length, 20);
  return Buffer.concat([header, serverPublic, sealed]);
}

/**
 * THE `Authorization` HEADER ONE REQUEST CARRIES (RFC 8292 §3.1, the `vapid`
 * scheme).
 *
 * THE AUDIENCE IS THE ENDPOINT'S ORIGIN AND NOT THE ENDPOINT, which is the
 * standard's own rule and a real fence: an assertion stolen off one request
 * is good for that push service and says nothing about which browser it was
 * for, and one minted for a different service is refused by the service that
 * receives it.
 */
export function vapidAuthorization(endpoint: string, vapid: VapidKeys): string {
  const audience = new URL(endpoint).origin;
  const header = toBase64Url(
    Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" }), "utf8"),
  );
  const claims = toBase64Url(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + ASSERTION_SECONDS,
        sub: vapid.subject,
      }),
      "utf8",
    ),
  );
  const signing = `${header}.${claims}`;
  const signer = createSign("SHA256");
  signer.update(signing);
  // `ieee-p1363` IS THE FORM JOSE ASKS FOR: an ES256 signature is r‖s, 64
  // bytes flat, and Node's default is DER — which every push service rejects
  // with a 401 that names nothing.
  const signature = signer.sign(
    {
      key: pkcs8From(fromBase64Url(vapid.privateKey), fromBase64Url(vapid.publicKey)),
      format: "der",
      type: "pkcs8",
      dsaEncoding: "ieee-p1363",
    },
    "base64url",
  );
  return `vapid t=${signing}.${signature}, k=${vapid.publicKey}`;
}

/**
 * The VAPID pair as a PKCS#8 key Node will sign with.
 *
 * ASSEMBLED BY HAND BECAUSE THE PAIR IS TWO BASE64URL STRINGS. That is the
 * shape every push tutorial, every browser API and every operator's clipboard
 * uses, so taking a PEM here would make the one operator step — generate a
 * pair, put it in the environment — a conversion nobody would get right.
 * `@dito/crypto` is not in this package's graph and must not be: notify is
 * class 4 of ADR-0013 and the smaller its graph the fewer ways there are to
 * reach it.
 *
 * THE PREFIX IS THE FIXED DER FOR «PrivateKeyInfo, ecPrivateKey,
 * prime256v1, 32-byte scalar, with the public point attached» — every byte of
 * it is structure, and the only two variables are the scalar and the point,
 * which is why it can be a constant at all.
 */
function pkcs8From(privateScalar: Buffer, publicPoint: Buffer): Buffer {
  if (privateScalar.length !== 32 || publicPoint.length !== 65) {
    throw new Error(
      "the VAPID pair is not a P-256 pair — the private key is 32 bytes and the public key is a 65-byte uncompressed point, both base64url (ticket #262)",
    );
  }
  const prefix = Buffer.from(
    "308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420",
    "hex",
  );
  const publicPrefix = Buffer.from("a144034200", "hex");
  return Buffer.concat([prefix, privateScalar, publicPrefix, publicPoint]);
}

/**
 * A P-256 pair in the two base64url strings the environment holds.
 *
 * HERE RATHER THAN IN A SCRIPT because the suites need one per run and never
 * a committed key, and because an operator provisioning a deployment should
 * be running the same code that will use it — a pair generated one way and
 * consumed another is exactly where a wrong curve or a compressed point hides
 * until the first 401.
 */
export function generateVapidKeys(subject: string): VapidKeys {
  const pair = createECDH("prime256v1");
  pair.generateKeys();
  return {
    publicKey: toBase64Url(pair.getPublicKey()),
    privateKey: toBase64Url(leftPad(pair.getPrivateKey(), 32)),
    subject,
  };
}

/**
 * A scalar at its full width, with the leading zeros the encoding needs.
 *
 * NODE STRIPS THEM AND THE STANDARD DOES NOT (the two-axis review's Spec
 * axis). `ECDH.getPrivateKey()` hands back a big-endian integer with leading
 * zero bytes removed, so roughly one P-256 key in 256 is shorter than 32
 * bytes — and the DER `pkcs8From` assembles declares a fixed 32-byte OCTET
 * STRING, so such a pair would be refused at the first send. One key in 256 is
 * a defect that ships and then fails a deployment nobody can reproduce.
 */
function leftPad(value: Buffer, width: number): Buffer {
  if (value.length >= width) return value;
  return Buffer.concat([Buffer.alloc(width - value.length), value]);
}

/**
 * The VAPID public key's own fingerprint, for a log line.
 *
 * A DIGEST AND NOT THE KEY. The public half is not a secret — a browser is
 * handed it to subscribe — but an operator checking that two processes agree
 * about the deployment's identity wants a short thing to compare, and a log
 * line carrying the key itself invites the private half into the next one.
 */
export function vapidFingerprint(publicKey: string): string {
  return createHash("sha256").update(publicKey, "utf8").digest("hex").slice(0, 12);
}

function toBase64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
