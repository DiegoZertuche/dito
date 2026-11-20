/**
 * THE SES TRANSPORT — the one place Dito holds email credentials (ticket
 * #219; ADR-0022, ADR-0019's flow 4, ADR-0028).
 *
 * ADR-0022 gives notify the SES credentials, and this module is what that
 * means: the SDK's own client, one command shape, and no other way out of
 * the process. ADR-0019 pins the destination at the network layer, so a
 * second provider would be a spine change rather than a dependency.
 *
 * REAL SES OR NOTHING (ADR-0028: no emulation). There is no fake, no
 * LocalStack and no in-memory SES here. The gated lane
 * (`ses.int.test.ts`) sends to a dev mailbox when `DITO_REQUIRE_SES=1` and
 * its two addresses are set, and LOUD-SKIPS when they are not — the KMS
 * lane's pattern exactly, for the same reason: a skipped test says it
 * proved nothing, and a mocked one says it proved something.
 *
 * THE COMMAND SHAPE IS PINNED BY A UNIT TEST rather than by a send
 * (`ses.test.ts`), because a send needs credentials nobody has yet and the
 * shape is what would be wrong: `sendEmailInput` is a pure function, the
 * transport wraps its result in the SDK's own `SendEmailCommand`, and the
 * test asserts both — so "the client is real" is a fact about the types and
 * the command class rather than a claim about a network call.
 *
 * PLAIN TEXT, NO HTML PART. The templates are plain text (`@dito/copy`), a
 * link is a link in either, and an HTML body would be a second rendering of
 * the same message for a rep to see differently depending on their client.
 */
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import type { SendEmailCommandInput, SendEmailCommandOutput } from "@aws-sdk/client-sesv2";
import { NotifyError } from "./catalog.js";
import type { EmailTransport, OutboundEmail } from "./notify.js";

/**
 * What this module needs of the SDK's client, structurally.
 *
 * NARROWED ON PURPOSE, and not so it can be faked away: `SESv2Client`
 * satisfies it, which is checked where the real client is constructed, and
 * naming only `send` is what stops this module reaching for any other
 * operation. Notify sends mail; it does not manage identities,
 * configuration sets or suppression lists, and a service that CAN is a
 * service somebody will.
 */
export interface SesClient {
  send(
    command: SendEmailCommand,
    options?: { readonly abortSignal?: AbortSignal },
  ): Promise<SendEmailCommandOutput>;
}

/**
 * HOW LONG ONE MESSAGE MAY TAKE TO LEAVE, in milliseconds.
 *
 * FIVE SECONDS, AND THE NUMBER IS ABOUT THE RUNTIME'S PASS RATHER THAN ABOUT
 * SES (ticket #276; Codex on PR #274, finding 2). The lease holder awaits
 * `announceRailTransition` before it consumes any work, so a call to a
 * provider that never answers stops drafting for as long as the socket stays
 * open — and the SDK's own default is no request timeout at all, with three
 * attempts behind it. A rep whose rail dropped loses their drafts too.
 *
 * SES ANSWERS IN WELL UNDER A SECOND when it answers, so five leaves room for
 * a slow region and a retry inside it, and still bounds the pass in seconds.
 * The push transport beside it carries the same number for the same reason
 * read from the other end (`PUSH_DEADLINE_MS`): what both bound is one tick of
 * one loop, and moving delivery off that loop is the horizon's fix (#117), not
 * this one's.
 *
 * WHAT IT COSTS is a message SES would have accepted on the sixth second: the
 * attempt is recorded `failed / transport_failed` and the next pass tries
 * again, because a channel that failed is retried until it is recorded sent or
 * refused (`notify.ts`).
 */
export const SES_DEADLINE_MS = 5_000;

/** Where the mail says it came from. One address, from the environment. */
export interface SesTransportOptions {
  readonly from: string;
}

