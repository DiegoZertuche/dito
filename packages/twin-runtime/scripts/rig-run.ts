/**
 * Rig runtime runner for #26: openTwinMemory → runTwinRuntime with a
 * harness holding the real model key (#328) and the send-lock writer (#24: hmacKeyFromEnv —
 * DITO_AUDIT_HMAC_KEY). The plane runs separately (go run ./plane/cmd/plane)
 * and independently enforces "self" from live session identity, so a
 * misconfigured DITO_SELF_CHAT_JID can never misroute (ADR-0006).
 *
 * Usage: source .env.rig, then
 *   node --experimental-strip-types scripts/rig-run.ts <rigNumber> [--trace=shape|full]
 * (build first: pnpm build)
 *
 * IT ALSO SERVES THE LOCAL API when `DITO_TWIN_API_PORT` and
 * `DITO_TWIN_API_BEARER` are both set: an HTTP server on loopback that rep-web
 * reads the rail's state and the feed through, because the lease holder is the
 * only process that may unseal (ADR-0010; #221). With neither set it runs the
 * loop and nothing else.
 *
 * AND IT IS WHERE NOTIFY IS CONSTRUCTED (ticket #262). The runtime package
 * assembles every rep-side automation registry, so it may hold no runtime
 * dependency on the rails at all (`dependency-wall.test.ts`) — it declares the
 * shape it needs and this composition root hands it the service, the way the
 * harness and the send-lock writer already arrive. The push identity and
 * the dashboard's origin are read HERE, by name, and never inside a package.
 */
import { KMSClient } from "@aws-sdk/client-kms";
import pg from "pg";
import { hmacKeyFromEnv } from "@dito/audit";
import { triggerRef } from "@dito/execution";
import { createLiveNotify, vapidFingerprint } from "@dito/notify";
import {
  BGE_M3_MODEL,
  createBgeM3Embedder,
  createSeatEvents,
  createRunEngine,
  createThreadSessions,
  createSendLockWriter,
  DEFAULT_REP_LANGUAGE,
  openTwinMemory,
  BATCH_LANE_CAP,
  REALTIME_LANE_CAP,
  renderFull,
  renderShape,
  runTwinRuntime,
  startLocalApi,
  entityKindModelConfig,
  extractionModelConfig,
  harnessDirectoryBeside,
  type RuntimeTrace,
} from "../dist/index.js";
import { disclosureHourFromEnv, repTimeZone } from "./rig-env.ts";

const disclosureHour = disclosureHourFromEnv();

