// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagSession/LogonStep.swift (MIT).

import {
  ClientInputError,
  ClientInputStep,
  CodecSpecGap,
  InputEnvelope,
  InputFocus,
  ReturnedField,
  ScreenSpecGapError,
  ScreenText,
  SESValue,
  type LogonInputField,
  type Secret
} from "../codec/index.js"
import type { DiagSession } from "./diagSession.js"
import type { DiagTransport } from "./diagTransport.js"
import type { ServerMessage } from "./serverMessage.js"
import { SessionSendError, describeSessionSendError, type SessionSendErrorInfo } from "./sessionState.js"

/** `util.inspect`'s custom hook, without importing node:util (src/diag stays portable). */
const INSPECT = Symbol.for("nodejs.util.inspect.custom")

/**
 * What a person types to log on: client, user, password and, optionally, the logon language. The
 * texts are sent as typed; their character set is the negotiated code page's (#18), the logon
 * screen's `ServerMessage.codePage`. The password is a `Secret`. Nothing of it prints: the
 * description, `toString()`, `toJSON()` and `util.inspect` show a fixed placeholder, because the
 * client and the user stay out of logs too (architecture.md §9).
 */
export class LogonCredentials {
  client: Uint8Array
  user: Uint8Array
  password: Secret
  /** The logon language; undefined or empty sends none, and the server uses its default. */
  language: Uint8Array | undefined

  constructor(fields: { client: Uint8Array; user: Uint8Array; password: Secret; language?: Uint8Array }) {
    this.client = fields.client
    this.user = fields.user
    this.password = fields.password
    this.language = fields.language
  }

  get description(): string {
    return "LogonCredentials(withheld)"
  }

  toString(): string {
    return this.description
  }

  toJSON(): string {
    return this.description
  }

  [INSPECT](): string {
    return this.description
  }
}

/** Which logon field an input is (credentials.md §5.1; server-screen.md R-SS-9). The raw value is the name. */
export type LogonFieldRole = "client" | "user" | "password" | "language"

export const LogonFieldRole = {
  allCases: ["client", "user", "password", "language"] as readonly LogonFieldRole[]
} as const

/**
 * The dlg flags of each returned field (client-input.md §3, #34; Swift `LogonStepOptions.DialogFlags`).
 * - `asReceived`: Reading R-CI-4: the flags as the server sent them on the field, with the new text.
 *   The reference client's constant flags equal those of the screen it answers.
 * - `markedChanged`: the field marked changed: blocked, since which bit means changed is #34;
 *   building the step then fails with `ClientInputError` `specGap` 34.
 */
export type LogonStepOptionsDialogFlags = "asReceived" | "markedChanged"

/**
 * The choices a logon step makes where the spec is open. The defaults follow the readings the spec
 * gives for the reference client; each can be switched. A Swift struct: `clone()` copies it.
 */
export class LogonStepOptions {
  dialogFlags: LogonStepOptionsDialogFlags = "asReceived"
  /**
   * The SES item sent before the fields: the reference client's, with `event_array = 1` and every
   * other field 0 (client-input.md §5, R-CI-5, PV-0760); undefined sends none. Its meaning is #32.
   */
  ses: SESValue | undefined = new SESValue({ eventArray: 1 })
  /**
   * The maxnrchars that tells the visible logon inputs apart (R-SS-9): the example screen's client,
   * user and language fields (PV-0724). A real server's lengths are not in the sources.
   */
  clientMaxNrChars = 3 // provenance: PV-0724
  userMaxNrChars = 12 // provenance: PV-0724
  languageMaxNrChars = 2 // provenance: PV-0724
  /**
   * Which parts of the reference input envelope the step sends (client-input.md §11). Undefined, the
   * default, lets `DiagSession.logOn` choose by the session's identity (`InputEnvelope.default`:
   * `chlStage` with the reference identity and its variants, none with the others); `LogonStep` on
   * its own takes undefined as `InputEnvelope.minimal`.
   *
   * With `InputEnvelope.changedBit` the returned fields carry bit 0x01 of dlg_flag_2 (R-CI-13). A
   * client, user or language field that holds a value is returned whether or not the value changed:
   * on the logon screen the server wants the prefilled client back (PV-0784), unlike open-diag-go's
   * client, which leaves an unchanged field out (PV-0777). With `InputEnvelope.focus` the step's
   * DYNT_FOCUS_1 names the password field, where the cursor is when the user submits, with column
   * offset 0 (R-CI-16).
   */
  envelope: InputEnvelope | undefined = undefined

