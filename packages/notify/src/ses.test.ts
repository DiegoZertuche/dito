/**
 * THE SES CLIENT IS REAL, PROVEN BY CONSTRUCTION (ticket #219; ADR-0022,
 * ADR-0028).
 *
 * SES credentials do not exist yet, so nothing here sends. What CAN be
 * wrong without them is the shape: the wrong command class, a destination
 * the SDK ignores, a charset that turns «Tu código» into mojibake in the
 * one message a rep sees first. So this suite pins three things — that the
 * command input is exactly what SESv2 takes, that the transport wraps it in
 * the SDK's own `SendEmailCommand`, and that the SDK's own `SESv2Client`
 * satisfies the interface the transport asks for.
 *
 * THE THIRD IS THE ONE THAT MAKES THE OTHER TWO WORTH ANYTHING, and it is a
 * TYPE claim as much as a runtime one: a suite could pin any shape against
 * any stub. Constructing a real `SESv2Client` and handing it to
 * `sesTransport` is what says the stub stands where the real client stands.
 * A client with no credentials constructs happily — the SDK resolves them
 * when a command is sent, which is what the gated lane does and this file
 * never does.
 */
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import type { SendEmailCommandOutput } from "@aws-sdk/client-sesv2";
import { describe, expect, it } from "vitest";
import { NotifyError } from "./index.js";
import type { OutboundEmail } from "./notify.js";
// FROM INSIDE THE PACKAGE, deliberately: the transport is not on the public
// surface (see `index.ts`), and being able to send is what this suite tests.
import {
  SES_DEADLINE_MS,
  sendEmailInput,
  sesTransport,
  type SesClient,
} from "./ses.js";

const FROM = "dito@example.test";
const MESSAGE: OutboundEmail = {
  to: "rep@example.test",
  subject: "Tu código para entrar a Dito",
  body: "Tu código es 000000.",
};

/** A client that records the command and answers with an id. */
function recordingClient(
  answer: SendEmailCommandOutput = {
    MessageId: "0100-abc",
  } as SendEmailCommandOutput,
): SesClient & { readonly commands: SendEmailCommand[] } {
  const commands: SendEmailCommand[] = [];
  return {
    commands,
    send: (command) => {
      commands.push(command);
      return Promise.resolve(answer);
    },
  };
}

describe("the SESv2 send shape (ticket #219)", () => {
  it("is exactly what SESv2 takes, charset and all", () => {
    expect(sendEmailInput(FROM, MESSAGE)).toEqual({
      FromEmailAddress: "dito@example.test",
      Destination: { ToAddresses: ["rep@example.test"] },
      Content: {
        Simple: {
          Subject: {
            Data: "Tu código para entrar a Dito",
            Charset: "UTF-8",
          },
          Body: {
            Text: { Data: "Tu código es 000000.", Charset: "UTF-8" },
          },
        },
      },
    });
  });

  it("carries no HTML part, so one message renders one way", () => {
    const content = sendEmailInput(FROM, MESSAGE).Content!.Simple!;
    expect(Object.keys(content.Body!)).toEqual(["Text"]);
  });

  it("sends through the SDK's own SendEmailCommand and returns its id", async () => {
    const client = recordingClient();
    const sent = await sesTransport(client, { from: FROM }).send(MESSAGE);

    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(SendEmailCommand);
    expect(client.commands[0]!.input).toEqual(sendEmailInput(FROM, MESSAGE));
    expect(sent).toEqual({ providerMessageId: "0100-abc" });
  });

  it("refuses a response that names no message id", async () => {
    // A send that happened and cannot be traced. Not a retry — the message
    // is already gone — but the caller has to hear about it.
    const client = recordingClient({} as SendEmailCommandOutput);
    await expect(
      sesTransport(client, { from: FROM }).send(MESSAGE),
    ).rejects.toThrow(NotifyError);
  });

  it("gives up on a provider that never answers, inside the deadline (#276)", async () => {
    // A HUNG PROVIDER HOLDS THE RUNTIME'S PASS UNLESS SOMETHING CUTS IT.
    // `announceRailTransition` is awaited before the loop consumes work, so an
    // SES call with no timeout stops drafting for as long as the socket stays
    // open — and the SDK's own default is no request timeout at all, with
    // three attempts behind it (Codex on PR #274, finding 2).
    const client: SesClient = { send: () => new Promise(() => undefined) };
    const started = Date.now();
    await expect(
      sesTransport(client, { from: FROM }).send(MESSAGE),
    ).rejects.toThrow(NotifyError);
    // Bounded by the deadline and not by the suite's patience: what a caller
    // gets is a failure it can record, in seconds rather than never.
    expect(Date.now() - started).toBeLessThan(SES_DEADLINE_MS * 3);
  }, 30_000);

  it("takes the SDK's real SESv2Client where the stub stood", () => {
    // THE CLAIM THIS FILE EXISTS FOR. Constructing the client resolves no
    // credentials and opens no socket; assigning it is the type check that
    // says `sesTransport`'s parameter is the real client's shape and not a
    // convenient interface.
    const real: SesClient = new SESv2Client({ region: "us-east-1" });
    expect(sesTransport(real, { from: FROM })).toHaveProperty("send");
  });
});