/**
 * One message as SESv2 takes it — a pure function, so the shape is a thing
 * a test can hold.
 *
 * UTF-8 SAID EXPLICITLY on both parts. The copy is es-MX: «está», «código»,
 * «número». SESv2 defaults the charset per-part, and a subject that arrived
 * as `Tu c=C3=B3digo` mangled would be the first thing a rep saw of Dito.
 */
export function sendEmailInput(
  from: string,
  email: OutboundEmail,
): SendEmailCommandInput {
  return {
    FromEmailAddress: from,
    Destination: { ToAddresses: [email.to] },
    Content: {
      Simple: {
        Subject: { Data: email.subject, Charset: "UTF-8" },
        Body: { Text: { Data: email.body, Charset: "UTF-8" } },
      },
    },
  };
}

/** The transport, over the SDK's client. */
export function sesTransport(
  client: SesClient,
  options: SesTransportOptions,
): EmailTransport {
  return {
    async send(email: OutboundEmail) {
      const out = await withDeadline((signal) =>
        client.send(
          new SendEmailCommand(sendEmailInput(options.from, email)),
          { abortSignal: signal },
        ),
      );
      if (out.MessageId === undefined) {
        // SES accepted a message and named nothing. The send is not
        // undoable, so this is a settled row with no provider id rather
        // than a retry — and the caller has to hear about it, because the
        // one thing an operator would take to the provider is missing.
        throw new NotifyError(
          "SES accepted the message and returned no MessageId",
        );
      }
      return { providerMessageId: out.MessageId };
    },
  };
}

/**
 * The transport a process gets when it simply wants to send: the SDK's own
 * client, constructed HERE.
 *
 * ADR-0022 GIVES NOTIFY THE SES CREDENTIALS, and this function is what makes
 * that structural rather than a sentence. A caller that had to construct the
 * client would be a caller holding the SES SDK — and the first such caller
 * was the rig's operator script, which lives in the package that holds the
 * model and every automation registry. So the client stays inside the
 * package the ADR names, and `sesTransport` above keeps taking one for the
 * suites that need to see the command.
 *
 * THE SENDER IS STILL THE CALLER'S. It is deployment configuration — which
 * verified identity this environment sends as — and reading an environment
 * variable in here would put a second, invisible input on a function whose
 * whole job is one command shape.
 */
export function liveSesTransport(
  options: SesTransportOptions,
): EmailTransport {
  return sesTransport(new SESv2Client({}), options);
}

/**
 * One call to the provider, cut off if it has not answered inside the deadline.
 *
 * BOTH HALVES, AND EACH DOES WHAT THE OTHER CANNOT (ticket #276). The signal
 * is what CANCELS: the SDK aborts the request, the socket closes, and no
 * message leaves on a call nobody is waiting for any more — which matters,
 * because an email has no undo and a send that arrives after the record says
 * it failed is a message nothing remembers. The race is what BOUNDS: a client
 * that ignores a signal — the suite's own stub, and any implementation of the
 * narrow interface above — still yields a failure the caller can record rather
 * than a promise that never settles.
 *
 * THE TIMER IS ALWAYS CLEARED, which is not tidiness in a process that runs a
 * two-second poll for weeks: a pending timer per send is a handle per send,
 * and it would also keep a finished suite's process alive.
 *
 * IT CARRIES NOTHING OF THE MESSAGE. The sentence names the deadline and the
 * transport; the address and the subject are the caller's, and what the caller
 * writes down is a row (`notify.ts`'s own rule about the provider's text).
 */
async function withDeadline(
  call: (signal: AbortSignal) => Promise<SendEmailCommandOutput>,
): Promise<SendEmailCommandOutput> {
  const controller = new AbortController();
  let cut: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    cut = setTimeout(() => {
      controller.abort();
      reject(
        new NotifyError(
          `the mail transport did not answer inside ${String(SES_DEADLINE_MS)}ms and the call was cut off`,
        ),
      );
    }, SES_DEADLINE_MS);
  });
  try {
    return await Promise.race([call(controller.signal), deadline]);
  } finally {
    clearTimeout(cut);
  }
}
