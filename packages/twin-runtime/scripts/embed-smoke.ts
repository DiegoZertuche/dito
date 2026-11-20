/**
 * ONE manual live smoke of the real embedding path (ticket #32): the
 * same ingest → embed → store → retrieve pipeline the runtime runs, with
 * the REAL BGE-M3 model in-process and a REAL SQLCipher bundle — the
 * embedding analog of the drafting live smoke (#23). Rig-shaped seed
 * data only; the model downloads on first run and caches locally. Never
 * wired into CI — run by hand:
 *   pnpm --filter @dito/twin-runtime smoke:embed
 * (build first: `pnpm build`)
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundle } from "@dito/bundle";
import { createDekFromMaterial } from "@dito/crypto";
import {
  BGE_M3_MODEL,
  createBgeM3Embedder,
  embedMessageBacklog,
  retrieveRelevantMessages,
} from "../dist/index.js";

if (process.env["CI"] !== undefined) {
  console.error("embed smoke must never run in CI — refusing");
  process.exit(1);
}

const model = process.env["DITO_EMBEDDING_MODEL"] ?? BGE_M3_MODEL;
const cacheDir = process.env["DITO_MODEL_CACHE_DIR"];
const GARZA = "5215550001@s.whatsapp.net";
const LOPEZ = "5215550002@s.whatsapp.net";

const seed = [
  { chatJid: GARZA, id: "SMK-1", fromMe: false, text: "buenas, soy la sra garza, ¿tiene chile en polvo?" },
  { chatJid: GARZA, id: "SMK-2", fromMe: true, text: "claro que sí, ¿cuántas cajas le mando?" },
  { chatJid: GARZA, id: "SMK-3", fromMe: false, text: "necesito 40 cajas para el jueves, ¿me las aparta?" },
  { chatJid: LOPEZ, id: "SMK-4", fromMe: false, text: "don pepe, ¿me manda la lista de precios de mayoreo?" },
  { chatJid: LOPEZ, id: "SMK-5", fromMe: true, text: "se la mando en la tarde sin falta" },
];

// A real SQLCipher bundle under a real locally-minted DEK — the same
// crypto path the runtime uses (never mocked, ADR-0028); vectors will
// exist nowhere but inside this encrypted file.
const tmp = mkdtempSync(join(tmpdir(), "dito-embed-smoke-"));
const bundle = createBundle(
  join(tmp, "smoke.bundle"),
  createDekFromMaterial(randomBytes(32)),
);
try {
  for (const [i, m] of seed.entries()) {
    bundle.ingestMessage({
      chatJid: m.chatJid,
      messageId: m.id,
      senderJid: m.chatJid,
      fromMe: m.fromMe,
      occurredAt: `2026-08-27T10:0${i}:00.000Z`,
      content: m.text,
    });
  }

  console.log(`loading ${model} (dtype q8; first run downloads + caches)…`);
  const loadStart = Date.now();
  const embedder = await createBgeM3Embedder({
    model,
    ...(cacheDir === undefined ? {} : { cacheDir }),
  });
  console.log(`model ready in ${Date.now() - loadStart}ms`);

  const embedStart = Date.now();
  const { embedded } = await embedMessageBacklog({ bundle, embedder });
  console.log(
    `embedded ${embedded} messages in ${Date.now() - embedStart}ms; bundle holds ${bundle.countMessageVectors()} vectors`,
  );

  for (const query of [
    { label: "global", text: "¿qué me pidió la sra garza?" },
    { label: `scoped to ${GARZA}`, text: "¿qué me pidió?", chatJid: GARZA },
  ]) {
    const queryStart = Date.now();
    const hits = await retrieveRelevantMessages({
      bundle,
      embedder,
      query: query.text,
      ...(query.chatJid === undefined ? {} : { chatJid: query.chatJid }),
      limit: 3,
    });
    console.log(
      `\n«${query.text}» (${query.label}, ${Date.now() - queryStart}ms):`,
    );
    for (const hit of hits) {
      console.log(
        `  ${hit.distance.toFixed(4)}  [${hit.message.messageId}] ${hit.message.content}`,
      );
    }
  }
} finally {
  bundle.close();
  rmSync(tmp, { recursive: true, force: true });
}
