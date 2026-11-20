/**
 * The runtime's decoder for `wa_events.payload_enc` — now the seam's,
 * where the contract it decodes lives (ADR-0005). Moved to @dito/seam with
 * ticket #50, because the aperture must re-read and re-decode the raw
 * plane-delivered row a class-2 rep act cites (ADR-0003), and the pinned
 * v1 contract must have exactly one decoder rather than one per reader.
 *
 * Kept as this module so every existing import path stays put.
 */
export {
  decodeWaMessagePayload,
  decodeWaOpaquePayload,
  decodeWaReactionPayload,
  opaquePlaceholder,
  opaqueRowStandsFor,
  WaPayloadError,
  type OpaqueReason,
  type WaMessagePayload,
  type WaOpaquePayload,
  type WaReactionPayload,
} from "@dito/seam";
