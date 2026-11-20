# Dito

Shared language for Dito — a WhatsApp-native twin for sales reps and owners. Glossary only: decisions live in `docs/adr/` and closed tracker tickets. Canonical terms are English; `_Surface_` gives the Spanish word the product shows — surface nouns never appear in code or internal docs, internal terms never in the UI.

## Language

### Identity & access

**Dito**:
The product and the company. In warm registers the twin speaks as Dito (the colleague); in grave registers Dito always means the company and the twin goes unnamed or self-refers «tu gemelo» — one referent per screen.

**Rep**:
The human salesperson occupying a seat.
_Avoid_: user, salesperson

**Owner**:
The human who owns the company; one owner identity per company (v1).

**Seat**:
A (person × company) employment relationship — the unit of twin ownership, lifecycle, and billing; one active seat per WhatsApp number.
_Avoid_: account, license

**Seat state**:
The rep-side lifecycle as built: invited (the link was issued) · linked (the number is on the rail; the seat is live) · retired (the twin is erased). The commit-point lifecycle — active · enforcement-paused · closing · retired — is the same seat seen from the wall's side and is decided, not yet built; the closing window and enforcement pause add their states when they land.

**Login session**:
A signed-in browser on the rep dashboard, opened by an invitation or by the seat's email and a one-time six-digit code, and ended by the rep from any device with «Cerrar sesiones». A different thing from a *session* with the twin, which is a conversation; the dashboard's Spanish says «sesión» for this one and nothing else.
_Surface_: sesión (only in «Cerrar sesiones»)
_Avoid_: session (bare, in the glossary's sense), login (as the noun for the browser)

**Invitation**:
The seat-scoped, single-use, expiring link that opens link day — issued by an operator (later the owner's Seats surface), delivered by email or forwarded by hand, stored only as a digest, and consumed once into a login session. «Invited» means the link was issued, not that anything was sent.
_Surface_: invitación
_Avoid_: magic link, onboarding link

**Acknowledgment**:
The rep's explicit act on a versioned document — the contract's summary and text, the ban-risk disclosure — recorded once as the seat, the document, its version and digest, the instant and the login session; append-only and never deleted. The document is shown in full and the button names the act and the version; whether it is also a signature is counsel's question.
_Avoid_: e-sign, consent checkbox, accept (as the verb; the button says what it does)

**Twin**:
The AI agent a seat owns — it belongs to the seat, not the person, and is erased at retirement. Unqualified, always a rep twin.
_Surface_: tu gemelo
_Avoid_: bot, assistant, copilot

**Owner twin**:
The owner's Ledger-scoped twin; always written qualified. It has no seat, no bundle and no lease: an execution over the Ledger, answering only from what its read tools return.

**Twin memory**:
The rep-private store behind the wall — conversations, style, timelines, workspace; erased at departure.
_Avoid_: knowledge base

**Rep notepad**:
The rep-scoped part of twin memory — how this rep works: register, tú/usted default, sign-off, and their standing instructions — as distinct from the facts about clientes that fill the rest of it. One hard-capped block the rep writes, through a tool that works only on the rep's own word. Twin-side only: it never crosses the wall, never migrates to a new seat, and is never exported (ADR-0033). Reviewed and edited on the dashboard in *Mi libreta*, a nav entry of its own; a save there is a dashboard act.
_Avoid_: rep profile, persona

**Bundle**:
The single per-twin encrypted file holding all twin memory; opens only under that twin's key.

**The wall**:
The architectural and contractual barrier between twin memory and every owner surface; nothing crosses except through the aperture.

**Audit chain**:
The append-only, hash-chained, content-free record — who acted, what act, opaque references, outcome — that every trust claim rests on. One per side: the rep side's is one chain; the owner side's is one per company. Neither side reads the other's.
_Avoid_: audit log (the surface above it is the Activity log), the chain (bare, when the side is not clear)

**Grant**:
Permission for a rep twin to read an entity's timeline. Two sources, different authority: a **creation grant** arises automatically when the rep binds a chat to a new entity (self-scoped — it returns only what that rep's own conversation filed), and every other grant is **owner-assigned**, which is what lets one rep read what another filed. Both are owner-revocable, and all grants die with the twin.
_Avoid_: permission, ACL

**Scope**:
The rep-controlled set of chats the twin may read; every chat starts out and is removable anytime.
_Avoid_: whitelist

### The Ledger & the crossing

**The Ledger**:
The company-owned, append-only, bi-temporal store of entity-scoped business facts.
_Surface_: el registro
_Avoid_: book, database, CRM

**Entity**:
The Ledger's anchor for a customer (person or business) — the unit of timelines, access control, and retrieval. A customer exists in the world; the entity represents one.
_Surface_: cliente
_Avoid_: contact, account, customer (as a system noun)

**Binding**:
The rep-confirmed association of one WhatsApp chat with one entity — proposed from chat metadata, confirmed by the rep, held rep-side in twin memory and never owner-visible; facts filed from a chat inherit its binding's entity.
_Avoid_: mapping, chat link

**Entity kind**:
Whether an entity is a **person** or a **business** — the only two values, always one of them. Determined by the model at the binding confirmation, from the name the rep confirmed and that chat's own words, and never asked of the rep. It drives display and one thing else: two records sharing a phone merge only when their kinds match, because a switchboard is shared by many people. A wrong one blocks or allows a merge and is corrected by hand; it never writes a false fact.
_Avoid_: type, category, unsure (there is no third value)

**Timeline**:
An entity's chronological fact history, supersessions and annotations included.

**Merge**:
The recording that two entity rows are one customer: the loser keeps its row and points at the winner, facts never move, and the loser's id stays resolvable forever. Fires automatically on a shared identifier, never on a matching name alone, and is never confirmed by anyone — a merge is made safe by being reversible, not by being reviewed (ADR-0035). It never deduplicates facts.
_Avoid_: dedupe, link, combine

**Unmerge**:
Taking one merge back. An **appended reversal** naming the edge, never an edit of it: the store recorded the merge that happened and goes on recording it, and what changes is that the graph's walks stop following that edge. Nothing moves — a merge only ever redirected at read time — so every fact stays on the entity it was filed against, facts written *after* the merge included, and every grant stays where it was. The loser resolves to itself again. Operator-invoked, audit-chained, not disclosed, and standing: the ladder does not redo a pair a human took apart.
_Avoid_: split, unlink, revert

**Fact**:
A Ledger record — entity-scoped, provenance-carrying, provisional for 24 hours, then final; corrections annotate, never erase.
_Avoid_: event (for Ledger content), record, entry

**Fact type**:
One of the closed set of kinds a fact can be (v1: QuoteGiven, OrderRequested, OrderTaken, DatePromised, ContactEstablished, CustomerPattern). **OrderRequested** is the customer asking for something; **OrderTaken** is the customer asking *and* the business agreeing. They are two independent events, never two states of one — neither becomes the other, nothing links them, and both disclose as their own line (ADR-0038). FR-30 froze a five-type list before the split; that list is superseded, and the gap between the two order types — what customers asked for and were never sold — is the unmet demand the model exists to record. **CustomerPattern** is a standing preference or constraint the *customer* stated about how they buy, read in the customer's own message and filed as one composed clause with nothing verbatim from the conversation in it (ADR-0040). Stated, never inferred: a regularity nobody said — a cadence read off a count of orders — is not one, and neither is anything about the rep, however standing and whoever says it.
_Avoid_: event type, order (unqualified — say which), habit, insight, profile

**Candidate fact**:
A model-extracted, untrusted, confidence-gated assertion, entity-attached, awaiting the aperture; below threshold it becomes a question, never a fact. One naming something the day does not spell out («lo mismo del pedido pasado») makes the extraction **look** in the rep's own history: exactly one referent found resolves it into a whole sentence carrying the goods that referent named — *resolved by reference*, filed as a stated one is and marked as such on its line — while two referents that differ, or none, leave it **unresolved**, dropped rather than asked about, and the drop is counted (ADR-0039). Nothing about the referent is recorded.
_Avoid_: extraction candidate, proposed fact, claim

**Rep act**:
The aperture's other input class — a rep's confirmation, correction, retraction, or entity operation, bound to verifiable evidence of the rep's own action.

**Aperture**:
The single Ledger writer and the filter deciding what may cross the wall: objective, entity-scoped business facts only. Its two inputs: candidate facts and rep acts.

**Question**:
A service, never a plea: the twin asks the rep only when the answer makes the rep's own work smaller, and never to fill a hole in the record (ADR-0043). It is a part of a post whose subject names the act a yes performs; a candidate below the confidence gate is dropped and counted, never asked. Today the only question on the rep side is the binding question, because the chat↔entity binding is one of the two acts reserved to the rep.
_Avoid_: clarification, verification, confirm-this (of the record)

**Daily disclosure**:
The rep-facing statement of everything filed to the Ledger that day — questions first, then facts by customer, every line present, numbered, in stored order. The lines are code's; the twin composes the opening, the closing and each question's lead and ask around them (ADR-0037). No consumer-facing noun; the twin simply reports.
_Avoid_: receipt, daily receipt, report

**Disclosure line**:
The journal line a filed fact gets (1:1) in the daily disclosure — rendered by code at filing and never reworded, every correctable field shown, the verb naming the fact type, a code-rendered mark when its goods were arrived at by looking; its reachability starts the correction window. Silence on it is a yes, which is why it is the record's words and not the twin's.
_Avoid_: fact sentence, summary line

**Correction window**:
The 24 hours after a fact's disclosure line is rep-reachable, during which corrections apply before it finalizes — a window, not an approval gate.

**Provenance**:
The source trail a fact or highlighted draft value carries; owner-visible provenance is timestamp, confidence, source type and the seat it was filed under — never chat identity (which chat, which number, which group, what was said).

**Shadow**:
The flag every fact and entity is filed with until its company's Ledger is **lifted**; the finalized views filter it, so nothing shadow is ever owner-visible. Lifting is one audited act per company — for the rig, the developer's; for a real owner, gated by Test 4.
_Avoid_: hidden, draft (for a Ledger row), unpublished

**Expungement**:
Removal of a wrongly-crossed fact, leaving a content-free tombstone.

### Conversation & surfaces

**Draft**:
A twin-composed outbound message awaiting the rep's tap; sends only from the rep's number, in the rep's voice.
_Avoid_: suggestion, auto-reply

**Turn**:
A customer's run of messages taken as one — the chat has gone quiet and none of them is answered — and the unit drafting answers: one turn, one draft.
_Avoid_: burst (in code), message (as the unit), batch (that is a lane)

**Tap**:
The rep's affirmation of one specific draft — the sole authorization for a send; authorship stays the rep's. One act, two renderings: a button on the dashboard, an exact keyword in the twin thread because WhatsApp has no button.
_Surface_: «va» (a quoted reply to the draft)
_Avoid_: approval (the act; the Approval card UI keeps its name)

**Dismiss**:
The rep's decline of one specific draft, said in their own words — terminal: the draft leaves the queue and a later tap on it is refused. The way back is asking for another draft, never un-dismissing. Silence is never a dismiss; an undismissed draft just keeps waiting, no nag.
_Avoid_: reject, cancel, snooze

**Reaction**:
An emoji placed on one specific message — remembered like any message, in both directions, with what it reacted to; a retracted reaction is remembered as a retraction. Evidence in a conversation, exactly like text — it can carry a fact's agreement. Never a tap: a reaction alone sends nothing, confirms nothing, dismisses nothing; in the twin thread it is ordinary rep input.
_Avoid_: like (the noun; says more than WhatsApp does), emoji reply

**Twin thread**:
The rep's WhatsApp self-chat, claimed by the twin as its in-WhatsApp surface — drafts, confirmations, refusals, answers, and questions all arrive there as plain messages, and an unquoted rep message there is input to the twin. Customers never see it. One of the twin's two doors; an answer to a message here comes back here. Its turns share one session per seat-local day (see *Session*).

**Door**:
One of the two places the rep speaks to the twin unprompted — the twin thread on WhatsApp and *the bar* on the dashboard. Two doors, one twin, one memory, one day's session: an answer goes back through the door it came in; a draft, a question, the day's account or a receipt goes to both surfaces and push. A door is never a thread of its own and never a page; what the twin says at the dashboard's door is kept in the day's thread, inside the bar.
_Surface_: the bar (the dashboard's door — permanent at the bottom edge of every dashboard page)
_Avoid_: Habla con Dito (retired 2026-09-25 with the labelled composer), chat panel, chat tab, channel

**Dashboard message**:
The rep's words typed into the bar, sealed by the runtime and routed by the consumer exactly as a self-chat message — a seam event from the dashboard door, and class-2 evidence like any rep message.
_Avoid_: chat message, prompt, request (that is a mechanism)

**Exchange**:
A dashboard message and the twin's reply to it — one entry of the day's thread, the rep's words on the right and the twin's bare line on the left, the hour above. Never the twin's own work, which is the acts log's. Not a transcript of the phone, not a session.
_Avoid_: conversation history (bare), chat log, thread (bare — that is the day's thread, which holds more than exchanges)

**Rep dashboard**:
The rep's web surface and the one that notifies: link day, Inicio (the canvas over the bar), Rutinas and Trabajos en curso, Mi libreta, Conexiones (the rail, re-linking, the scope rows), Ajustes and the bell. It stands with the rail down, holds no key, calls no model from the browser, and reaches everything twin-side through the twin's own runtime. Never native, never an app-store listing.
_Surface_: el tablero
_Avoid_: app, portal, panel, rep-web (a code name, not a noun)

**Post**:
One record of what the twin told the rep — from one execution, with an ordered list of typed parts: prose the twin composed; a draft; the day's numbered record lines; a question; a receipt; a document; a list; the twin's proposal of a rutina, accepted or discarded on the card (2026-10-11, #386); the canvas's curation — a knock is a row beside the post, never a part (2026-10-08, #358). Written by code from the execution's tool calls and its final words (the submission retired 2026-10-07), never by the model directly; sealed on the seam; immutable. Every surface renders the same post: the twin thread in its own grammar, the dashboard as a card.
_Avoid_: message (bare), notice, notification (a post is not one; its knock is what notify pushes), card (that is a rendering)

**Card**:
The dashboard's rendering of one post: its parts as text and its answer acts as buttons — Enviar and Descartar on a draft, retract per record line, confirm and decline on a binding question. No sigil, no keyword, no instruction line, no frame label. Chrome around the parts is the copy package's, never the twin's.
_Avoid_: tile, widget, notification


**Canvas**:
Inicio's body: the hand-offs that wait on the rep — drafts, binding questions, the day's notes for their window, the first-day fill card, the rail card while the rail is down — curated by the twin for the moment: one spotlight, the rest smaller, «Todo lo que espera» for the whole set. Holds what waits and what the twin places there: a settled hand-off leaves it; a card with no act of its own — a run's report, a document, a list — leaves when the rep says «Listo», when the twin's curation drops it, or after a day; the twin's curation may take any card off the canvas for the rep (ruled 2026-10-08, #368). No record, no act lines, no regions.
_Avoid_: queue (retired 2026-09-25), inbox, feed, to-do list, dashboard (bare)

**Hand-off**:
One thing the twin hands the rep to decide, as a card on the canvas: the twin's sentence naming the counterparty and the reason — its own words from the turn that made the card, never a parameter and never a label (2026-10-08) — the thing itself, its buttons. A draft, a binding question, the day's notes, the fill card; a run's report, a document or a list is a card the rep clears with «Listo» (2026-10-08).
_Avoid_: task, item, post (that is the record beneath it), notification

**The day's thread**:
Everything said at the dashboard's door today, oldest first, inside the pill — the rep's exchanges and every line the twin said on its own (the morning line, a return line, a line on a card's landing, its answer to a pick or a selection, a sentence it added to a card), each under its hour, with the day's name as the only other chrome; nothing fades; older days on request. Opened by the clock glyph; the current line is its last entry. Code's acknowledgement of the rep's own act is never an entry (the acts log keeps it).
_Surface_: Lo de hoy · Hoy · Ayer · Días anteriores · «Respuesta nueva»
_Avoid_: history (bare), chat history, transcript, log, conversation (bare)

**Open matter**:
One thing the twin holds as half done, in its own working notes: its short label and what it is about — a customer or a card. Offered to the rep as where the two of them left off («¿Dónde quedamos?»: one pill above the bar at a return, then the twin's carousel); picking one is an event the twin resumes in its own words. Never a task the rep is assigned, never a chip that types for them.
_Surface_: «¿Dónde quedamos?» · «Tenemos esto a medias»
_Avoid_: todo, task, open topic chip (retired 2026-10-05), thread (bare)

**Lean-in offer**:
The twin's one sentence about the card the rep rests on — what it would do for them there — written into its curation and risen in the pill as its own line after the rep's pause; a tap takes it as the rep's yes in their name, a dismissal («Luego») lets it go. Spent for the day once taken, answered or let go, on every device.
_Surface_: the risen pill · «Luego»
_Avoid_: suggestion chip, tooltip, hint (that is the rep's), prompt

**Pick**:
The rep choosing one of the twin's open matters. An event, carrying the twin's own label; the twin resumes the matter in its own words. Never a message in the rep's name.
_Avoid_: selection (that is a phrase), click (a mechanism)

**Selection**:
The rep selecting a phrase on a card's text and letting go. An event, carrying the phrase verified against the card's own words; the twin explains it in its own words, the phrase bold where it quotes it. A selection inside the pill or shorter than a word is nothing.
_Surface_: «¿Y esto?»
_Avoid_: highlight (that is the drawing), query, prompt

**Blank**:
A typed slot the twin leaves in a draft where a fact is missing that only the rep has — its key, its short label and the one question, all the twin's words at drafting time — drawn by code as a dashed capsule in the draft's text. Enviar stays active and asks instead of sending while one is open; the send lock refuses one; the rep's prose answer fills it and the fill is a new draft.
_Surface_: the dashed capsule · «Me falta un dato»
_Avoid_: placeholder, variable, field (that is the rep's), template slot

**Delicate draft**:
A draft that commits the rep to something — a price below list, a delivery date, an apology — as the twin judges it, carrying the twin's reason of two sentences at most, written when the draft is composed and read before the tap: resting on Enviar raises it in the pill. The reason is the card's own text borrowed by the pill, never a thread entry; code shows it and judges nothing about it.
_Surface_: «Antes de que la mandes»
_Avoid_: risky, flagged, warning, confirmation dialog

**Arrival**:
The rep opening Inicio — an occasion: it wakes a turn of the thread, which says the welcome or the return line and curates the canvas (2026-10-03). A return within ten minutes is not an arrival.
_Avoid_: page view, session start, login (that is the credential)

**Acts log**:
The twin's account of what it did and when — Enviado, Descartado, Ligado, Retirado, the reminders — as lines with the act word first and a link where the subject still exists, one day at a time under the day's name and date, seven days deep, then gone from the dashboard. Lives in Trabajos en curso and nowhere else; never the twin's answers to the rep, which stay at the door that asked.
_Surface_: Trabajos en curso · Hoy · Ayer · a date
_Avoid_: record (retired 2026-09-25), history, archive, activity log (the trust job this is), timeline (that is an entity's)

**Trabajos en curso**:
The dashboard page holding every run going — its state word, one detail, its steps on demand, Pausar · Reanudar · Cancelar as the rep's acts on it, a still mark by state — for a run that waits, the mark names what it waits for: the clock, the rep's reply, a card, other runs (built 2026-10-08, #368) — and, in each day's history, the runs that ended that day above the acts log (2026-10-06) — **what fired**: every firing of work that runs on its own is a run here, even one of a single step; a turn that answers someone (the thread, drafting) is never listed, and a reminder's firing wakes the thread and is never a run (ruled 2026-10-07). Reached through the two-way switch it shares with Rutinas.
_Surface_: En marcha · Trabajos que terminaron · Pausar · Reanudar · Cancelar
_Avoid_: activity, history, feed, jobs

**Rutinas**:
The dashboard page that shows, in the twin's first person, the automations it runs on its own — what each does, when it runs, when it last ran and, for a cadence, when it fires next («Próxima vez», the clock's own arithmetic said forward; a held one says only «En pausa» — 2026-10-11, #387) — whether Dito shipped them or the twin wrote them for the rep — **what fires**, by the clock or on an event: Dito's five — drafting, extraction, the daily disclosure, the reminders, the overnight briefing (built 2026-10-08, #364) — and the rep's rutinas, each with the rep's pause switch («Activa / En pausa») and Descartar. A rutina the rep asked for is live at the ask and shows here at once; a rutina the twin proposes is a card where the rep is — on the canvas and in the self-chat — and runs only once they accept it there, never from this page; the twin says which it was and nothing verifies it (Diego, 2026-10-11, #386). Only the twin thread writes a rutina; a run never does. The twin's thread is never listed here: it is the twin itself, not a job (ruled 2026-10-07).
_Avoid_: automations (in rep-facing copy), settings, cron

**Chrome**:
The dashboard's fixed words — labels, headers, state words, empty states, the legal documents, notify's templates — every one a keyed entry of the copy package, never composed and never a literal in a page. Exempt from composition, not from register: **chrome says what is the case and what the rep can do next, never what is not the case or what will happen to them** — affirmative sentences, no negation, no suspense. A draft waiting on the dashboard is marked by chrome («Listo para enviar»), as the thread marks it by a frame label.
_Avoid_: microcopy, UI text, strings

**Session**:
The harness's thread of the machine (ADR-0012, ADR-0014): the twin thread's is one per rep per seat-local day — cut by code past midnight in the rep's zone at a quiet moment, never mid-conversation, yesterday's tail carried in as a few lines (2026-10-03) — and every run has one of its own, resumed by each of its agent steps (2026-10-06). Partitions attention and task context, never memory; searchable by a sentence. Lives with the twin's key: on the twin's volume once there is one, until then in the twin's own directory beside its memory.
_Surface_: plática (the owner's La mesa; the rep never sees a session)
_Avoid_: chat, thread, conversation (as system nouns); context window; the dashboard's signed-in browser, which is a *login session*; focus (retired 2026-10-06 — the day's session carries what the two were just discussing)

**Event**:
A fact of the seam appended to the twin thread's session as a message with an id — a post landed, seen or settled; a pick, a selection, a summons; a run started, moved a step, waiting, finished or failed; an arrival; the rail's state, once it has been down three minutes (2026-10-09, #377); the rep's switch or Descartar on a rutina (2026-10-11, #386). Code decides which events wake a turn and which only append (a run's end wakes; its start, steps and waits only append — 2026-10-09, #382); the thread decides what, if anything, to say.
_Avoid_: notification, trigger (that creates an execution), message (bare), integration event (that is the ingress envelope)

**Unit**:
A twin's compute: a runtime that boots identityless from the image, receives the twin's volume, asks KMS for the twin's key and only then is a twin; suspends by dropping the compute and keeping the volume. Behind the always-on connection plane; the one writer of the twin's volume (ADR-0001, ADR-0010).
_Avoid_: box, VM (bare), container, process (bare), sandbox, machine per user

**Volume**:
The twin's encrypted disk, grafted onto its unit — the SQLCipher bundle, the session files, the workspace directory — one key, one erasure (ADR-0007, ADR-0009).
_Avoid_: bundle (that is the SQLCipher file inside it), disk, storage, drive

**Reference**:
How the twin names a customer when it speaks or calls a tool — never a typed name, never an address; code fills in the confirmed name where the reference stands. The customer's own stable number, one per customer for as long as the twin holds them (2026-10-03), so the same reference means the same customer across every turn of a day and every step of a run; code renders the confirmed name, with the number's tail only where the customer has more than one chat, and a reference that names no customer sends the twin's submission back. A customer with two numbers is one reference — the twin picks the chat when it writes and the tap covers the pick.
_Avoid_: slot (where a reference is rendered, not the reference), served number, mention, handle

**Working memory**:
The twin's own notes about what is live with this rep — a short text and the list of its open matters — written by the twin in any turn as a whole new version, shown as Mi libreta's second section in the twin's voice and corrected by telling the twin at either door; the opposite of the notepad, which is the rep's rule (2026-10-03).
_Surface_: Mi libreta (its second section)
_Avoid_: notepad (that is the rep's), memory (bare), context, scratchpad

**Ask**:
The one question the twin puts to the rep when a name it was given matches more than one bound chat — «¿cuál Torres?» — with every candidate offered, because a choice missing an option is not the rep's choice; chats that share the name are offered each with its hint, so the choice is one the rep can make. The rep answers in prose — a position, a hint, «el que sea» — and the next turn resolves it against the references the twin holds. Never for a name that matched one (that gets the draft), none (that gets a sentence) or chats nothing tells apart — same name, same hint — which get an honest sentence naming what was found; and never a Question, which is the aperture's (ADR-0039). The other way round is not an ask either: the rep's pick on a card, their selection of a phrase and their summons of the twin are the rep's lines without words — rows beside the typed ones, read by the same pass and answered by the same thread turn (built 2026-10-08, #358; the code's table is named `rep_asks`, a name this entry does not share).
_Avoid_: clarification, disambiguation prompt, question (taken — the aperture's), ask (for a pick, a selection or a summons — those are the rep's wordless lines)

**Hint**:
What code puts beside a chat's name when two or more confirmed chats carry the same name — the last four digits of the chat's number and the day the other side last wrote — so that the twin can ask a question the rep can answer and write to the chat the rep chose. Rendered by code from facts the twin may see without seeing an address; absent wherever names do not collide. The twin says it in the rep's own words («el que termina en 8416», «el que te escribió el sábado»), and a rep's answer naming one is prose the twin reads, never a keyword. Two chats whose name and hint read the same are still not an ask.
_Avoid_: disambiguator, the number (a hint is never the number), label, phone

**Receipt**:
The twin's acknowledgement of an effect it performed, rendered by code from the tool's result — «Descartado», «Listo, guardé este chat como *Torres*» — and the send lock's refusals on a tap. Never composed: a receipt reports what code did, so a reply and an action cannot look alike and the twin cannot report an effect it did not perform. A run's endings — it stopped, paused, was cancelled, finished — are receipts too, never a sentence in the twin's voice; a receipt that stands alone reaches the phone and the card by one path and the day's thread shows it as the twin's reply to the line that caused it (built 2026-10-08, #358). Chrome, recorded on the pinned allowlist beside the frame labels (ADR-0037).
_Avoid_: ack (in code), confirmation message, receipt (for the daily disclosure — see there)

**Frame label**:
A fixed piece of the structure of what the twin posts — the ✳️ sigil, «Borrador — para», «(sin confirmar)», the disclosure's numbered-line frame («Fuentes:» retired 2026-10-07 with the sources line; «Porque:» and «(su chat, HH:MM)» retired 2026-10-08 — the draft's reason and where it came from are the twin's words, #368) — rendered by code because the matcher and the guard depend on it. Structure, never a sentence; each one is on the pinned allowlist, which is the record of what is chrome (ADR-0037).
_Avoid_: template, boilerplate, microcopy (for a label)

**Attention set**:
The open and recently-settled sessions routing considers — never full history.
_Surface_: la mesa (also the nav room's name)

**Receipt strip**:
The product's only citation UI — tap a provenance span or gutter square to see a value's source in place. Not the rep-side *Receipt* (an effect acknowledgement in the twin thread), and never a name for the daily disclosure.
_Surface_: «De dónde salió»

**Activity log**:
The human-readable, strictly read-only record of what the twin did and when — the trust surface.
_Surface_: Registro de actividad
_Avoid_: audit log (that's the hash-chained store beneath it)

**Standing instruction**:
A rep-authored durable rule ("lesson") outranking defaults and learned behavior; visible, editable, cited on request.
_Avoid_: setting, config

**Workspace**:
The twin's store of work-product artifacts: one directory inside the per-twin harness directory that the SDK's own file tools write in, snapshotted at every step boundary and at a thread turn's end into immutable versions in the bundle (built 2026-10-08, #326). A document is a file there, titled by its first heading; its card opens it through the runtime, and Mi libreta's third section «Documentos» lists every document with its latest version to open or download, whether or not a card is on the canvas (ruled 2026-10-08, #368). Citations pin versions.
_Surface_: Mi libreta (its third section) · «Documentos» · «Abrir» · «Descargar»
_Avoid_: file system (as a noun for it), artifact store, folder

### Automation

**Primitive**:
The system beneath the defaults: sessions, triggers, scheduled runs, workflows, integrations, workspace.

**Automation**:
One wake plus one definition plus whatever the occasion binds — the one shape every unit of agentic work is an instance of, whether Dito shipped it or a rep assembled it. Assembled only from Dito-authored parts: instructions, tools by name, context recipes by name, a cadence or a predicate. Since 2026-10-06 the definition is a workflow definition — a list of typed steps (see *Step*) of which one agent step is the common case — the same for what Dito ships and what the twin writes for a rep. It also says which conversation its agent step continues: the day's, for Dito's shipped thread alone, or a fresh one per run (2026-10-07).
_Avoid_: harness, task, job, plan

**Trigger**:
The wake that creates an execution when something happens — an event, matched by a predicate over metadata only, never content — and names what the execution is about.
_Avoid_: hook, listener, webhook

**Schedule**:
The wake that creates executions from the clock — a cadence, what it fires for, a precondition — each firing naming its own occasion. Kept as rows the holder's pass reads: a one-shot wake for a run's wait, a cadence for an automation (2026-10-06). A cadence is every day or every week at a whole hour of the rep's day; a weekly one holds a set of weekdays on one row — «entre semana», «lunes y jueves» (2026-10-11, #387).
_Avoid_: cron, scheduled task, job

**Execution**:
One run of an automation: its wake creates it with its own instructions, tools and context, and the agent inside decides what to do — including nothing. Every unit of agentic work is one, and context never spans two — except the twin thread's turns, which share the day's session, and a run's agent steps, which share the run's session.
_Avoid_: harness, agent loop, run (bare — that is the job of steps, see *Run*)

**Run**:
One job of the twin's that outlives a turn: a workflow definition — typed steps the twin wrote for the rep's errand or Dito shipped — pinned as it started, advanced step by step by the holder behind the seat-state gate, with its own session and a row on the seam (its state, the step it stands at, its budget, the flags paused and cancelled); it waits on the clock, on a customer's reply or on a card settling, lands its own cards at both doors and never speaks in the bar; shown on Trabajos en curso (2026-10-06). A run inside another run — one per item of a list — is a child run.
_Surface_: trabajo · En marcha · Por empezar · Trabajando · En espera · Listo · Se detuvo · En pausa · Cancelado
_Avoid_: job (in code and docs), task, workflow (bare — that is the definition), execution (each step is one)

**Step**:
One typed unit of a run, laid in order: agent (one execution on the run's session, holding any registered tool under its gate, ending when the model stops — its words the final message, its typed fields the structured output when it declares any), code (a shipped recipe), act (one call to one gated tool, no model), post (the report), wait (an instant, a span, a customer's reply, a card's settle), ask (a question card the rep answers), each (a child run per item), while (a sequential repeat under a cap), if, end (2026-10-06).
_Surface_: Pasos · Pensar · Calcular · Hacer · Avisar · Esperar · Decidir · Preguntarte · Uno por uno · Repetir · Terminar · Vuelta N de M (the last five ruled 2026-10-07)
_Avoid_: action (Quick's word), node, stage

**Disposition**:
The one word an execution's record ends with — answered · acted · drafted · classified · no-action · wall-refused · schema-miss · failed · filed · nothing-to-file · posted. The runtime's word, not the model's and not the model's submission either: `acted` needs a performed effect behind it and covers a turn that acted and said nothing; `no-action` is a turn that posted nothing and performed nothing; `failed` means the turn broke on the wire or ran out; `filed`, `nothing-to-file` and `posted` are read from what the filing and the send tools performed. Since 2026-10-07 every word is read from what happened — the effect's act word, `answered` for words or a typed result, `no-action` for neither, `asked` for a question left open, `schema-miss` for a malformed typed result, an `act` step's word its tool's own, `posted` for a step that lands a card — never from a form the model filled (ADR-0014; #358).
_Avoid_: status, result, outcome (bare)

**Occasion**:
What an execution is about — the closed word its wake stamps on the trigger record and the audit entry: an owner question, a chat turn, a twin-thread message (from either door), a twin-thread event, a dashboard act, the rep's arrival, an entity-kind classification, an extraction, a daily disclosure, a run's step.
_Avoid_: event type, purpose, kind (taken — entity kind)

**Mechanism**:
How a wake fired — `seam_event` (a rail delivery matched by a predicate), `request` (code asked, with no event behind it), `schedule` (the clock) — written on the trigger record beside the occasion, never inferred from it.
_Avoid_: source, channel

**Enumerator**:
The part of a Schedule that names what each firing is for — every twin with a linked rail, every chat with unextracted messages — so one cadence creates one execution per item, each carrying its own occasion.
_Avoid_: iterator, target list

**Precondition**:
The check a Schedule makes before creating an execution — the seat's state, something left to do — so a firing with nothing behind it creates no execution.
_Avoid_: guard (taken — the capture guard), filter

**Lane**:
One of the two queues the single holder runs work in at the same time, so a long run never blocks a short answer: the **executions that answer someone** — the twin thread, drafting, the entity-kind classification — up to four at once; and the **runs** — what Rutinas fires: extraction, the daily disclosure, a rep's rutina — one step at a time. Nothing else: a lane is not a kind of work, only the queue it waits in (re-cut 2026-10-08). The code names the two `realtime` and `batch`. A lane bounds how many run at once; it does not order two executions that touch one target (ADR-0010). Both lanes record an execution that fails on what it was handed and go on — a run one attempt per firing, an answer one attempt per trigger; fail-stop is for infrastructure (ADR-0016, ADR-0042). The entity-kind classification is the one answering execution whose refusal still stops the holder.
_Avoid_: queue, worker pool, thread, realtime lane / batch lane (in design talk — say «the executions that answer someone» or «the runs»)

**Gate**:
The human-in-the-loop check a tool with an externally visible effect carries by construction, so it is safe in any execution. Three shapes: **approve-before** for external or irreversible effects (the tap), **disclosed-and-undoable-after** for Ledger writes (the correction window), **rep-evidenced** for twin-side state a rep may change (the tool works only when it can cite the rep's own message). A tool with an effect has one of the three; a read has none — it owes a projection. A rutina's creation is disclosed-and-undoable-after when the rep asked (Rutinas shows it; the switch and Descartar undo) and approve-before when the twin proposed (the card's Activar); which it was is the twin's word, never checked by code (Diego, 2026-10-11, #386).
_Avoid_: permission, approval flow, allowlist

**Projection**:
What a read-only tool owes instead of a gate: the fixed set of columns it can return, pinned by the view and the database role it runs as, never by its caller. Its parameters narrow rows — an entity, a window, a fact type, a seat — and can never widen columns, tables or company.
_Avoid_: scope (taken — the rep's chat set), query, schema

**Shipped defaults**:
The pre-wired primitives delivering the flagship experience at link time (push drafting, daily disclosure).
_Avoid_: onboarding flow

**Integration**:
A connected capability source — everything is an integration, WhatsApp included. Provides up to three capabilities: knowledge sources, actions (always draft-gated), events.

**Integration event**:
The normalized signal an integration emits inward — what triggers listen to.
_Avoid_: event (bare)

**Dashboard act**:
A rep act performed by pressing a button on the dashboard — tap, dismiss, retract, confirm or decline a binding, scope a chat in or out — recorded as its own row naming the act, the target and the login session, and run as an execution with a `dashboard` trigger. It is class-2 evidence exactly as a raw twin-thread message is: the rep-evidenced gate accepts either surface. A scope change is an execution with no model in it at all; on the dashboard it is performed by the press that saves the marked list, one act per changed chat, never by the mark itself.
_Avoid_: click event, interaction id (as the noun), action (bare)

### Connection & lifecycle

**Linked-device rail**:
WhatsApp's own multi-device (QR-link) connection — the transport for the first-party WhatsApp integration.

**Connection plane**:
The thin service holding the WhatsApp socket; it delivers events, executes sends, reports rail status — and judges nothing. What it cannot read it delivers as opaque, never as silence.

**Capture guard**:
Socket-side enforcement of scope, pause, and tenure — out-of-scope chats never leave the plane.

**Opaque delivery**:
A message in an in-scope chat whose content the twin cannot yet read — a photo, a voice note, a message the rail could not decrypt, a shape that did not parse. Remembered as having happened, with who, when, and what kind, never as silence. When a kind of opaque delivery earns its own place in twin memory it becomes a kind of its own, as reactions did.
_Avoid_: unreadable, unknown message, husk

**Chat directory**:
The plane's content-free row for every conversation the rail has shown it — the chat's identities, its kind (self, dm, group, other), its name sealed, its last activity, one anchor on its newest message and how its last fill ended — kept for every chat, in scope or not, so the rep can choose. The dashboard reads directory rows by id with names opened; no page holds a phone number, save the binding card, where the chat's number is the question being asked.
_Surface_: tus chats
_Avoid_: contact list, address book, chat list (as a system noun)

**Fill**:
Pulling a chat's last ninety days into twin memory after the rep scopes it in: on-demand history pages from the phone, one chat at a time, under the capture guard, until the ninety-day line or the phone's end. It stops with a named reason the dashboard reads — the ninety days are in, nothing was fetchable so the twin reads from today, or history is still on the phone — and a message that arrived while the chat was out of scope is never recovered by a later fill.
_Surface_: Trayendo tu historial · Dito ya está al día con tus chats
_Avoid_: sync (the rep-facing word for the whole step), backfill (in product), import

**Lease**:
The exclusive hold a runtime takes on one twin; one holder at a time, everything twin-side runs under it.

**Notify**:
The only sender of system mail and of web push: a closed catalog of templates with typed slots — a login code, an invitation, the grave events — and the push transport that carries a post's knock or nudge to the rep's browsers, resolving the recipient from the seat, refusing a seat with no address by name, recording every send with its outcome. Never on a model's tool surface; composed text enters it only from a sealed post row, and only for push. There is no digest.
_Avoid_: mailer, notification service (it is not what notifies the rep — the dashboard is), email (as the system noun)


**Knock**:
The one sentence the twin writes to announce a card on the rep's phone — a draft ready, a question asked, a hand-off the rep asked for («escríbele a …» from either door), a reminder — through the thread's knock tool, as a row beside the post (2026-10-06): a card knocks once when it lands and once more for each reminder that fired for it (2026-10-07; the knock carried inside a post at birth retires, #358). Rendered by notify as the body of a push — and once on the canvas, inside the permission ask, as the example of what a push carries. Length-capped, never a link, never shown on a device whose tab is on Inicio: the twin's voice on the lock screen, tied to a post that exists — or to the card the same turn is still writing, which lands with its knock when the turn ends, under the post id the draft tool named (built 2026-10-08, #358 · #368).
_Avoid_: notification text, template, alert, toast

**Reminders**:
The twin's second knock about a card that still waits — a binding question on its sixth day, the day's notes two hours before their window closes, a draft waiting since yesterday — as a one-shot schedule row written when the card is born, shifted out of quiet hours (22:00–08:00 in the rep's zone), whose firing wakes the thread with an `expiring` event naming the card; the thread decides whether to knock and with what words (ruled 2026-10-07, built 2026-10-08, #364). One of Dito's automations on Rutinas, with the rep's switch. Never by email.
_Surface_: Recordatorios · «Activa / En pausa»
_Avoid_: nudge (retired 2026-10-07), reminder clock, re-notification, escalation

**Push subscription**:
A browser's registration to receive the twin's knocks — its endpoint and keys, held per login session, written by the dashboard and read by notify, removed with the session or when the push service says it is gone. A secret: never rendered, never logged.
_Avoid_: device, token (bare), registration
**Link day**:
The rep's first dashboard visit, from an invitation to a linked number and chosen chats: intro → email (only while the seat has none) → contract → ban-risk → link by QR or pairing code → scoping from the chat directory → sync. Every step is computed from durable facts and a step reached early goes back to the first incomplete one; the seat goes live when the rail links. Shipped defaults activate the same day.
_Surface_: primer día
_Avoid_: onboarding (as the rep-facing noun), sign-up

**Closing window**:
The ~72-hour post-departure period: filed facts finalize, pending questions void, workflows halt.

**Retirement**:
Per-twin key destruction at departure — cryptographic erasure of all rep-side data; entities and facts survive, grants don't.
_Avoid_: deletion, offboarding

### Development rig

**Rig number**:
The dedicated WhatsApp number QR-linked to the connection plane during development — an aged, otherwise-unused number on its own spare device, running normal WhatsApp. Never the developer's personal number until promotion.
_Avoid_: test number, dev number

**Counterparty**:
An unlinked number that messages the rig number to generate live steering traffic. It carries no enforcement risk because it is never linked to the connection plane.

**Promotion**:
QR-linking the developer's personal number to the rig, permitted only once all named promotion criteria hold at a slice boundary.

**Demotion**:
Immediate unlinking of the personal number on any enforcement signal, falling back to the rig number. Re-promotion re-runs the full promotion gate.
_Avoid_: rollback

**Steering install**:
The single evolving deployment of Dito that slices update and the developer steers against — one per effort, carried across slices, not rebuilt per slice.
_Avoid_: dev environment, staging

**Steering surface**:
A product surface used to judge a slice's behavior first-hand. Always one of the product's own surfaces, entering the rig when a slice first builds it; logs and audit tails are debug views, never steering surfaces.
_Avoid_: mirror, operator console

**Slice**:
One increment of the build — at most about a week of agent work, ending in a runnable artifact steered on the rig with its wall and lock audits fused in.
_Avoid_: sprint, milestone, phase

**Slice boundary**:
The steering session that closes a slice, where promotion criteria are checked and the coming slices are re-cut.
