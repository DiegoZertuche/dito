/**
 * THE DASHBOARD'S CHROME — labels and page copy, keyed (ticket #219; spec
 * #214 decisions 9 and 13; ADR-0037 as amended 2026-09-02 and 2026-09-04).
 *
 * ADR-0037's rule binds what a TWIN says. A dashboard is legitimately a
 * form, and its navigation, its headings and its buttons are chrome the
 * amendment exempts by name — so they may be constants, and this is where
 * they live rather than scattered through the pages that render them.
 *
 * WHAT IS HERE IS THE DASHBOARD'S OWN COPY, and nothing beyond it. The
 * scoping promise, the feed's heading, the two draft buttons and «Cerrar
 * sesiones» are sentences spec #214 names by hand — a page that paraphrased
 * one would be changing a promise. Beside them are the titles of the six
 * link-day steps and the nav's labels, and then a block per PAGE ticket:
 * #221's login screens, nav furniture, Inicio's empty state, Conexiones' rail
 * states and Ajustes' one card; then #224's four card kinds, the feed's second
 * heading and its two system statements, and link day's first two cards; then
 * #223's link day itself — the invitation's refusal, the onboarding shell's
 * progress line, a block per step, and Conexiones' two new sections; then
 * then #264's *Mi libreta*; then #266's canvas; then #263's bar; then #267's
 * Rutinas and Trabajos en curso; then #265's
 * chrome from the rulings — the bell, the dots' clauses and the avisos row. The
 * family grows with each page
 * ticket rather than being guessed at in one go, which is why a block is dated
 * by its ticket rather than merged into the lists above.
 *
 * WHAT IS NOT HERE. A surface's label arrives with the surface (spec #214
 * decision 9: "the nav shows only what exists"), so nothing waits here to be
 * rendered by mistake. Neither is anything the twin says: the twin composes
 * that, on the dashboard as in the thread.
 *
 * KEYS ARE `surface.thing`, dot-separated and camel within a part, so a
 * page reads `CHROME["draft.send"]` and the CI check has one shape to look
 * for (`scripts/copy-check.mjs`).
 */

/**
 * The record. One locale, es-MX — see the package header for why there is
 * no negotiation and no fallback chain.
 */
