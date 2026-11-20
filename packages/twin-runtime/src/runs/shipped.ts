/**
 * THE RUNS DITO SHIPS (tickets #324, #326; spec #318 decision 27), in the
 * shape the twin writes an inline run in, so the same engine runs both and
 * `definition.test.ts` parses both through the same parser.
 *
 * WHAT THE RUN DOES IS CODE'S; WHAT IT SAYS IS THE TWIN'S. The steps, their
 * order and their fields are here; every sentence the rep reads — the question
 * on the card, each child's line, the report — is an agent step's typed output
 * in the rep's language, and the run's own name is the thread's (`start_workflow`
 * takes it beside `shipped`). The instructions below are the model's, and the
 * rep's own words reach a run only as its inputs.
 *
 * NOTHING HERE SENDS. Every draft a run writes is `create_draft`'s card behind
 * the rep's tap (ADR-0006), and the spotlight, the knock and every line in the
 * bar stay the thread's (decisions 21 and 25): a run lands cards.
 */
import type { RunDefinition } from "./definition.js";
import type { ShippedRunName } from "./shipped-names.js";

/** The reads an agent step looks through a customer's history with. */
const LOOKS = ["search_memory", "resolve_chat", "read_entity", "search_messages", "read_message"];

/**
 * «BÚSCAME LOS CLIENTES QUE YA NO ME CONTESTAN»: find the customers whose
 * conversations went quiet → ask which to write to → one child per chosen
 * customer drafts a follow-up → the parent reports over the children's lines.
 * When nobody went quiet the run ends with the twin's line saying so.
 */
const STALE_RELATIONSHIPS: RunDefinition = {
  name: "stale_relationships",
  budget: { iterations: 40, tokens: 1_500_000 },
  steps: [
    {
      kind: "agent",
      name: "find",
      instructions: [
        "Find the rep's customers whose conversations went quiet: they used to write back and have stopped answering the rep's last messages, or have not written in a while where they used to write often. Look through memory and their conversations with your tools; never guess.",
        "Return every such customer in `customers`, each as their reference, and in `reasons`, in the same order, a few words each on why — in the rep's language.",
        "Write `question`: one short question to the rep, in their language and register, asking whether you should write a follow-up draft for all of them or only some, saying how many you found.",
        "Write `summary`: one short line to the rep saying what you looked at and, when you found nobody, that everybody is answering.",
      ].join("\n\n"),
      tools: LOOKS,
      output: { customers: "list", reasons: "list", question: "string", summary: "string" },
    },
    { kind: "code", name: "tally", recipe: "count", inputs: { list: "find.customers" } },
    {
      kind: "if",
      name: "found",
      when: { field: "tally.count", is: "more", value: 0 },
      then: [
        {
          kind: "ask",
          name: "choose",
          question: "find.question",
          fields: [{ name: "customers", kind: "pick_many", options: "find.customers" }],
        },
        {
          kind: "each",
          name: "drafts",
          over: "choose.customers",
          item: "customer",
          body: [
            {
              kind: "agent",
              name: "follow_up",
              instructions: [
                "This run is for one customer: input.customer. Read their conversation with your tools and write them a short, warm follow-up that picks up where it went quiet, in the customer's own conversation language.",
                "Create it with create_draft for that customer, with no knock: the draft waits behind the rep's tap and nothing is sent.",
                "Then return `line`: one short line to the rep, in their language, saying who the draft is for — as their reference — and what it picks up.",
              ].join("\n\n"),
              tools: ["search_memory", "read_entity", "search_messages", "read_message", "create_draft"],
              output: { line: "string" },
            },
          ],
        },
        { kind: "post", name: "report", text: "drafts.outputs" },
      ],
      else: [{ kind: "end", name: "nobody", value: "find.summary" }],
    },
  ],
};

/**
 * «SIGUE A SERGIO HASTA QUE CONTESTE, MÁXIMO TRES INTENTOS»: while the
 * customer has not replied and the attempts are not spent, draft a follow-up
 * and wait for their reply or the days to pass; then report how it went.
 * Its inputs are the customer's reference (`customer`), the most attempts
 * (`attempts`) and the days to wait after each (`days`).
 */
const STANDING_GOAL: RunDefinition = {
  name: "standing_goal",
  budget: { iterations: 30, tokens: 800_000 },
  steps: [
    {
      kind: "while",
      name: "follow",
      when: { field: "answer.replied", is: "unequal", value: true },
      cap: "input.attempts",
      body: [
        {
          kind: "agent",
          name: "nudge",
          instructions: [
            "This run follows up with input.customer until they reply, at most input.attempts times; the attempt you are on is `follow.iteration` in what the run holds. Read their conversation with your tools — including what you wrote on earlier attempts, above in this conversation — and write the next short follow-up, in the customer's own conversation language, never repeating an earlier one.",
            "Create it with create_draft for that customer, with no knock: the draft waits behind the rep's tap and nothing is sent.",
            "Then return `line`: one short line to the rep, in their language, saying which attempt this is and what the draft says.",
          ].join("\n\n"),
          tools: ["search_memory", "read_entity", "search_messages", "read_message", "create_draft"],
          output: { line: "string" },
        },
        { kind: "wait", name: "answer", until: { reply: "input.customer", within: { days: "input.days" } } },
      ],
    },
    {
      kind: "agent",
      name: "summary",
      instructions:
        "Write the run's report to the rep, in their language and register: whether input.customer replied and on which attempt (`answer.replied`, `follow.iteration`), or that the attempts ran out with no reply, and what you suggest next. Name the customer by their reference.",
      tools: [],
      output: { line: "string" },
    },
    { kind: "post", name: "report", text: "summary.line" },
  ],
};

