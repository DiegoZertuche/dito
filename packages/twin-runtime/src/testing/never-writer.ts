/**
 * A send-lock writer that must never be reached — the writer-side mirror
 * of the scripted model client's empty turn list: tests that script no
 * mint fail loudly on any unexpected mint attempt instead of silently
 * writing a tap (ADR-0006).
 */
import type { SendLockWriter } from "../send-lock/writer.js";

export function neverSendLock(): SendLockWriter {
  return {
    requestCustomerSend: () => {
      throw new Error(
        "requestCustomerSend was called, but this test scripts no mint — a tap almost got written where none was expected",
      );
    },
  };
}