export const CHROME = {
  // The nav, which shows only the surfaces that exist, in spec #258 decision
  // 17's order with Ajustes at the foot.
  "nav.inicio": "Inicio",
  "nav.conexiones": "Conexiones",
  "nav.libreta": "Mi libreta",
  "nav.rutinas": "Rutinas",
  "nav.ajustes": "Ajustes",

  // Link day, step by step, in FR-23's fixed order.
  "linkDay.intro": "Qué hace Dito por ti",
  "linkDay.contract": "Tu contrato",
  "linkDay.banRisk": "El riesgo que corres",
  "linkDay.link": "Conecta tu WhatsApp",
  "linkDay.scoping": "Elige tus chats",
  "linkDay.sync": "Trayendo tu historial",
  "linkDay.acknowledge": "Lo leí y lo acepto",

  // The promise the scoping page makes, word for word (user story 17).
  "scoping.promise": "Dito lee los últimos 90 días de los chats que marques",

  // The draft card's two buttons (user stories 27 and 28).
  "draft.send": "Enviar",
  "draft.dismiss": "Descartar",

  // Ajustes, whose one 6a act is ending every session (user story 7).
  "settings.closeSessions": "Cerrar sesiones",

  // ─────────────────────────────────────────────────────────────────────
  // THE PAGES #221 BUILDS. The family grows with each page ticket, which
  // is the design stated in this file's header: a label with no page is a
  // label nobody reviewed. What follows is the login's two screens, the
  // nav's furniture, Inicio's empty state, Conexiones' five rail states
  // and Ajustes' one card.
  // ─────────────────────────────────────────────────────────────────────

  // The furniture. The nav's own label is what a screen reader announces,
  // which is copy nobody sees and everybody hears.
  //
  // THE WORDMARK IS A NAME AND IT IS STILL A KEY, which is worth one line
  // because the instinct is to leave it in the markup. A name is a rep-facing
  // string, this record holds every rep-facing string of the dashboard, and
  // the alternative was `copy-check.mjs`'s allowlist gaining its first entry
  // — an exemption with an expiry, for a word that will never expire. One
  // key costs nothing and keeps the allowlist empty, which is the state the
  // rule is worth having in.
  "chrome.wordmark": "dito",
  "chrome.wordmarkTag": "tu gemelo",
  "chrome.navLabel": "Navegación",
  "chrome.title": "Dito — tu tablero",
  "chrome.description": "Lo que tu gemelo tiene para ti, en un solo lugar.",
  // THE THEME CONTROL (#297; boundary #270 F2): the group's name and its three
  // states, each the name of what the page then shows.
  "chrome.theme": "Tema",
  "chrome.themeSystem": "Automático",
  "chrome.themeLight": "Claro",
  "chrome.themeDark": "Oscuro",

  // Login, screen one: the email (prototype variant A — «dos pantallas»).
  "login.title": "Entrar",
  "login.lead":
    "Escribe el correo de tu asiento. Te mandamos un código de seis dígitos: con eso entras.",
  "login.emailLabel": "Tu correo",
  "login.emailPlaceholder": "nombre@empresa.mx",
  "login.submit": "Mandarme el código",

  // ...and screen two: the code.
  //
  // THE ADDRESS IS NOT ON IT. The prototype drew a masked one
  // («m•••••o@treviño.mx»); a mask is still the address, partly, on a screen
  // anybody holding the phone can read — and it is the one value ADR-0019's
  // flow 4 keeps out of everything else. The rep knows which address they
  // just typed.
  "login.codeTitle": "Revisa tu correo",
  // THE NUMBER IS NOT IN THE SENTENCE. `CODE_LIFETIME_MINUTES` is the login
  // flow's constant and `notify.loginCode` renders it from the same value, so
  // a copy that wrote «diez minutos» would be a second home for a figure that
  // lives in code — `LAG_STATEMENT_*`'s shape on the owner web, for the same
  // reason.
  "login.codeLeadBefore": "Te mandamos un código a tu correo. Vence en ",
  "login.codeLeadAfter": " minutos y sirve una sola vez.",
  "login.codeLabel": "Código de seis dígitos",
  "login.codeSubmit": "Entrar",
  "login.resend": "Mandar otro código",
  "login.resendNote": "El correo tarda un par de minutos. Espera un poco antes de pedir otro.",
  // The same-device link, mentioned in one line (Diego's reaction: «el código
  // menciona la liga del correo en una línea»).
  "login.linkNote":
    "Si abriste el correo en este mismo aparato, la liga que trae te mete directo con un toque.",
  // ...and the screen that liga lands on. A tap and not a form: the code is
  // already in the link, and what the rep confirms is that it is THEM opening
  // it and not their company's mail scanner (the page argues it in full).
  "login.linkReady": "Ya casi. Toca para entrar con la liga de tu correo.",
  // ONE REFUSAL FOR ALL FIVE WAYS A CODE FAILS — wrong, expired, already
  // used, out of guesses, another device's. Telling them apart would tell a
  // caller which one they hit, and four of the five are facts about a
  // credential they do not hold (`login.ts` argues it).
  //
  // AND IT IS THE WAY OUT RATHER THAN THE VERDICT (boundary #225's F16): a
  // fresh code is what all five need, and naming that is the one thing this
  // sentence can say that is both true of every case and worth a rep's time.
  "login.refused": "Necesitas un código nuevo. Pídelo y vuelve a intentar.",

  // Inicio, which #224 fills. In 6a it is the heading and the empty state.
  //
  // AN EMPTY FEED IS A SURFACE AND NOT A VERDICT (boundary #225's F16, and
  // Codex r2). The title is chosen from `posts.length === 0` alone, which is
  // also the state of a rep who marked no chat and of a feed served with the
  // rail down — so a title claiming Dito is at work would make an idle setup
  // read as a running one. It names the surface; the body below names what
  // arrives here and where else it lands.
  "feed.emptyTitle": "Aquí se juntan tus tarjetas.",
  "feed.emptyBody":
    "Cuando Dito tenga un borrador, una pregunta o algo que registrar, aparece aquí — y en tu WhatsApp, en el chat contigo mismo.",

  // Conexiones: the rail's state, one entry per status the store can hold.
  // «vinculado» is quiet and the two bad states are coral at the same
  // strength (Diego's reaction).
  "conexiones.lead": "El estado de tu WhatsApp.",
  "rail.linked": "WhatsApp vinculado",
  "rail.linkedBody":
    "Dito lee y escribe por ti. Si la conexión se cae o cierras la sesión desde WhatsApp, aquí lo verás.",
  "rail.dropped": "Se cayó la conexión",
  // WHAT COMES BACK IS THE SCOPE, never «everything» (Codex r3). Conexiones
  // picks this from the rail status alone, and a rep may hold an empty
  // allowlist — link day finishes at zero marked chats and Conexiones can
  // unmark the rest — so a sentence promising that re-linking resumes reading
  // would send that rep away waiting for drafts the guard will never make
  // (plane/ingest refuses an out-of-scope chat at the socket). Naming the
  // marks is true at every count, empty included, and says where they live.
  "rail.droppedBody":
    "En cuanto lo vincules otra vez, Dito sigue leyendo y escribiendo en los chats que marcaste en Conexiones. Lo que ya tenía, lo sigue teniendo.",
  "rail.loggedOut": "Sesión cerrada",
  "rail.loggedOutBody":
    "Cerraste la sesión desde WhatsApp › Dispositivos vinculados. En cuanto lo vuelvas a vincular, Dito sigue con los chats que marcaste en Conexiones.",
  "rail.qr": "Falta vincular tu WhatsApp",
  // AND LINKING IS ONE OF THE TWO CONDITIONS, never the whole of it (Codex
  // r1). «Seguir» is allowed at zero marked chats, so a rep can hold a linked
  // número and an empty allowlist — a sentence promising that Dito starts
  // reading the moment the number is linked would be the one place the app
  // overstated its own reach. It names the marks too, in `scoping.promise`'s
  // own words.
  "rail.qrBody":
    "Dito está esperando a que vincules tu número. En cuanto lo vincules, lee los chats que marques en Conexiones.",
  // THE CODE ITSELF IS NOT HERE, and cannot be: `detail` is the one
  // `rail_status_events` column rep-web holds no grant on, because a pairing
  // code is a live credential for linking a WhatsApp account
  // (…20260908100050). Conexiones says the linking is still to do; the page
  // that SHOWS a code is the link page, and it reads it through the runtime's
  // API (`link.*` below).
  "rail.pairingCode": "Falta vincular tu WhatsApp",
  "rail.pairingCodeBody":
    "Dito generó un código para vincular tu número. En cuanto lo escribas en WhatsApp, lee los chats que marques en Conexiones.",
  // THE STATE BEFORE ANY LINK AT ALL, said as where the history is (boundary
  // #225's F16). What a rep needs from this card is that their conversations
  // are still their own and that one act starts everything — which is the
  // same fact the absence was making, put where the rep can act on it.
  "rail.never": "Vincula tu WhatsApp para empezar",
  "rail.neverBody":
    "Tu historial sigue en tu teléfono. Dito empieza a leer cuando vincules tu número y marques tus chats.",
  "rail.since": "desde",
  // WHAT THE PAGE SAYS WHEN THE TWIN DOES NOT ANSWER. Conexiones renders the
  // last known state from the seam, so it works with the runtime stopped —
  // and this is the line that keeps that from reading as "everything is
  // fine". A statement about THIS SYSTEM, in the third person, never the
  // twin's voice (ADR-0037 as amended).
  "rail.unreachable":
    "Esto es lo último que sabemos de tu gemelo. Vuelve a cargar en un momento.",

  // Ajustes: one card, three rows — the avisos row's words are the block
  // at the end of this record (#265).
  "settings.emailLabel": "Tu correo",
  "settings.emailNote":
    "Con él entras, y a él llegan los códigos. Lo dio tu empresa al invitarte.",
  "settings.sessionsLabel": "Sesiones",
  "settings.sessionsNote":
    "Las sesiones duran meses. Esto las cierra todas, también la de este aparato.",
  // Confirmed INLINE, because a close that also closes this device is a tap
  // whose result the rep should see coming (Diego's reaction).
  //
  // TWO VERBS AND NOT A YES AND A NO (boundary #225's F16). Each branch of
  // this confirm says the act it performs, so a rep reading either one knows
  // what the tap does without carrying the question above it in their head —
  // and the branch that stays is a place to be rather than a refusal.
  "settings.closeConfirm": "¿Cerrar en todos tus dispositivos?",
  "settings.closeConfirmYes": "Cerrar sesiones",
  "settings.closeConfirmNo": "Seguir aquí",

  // ─────────────────────────────────────────────────────────────────────
  // INICIO'S CARDS, WHICH #224 BUILDS. The feed's second heading, the
  // draft card's lead and its post-tap strip, the day's record with its
  // window and its per-line act, the binding block, and link day's first
  // two cards. Every word here is CHROME in ADR-0037's amended sense — a
  // label, a heading or a state — and NOT ONE OF THEM IS A RECEIPT: what
  // the twin says about what it did arrives as a `receipt` part on the post
  // and is rendered verbatim (#220), never composed from a key.
  // ─────────────────────────────────────────────────────────────────────

  // The cursor's own button. A page and not an infinite scroll: Inicio has no
  // client component, so «Ver más» is a link carrying the next keyset.
  "feed.more": "Ver más",
  // WHAT THE PAGE SAYS WHEN THE RAIL IS DOWN. Inicio renders from the twin's
  // own feed, so a dropped rail does not empty it — what it changes is what a
  // tap will DO: the plane's executor is the only caller of the rail's send
  // APIs (ADR-0006), so an approved send waits. A statement about THIS
  // SYSTEM, in the third person, never the twin's voice (ADR-0037 as
  // amended).
  "feed.railDown":
    "Tu WhatsApp está desconectado. Puedes revisar y aprobar; lo que apruebes sale en cuanto lo vuelvas a vincular.",
  // ...AND WHEN THE TWIN ITSELF DOES NOT ANSWER. Conexiones already has a
  // sentence for an unreachable twin and it is about the RAIL; this one is
  // about the FEED, which cannot be shown at all without the lease holder
  // (ADR-0010) — so the page says that rather than rendering as empty.
  "feed.unreachable":
    "Tus tarjetas llegan en cuanto tu gemelo responda. Vuelve a cargar en un momento.",

  // THE POST-TAP STRIP, one entry per state rep-web can actually observe from
  // the seam (`DraftCardState` in the app argues each). They are STATES and not
  // receipts: the twin's own «Enviado a Garza ✓» is a receipt part on a post
  // of its own, rendered verbatim above the card.
  "draft.sending": "Enviando…",
  "draft.sent": "Enviado",
  "draft.failed": "Se quedó aquí",
  // `held` is ADR-0006's third outcome: the rail was touched and never
  // answered, so the message may well have left. «Se quedó aquí» here would be
  // the one lie in the strip, and so would «Enviado» — what is true is that
  // WhatsApp owes an answer, so that is the word.
  "draft.unknown": "Falta la confirmación de WhatsApp",
  "draft.dismissed": "Descartado",
  // The late second tap, off `taps`' UNIQUE(draft_id) — that constraint IS
  // the cross-surface single-use lock (ADR-0006), so this is what a rep reads
  // when they approved the same draft twice, or on two devices, or once here
  // and once with «va» in their thread.
  "draft.alreadySent": "Ya se envió",
  // ONE REFUSAL FOR EVERY WAY A SEND IS REFUSED — off the allowlist, over
  // pacing, another send still in flight, a twin with no pacing configured at
  // all. `login.refused` makes the same call for the same reason: three of the
  // four are facts about limits the rep does not set and cannot act on, and
  // telling them apart would map the store for whoever is reading. «Ya se
  // envió» is the one that is NOT collapsed into this, because it is the one a
  // rep can act on: nothing more to do.
  "draft.refused": "Se quedó aquí. Vuelve a intentar en un momento.",
  // ...AND THE ONE REFUSAL THE REP CAN ACT ON BESIDES IT (ticket #342): a
  // draft with a blank still open, which the send lock refuses until the rep
  // gives the twin the fact. Its own word because the remedy is theirs, and
  // it is what a tap without script reads — with script, Enviar asks instead.
  "draft.blankOpen": "Falta un dato en este borrador. Toca el espacio punteado y dáselo a Dito.",
  // A BLANK'S NAME FOR A SCREEN READER (ticket #342), before the twin's label
  // the capsule draws: what the capsule is, and what tapping it asks.
  "draft.blankBefore": "Dato por llenar: ",

  // The day's record. The window's close is rendered from the instant the
  // runtime carries on the card, so the sentence is a FRAME around a value
  // rather than a sentence with a time written into it — `login.codeLead*`'s
  // shape, for the same reason.
  "disclosure.windowBefore": "Puedes corregir hasta el ",
  "disclosure.windowAfter": ".",
  "disclosure.retract": "Retirar",
  "disclosure.retracted": "Retirado",
  // A LINE OPENS FOR EDITING WHERE IT STANDS (ticket #344): the field's own
  // name for a screen reader, before the line's printed number. What the rep
  // types there is their own line to the twin, never a word of the chrome's.
  "disclosure.correctLine": "Corrige la línea ",
  // THE ONE REFUSAL A CARD NAMES, because the rep can read it: the window shut
  // and the record is firm (ADR-0004). The thread says the same thing in the
  // twin's own microcopy; this is the dashboard's chrome for it.
  "disclosure.windowClosed":
    "Ya se cerró la ventana de esa línea. El registro quedó firme.",

  // The binding question's two buttons of equal weight; the ask itself is the
  // post's own prose and is not here.
  //
  // THE BUTTONS NAME THE ACT AND NOT A NAME. The customer's name is in the
  // twin's own sentence above them; a button carrying it would be code
  // composing the twin's words (ADR-0037). This is one of the two acts a
  // wrong yes cannot take back (#58's ruling), so what the button says has to
  // be what it DOES.
  "binding.confirm": "Sí, es este cliente",
  "binding.decline": "Es otro cliente",
  // ...AND WHAT THE BLOCK SAYS ONCE THE REP HAS ANSWERED, on either surface
  // (ticket #255; boundary #225's F34 — the card kept both buttons under a
  // question the rep had answered, while the receipt landed as its own post).
  // A STATE AND NOT A RECEIPT, which is the draft card's own split: the twin's
  // acknowledgement is its own post, and these two are the card saying the
  // choice has been made, in the shape `draft.sent` and `draft.dismissed` have.
  //
  // THE DECLINE RESTATES THE REP'S OWN ANSWER rather than naming what did not
  // happen (F16's rule): saying no to this question is saying the chat belongs
  // to somebody else, which is a fact about the chat said forwards. It is the
  // button's sentence SHORTENED rather than repeated, so a page carrying the
  // state can never be read as one still offering the press.
  "binding.confirmed": "Ligado",
  "binding.declined": "Otro cliente",
  // A RUN'S QUESTION CARD (ticket #324; ADR-0044's `ask` part): the twin's
  // question is its own words and is not here; this is the button that sends
  // the rep's typed answer, and the card's word once it is answered, on
  // either surface.
  "ask.answer": "Responder",
  "ask.answered": "Respondido",
  // A RUN'S REPORT HANDS THE REP A DOCUMENT AND A LIST (ticket #326; spec
  // #318 decision 34): the version beside the document's title, the button
  // that opens it, and its page's way back.
  "document.version": "versión ",
  "document.open": "Abrir",
  // «LISTO» (ticket #368; ruled 2026-10-08): the button on a card that has no
  // act of its own, and the word it shows once pressed, as the card leaves.
  "card.clear": "Listo",
  "card.cleared": "Listo",
  "document.back": "Volver a Inicio",
  "document.away": "Tu twin está fuera por ahora; el documento te espera aquí en cuanto vuelva.",
  // ...AND ONE REFUSAL FOR EVERY OTHER WAY AN ACT ON A CARD DOES NOT HAPPEN:
  // a draft already sent, a line that turns out to disclose a binding, a card
  // whose post has nothing this act works on. Collapsed for `draft.refused`'s
  // reason, and the card itself re-renders in its new state either way — which
  // is usually the whole answer.
  //
  // ...AND IT CLAIMS NOTHING ABOUT THE CARD (Codex r1). «A draft already sent»
  // is one of the cases above — a rep pressing Descartar on a card their other
  // device already sent from — so a sentence saying the card stands as it was
  // would be false precisely when the rep most needs to look. The re-render is
  // the answer, and this points at it.
  "act.refused": "Vuelve a cargar para ver cómo quedó la tarjeta.",

  // Link day's first two cards on Inicio (Diego's reaction). Both are
  // RENDERERS over typed inputs, and the fill card's read is the chat
  // directory's own progress columns joined to the chats the rep marked
  // (`fill.ts`); Inicio shows the empty state above when there is neither.
  //
  // FOUR STATES, EVERY ONE OF THEM AFFIRMATIVE (ticket #245; boundary #225's
  // F16 rule — say what is the case and what the rep can do next, never what
  // is not the case or what will happen to them). The card reads the fill's
  // own stop marker off the directory row, so each sentence is a fact the
  // plane stamped rather than a guess about how long ago a page landed.
  "fill.title": "Trayendo tu historial",
  "fill.body":
    "Dito está leyendo los últimos 90 días de los chats que marcaste. Puedes usar el tablero mientras llega.",
  // «labelled by the date reached», which is the progress a rep can actually
  // check: how far back the fill has got, rather than a percentage of a total
  // nobody can verify. It is always inside the ninety-day window, because the
  // page that crosses that line is recorded together with the stop that ends
  // the fill (`plane/directory`'s `RecordPage`).
  "fill.reachedBefore": "Ya llegó hasta el ",
  "fill.reachedAfter": ".",
  // ...AND WHAT THE CARD SAYS ONCE EVERY MARKED CHAT'S FILL HAS STOPPED
  // (ticket #245 F17). One title over three lines, and the lines are the news:
  // the ninety days are the fallback the title already implies, so it is said
  // only when there is nothing more specific to say.
  "fill.readyTitle": "Dito ya está al día con tus chats",
  // ...AND THE HEADING FOR EVERY OTHER TERMINAL MIX (Codex r3). «Al día» is
  // itself a completion claim, so it may not stand over a chat whose history is
  // still pending or one Dito only reads from today — the heading would
  // contradict the sentence under it. This one is true of every mix and leads
  // into the lines rather than summarising them.
  "fill.settledTitle": "Esto es lo que Dito ya tiene",
  "fill.doneLine": "Los chats que marcaste ya tienen sus últimos 90 días.",
  // A CHAT THE PHONE ANSWERS NO HISTORY REQUEST FOR — a group, or a chat whose
  // second identity nobody knows (`no_lid`). Its history stays on the phone,
  // and Dito reads it from today, which is the whole truth said forwards.
  //
  // IT NAMES THE CHATS AND WHAT «DESDE HOY» MEANS FOR THEM (ticket #255;
  // boundary #225's F39 — a line that named neither left the rep not knowing
  // what the card was). The names the lease holder opened are rendered BETWEEN
  // two keys, which is the shape a sentence around a value has here
  // (`fill.reachedBefore`'s own). The card renders no line at all when it has
  // no name to print, because a list of chats with nothing in it is the
  // sentence this replaces.
  "fill.fromTodayBefore": "Dito lee estos chats desde hoy: ",
  "fill.fromTodayAfter":
    ". Su historial se queda en tu teléfono, y el registro de Dito empieza con los mensajes de hoy.",
  // ...AND A CHAT THE REP MARKED AGAIN (the F23 rider). A message that arrived
  // while the chat was out of scope stays on the phone — the history request
  // returns only messages older than its anchor — so the rep is told at the
  // moment the hole is made rather than finding it in a draft.
  "fill.resumedLine":
    "Hay chats que volviste a marcar: Dito los retoma desde hoy.",
  // ...AND AN ATTEMPT THAT ENDED WITH MORE OF THE CHAT STILL ON THE PHONE —
  // the phone stopped answering, the número was disconnected, the plane
  // failed. An attempt that ENDED is not history that ARRIVED, so the ninety
  // days may not be claimed here; what the rep can do next is mark the chat
  // again, which starts another attempt, and that is what the sentence says.
  "fill.partialLine":
    "Hay chats con historial pendiente: márcalos otra vez en Conexiones y Dito sigue.",
  "avisos.title": "Deja que Dito te avise",
  // THE CARD SAYS WHAT AN AVISO DOES AND WHERE IT LANDS. A card that made its
  // case from the absence of the switch would be ADR-0031's fact — the twin
  // thread never notifies, the dashboard does — reaching the rep as a threat,
  // which is the reading boundary #225's F16 rules out. Said forwards it is
  // the same fact and asks nobody to imagine a loss, and it is a different
  // statement from the one a key called `body` was carrying, which is why
  // this one is minted (`entries.test.ts` holds the rule for both families).
  "avisos.lead":
    "Con los avisos te enteras en cuanto un borrador te espera. El aviso llega aquí, al tablero.",
  "avisos.allow": "Activar avisos",
  // ...AND WHAT THAT CARD SAYS WHEN THERE IS NOTHING TO READ (ticket #223).
  // «Seguir» is allowed at zero (Diego's reaction), so the
  // ordinary first Inicio of a cautious rep has no scoped chat at all — and a
  // fill card that rendered «trayendo tu historial» over nothing would be the
  // one lie link day can tell. It names where the switch is instead.
  //
  // SAID FORWARDS, which is F16's rule: the state as an ABSENCE is the shape
  // it refuses, so the sentence names the rep's own choice and where they make
  // it rather than what Dito is not reading.
  "fill.nothingTitle": "Tú eliges qué chats lee Dito",
  "fill.nothingBody":
    "Marca en Conexiones los chats que quieras, cuando quieras, y Dito lee sus últimos 90 días.",

  // ─────────────────────────────────────────────────────────────────────
  // LINK DAY (ticket #223): the invitation's refusal, the onboarding
  // shell's progress line, and one block per step — the intro, the email,
  // the two acknowledgments, the link page and the scoping page — plus
  // Conexiones' two new sections. The step TITLES are already above, where
  // #219 put them; what follows is everything a page around them says.
  // ─────────────────────────────────────────────────────────────────────

  // The invitation's one plain refusal. USED, EXPIRED AND UNKNOWN ARE ONE
  // ANSWER, which is `login.refused`'s own rule: nothing is learned from the
  // difference, and two of the three are facts about a credential the caller
  // does not hold. It names the way back that does not go through Dito,
  // because a rep whose link died cannot log in either — they have no
  // address on file yet.
  "invitation.refused":
    "Necesitas una liga nueva. Pídesela a quien te invitó y ábrela desde el correo o el mensaje que te llegue.",

  // THE ONBOARDING SHELL'S PROGRESS LINE, as a frame around two numbers
  // rather than a sentence with numbers written into it. How many steps a
  // rep sees depends on whether their seat already has an address (the owner
  // gave it at the invite, or the link was forwarded), so the total is
  // COMPUTED — `login.codeLead*`'s shape, for the same reason.
  "onboarding.progressBefore": "Primer día · paso ",
  "onboarding.progressOf": " de ",

  // Step 1 — the intro (Diego's reaction: variant C, the skeptic's
  // questions, with the wall as the answer to the second and a greeting by
  // name). The greeting is a frame around the rep's own name for the reason
  // the progress line is a frame around a number.
  "linkDay.introGreetingBefore": "Hola, ",
  "linkDay.introGreetingAfter": ". Esto es lo que estás por tener.",
  "linkDay.introLead": "Respuestas cortas antes de empezar.",
  "linkDay.introQ1": "¿Dito lee mis chats?",
  // THE EXCLUSIVITY IS THE SENTENCE'S SUBJECT, said as the set it covers
  // (boundary #225's F16): «esos son los que Dito lee y guarda» is the same
  // promise as the list of what it leaves alone, and it is the half a rep can
  // check against the switches they are about to touch.
  "linkDay.introA1":
    "Solo los que tú marques, desde el momento en que los marques: esos son los que Dito lee y guarda. De ahí te deja borradores listos para tus clientes y se acuerda de lo que quedó pendiente.",
  "linkDay.introQ2": "¿Mi jefe ve esto?",
  // THE WALL, SAID AS WHAT CROSSES IT (ADR-0004, and F16's rule): the answer
  // names the record the company receives and then where the conversations
  // stay, so the boundary arrives as two places rather than as a denial the
  // rep has to take on trust.
  "linkDay.introA2":
    "Ve un registro de hechos de negocio — qué cotizaste, qué te pidieron, qué prometiste — y tú ves cada dato antes de que quede firme. Tus conversaciones se quedan contigo. Lo garantiza un contrato de dos partes, tú y Dito; lo lees completo en el siguiente paso.",
  "linkDay.introQ3": "¿Me pueden bloquear el número?",
  "linkDay.introA3":
    "Sí, y te lo vamos a decir tal cual. Es el paso después del contrato: ahí te decimos de frente cuál es el riesgo, qué hace Dito para reducirlo y hasta dónde llega su promesa.",
  "linkDay.introContinue": "Seguir",

  // Step 2 — the address, which appears only while the seat has none. A
  // forwarded link is the case it exists for: the rep has no address on
  // file, so without this step they could never come back.
  "linkDay.emailTitle": "Tu correo",
  "linkDay.emailLead":
    "Con él vuelves a entrar desde cualquier aparato: te mandamos un código de seis dígitos y con eso entras. Se queda entre tú y Dito.",
  "linkDay.emailLabel": "Tu correo",
  "linkDay.emailPlaceholder": "nombre@empresa.mx",
  "linkDay.emailSubmit": "Guardar y seguir",
  // ONE REFUSAL, AND IT DOES NOT ECHO THE ADDRESS. The only way this step
  // fails is an address another seat of the same company already holds, and
  // saying which seat would tell a caller who works there.
  "linkDay.emailRefused":
    "Revisa ese correo y vuelve a intentar, o pídele ayuda a quien te invitó.",

  // Steps 3 and 4 — the two acknowledgments. The button names the ACT and
  // the VERSION (Diego's reaction: «un botón que nombra el acto y la
  // versión»; no checkbox), so the version rides between a key and nothing.
  // ITS PARTIES, AND NOTHING ABOUT SIGNING (Codex r2). The rep reaches this
  // page BEFORE acknowledging, and what the next step records is an
  // acknowledgment of a version — an e-signature is Dito-Core/dito#16 and open
  // — so a lead claiming the contract is signed would assert on the consent
  // path the one thing the consent path has yet to do. Two parties is the fact
  // the rep needs, and it is the whole of what this says.
  "linkDay.contractLead":
    "Es un contrato de dos partes: tú y Dito, la empresa que hace el gemelo. Léelo con calma, que esta página va a tu ritmo.",
  "linkDay.contractSummaryLabel": "En pocas palabras",
  "linkDay.contractTextLabel": "Texto legal",
  "linkDay.contractAcceptBefore": "Acepto mi contrato, versión ",
  // THE ONE PLACE THE APP NAMES A CONSEQUENCE, and it is named on purpose.
  // F16 rules out a sentence about what will happen to the rep; this step IS a
  // disclosure the rep acknowledges by version (spec #214 decision 6, user
  // story 12), so a lead that softened the risk would be the failure the step
  // exists to prevent. The exemption is this block — the lead, the title above
  // it and `linkDay.introQ3`'s answer — and nothing else in the package.
  "linkDay.banRiskLead":
    "Antes de vincular tu número, esto es lo que puede pasarle. Te lo decimos de frente.",
  "linkDay.banRiskSignature": "— Dito",
  // THE KEY NAMES THE FACT AND THE SENTENCE STATES IT: there is no clock on
  // this page, and what a rep gets from hearing that is the time, so that is
  // what the words hand them (boundary #225's F16).
  "linkDay.banRiskNoClock": "Léelo las veces que quieras. El tiempo es tuyo.",
  "linkDay.banRiskAcceptBefore": "Entiendo el riesgo y lo acepto, versión ",
  // WHAT THE ROW HOLDS, said on the page that writes it (spec #214 decision
  // 6: "recorded as seat, document, version, instant, device").
  "linkDay.acknowledgeNote":
    "Se guarda tu asiento, el documento, la versión que leíste, la hora y este aparato. Ese registro dice exactamente qué palabras aceptaste.",
  // THE MARKER, AND IT RENDERS. A document whose status is `placeholder` is
  // a published version a rep can acknowledge and NOT the words that will
  // stand, so the page says so above the text rather than letting a draft
  // read as final (spec #214 decision 6; Dito-Core/dito#16).
  // WHEN THE WORDS CHANGED WHILE THE REP WAS READING THEM (Codex r1). A
  // deploy can publish a new version between the render and the press, and a
  // row that recorded the NEW version for a rep who read the OLD text is
  // exactly what user story 12 exists to prevent — so the acceptance is
  // refused and the new text is on the screen. It says what happened, because
  // a page that silently reloaded would look like a button that did nothing.
  "linkDay.documentChanged":
    "El texto cambió mientras lo leías. Esta es la versión nueva: vuelve a leerla y acéptala.",
  "linkDay.documentPlaceholder":
    "Texto pendiente de revisión legal. Es un borrador de Dito; las palabras definitivas llegan como una versión nueva y te la volveremos a mostrar.",

  // Step 5 — the link page. THE CODE IS THE HERO ON A PHONE AND THE QR ON A
  // LAPTOP (ADR-0031), offered as two tabs that work with no JavaScript.
  "linkDay.linkLead":
    "Desde este mismo aparato. Ten esta página abierta y cambia a WhatsApp.",
  "link.tabCode": "Con código",
  "link.tabQr": "Con QR",
  "link.codeLabel": "Tu código",
  "link.codeStep1": "Abre WhatsApp y entra a Dispositivos vinculados.",
  "link.codeStep2":
    "Toca Vincular un dispositivo y luego Vincular con el número de teléfono.",
  "link.codeStep3": "Escribe el código de arriba.",
  // TWO SENTENCES AND NOT ONE KEY DOING BOTH JOBS (the two-axis review's
  // Spec axis): the panel either HAS a QR to show or it does not, and the
  // line above a rendered QR and the line explaining why there is none are
  // different statements. One key serving both would tell a rep looking
  // straight at a QR that they need another device to see one.
  "link.qrLead": "Escanéalo con el WhatsApp del número que vas a vincular.",
  "link.qrNone": "Para el QR necesitas otro aparato que lo muestre — una laptop.",
  "link.qrStep1": "Abre WhatsApp y entra a Dispositivos vinculados.",
  "link.qrStep2": "Toca Vincular un dispositivo y escanea este código.",
  // THE WINDOW AS A COUNTDOWN (Diego's reaction: «la ventana como una cuenta
  // regresiva»), rendered as a frame around a value the server computed —
  // there is no client JavaScript on this page, so the page reloads itself
  // and the number is right at each reload.
  "link.expiresBefore": "Caduca en ",
  "link.expiresAfter": ".",
  "link.waiting": "Esta pantalla se queda esperando a que WhatsApp confirme.",
  // ...AND THE STATE AFTER IT. Plain, and it says whose clock it is: the
  // window is WhatsApp's, not Dito's.
  "link.expiredBefore": "El código se venció a las ",
  "link.expiredAfter": ".",
  "link.expiredBody":
    "Todo sigue igual. Pide otro y continúa donde ibas — los códigos duran poco porque así lo pide WhatsApp.",
  "link.again": "Generar otro",
  // The state before there is any credential at all: nothing has been asked
  // for, or the last thing the rail said was that the connection dropped.
  "link.askTitle": "Vamos a conectar tu WhatsApp",
  "link.askBody":
    "Dito le pide a WhatsApp un código de ocho caracteres para vincular tu número. Tarda unos segundos.",
  "link.ask": "Generar mi código",
  // ...AND WHAT THE PAGE SAYS WHILE THE PLANE OWES ONE (Codex r2). It is not
  // «se venció»: the rep just pressed, and the screen they land on has to say
  // that something is coming and that they need not press again. It reloads
  // itself, so this is the whole of it.
  "link.pendingTitle": "Pidiendo tu código",
  "link.pendingBody":
    "Dito le está pidiendo el código a WhatsApp. Tarda unos segundos y esta pantalla se actualiza sola.",
  // ...AND THE TWO WAYS THAT ASK ENDS WITH NOTHING TO SHOW (#403). Each says
  // what happened in a sentence and hands the rep the same button: a screen
  // that kept waiting on either would never move. The failure says plainly
  // that it failed; the slow one makes no guess about why.
  "link.failedTitle": "Tu código falló",
  "link.failedBody":
    "Dito le pidió el código a WhatsApp y la conexión falló. Pídelo otra vez: cada intento empieza de cero.",
  "link.untakenTitle": "Tu código está tardando",
  "link.untakenBody":
    "Dito tarda más de lo normal en atender tu pedido. Pídelo otra vez en un momento.",
  // ONE REFUSAL for every way the ask ends somewhere else — the number is
  // already linked, or the twin did not answer. `login.refused`'s rule: the
  // page re-reads its own state either way, which is usually the answer, so
  // this points at that read rather than promising a code it may owe nobody.
  "link.askRefused":
    "Vuelve a cargar en un momento: la página te dice cómo quedó tu número.",
  "link.linkedTitle": "Tu número quedó vinculado.",
  "link.linkedBody":
    "Tu historial sigue en tu teléfono. Ahora eliges qué chats puede leer Dito.",
  "link.toScoping": "Elegir qué chats",
  // WHAT THE PAGE SAYS WITH THE TWIN DOWN. The rail's last known state comes
  // off the seam, so the page renders — but a credential comes only from the
  // lease holder, so this is the line that keeps an empty panel from reading
  // as «WhatsApp said no».
  // ...AND IT PROMISES NO CREDENTIAL. `unreachable` is every render where the
  // lease holder did not answer, including one where the rep has yet to press
  // «Generar mi código» — so a sentence saying a code is on its way would
  // promise a rep something only their own press starts. The feed's and the
  // scoping list's own sentences may say it arrives, because a feed and a
  // directory exist whether or not the rep asked for anything; a credential
  // does not.
  "link.unreachable":
    "Esta pantalla necesita a tu gemelo para darte un código. Vuelve a cargar en un momento.",

  // Step 6 — scoping (Diego's reaction: variant B plus a search field —
  // grouped, the whole row is the switch, everything off, and «Seguir» is
  // allowed at zero).
  "scoping.honest":
    "Esta lista viene solo de nombres y fechas: tu historial sigue en tu teléfono. Todo empieza fuera, y así se queda hasta que tú lo marques. Empezar con poco está bien.",
  "scoping.groups": "Grupos",
  "scoping.people": "Contactos",
  // THE PRESS THE WHOLE PAGE IS NOW ONE OF (#243, ruling F24). A rep marks
  // what Dito may read and one press applies the list, so the page needs a
  // word for «apply» — and a row needs no state word beside its own box,
  // which is the state.
  "scoping.save": "Guardar",
  // ...AND WHAT A PRESS THAT STOPPED PART WAY LEAVES BEHIND. The acts go one
  // per changed chat in the page's order, so a refusal midway leaves the
  // allowlist between the two lists — and the page re-reads it, so the honest
  // sentence is that this list holds, plus the press that finishes the rest.
  "scoping.savedPart":
    "Esta lista es lo que Dito lee ahora. Ajusta las marcas que quieras y presiona Guardar otra vez.",
  // ...AND WHAT A PRESS THAT APPLIED NOTHING LEAVES BEHIND (Codex r1). The
  // press diffs against the directory the lease holder serves, and that read
  // is bounded at two seconds — so a slow twin means the marks were never
  // applied. It says which chats Dito reads (the same ones) without naming
  // «esta lista», because the render this lands on may have no list to point
  // at.
  "scoping.unsaved":
    "Dito lee los mismos chats que antes. Vuelve a presionar Guardar en un momento.",
  // ...AND A PRESS THAT LANDED PART WAY WHOSE LIST THE PAGE CANNOT SHOW
  // (Codex r2). A press stops mid-loop because the twin went away, and that is
  // the same reason the next read fails — so this render has changes that
  // landed AND no list to point at. It says the first and how to reach the
  // second, and it never claims to be showing the scope.
  "scoping.savedSome":
    "Algunos cambios ya se aplicaron. Vuelve a cargar para ver tu lista y presiona Guardar otra vez.",
  "scoping.searchLabel": "Buscar un chat",
  "scoping.searchPlaceholder": "Buscar por nombre",
  "scoping.searchSubmit": "Buscar",
  "scoping.searchClear": "Ver todos",
  // A CHAT THE PLANE HAS LEARNED NO NAME FOR. The row still has to be
  // switchable — it may be the customer the rep cares most about — and the
  // one thing the page may NOT do is fall back to the phone number
  // (ADR-0004), so it says what it knows: a name is on its way, because the
  // directory learns one as messages arrive (`scoping.empty` says the same
  // thing about the whole list).
  "scoping.noName": "Chat por conocer",
  "scoping.empty":
    "Tu lista se llena conforme llegan mensajes: así los va conociendo Dito. Vuelve a esta página en un rato.",
  "scoping.unreachable":
    "Tu lista llega en cuanto tu gemelo responda. Vuelve a cargar en un momento.",
  // THE COUNT IS THE SAVED LIST AND THE LABEL SAYS SO (boundary #225's
  // F16, over the scoping form). The boxes beside it are marks a rep may have
  // changed without pressing «Guardar», so a label that named only the two
  // sides reads as a contradiction of what they are looking at; naming the
  // moment — what Dito reads TODAY — makes the number a fact about the twin
  // rather than a claim about the form. What is COUNTED is `scopeCounts`' and
  // is untouched: the number was honest all along.
  //
  // AND NEITHER HALF NAMES A NOUN, which is not brevity: the page renders each
  // key straight after a number the server counted, so a label carrying
  // «chats» would read «1 chats» on the ordinary first scoping — and a plural
  // rule in the copy package would be an i18n framework arriving one string at
  // a time (spec #214, *Rejected, not horizon*).
  //
  // ...AND IT SPEAKS FOR THIS LIST AND NOT FOR THE SCOPE (Codex r3). The page
  // counts the rows it is SHOWING — the search filters them, and a directory
  // the lease holder did not serve leaves none — so a label reading as a total
  // would answer «0» about a rep whose marked chat is one search term away.
  // «De esta lista» is what the number is counted over, and it is true at
  // every render the page has.
  "scoping.countIn": " de esta lista ya los lee Dito · ",
  "scoping.countOut": " se suman cuando los marques",
  // WHAT UNMARKING DOES, AND WHEN (#243, Codex r3). A mark is a mark until
  // the press applies it, so «en ese momento» would promise a rep that
  // unticking a private chat had already stopped Dito reading it — and a rep
  // who then left without pressing would be reading a lie. The sentence names
  // the press, and still says which half of the record stays.
  "scoping.scopeOutNote":
    "Cuando presionas Guardar, Dito deja de leer los chats que desmarcaste; lo que ya cruzó al registro se queda.",
  // THE PHONE'S OWN NOTICES, said once, on the page that causes them (#237's
  // recorded finding from the rig): WhatsApp shows a «Finished syncing»
  // notice while the history arrives, and a rep who was not told reads it as
  // something going wrong.
  "scoping.syncNotices":
    "Mientras llega tu historial, WhatsApp te va a mostrar avisos de que terminó de sincronizar. Son normales: es tu teléfono mandándole a Dito lo que ya tenías.",
  // ONE LABEL AT EVERY COUNT (#243). This press applies the marks and then
  // ends link day, and the server cannot know what is ticked — so a second
  // label chosen from the SAVED count would read «sin marcar nada» over three
  // ticked boxes. Finishing at zero is still allowed; it just says the same
  // word.
  "scoping.continue": "Seguir",
  "scoping.footNote": "Puedes cambiarlo cuando quieras en Conexiones.",

  // Conexiones' other two sections (spec #214 decision 9: "Conexiones — rail
  // state, re-link, scope rows"). The rail card is above; these two are the
  // scope rows' heading and the re-link entry.
  "conexiones.scopeTitle": "Qué chats lee Dito",
  "conexiones.relinkTitle": "Volver a vincular",
  "conexiones.relinkBody":
    "Si tu WhatsApp se desconectó o cerraste la sesión, aquí vuelves a conectarlo con un código o un QR.",
  "conexiones.relink": "Vincular otra vez",

  // ─────────────────────────────────────────────────────────────────────
  // MI LIBRETA, WHICH #264 BUILDS (spec #258 decision 17; ADR-0033 as
  // amended 2026-09-25). The prototype's words (`prototype/rep-web-teammate`,
  // `#/libreta`), in the twin's first person because the page is the twin
  // showing the rep what it believes about them — the notebook's TEXT is the
  // rep's own and arrives from the runtime, never from here.
  // ─────────────────────────────────────────────────────────────────────

  "libreta.heading": "Esto es lo que creo saber de ti",
  "libreta.how":
    "Lo anoto cuando me lo pides, por WhatsApp o desde Inicio, y cada borrador que te hago lo sigue.",
  // ONE EMPTY STATE for a notebook nobody wrote and one the rep cleared: the
  // recipe treats the two alike, and so does the rep's next draft.
  "libreta.empty":
    "Tu libreta está en blanco. Lo que me enseñes por WhatsApp o desde Inicio aparece aquí.",
  "libreta.edit": "Editar",
  "libreta.fieldLabel": "Lo que Dito sabe de ti",
  "libreta.save": "Guardar",
  "libreta.keep": "Dejarlo así",
  "libreta.saved": "Guardado. El próximo borrador ya sale así.",
  // THE CAP, NAMED ONLY WHEN REACHED, and what the rep can do about it. The
  // number is not in the sentence: it is the store's constant, rendered
  // between the two halves from the wire's own copy of it
  // (`TWIN_API_NOTEPAD_MAX_CHARS`), `login.codeLead*`'s shape.
  "libreta.capBefore": "Tu libreta llegó a sus ",
  "libreta.capAfter":
    " caracteres. Para anotar algo nuevo, junta dos reglas en una o quita la que ya sobre.",
  // WITH THE TWIN DOWN. The notebook lives in the bundle and only the lease
  // holder can open it (ADR-0010), so the page says where it is and when it
  // shows — the register `feed.unreachable` keeps.
  "libreta.unreachable":
    "Tu libreta llega en cuanto tu gemelo responda. Vuelve a cargar en un momento.",
  // ...and a «Guardar» that wrote nothing, known from the notebook itself —
  // the version it was based on still stands. The rep's text stays in the
  // field, so pressing again is all it takes.
  "libreta.unsaved":
    "Tu libreta sigue como estaba. Vuelve a presionar Guardar en un momento.",
  // ...and one whose answer never came, with the notebook unreadable too: the
  // save may have landed, so the sentence says what is certain — the text is
  // still in the field — and what to press, which settles it either way.
  "libreta.unknown":
    "Tu gemelo tarda en responder; lo que escribiste sigue aquí. Presiona Guardar otra vez en un momento.",
  // A «Guardar» composed against a notebook the thread wrote in the meantime.
  // What stands now renders under this line and the rep's text stays in the
  // field, so the sentence says how to join the two.
  "libreta.stale":
    "Anoté algo mientras editabas; así está tu libreta ahora. Junta lo tuyo con esto y presiona Guardar.",

  // MI LIBRETA'S SECOND SECTION, WHICH #322 BUILDS (spec #318 decision 33;
  // ADR-0033 as amended): the twin's own working notes, read-only, under the
  // rep's notebook. In the twin's first person, as the first section is, and
  // it says what the section IS — the notes are the twin's to keep, and the
  // rep corrects them by telling the twin. The notes' TEXT and the open
  // matters' labels arrive from the runtime, never from here.
  "libreta.notesHeading": "Lo que traigo entre manos",
  "libreta.notesHow":
    "Esto lo anoto yo para seguirte el paso. Si algo cambió, dímelo por WhatsApp o desde la barra y lo corrijo.",
  // ONE EMPTY STATE: the twin keeps its notes as the day goes, so an empty
  // section says where they appear.
  "libreta.notesEmpty": "Aquí aparece lo que voy siguiendo contigo en cuanto lo anote.",
  // The heading over the open matters, the same ones «¿Dónde quedamos?»
  // offers in the bar.
  "libreta.notesOpen": "Temas abiertos",
  // Between a matter's customer, which code renders, and the twin's label.
  "libreta.notesJoin": " · ",
  // «DOCUMENTOS» (ticket #368; ruled 2026-10-08): every document the twin
  // wrote for the rep, in its latest version, whether or not its card is on
  // Inicio — the section's heading, what it holds, its empty state, and each
  // document's two links. The titles and dates arrive from the runtime.
  "libreta.documentsHeading": "Documentos",
  "libreta.documentsHow":
    "Lo que escribí para ti, cada uno en su última versión. Ábrelo aquí o descárgalo.",
  "libreta.documentsEmpty": "Aquí aparecen los documentos que escriba para ti.",
  "libreta.documentOpen": "Abrir",
  "libreta.documentDownload": "Descargar",

  // ─────────────────────────────────────────────────────────────────────
  // THE CANVAS, WHICH #266 BUILDS (spec #258 decisions 12, 15 and 19; the
  // prototype's `WELCOME`, `HANDOFFS` and `DISMISSED` blocks on
  // `prototype/rep-web-teammate`). Inicio as a teammate's desk: the greeting
  // over the twin's line, the expander for the rest, the «nuevo» mark, the
  // words a card shows in place of its buttons, and the sentences code says
  // in the bar when a card leaves.
  //
  // WHAT IS NOT HERE IS THE TWIN'S LINE. The welcome, the return line and the
  // spotlight sentence are composed by the twin on the rep's arrival and
  // carried in a post (ADR-0044 as amended); the FALLBACK below is what stands
  // while that line is written, built by code from two typed facts.
  // ─────────────────────────────────────────────────────────────────────

  // THE GREETING OVER THE LINE, by the hour of the rep's own day, with the
  // rep's name between the two pieces. Chrome and not composition: it names
  // the rep, and a name goes through code rather than through a model.
  "canvas.greetMorning": "Buenos días, ",
  "canvas.greetAfternoon": "Buenas tardes, ",
  "canvas.greetEvening": "Buenas noches, ",
  "canvas.greetAfter": ".",
  // THE CANVAS WITH NOTHING ON IT, in code's own words where the cards would
  // be (ticket #340): the twin's line is the pill's, and a page drawn without
  // script still says the day is in order.
  "canvas.waitingNone": "Por ahora todo está al día.",
  // The expander over everything past what the canvas shows.
  "canvas.more": "Todo lo que espera",
  // The mark on a card that arrived since the rep last looked.
  "canvas.new": "nuevo",
  // A DRAFT'S OWN SENTENCE WHEN ITS POST CARRIES NONE — a draft re-expressed
  // from before parts existed recorded no prose, and a card offering Enviar
  // must still say who it is for.
  "canvas.draftForBefore": "Te dejé una respuesta para ",
  "canvas.draftForAfter": ".",
  // WHERE A DRAFT GOES WHILE THE RAIL IS DOWN, on the card, only then.
  "canvas.leavesOnRelink":
    "Sale desde tu número en cuanto vuelvas a vincular tu WhatsApp.",
  // THE WORDS ENVIAR SHOWS WITH THE RAIL DOWN: approved, and when it leaves.
  // «Enviado» would be untrue before the rail returns.
  "canvas.approved": "Aprobado",
  "canvas.leavesLater": "Sale al volver tu WhatsApp",
  // WHERE THE RECORD WENT, said in the bar when the card leaves (ruling 6 on
  // #279). Effect acknowledgements are code's (ADR-0037), with the name slot
  // filled by code between the two pieces of each.
  "canvas.wentSentBefore": "Salió a ",
  "canvas.wentSentAfter": "; queda en Trabajos en curso.",
  "canvas.wentQueuedBefore": "Aprobado para ",
  "canvas.wentQueuedAfter": ": sale al volver tu WhatsApp y queda en Trabajos en curso.",
  "canvas.wentDismissedBefore": "Descarté el borrador para ",
  "canvas.wentDismissedAfter": "; queda en Trabajos en curso.",
  "canvas.wentConfirmedBefore": "Listo: el chat quedó ligado a ",
  "canvas.wentConfirmedAfter": ".",
  "canvas.wentDeclinedBefore": "Entendido: el chat que propuse para ",
  "canvas.wentDeclinedAfter": " es de otro cliente.",
  "canvas.wentRetractedBefore": "Listo, retiré el dato ",
  "canvas.wentRetractedAfter": " de las notas.",

  // ─────────────────────────────────────────────────────────────────────
  // THE BAR, WHICH #263 BUILDS (spec #258 decisions 4, 13 and 14; the
  // prototype's `BAR` block on `prototype/rep-web-teammate`). The chrome of
  // the twin's home at the foot of every dashboard page: the region and the
  // composer, the history's glyph and its day names, the pill that takes a
  // reader to a reply that landed below them, and the two sentences the bar
  // says about itself. What the twin says in the bar is the twin's and never
  // here — the failed-reply sentence is the one line code owns, because it is
  // said exactly when the twin could not say anything.
  // ─────────────────────────────────────────────────────────────────────

  // The landmark a screen reader announces for the whole bar.
  "bar.region": "Conversación con Dito",
  // The composer's field: its spoken label and the words inside it.
  "bar.inputLabel": "Escríbele a Dito",
  "bar.placeholder": "¿En qué te ayudo?",
  "bar.send": "Mandar",
  // The clock glyph that grows the pill with the day's thread, and the
  // thread's own label (ticket #338; the UX spine's row A, «Lo de hoy»).
  "bar.history": "Lo de hoy",
  // The two day names the thread's separators say before they fall back to
  // the weekday and date, which code renders from the day itself.
  "bar.today": "Hoy",
  "bar.yesterday": "Ayer",
  // The affordance at the top of the thread that reads the days before.
  "bar.earlier": "Días anteriores",
  // The pill floating at the thread's foot when a line lands below the reader.
  "bar.newReply": "Respuesta nueva",
  // THE FAILED REPLY, in the current line beside the mark's `error`: the
  // twin had nothing for this one, and the question is back in the composer.
  "bar.failed": "Dito se quedó corto con esta. Puedes preguntarla otra vez.",
  // WITH THE TWIN DOWN, the composer's words stay where the rep typed them —
  // the register `feed.unreachable` and `libreta.unknown` keep.
  "bar.unreachable":
    "Tu gemelo tarda en responder; lo que escribiste sigue aquí. Mándalo otra vez en un momento.",
  // ...and the thread, which only the twin can open (ADR-0010).
  "bar.historyUnreachable":
    "Lo de hoy llega en cuanto tu gemelo responda.",
  // THE NUMBER'S TAIL BESIDE A CUSTOMER'S NAME (ticket #321; CONTEXT.md
  // *Reference*): rendered only where the customer has more than one chat —
  // in the twin's answers and its own lines in the bar, and on a draft card,
  // where it shows the rep which number the twin picked before the tap. The
  // digits are data; this is the words around them.
  "customer.tail": "termina en",

  // THE LEAN-IN OFFER'S ACCEPTANCE: the twin's own sentence about a card the
  // rep rested on is the pill's line, and a tap says yes to it in the rep's
  // name — the sentence quoted inside a frame of theirs, so the line in the
  // history reads as the rep agreeing rather than as the twin's words in the
  // rep's mouth.
  "bar.offerTakeBefore": "Sí, adelante con esto: «",
  "bar.offerTakeAfter": "»",
  // «¿DÓNDE QUEDAMOS?» (ticket #335; the spine's movement 5): one pill above
  // the bar when the rep comes back, in the twin's voice; tapped, the twin's
  // one line over the carousel of its open matters — the matters themselves
  // arrive from the runtime, never from here — and the carousel's own label
  // and its two arrows'.
  "bar.whereWereWe": "¿Dónde quedamos?",
  "bar.mattersIntro": "Tenemos esto a medias:",
  "bar.matters": "Lo que tenemos a medias",
  "bar.mattersBack": "Anterior",
  "bar.mattersOn": "Siguiente",
  // «VEN CONMIGO» (ticket #340; the spine's movement 6): the name the mark's
  // rest slot in the pill carries as a control — tapped, the twin goes out
  // with the rep, to the card they click next (ticket #401); pressed again,
  // it comes home.
  "bar.summon": "Dito, ven conmigo",
  // «ANTES DE QUE LA MANDES» (ticket #343; the spine's movement 11): the few
  // words before a delicate draft's reason when it rises in the pill as the rep
  // rests on Enviar — what makes this line rise now is code's fact, the reason
  // after it is the twin's own words.
  "bar.reasonLead": "Antes de que la mandes: ",

  // ─────────────────────────────────────────────────────────────────────
  // RUTINAS AND TRABAJOS EN CURSO, WHICH #267 BUILDS (spec #258 decision
  // 16; #279 rulings 9 and 10, round 2 Q9; the prototype's `RUTINAS`, `RUNS`
  // and `LOG` blocks on `prototype/rep-web-teammate`). The two pages the
  // switch heads: Rutinas' cards — each automation's name and the twin's own
  // sentence about it — with the words «when it runs» and «last ran» are
  // said in, and Trabajos en curso's runs, its day step, the act words its
  // lines open with and its empty states.
  //
  // DITO'S OWN AUTOMATIONS' SENTENCES ARE COPY IN THE TWIN'S VOICE, not
  // composition (decision 16: «from the copy package»): an automation's
  // description changes when the automation does, never with the day. NONE
  // NAMES A NUMBER — an hour is the row's, rendered by code into «Cada día a
  // las» — so a sentence cannot say one hour while the automation runs at
  // another.
  //
  // WHAT IS NOT HERE IS THE TWIN'S LINE ABOUT A DAY: Trabajos' heading is the
  // arrival line it composed, and the day's name when it composed none.
  // ─────────────────────────────────────────────────────────────────────

  // The switch that heads both pages, as a screen reader names it.
  "trabajos.switchLabel": "Rutinas y trabajos en curso",
  "trabajos.title": "Trabajos en curso",
  // Rutinas' one line under its heading, in the twin's voice.
  "rutinas.lead": "Esto es lo que hago por mi cuenta, a su hora.",
  // ONE NAME AND ONE SENTENCE PER AUTOMATION OF DITO'S, by the name its row carries.
  "rutinas.draftingName": "Respuestas a tus clientes",
  "rutinas.draftingSays":
    "Cuando un cliente te escribe, leo su chat y te dejo la respuesta lista para que la revises.",
  "rutinas.extractionName": "Lo que aprendo de tus chats",
  "rutinas.extractionSays":
    "Al cerrar el día leo tus chats y anoto lo que quedó claro: cotizaciones, pedidos y acuerdos.",
  "rutinas.disclosureName": "Las notas del día",
  "rutinas.disclosureSays":
    "Al cerrar el día te muestro lo que anoté de tus chats, para que lo revises antes de que quede firme.",
  "rutinas.remindersName": "Recordatorios",
  "rutinas.remindersSays":
    "Te aviso cuando algo tuyo está por vencer: una pregunta mía, las notas del día o un borrador que te espera. De noche guardo el aviso para la mañana.",
  "rutinas.overnightName": "Lo que te pidieron anoche",
  "rutinas.overnightSays":
    "Cada mañana leo lo que tus clientes escribieron en la noche, te dejo la lista de lo que pidieron y un borrador de respuesta para cada uno.",
  // WHEN IT RUNS: a cadence's hour follows the first two — every day, or
  // Monday to Friday (ticket #387); an event's words and the reminders' are
  // their own.
  "rutinas.dailyAt": "Cada día a las ",
  "rutinas.weekdaysAt": "Entre semana a las ",
  "rutinas.whenCustomerWrites": "Cuando un cliente te escribe",
  "rutinas.whenReminders": "Cuando algo está por vencer",
  // ...and what stands between «when it runs» and «when it last ran».
  "rutinas.whenJoin": " · ",
  // WHEN IT LAST RAN: the day's word or its date, then the clock, after this.
  "rutinas.lastRun": "Última vez: ",
  "rutinas.lastRunToday": "hoy",
  "rutinas.lastRunYesterday": "ayer",
  "rutinas.lastRunPending": "Última vez: por estrenar",
  // WHEN ITS CADENCE COMES NEXT (ticket #387): the day's word or its date,
  // then the clock, after this.
  "rutinas.nextRun": "Próxima vez: ",
  "rutinas.nextRunToday": "hoy",
  "rutinas.nextRunTomorrow": "mañana",
  "rutinas.unreachable":
    "Tus rutinas llegan en cuanto tu gemelo responda. Vuelve a cargar en un momento.",
  // THE SWITCH AND THE RUTINAS THE TWIN AUTHORS (tickets #325, #386; spec
  // #318 decisions 29–31; ADR-0044's `proposal` part). The switch's two
  // words; a weekly cadence said around the weekday code renders; a trigger
  // said by the event it waits on — any customer's message in drafting's own
  // words, one customer's by the name after «Cuando te escribe»; the plan's
  // heading, a wait's span and the card it waits on, which code renders from
  // the steps for the proposal card at both doors; that a proposal changes a
  // rutina the rep has; the two acts on the card and on Rutinas, and the
  // words a proposal card settles with. The rutina's own sentence is the
  // twin's, composed — never here.
  "rutinas.switchOn": "Activa",
  "rutinas.switchOff": "En pausa",
  "rutinas.every": "Cada ",
  "rutinas.atClock": " a las ",
  "rutinas.whenNamedWrites": "Cuando te escribe ",
  "rutinas.whenCardSettles": "Cuando resuelves una tarjeta",
  "rutinas.replaces": "Cambia una rutina que ya tienes.",
  "rutinas.plan": "Cómo la hago",
  "rutinas.waitFor": "Esperar ",
  "rutinas.spanDay": "día",
  "rutinas.spanDays": "días",
  "rutinas.spanHour": "hora",
  "rutinas.spanHours": "horas",
  "rutinas.spanMinute": "minuto",
  "rutinas.spanMinutes": "minutos",
  "rutinas.waitCard": "Esperar a que resuelvas una tarjeta",
  "rutinas.activate": "Activar",
  "rutinas.discard": "Descartar",
  // AN ACTIVE RUTINA'S ONE ACT THAT REMOVES IT (ticket #393): «Descartar»
  // stays the proposal card's answer.
  "rutinas.erase": "Borrar",
  "rutinas.activated": "Activada",
  "rutinas.discarded": "Descartada",
  // THE RUNS (ticket #323; ADR-0044's `run` part): the list's spoken name,
  // what stands when none is going, and a run's row — its state word, its one
  // detail, its steps on demand and its two acts.
  "trabajos.runs": "En marcha",
  "trabajos.runsIdle":
    "Aquí aparece lo que tengo en marcha. Abajo está lo que hice, día por día.",
  // A run the twin gave no name the page can read.
  "trabajos.runUnnamed": "Un trabajo",
  // THE STATE WORD, one per state and one per flag that stands over it.
  "trabajos.runReady": "Por empezar",
  "trabajos.runRunning": "Trabajando",
  "trabajos.runWaiting": "En espera",
  "trabajos.runSucceeded": "Listo",
  "trabajos.runFailed": "Se detuvo",
  "trabajos.runPaused": "En pausa",
  "trabajos.runCancelled": "Cancelado",
  // THE ONE DETAIL: the step it stands at, or when its wait comes due.
  "trabajos.runStep": "Paso ",
  "trabajos.runOf": " de ",
  "trabajos.runUntil": "Hasta el ",
  "trabajos.runEnded": "Terminó a las ",
  "trabajos.detailJoin": " · ",
  // ...AND, INSIDE A REPEAT, WHICH PASS IT IS ON (ticket #324): «Vuelta 2 de 3».
  "trabajos.runPass": "Vuelta ",
  // WHAT A WAITING RUN'S STILL MARK SAYS (ticket #368): what it waits on,
  // read from the run's own rows — the clock, before the instant it wakes;
  // a customer's reply; a card the rep has in front of them; the runs its
  // `each` started, one per item.
  "trabajos.awaitsClock": "Dito espera hasta el ",
  "trabajos.awaitsReply": "Dito espera la respuesta de un cliente",
  "trabajos.awaitsCard": "Dito espera a que resuelvas una tarjeta",
  "trabajos.awaitsRuns": "Dito espera a que terminen los trabajos que empezó",
  // THE STEPS ON DEMAND: the disclosure's label, each kind's word and each state's.
  "trabajos.runSteps": "Pasos",
  "trabajos.stepAgent": "Pensar",
  "trabajos.stepCode": "Calcular",
  "trabajos.stepAct": "Hacer",
  "trabajos.stepPost": "Avisar",
  "trabajos.stepWait": "Esperar",
  "trabajos.stepIf": "Decidir",
  // ...a question to the rep, a child run per item, a repeat, and the end of
  // the run from inside a branch (ticket #324).
  "trabajos.stepAsk": "Preguntarte",
  "trabajos.stepEach": "Uno por uno",
  "trabajos.stepWhile": "Repetir",
  "trabajos.stepEnd": "Terminar",
  "trabajos.stepPending": "Pendiente",
  "trabajos.stepRunning": "En curso",
  "trabajos.stepWaiting": "En espera",
  "trabajos.stepSucceeded": "Hecho",
  "trabajos.stepFailed": "Se detuvo",
  // THE ROW'S ACTS, each a dashboard act on the run.
  "trabajos.runPause": "Pausar",
  "trabajos.runResume": "Reanudar",
  "trabajos.runCancel": "Cancelar",
  // THE DAY'S RUNS THAT ENDED, listed in its history above its acts.
  "trabajos.runsEnded": "Trabajos que terminaron",
  // THE DAY STEP: today and yesterday by name, the two arrows' spoken labels.
  "trabajos.today": "Hoy",
  "trabajos.yesterday": "Ayer",
  "trabajos.dayBefore": "Día anterior",
  "trabajos.dayAfter": "Día siguiente",
  // A DAY WITH NO LINE, said as what the page holds.
  "trabajos.emptyToday": "Lo que haga hoy queda aquí, con su hora.",
  "trabajos.emptyDay": "Ese día quedó en blanco.",
  "trabajos.unreachable":
    "Lo que hice llega en cuanto tu gemelo responda. Vuelve a cargar en un momento.",
  // THE ACT WORDS, each the first thing its line says (CONTEXT.md *Acts log*),
  // and what joins a word to its subject.
  "trabajos.actSent": "Enviado",
  "trabajos.actDismissed": "Descartado",
  "trabajos.actConfirmed": "Ligado",
  "trabajos.actDeclined": "Otro cliente",
  "trabajos.actRetracted": "Retirado",
  "trabajos.actReminded": "Recordatorio",
  "trabajos.actDisclosed": "Notas del día",
  // «Listo» on a card with no act of its own (ticket #368), named by its document.
  "trabajos.actCleared": "Listo",
  "trabajos.actJoin": " · ",
  // A RETRACTION'S SUBJECT: the number the notes printed, and whose day.
  "trabajos.retractedLine": "dato ",
  "trabajos.retractedOf": " de las notas de ",
  "trabajos.retractedOfDated": " de las notas del ",
  "trabajos.notesToday": "hoy",
  "trabajos.notesYesterday": "ayer",

  // ─────────────────────────────────────────────────────────────────────
  // THE CHROME FROM THE RULINGS (#265; spec #258 decisions 7, 17 and 19;
  // #279 round 1 rulings 8, 12, 13, round 2 Q7, Q8): the bell and its page,
  // the two clauses a glyph's label gains while its dot shows, the groups'
  // reason line, and the Ajustes row for the avisos on this device. A dot is
  // `aria-hidden`, so the clause beside the label is what says it in words.
  // ─────────────────────────────────────────────────────────────────────

  // The bell's label, and the heading of the page it opens.
  "nav.avisos": "Avisos",
  // The clause the bell's label gains while something new waits.
  "bell.newClause": ", con algo nuevo",
  // ...and Conexiones', while the rail is down (#279 ruling 12, round 2 Q8).
  "conexiones.downClause": ", se cayó la conexión",
  // THE BELL'S PAGE: one line per knock the dashboard sent, by its type.
  // CODE SENTENCES, never the knock itself: what the twin composed for the
  // lock screen is stored nowhere, so the list names the occasion.
  "bell.draftReady": "Un borrador listo para revisar",
  "bell.questionAsked": "Una pregunta de Dito para ti",
  "bell.reminder": "Un recordatorio de algo por vencer",
  "bell.open": "Ver en Inicio",
  "bell.empty": "Aquí aparecen los avisos que Dito te manda a tus aparatos.",
  // THE ONE LINE OVER THE GROUPS (#279 ruling 12, «as drawn»): why a group
  // brings its messages from the day it is marked.
  "scoping.groupsReason":
    "Los grupos se leen desde el día que los marcas: su historial se queda en tu teléfono.",
  // AJUSTES' AVISOS ROW: its label, a word for each state this device can be
  // in and the note under it (`avisos.ts` holds the table; the iPhone's state
  // is «por activar» with the home-screen note). The button is `avisos.allow`,
  // the same one the first-day card offers (spec #258 decision 19: Ajustes
  // offers it again).
  "settings.avisosLabel": "Avisos",
  "avisos.statePending": "Por activar en este aparato",
  "avisos.stateOn": "Activados en este aparato",
  "avisos.stateBlocked": "Tu navegador los tiene bloqueados",
  "avisos.iosNote":
    "En iPhone, los avisos llegan a Dito instalado en tu pantalla de inicio: toca Compartir y luego «Agregar a inicio», abre Dito desde ahí y permite los avisos.",
  "avisos.note":
    "Un borrador o una pregunta, algo por vencer, tu WhatsApp desconectado. Con los avisos apagados, todo te espera en Inicio.",
  "avisos.blockedNote":
    "Actívalos en los ajustes de tu navegador para este sitio y vuelve aquí.",

  // ─────────────────────────────────────────────────────────────────────
  // THE PERMISSION MOMENT, LATE (#269; spec #258 decisions 17 and 19; #279
  // round 1 ruling 14, round 2 Q10): the words around the browser's own
  // dialog, never the dialog. The twin's line beside the first-day card is
  // its own knock and is not here; what is here is chrome — the card, the
  // button's state, the acknowledgement after the rep answered, and two of
  // Ajustes' states. Every one says what IS the case and what the rep can do
  // next: a rep who said no reads where the way back is, never a warning.
  // ─────────────────────────────────────────────────────────────────────

  // The installed app's name under its icon on a home screen (`manifest.ts`).
  "avisos.appName": "Dito",
  // THE iPHONE'S FIRST STEP, and the card's heading: push reaches an iPhone
  // only through Dito installed on the home screen, which `avisos.iosNote`
  // says under it, with how.
  "avisos.iosTitle": "Primero, Dito en tu pantalla de inicio",
  // The button while the browser's dialog is open and the subscription saves.
  "avisos.allowing": "Activando…",
  // THE ACKNOWLEDGEMENTS, in the bar's current line once the card leaves: what
  // the answer did, from its result (ADR-0037: an effect's acknowledgement is
  // code's). A no is taken as said, and the rep is told where the way back is:
  // after a browser's no, only its own settings can ask again, which is what
  // Ajustes then says.
  "avisos.granted": "Listo: los avisos llegan a este aparato.",
  "avisos.declined": "Entendido. Cuando quieras, Ajustes te dice cómo activarlos.",
  "avisos.failed": "Algo se atoró al activarlos; prueba otra vez en un momento.",
  // TWO OF AJUSTES' STATES: the avisos are on for this seat on another login
  // only, and a browser that cannot receive a push at all.
  "avisos.stateElsewhere": "Activados en otro de tus aparatos",
  "avisos.elsewhereNote": "Para que también lleguen a este, actívalos aquí.",
  "avisos.stateUnavailable": "Este navegador guarda tus avisos en Inicio",
  "avisos.unavailableNote":
    "Para que lleguen a tu pantalla, abre Dito en un navegador actualizado y actívalos ahí.",
} as const satisfies Readonly<Record<string, string>>;

export type ChromeKey = keyof typeof CHROME;

/**
 * THE PACE THE BAR PLAYS THE TWIN'S ACCEPTED WORDS BACK AT (ticket #375;
 * ruled 2026-10-09): nothing of a turn's words reaches the page while the
 * twin writes them, and once the turn commits them the pill types them out —
 * so they read as a person typing rather than a block dropped in. Chrome's
 * timing beside chrome's words, so the pace is one reviewed value and never a
 * number in a component.
 *
 * 28 MS A CHARACTER is about 35 characters a second, the pace a rep reads
 * Spanish prose at: the words come as fast as the eye takes them, so the rep
 * reads along and never waits on a typist, yet each word visibly arrives. A
 * name a reference renders comes whole, timed by its letters.
 *
 * 260 MS AFTER A SENTENCE ENDS, and between two paragraphs: the breath a
 * person takes before the next sentence, which is what makes a line read as
 * typed rather than scrolled.
 *
 * 5 S AT MOST for a line's words: the rep already waited on the turn, and a
 * long answer plays faster rather than holding them. A typical line of one
 * or two sentences plays in two to four seconds.
 */
export const BAR_PLAYBACK = {
  charMs: 28,
  sentenceMs: 260,
  mostMs: 5_000,
} as const;