/**
 * «BÚSCAME HOTELES EN MADRID PARA LA SEMANA QUE VIENE Y ÁRMAME UN DOCUMENTO»
 * (ticket #326): gather sources on the web and in the rep's memory → when the
 * twin found sources, write the document into the workspace → the report
 * hands the rep the document; when it found none, the run ends on its line
 * saying so. Its input is the rep's ask (`topic`).
 *
 * WHETHER THERE ARE SOURCES ENOUGH IS THE TWIN'S CALL, typed in `found`: the
 * `if` reads that field and no rule of code's guesses at sources from the
 * notes (agentic first, 2026-09-29).
 */
const RESEARCH_AND_DOCUMENT: RunDefinition = {
  name: "research_and_document",
  budget: { iterations: 24, tokens: 1_200_000 },
  steps: [
    {
      kind: "agent",
      name: "gather",
      instructions: [
        "Research input.topic — the rep's own ask — on the web with WebSearch, a few searches from different angles; look with search_memory for anything the rep's customers said about it, and with search_messages for what the rep told you and the documents you already wrote.",
        "Return `found`: true when you found sources worth writing up for the rep, false when you did not — that decision is yours. Return `sources`: each source you will use, as its title and its address. Return `notes`: what you found, fact by fact, for the next step to write the document from — or, when `found` is false, one short line to the rep in their language saying what you looked for and that nothing came up worth a document.",
      ].join("\n\n"),
      tools: ["WebSearch", "search_memory", "search_messages"],
      output: { found: "boolean", sources: "list", notes: "string" },
    },
    {
      kind: "if",
      name: "sourced",
      when: { field: "gather.found", is: "true" },
      then: [
        {
          kind: "agent",
          name: "write",
          instructions: [
            "Write the document the rep asked for — input.topic — from what the gather step found, above in this conversation: in the rep's language, organised for them to use, each fact with the address of the source it came from.",
            "Write it into your workspace with Write as one Markdown file with a short lowercase name ending in .md, opening with a `# ` heading that is its title. Read it back and fix it with Edit if anything is off.",
            "Then return `path`: the file's path as you wrote it, and `line`: one short line to the rep, in their language, saying what the document holds.",
          ].join("\n\n"),
          tools: ["Read", "Write", "Edit"],
          output: { path: "string", line: "string" },
        },
        { kind: "post", name: "report", text: "write.line", document: "write.path" },
      ],
      else: [{ kind: "end", name: "nothing_found", value: "gather.notes" }],
    },
  ],
};

/**
 * «¿QUÉ ME PIDIERON ANOCHE?» (ticket #326): read what the rep's customers
 * asked for overnight → the briefing — the twin's line and the requests, one
 * row each, every customer by reference — → one child per request writes the
 * reply as a draft behind the rep's tap. The drafts are the result; the run
 * ends once every child has.
 */
const OVERNIGHT_REQUESTS: RunDefinition = {
  name: "overnight_requests",
  budget: { iterations: 80, tokens: 3_000_000 },
  steps: [
    {
      kind: "agent",
      name: "read_night",
      instructions: [
        "Read what the rep's customers wrote since the rep's last working day ended — the night before the now you were given — with your tools, and find each thing a customer asked the rep for: a price, an order, a delivery, a question waiting on an answer.",
        "Return `requests`: one line per request, in the rep's language, naming the customer by their reference and saying what they asked for. Return `summary`: one short line to the rep, in their language and register, saying how many requests came in overnight and that you are drafting the replies.",
      ].join("\n\n"),
      tools: ["search_memory", "search_messages", "read_message", "resolve_chat", "read_entity"],
      output: { requests: "list", summary: "string" },
    },
    { kind: "post", name: "briefing", text: "read_night.summary", list: "read_night.requests" },
    {
      kind: "each",
      name: "drafts",
      over: "read_night.requests",
      item: "request",
      body: [
        {
          kind: "agent",
          name: "reply",
          instructions: [
            "This run answers one request: input.request. Read that customer's conversation with your tools and write the reply that answers it, in the customer's own conversation language.",
            "Create it with create_draft for that customer, with no knock: the draft waits behind the rep's tap and nothing is sent.",
            "Then return `line`: one short line to the rep, in their language, saying who the draft is for — as their reference — and what it answers.",
          ].join("\n\n"),
          tools: ["read_message", "search_memory", "create_draft"],
          output: { line: "string" },
        },
      ],
    },
    { kind: "end", name: "done" },
  ],
};

/** The shipped runs, by the registry word `start_workflow({ shipped })` names. */
export const SHIPPED_RUNS: Readonly<Record<ShippedRunName, RunDefinition>> = {
  stale_relationships: STALE_RELATIONSHIPS,
  standing_goal: STANDING_GOAL,
  research_and_document: RESEARCH_AND_DOCUMENT,
  overnight_requests: OVERNIGHT_REQUESTS,
};
