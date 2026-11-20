/**
 * NOTIFY'S TEMPLATES (ticket #219; spec #214 decision 13 and *Notify, in
 * detail*; spec #258's *Notification end to end*; ADR-0022 as amended,
 * ADR-0019's sixth flow, ADR-0037 as amended).
 *
 * FOUR MESSAGES LEAVE BY EMAIL and they are the only four: the invitation
 * that starts link day, the six-digit code that logs a rep in on a second
 * device, and the two GRAVE EVENTS — the rail dropped, the rail logged out
 * (spec #258 decision 7). Every one of them is chrome: it labels, names and
 * explains, and states nothing about the rep's record, which is what lets a
 * fixed sentence live in code at all.
 *
 * THE GRAVE PAIR IS IN THE CHARACTER-SILENT REGISTER (ADR-0037). Nothing the
 * twin would say is in either: they report what is the case and name the one
 * thing the rep can do next, which is re-link in Conexiones. The twin's own
 * voice reaches a rep through the knock on a push and through nothing else.
 *
 * THE SLOTS ARE THE WHOLE OF WHAT AN OCCASION MAY BIND, and none of the four
 * email templates declares `text` or `composed`: ADR-0022's "no free-text
 * parameter exists" is enforced at the catalog (@dito/notify refuses a
 * template declaring either on an email type), and these are written so that
 * refusal never has to fire. A link, a six-digit code, a count of minutes and
 * the rep's own name are the values, and every one is bounded by its type
 * (`slots.ts`).
 *
 * THE PUSH TEMPLATES ARE THE OTHER FAMILY (ticket #262). A push carries a
 * title, a body and a link: the SUBJECT is the title a lock screen shows above
 * the body, and it is the product's name because the notification is from
 * Dito and a title that re-stated the occasion would be a form. The three that
 * announce a post declare ONE `composed` slot, which notify fills from a
 * sealed post part and from nothing else; the two grave pushes declare no slot
 * at all, because code knows the whole sentence. The LINK is never a slot
 * here — notify appends the deep link from the deployment's own dashboard
 * origin, so nothing a template or a caller holds decides where a tap lands.
 *
 * THE NAME COMES FROM SEAT STATE, NOT FROM THE CALLER. Every email template
 * greets the rep by name, and @dito/notify fills that slot from the seat it
 * resolved rather than from the send request — the same argument as the
 * address: a caller that could type the name could type anything into a
 * message it does not otherwise control. A push carries no name at all: a
 * lock screen is already the rep's own.
 *
 * `minutes` IS A SLOT RATHER THAN A SENTENCE, and that is not decoration.
 * The ten-minute expiry is the LOGIN FLOW's (spec #214 decision 4), so a
 * copy that wrote «diez minutos» would be a second home for a
 * number that lives somewhere else — and the day it moved, this text would
 * quietly lie to a rep about how long they have.
 *
 * AND EVERY ONE IS UNDER THE DASHBOARD'S OWN LANGUAGE RULE (boundary #225's
 * F16; `entries.test.ts` holds it over both keyed families): a message is app
 * language wherever it is read, so each one says what IS the case and what the
 * rep can do next — the correo that arrived by mistake, the connection to make
 * again — rather than what is not the case or what will happen to them.
 */
import type { CopyTemplate } from "./template.js";
import { checkTemplate } from "./template.js";

/**
 * The record: template key → template.
 *
 * CHECKED AT IMPORT, so a malformed template — a hole no slot declares, a
 * slot no hole renders — fails when the package loads rather than at the
 * one send that needed it. A message nobody can render is not a message.
 */
export const TEMPLATES = {
  "notify.invitation": {
    key: "notify.invitation",
    subject: "Tu tablero de Dito está listo",
    body: [
      "Hola {name}:",
      "",
      "Este es tu enlace para entrar a tu tablero de Dito y conectar tu",
      "WhatsApp. Ábrelo en el teléfono donde tienes WhatsApp.",
      "",
      "{url}",
      "",
      "Si te llegó por error, ignóralo.",
    ].join("\n"),
    slots: { name: "name", url: "url" },
  },
  "notify.loginCode": {
    key: "notify.loginCode",
    subject: "Tu código para entrar a Dito",
    body: [
      "Hola {name}:",
      "",
      "Tu código para entrar es {code}. Vence en {minutes} minutos y sirve",
      "una sola vez.",
      "",
      "Si estás en este mismo aparato, entra directo aquí:",
      "",
      "{url}",
      "",
      "Si te llegó por error, ignóralo.",
    ].join("\n"),
    slots: { name: "name", code: "code", minutes: "count", url: "url" },
  },
  "notify.railDropped": {
    key: "notify.railDropped",
    subject: "Vuelve a conectar tu WhatsApp con Dito",
    body: [
      "Hola {name}:",
      "",
      "Tu WhatsApp se desconectó de Dito, así que Dito está esperando para",
      "seguir leyendo tus chats. Vuelve a conectarlo en Conexiones:",
      "",
      "{url}",
      "",
      "Si te llegó por error, ignóralo.",
    ].join("\n"),
    slots: { name: "name", url: "url" },
  },
  "notify.railLoggedOut": {
    key: "notify.railLoggedOut",
    subject: "Tu WhatsApp cerró la sesión de Dito",
    body: [
      "Hola {name}:",
      "",
      "Tu teléfono cerró la sesión de Dito en WhatsApp. Conéctalo otra vez",
      "en Conexiones y Dito sigue donde quedó:",
      "",
      "{url}",
      "",
      "Si te llegó por error, ignóralo.",
    ].join("\n"),
    slots: { name: "name", url: "url" },
  },
  "notify.push.draftReady": {
    key: "notify.push.draftReady",
    subject: "Dito",
    body: "{body}",
    slots: { body: "composed" },
  },
  "notify.push.questionAsked": {
    key: "notify.push.questionAsked",
    subject: "Dito",
    body: "{body}",
    slots: { body: "composed" },
  },
  "notify.push.reminder": {
    key: "notify.push.reminder",
    subject: "Dito",
    body: "{body}",
    slots: { body: "composed" },
  },
  "notify.push.railDropped": {
    key: "notify.push.railDropped",
    subject: "Dito",
    body: "Tu WhatsApp se desconectó. Vuelve a conectarlo en Conexiones.",
    slots: {},
  },
  "notify.push.railLoggedOut": {
    key: "notify.push.railLoggedOut",
    subject: "Dito",
    body: "Tu teléfono cerró la sesión de Dito. Conéctalo otra vez en Conexiones.",
    slots: {},
  },
} as const satisfies Readonly<Record<string, CopyTemplate>>;

export type TemplateKey = keyof typeof TEMPLATES;

/**
 * FROZEN, TEMPLATES AND SLOT MAPS BOTH, before anything reads them (Codex
 * r1).
 *
 * The check below runs once, when this module loads. That is only a
 * guarantee if what it checked cannot change afterwards: a mutable slot map
 * could gain a `text` slot and a matching hole AFTER `@dito/notify`'s
 * catalog had approved the template, and the renderer — which checks values
 * against types and never re-checks the types themselves — would then hand
 * a caller's prose to SES through a message type ADR-0022 says carries no
 * free text. `DOCUMENTS` and `NOTIFY_CATALOG` are frozen for the same
 * reason; this record was the one that was not.
 */
for (const template of Object.values(TEMPLATES)) {
  checkTemplate(template);
  Object.freeze(template.slots);
  Object.freeze(template);
}
Object.freeze(TEMPLATES);