const twinId = process.env["DITO_TWIN_ID"];
const dbUrl = process.env["DITO_DATABASE_URL"];
const args = process.argv.slice(2);
const rigNumber = args.find((arg) => !arg.startsWith("--"));
if (twinId === undefined || dbUrl === undefined || rigNumber === undefined) {
  console.error(
    "usage: source .env.rig && node --experimental-strip-types scripts/rig-run.ts <rigNumber> [--trace=shape|full]",
  );
  process.exit(1);
}
// THE PER-CALL TRACE (#177 hotfix 1; `trace-render.ts` argues both views).
//
// ON BY DEFAULT, AND CONTENT-FREE BY DEFAULT. What the slice-5a boundary
// needed and did not have was the SEQUENCE of a failed turn — «drafted, then
// talked, then never submitted» — and `shape` is exactly that and nothing
// else. `--trace=full` adds what the model wrote, what a tool was sent and
// what it answered: a debug view of one turn on one laptop, never a steering
// surface and never the default.
const TRACE_FLAG = "--trace=";
const view = args.find((arg) => arg.startsWith(TRACE_FLAG))?.slice(TRACE_FLAG.length) ?? "shape";
if (view !== "shape" && view !== "full") {
  console.error(`${TRACE_FLAG} takes shape or full, got: ${view}`);
  process.exit(1);
}
const renderTrace = view === "full" ? renderFull : renderShape;
// STDERR, so a trace never lands in whatever reads this process's stdout, and
// prefixed with the execution's own audit ref — the same string the chain
// entry carries, which is what tells two interleaved executions apart and what
// joins a terminal line to the durable record.
const trace: RuntimeTrace = (trigger, event) => {
  const line = renderTrace(event);
  if (line !== undefined) console.error(`[${triggerRef(trigger)}] ${line}`);
};
const apiKey = process.env["ANTHROPIC_API_KEY"];
if (apiKey === undefined) {
  console.error("rig run needs ANTHROPIC_API_KEY (append it to .env.rig) — refusing");
  process.exit(1);
}
if (!/^\d{10,15}$/.test(rigNumber)) {
  console.error(`rig number must be international digits only, got: ${rigNumber}`);
  process.exit(1);
}
const selfChatJid = `${rigNumber}@s.whatsapp.net`;
const bundlePath = new URL(`../../../rig-data/twin-${twinId}.bundle`, import.meta.url).pathname;
const model = process.env["DITO_DRAFTING_MODEL"] ?? "claude-sonnet-5";
// THE REP'S LANGUAGE AND REGISTER, AS A DEPLOYMENT SETTING (ticket #172;
// spec #171 decision 15, user story 17). The drafting prompt used to carry
// «this rig's traffic is Mexican Spanish» as a constant, so a rep in another
// register was fighting the code. It is now data the twin is TOLD, and this
// is where a deployment says it — beside the rung, read once, for the same
// reason `repTimeZone` is read once. The rep notepad replaces it in slice 6
// with a line the rep wrote themselves (ADR-0033); until then the default is
// this rig's own traffic and this variable is how it moves.
const repLanguage = process.env["DITO_REP_LANGUAGE"] ?? DEFAULT_REP_LANGUAGE;
// THE LOCAL API'S TWO SETTINGS (ticket #221; ADR-0010). The port and the
// bearer rep-web presents — read here, beside every other thing this process
// was told to be, and refused rather than defaulted: an API with no secret
// authenticates every caller on the loopback interface, and a default port
// would be a service a second rig silently fought over.
//
// OPTIONAL AS A PAIR. A steering session that wants the loop and no dashboard
// sets neither and gets no server; setting one without the other is a
// misconfiguration and is refused here rather than at the dashboard's first
// read (#221).
const apiPort = process.env["DITO_TWIN_API_PORT"];
const apiBearer = process.env["DITO_TWIN_API_BEARER"];
if ((apiPort === undefined) !== (apiBearer === undefined)) {
  console.error(
    "the runtime's local API needs DITO_TWIN_API_PORT and DITO_TWIN_API_BEARER together (append both to .env.rig), or neither — refusing",
  );
  process.exit(1);
}
const apiPortNumber = apiPort === undefined ? undefined : Number(apiPort);
if (
  apiPortNumber !== undefined &&
  (!Number.isInteger(apiPortNumber) || apiPortNumber < 1 || apiPortNumber > 65535)
) {
  console.error(`DITO_TWIN_API_PORT must be a port, got: ${apiPort ?? ""}`);
  process.exit(1);
}
// ADR-0015's ladder, at the one rung this slice actually routes: extraction
// is the batch call site (ticket #52). It ran on Haiku until #148, which
// moved it to Sonnet 5 — the weekday dates three live sessions filed wrong
// were Haiku 4.5's own arithmetic on a correct calendar, and the ladder's
// routine/high-stakes axis had asked about volume rather than difficulty.
// Every other rung is still deferred. Both knobs come from one resolver,
// so the rig can be put on the arm the corpus picked.
const extractionConfig = extractionModelConfig({
  model: process.env["DITO_EXTRACTION_MODEL"],
  effort: process.env["DITO_EXTRACTION_EFFORT"],
});
const extractionModel = extractionConfig.model;
// Its own rung and its own variable (#154) — resolved here, beside the
// other two, so the banner below can say which model each one took.
const kindConfig = entityKindModelConfig({
  model: process.env["DITO_ENTITY_KIND_MODEL"],
});