  /** A copy of the options. */
  clone(): LogonStepOptions {
    return Object.assign(new LogonStepOptions(), this)
  }

  /** The maxnrchars that finds a visible field; undefined for the password, which is found by INVISIBLE (R-SS-9). (Swift internal.) */
  maxNrChars(role: LogonFieldRole): number | undefined {
    switch (role) {
      case "client":
        return this.clientMaxNrChars
      case "user":
        return this.userMaxNrChars
      case "language":
        return this.languageMaxNrChars
      case "password":
        return undefined
    }
  }
}

/**
 * Why no logon step was built or written. The descriptions name the rule, never a text and never a
 * length: a password's length stays withheld (#40).
 */
export type LogonStepErrorInfo =
  /** The screen's items were not read. */
  | { readonly kind: "notDecoded" }
  /** The screen is a server error (IMPL-DH-8). */
  | { readonly kind: "serverError" }
  /** The screen is not the logon program (R-SS-5); nothing is sent to it. */
  | { readonly kind: "notLogonProgram" }
  /** DYNPRONAME repeats, so the logon program cannot be told (#54). */
  | { readonly kind: "identityRepeats" }
  /** Not exactly one password field (INVISIBLE; credentials.md §5.1, R-SS-9). */
  | { readonly kind: "passwordFields"; readonly count: number }
  /** No visible input field with the role's maxnrchars (R-SS-9), though a text was given. */
  | { readonly kind: "missingField"; readonly role: LogonFieldRole }
  /** More than one visible input field with the role's maxnrchars (R-SS-9). */
  | { readonly kind: "ambiguousField"; readonly role: LogonFieldRole }
  /** The field's payload was not decoded, so its maximum length is unknown (IMPL-DA-2, #36). */
  | { readonly kind: "unknownFieldWidths"; readonly role: LogonFieldRole }
  /** The text is longer than the field's maxnrchars (counted in bytes). */
  | { readonly kind: "textTooLong"; readonly role: LogonFieldRole }
  /**
   * The field cannot be returned: the options ask for a changed flag (#34), or the atom cannot be
   * written. The reason is not kept, since it may hold the text's length.
   */
  | { readonly kind: "fieldNotEncodable"; readonly role: LogonFieldRole; readonly specGap: number | undefined }
  /** The step was built but not written (`DiagSession.submit`). */
  | { readonly kind: "notSent"; readonly error: SessionSendErrorInfo }

export class LogonStepError extends Error {
  constructor(readonly info: LogonStepErrorInfo) {
    super(describeLogonStepError(info))
    this.name = "LogonStepError"
  }

  /** Whether the step was built but its write failed, which disconnected the session. */
  get isNotWritten(): boolean {
    return this.info.kind === "notSent" && this.info.error.kind === "notWritten"
  }
}

/** Throws `LogonStepError` with `info`. */
function fail(info: LogonStepErrorInfo): never {
  throw new LogonStepError(info)
}

/** The error in words (Swift `LogonStepError.description`): the rule, never a text or a length. */
export function describeLogonStepError(info: LogonStepErrorInfo): string {
  switch (info.kind) {
    case "notDecoded":
      return "the screen was not decoded"
    case "serverError":
      return "the screen is a server error (IMPL-DH-8)"
    case "notLogonProgram":
      return "the screen is not the logon program (R-SS-5)"
    case "identityRepeats":
      return `DYNPRONAME repeats, so the logon program cannot be told (spec gap #${CodecSpecGap.identityItemRepeats})`
    case "passwordFields":
      return `the screen has ${info.count} password field(s), not exactly one (R-SS-9)`
    case "missingField":
      return `no ${info.role} field on the screen (R-SS-9)`
    case "ambiguousField":
      return `more than one ${info.role} field on the screen (R-SS-9)`
    case "unknownFieldWidths":
      return `the ${info.role} field's lengths were not decoded`
    case "textTooLong":
      return `the ${info.role} is longer than its field accepts`
    case "fieldNotEncodable":
      return `the ${info.role} field cannot be returned` + (info.specGap === undefined ? "" : ` (spec gap #${info.specGap})`)
    case "notSent":
      return `the logon step was not sent: ${describeSessionSendError(info.error)}`
  }
}