// WHAT THE TWIN NEEDS TO REACH A REP WHO IS NOT LOOKING (ticket #262; spec
// #258 *Notification end to end*).
//
// FOUR NAMES, READ TOGETHER OR NOT AT ALL. Without the dashboard's origin
// there is nowhere for a notification to land, and without the VAPID pair
// there is no identity to encrypt under — so a deployment that has some of
// them is a misconfiguration, and one that has none simply announces nothing
// and every card still reaches the dashboard. `DITO_SES_FROM` is the same
// value rep-web sends its login codes as.
const dashboardOrigin = process.env["DITO_DASHBOARD_ORIGIN"];
const sesFrom = process.env["DITO_SES_FROM"];
const vapidPublicKey = process.env["DITO_VAPID_PUBLIC_KEY"];
const vapidPrivateKey = process.env["DITO_VAPID_PRIVATE_KEY"];
const vapidSubject = process.env["DITO_VAPID_SUBJECT"];
const notifications =
  dashboardOrigin !== undefined &&
  sesFrom !== undefined &&
  vapidPublicKey !== undefined &&
  vapidPrivateKey !== undefined &&
  vapidSubject !== undefined
    ? {
        dashboardOrigin,
        sesFrom,
        vapid: {
          publicKey: vapidPublicKey,
          privateKey: vapidPrivateKey,
          subject: vapidSubject,
        },
      }
    : undefined;
if (
  notifications === undefined &&
  [dashboardOrigin, sesFrom, vapidPublicKey, vapidPrivateKey, vapidSubject].some(
    (name) => name !== undefined,
  )
) {
  console.error(
    "notifications need DITO_DASHBOARD_ORIGIN, DITO_SES_FROM, DITO_VAPID_PUBLIC_KEY, DITO_VAPID_PRIVATE_KEY and DITO_VAPID_SUBJECT together (append them to .env.rig), or none — refusing",
  );
  process.exit(1);
}

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
const pool = new pg.Pool({ connectionString: dbUrl });
// THE EXECUTIONS' OWN CONNECTIONS (ticket #173; spec #171 decision 3).
//
// A SECOND POOL RATHER THAN THE SEND LOCK'S, and the reason is what each one
// holds a connection FOR. An execution holds its transaction open across a
// model call — up to NFR-2's minute — so four of them can hold four
// connections for a minute at a time; the send-lock writer's transaction is
// three statements and it is on the path of a REP ACT, the tap, which must
// never wait behind a model call. Sharing one pool would put them in the same
// queue for no benefit.
//
// SIZED FROM BOTH LANES' CAPS, so the pool and the concurrency the lanes
// declare cannot disagree. The batch lane's one is included because the
// daily extraction runs its own transaction on its own connection like every
// other execution (#194), drawing on this same pool.
const executionPool = new pg.Pool({
  connectionString: dbUrl,
  max: REALTIME_LANE_CAP + BATCH_LANE_CAP,
});
const { bundle, dek } = await openTwinMemory({
  kms: new KMSClient({}),
  db,
  twinId,
  bundlePath,
});
// THE KIND RUNG IS NAMED HERE TOO (ticket #154). It has an override again,
// and a knob whose setting the operator cannot see is one they cannot check
// — the other two rungs have said which model they took since #148.
console.log(
  `twin memory open (schema v${bundle.schemaVersion}); drafting on ${model} for a rep who writes ${repLanguage}, extraction on ${extractionModel} at effort ${extractionConfig.effort ?? "(the model's own default)"}, entity kind on ${kindConfig.model}`,
);

// The real embedder (#32): BGE-M3 in-process — the rig's composition
// choice at this edge, where tests compose the deterministic fake. First
// run downloads and caches the weights; the runtime's backlog pass then
// embeds any un-embedded history in the migrated bundle.
const embeddingModel = process.env["DITO_EMBEDDING_MODEL"] ?? BGE_M3_MODEL;
const modelCacheDir = process.env["DITO_MODEL_CACHE_DIR"];
console.log(`loading embedder ${embeddingModel}…`);
const embedder = await createBgeM3Embedder({
  model: embeddingModel,
  ...(modelCacheDir === undefined ? {} : { cacheDir: modelCacheDir }),
});
console.log(`runtime up — self-chat ${selfChatJid}; Ctrl-C to stop`);

// THE LOCAL API, ON ITS OWN POOL AND NOT THE SEND LOCK'S (ticket #221).
// A feed read unseals every part of a page inside one request, and the send
// lock's transaction is three statements on the path of a REP ACT — the tap —
// which must never wait behind a page. Small, because one dashboard on one
// laptop makes at most a handful of concurrent reads.
const apiPool =
  apiPortNumber === undefined
    ? undefined
    : new pg.Pool({ connectionString: dbUrl, max: 4 });
// ONE chain key for the whole REP-SIDE process (#54). The send-lock writer
// chains its refusals under it and the aperture chains the crossing and its
// corrections under it, so a rig run writes one chain that
// `scripts/audit-verify.mjs` can verify end to end. Custody is fail-closed:
// there is no fallback key, and a missing DITO_AUDIT_HMAC_KEY stops the rig
// here rather than at the first refusal (ADR-0020).
//
// THE OWNER SIDE'S KEY IS NOT READ HERE, and never should be (#165; the
// decision on #157). The owner web is a separate process with its own
// launcher, its own chain — `owner.audit_chain`, one per company — and its
// own `DITO_OWNER_AUDIT_HMAC_KEY`. This process holds no key that
// authenticates anything the owner wrote, exactly as the owner holds none
// for this one.
const hmacKey = hmacKeyFromEnv();

// NOTIFY ON ITS OWN POOL, for rep-web's own reason one app over: a send holds
// a client across a call to somebody else's service, and the AWS SDK's default
// handler sets no timeout — so a mail rail that accepts a socket and never
// answers must not be able to starve the loop's own connections. Small,
// because a twin announces at most a handful of things a minute.
const notifyPool =
  notifications === undefined
    ? undefined
    : new pg.Pool({ connectionString: dbUrl, max: 2 });
const notify =
  notifications === undefined || notifyPool === undefined
    ? undefined
    : createLiveNotify({
        db: notifyPool,
        from: notifications.sesFrom,
        dashboardOrigin: notifications.dashboardOrigin,
        now: () => new Date(),
        vapid: notifications.vapid,
      });
if (notifications !== undefined) {
  // THE FINGERPRINT AND NEVER THE KEY. An operator checking that the runtime
  // and the dashboard agree about this deployment's push identity wants a
  // short thing to compare, and a line carrying the key itself invites the
  // private half into the next one.
  console.log(
    `notifications on — ${notifications.dashboardOrigin}, push identity ${vapidFingerprint(notifications.vapid.publicKey)}`,
  );
}

// ONE BUS FOR THE WHOLE PROCESS (ticket #263): the loop publishes a door
// turn's reply to it and the local API's stream reads it — the same object in
// both, which is what one lease holder per twin makes enough (ADR-0010). No
// API, no stream, and nothing to publish to.
const events =
  apiPool === undefined || apiPortNumber === undefined
    ? undefined
    : createSeatEvents();

// THE TWIN THREAD'S DAYS, ONE REGISTRY FOR THE WHOLE PROCESS (ticket #319):
// the loop pushes the day's turns into it and the local API raises the rep's
// acts, seen-stamps and arrivals into it — the same object in both, for the
// bus's reason. Closed last of all below, so the day's child exits and its
// conversation file is flushed before the pools it wrote rows through end.
const threadSessions = createThreadSessions();

// THE RUNS ENGINE, ONE FOR THE PROCESS (ticket #323): the thread's tools steer
// through it and the loop advances runs through it, the same object in both.
const runs = createRunEngine();