/**
 * The logon input step for a logon screen (credentials.md §5.1; client-input.md §1–§3, R-CI-3): the
 * reference client's SES (R-CI-5), then one EFIELD_2 atom per logon field that holds a value, in the
 * screen's atom order, each at the received field's block, row and column with its widths and, by
 * default, its dlg flags (R-CI-4). The password field always goes, with the `Secret`'s bytes.
 * Client, user and language go with the credential's text when it is not empty, else with the text
 * the server put in the field when there is one, changed or not: the owner's server did not accept a
 * logon step without its prefilled client (client-input.md §11.7, PV-0784).
 *
 * The screen must be the logon program (R-SS-5) with exactly one password field, the one INVISIBLE
 * input, whose maxnrchars bounds the password; the other fields are found by their maxnrchars
 * (R-SS-9, `LogonStepOptions`), never by position. No function code is set: the reference client
 * submits its logon without one (client-input.md §7.4).
 */
export class LogonStep {
  /** The step to send. */
  readonly input: ClientInputStep
  /** The fields the step returns, in the order sent. */
  readonly roles: readonly LogonFieldRole[]

  /** Builds the step for `message`, the logon screen the server sent. Throws `LogonStepError`. */
  constructor(message: ServerMessage, credentials: LogonCredentials, options: LogonStepOptions = new LogonStepOptions()) {
    const screen = message.screen
    if (screen === undefined) fail({ kind: "notDecoded" })
    if (screen.isServerError) fail({ kind: "serverError" })
    let isLogon = false
    try {
      isLogon = message.isLogonProgram()
    } catch (error) {
      if (!(error instanceof ScreenSpecGapError)) throw error
      fail({ kind: "identityRepeats" })
    }
    if (!isLogon) fail({ kind: "notLogonProgram" })
    const fields = screen.fields
    const passwords = fields.passwordFields
    if (passwords.length !== 1) fail({ kind: "passwordFields", count: passwords.length })
    const password = passwords[0]
    const passwordLimit = password.maxNrChars
    if (passwordLimit === undefined) fail({ kind: "unknownFieldWidths", role: "password" })
    if (!credentials.password.fits(passwordLimit)) fail({ kind: "textTooLong", role: "password" })

    const envelope = options.envelope ?? InputEnvelope.minimal
    // The visible fields to fill, found by maxnrchars.
    const chosen: { field: LogonInputField; role: LogonFieldRole }[] = [{ field: password, role: "password" }]
    const texts = new Map<LogonFieldRole, Uint8Array>()
    const isChosen = (field: LogonInputField): boolean =>
      chosen.some(entry => entry.field.itemIndex === field.itemIndex && entry.field.atom.index === field.atom.index)
    for (const role of ["client", "user", "language"] as const) {
      const length = options.maxNrChars(role)
      if (length === undefined) continue
      const matches = fields.inputFieldsWithMaxNrChars(length)
      const text = LogonStep.text(role, credentials)
      if (text === undefined || text.length === 0) {
        // No text given: the field goes with the value the server put in it, if any.
        if (matches.length !== 1) continue
        const field = matches[0]
        if (isChosen(field)) continue
        const received = LogonStep.receivedText(field, message)
        if (received === undefined || received.length === 0) continue
        texts.set(role, received)
        chosen.push({ field, role })
        continue
      }
      if (!(matches.length <= 1)) fail({ kind: "ambiguousField", role })
      if (matches.length === 0) fail({ kind: "missingField", role })
      const field = matches[0]
      // Two roles with the same maxnrchars would fill one field twice.
      if (isChosen(field)) fail({ kind: "ambiguousField", role })
      if (!(text.length <= length)) fail({ kind: "textTooLong", role })
      texts.set(role, text)
      chosen.push({ field, role })
    }
    // In the screen's atom order, as the reference client returns them (PV-0724).
    chosen.sort((a, b) => a.field.itemIndex - b.field.itemIndex || a.field.atom.index - b.field.atom.index)

    const step = new ClientInputStep({ ses: options.ses, envelope })
    for (const { field, role } of chosen) {
      try {
        let returned = ReturnedField.received(field.atom)
        if (options.dialogFlags === "markedChanged") returned = returned.markedChanged()
        if (InputEnvelope.contains(envelope, InputEnvelope.changedBit)) returned = returned.withChangedBit()
        if (role === "password") step.appendSecretField(returned, credentials.password)
        else step.appendField(returned, texts.get(role) ?? new Uint8Array(0))
      } catch (error) {
        if (!(error instanceof ClientInputError)) throw error
        const info = error.info
        if (info.kind === "unknownFieldWidths") fail({ kind: "unknownFieldWidths", role })
        if (info.kind === "specGap") fail({ kind: "fieldNotEncodable", role, specGap: info.issue })
        fail({ kind: "fieldNotEncodable", role, specGap: undefined })
      }
    }
    if (InputEnvelope.contains(envelope, InputEnvelope.focus)) step.focus = new InputFocus(password.atom.row, password.atom.col)
    this.input = step
    this.roles = chosen.map(entry => entry.role)
  }

  /**
   * The text the server sent in `field`, trailing spaces and zero bytes removed (R-SS-4), or
   * undefined when its text part was not decoded. Never called for the password field.
   */
  private static receivedText(field: LogonInputField, message: ServerMessage): Uint8Array | undefined {
    const range = field.atom.textRange
    if (field.atom.isPasswordField || range === undefined) return undefined
    const start = field.itemValue.lowerBound
    return message.withItems(items => {
      const text = items.subarray(start + range.lowerBound, start + range.upperBound)
      return ScreenText.trimmedRange(text).of(text).slice()
    })
  }

  private static text(role: LogonFieldRole, credentials: LogonCredentials): Uint8Array | undefined {
    switch (role) {
      case "client":
        return credentials.client
      case "user":
        return credentials.user
      case "language":
        return credentials.language
      case "password":
        return undefined
    }
  }

  /** The roles and the input step's counts; never a text or a length. */
  get description(): string {
    return `LogonStep(fields: ${this.roles.join(", ")}; ${this.input.description})`
  }

  toString(): string {
    return this.description
  }

  toJSON(): string {
    return this.description
  }

  [INSPECT](): string {
    return this.description
  }
}

/**
 * Builds the logon step for `screen`, the message the server sent, and writes it (`LogonStep`,
 * `DiagSession.submit`). Unless `options` names an envelope, the session's identity chooses it: the
 * reference input envelope's `chlStage` with the reference identity and its variants
 * (`InputEnvelope.default`, client-input.md §11). Returns the step that was written; its reply comes
 * from `nextMessage()`, and the state is `active` once that reply is a screen past the logon screen.
 * Nothing is written when it throws `LogonStepError`, except that a failed write disconnects the
 * session (`notSent`). (Swift: `extension DiagSession { logOn(_:on:options:) }`; call it as
 * `session.logOn(credentials, screen, options)`.)
 */
export async function logOn<Transport extends DiagTransport>(
  session: DiagSession<Transport>,
  credentials: LogonCredentials,
  screen: ServerMessage,
  options: LogonStepOptions = new LogonStepOptions()
): Promise<LogonStep> {
  const chosen = options.clone()
  if (chosen.envelope === undefined) chosen.envelope = InputEnvelope.default(session.machine.identity)
  const step = new LogonStep(screen, credentials, chosen)
  try {
    await session.submit(step.input)
  } catch (error) {
    if (error instanceof SessionSendError) throw new LogonStepError({ kind: "notSent", error: error.info })
    throw error
  }
  return step
}