const api =
  apiPool === undefined || apiPortNumber === undefined
    ? undefined
    : await startLocalApi(
        {
          db: apiPool,
          twinId,
          dek,
          bearer: apiBearer!,
          // The rep's own zone, so a record line's «hoy» is their day and not
          // the host's — the same value the loop is given.
          timeZone: repTimeZone(),
          // THE THREE THINGS AN ACT NEEDS AND A READ DOES NOT (ticket #224):
          // the chain key for the one entry each execution owes, the bundle
          // whose entity mirror a confirmed binding lands in, and the thread
          // every receipt is posted to. Passed as a group, because a server
          // holding two of the three would be one whose acts fail halfway
          // through the account they owe.
          acts: { hmacKey, bundle, selfChatJid },
          ...(events === undefined ? {} : { events }),
          thread: threadSessions,
          // WHERE EACH WORKFLOW RUN'S SEALED CONTENT LIES (ticket #323): the
          // runs read opens an inline run's name there.
          harnessDirectory: harnessDirectoryBeside(bundlePath),
        },
        { port: apiPortNumber },
      );
if (api !== undefined) {
  console.log(
    `local API up on 127.0.0.1:${api.port} — rep-web is its only caller (ADR-0010)`,
  );
}

const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());

try {
  await runTwinRuntime(
    {
      db,
      // THE SDK CHILD'S DIRECTORY IS THIS TWIN'S, BESIDE ITS BUNDLE (#328):
      // created on the first execution, reported by FR-73 as the recorded
      // gap. The key is the one this process was started with.
      harness: { directory: harnessDirectoryBeside(bundlePath), apiKey },
      bundle,
      dek,
      twinId,
      selfChatJid,
      drafting: { model },
      // THE WHOLE CONFIG, not just the model (ticket #148, Codex r1).
      // `DITO_EXTRACTION_EFFORT` was being parsed, validated, and then
      // dropped here — so an operator who selected an arm got the default
      // arm's latency, cost and answers while believing otherwise, which
      // is the one failure the validation exists to prevent.
      extraction: extractionConfig,
      // ITS OWN RUNG, AND ITS OWN VARIABLE (tickets #148 and #154). Not
      // derived from the extraction config, even though #154 moved this
      // rung to Sonnet 5 as well: a failed determination fail-stops the
      // consumer with the rep's confirmed entity unfiled, so which model
      // makes it is chosen here deliberately rather than inherited from a
      // variable named for a different call site.
      kindModel: kindConfig,
      executionPool,
      sendLock: createSendLockWriter({ pool, hmacKey }),
      // The same chain key the writer holds (#53, #54): every class-2 rep
      // act this runtime can receive — the crossing, a correction, a rep's
      // answer to an aperture question — is audit-chained (ADR-0020), so
      // the runtime that can receive one carries the key.
      hmacKey,
      embedder,
      // The rep's calendar day, pinned (#51, Codex r1). The daily
      // disclosure keys its idempotence on the day, so the scheduled pass
      // and the hand trigger must derive the SAME day: two processes on
      // different ambient zones would key one rep day as two and post
      // twice. `repTimeZone` reads one env var in one place, so both
      // composition roots agree by construction.
      timeZone: repTimeZone(),
      repLanguage,
      // THE RAILS, AS A VALUE (ticket #262). The runtime declares the one verb
      // it needs and this is where the service that satisfies it is built, so
      // no module a registry can reach ever names `@dito/notify` (ADR-0013
      // class 4, held by `dependency-wall.test.ts`).
      ...(notify === undefined ? {} : { notify }),
      ...(events === undefined ? {} : { events }),
      threadSessions,
      runs,
      trace,
      ...(disclosureHour === undefined ? {} : { disclosureHour }),
    },
    { signal: abort.signal },
  );
} finally {
  // THE SERVER GOES FIRST. It reads the DEK and the pool below it, so a
  // request still in flight while the bundle closes is a read of a twin this
  // process has stopped holding.
  await api?.close();
  await apiPool?.end();
  // THE DAY'S CHILD EXITS BEFORE ITS STORES CLOSE: its inbox ends, its file is
  // flushed, and the last rows it moved are written through the pool below.
  await threadSessions.close();
  bundle.close();
  await db.end();
  await pool.end();
  await executionPool.end();
  await notifyPool?.end();
  console.log("runtime stopped cleanly");
}
