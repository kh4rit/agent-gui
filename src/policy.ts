// SPDX-License-Identifier: MIT
// What the agent may do on a system: which transactions it may start and work in, which
// OK-codes are refused, and which functions count as committing (they go through gui_save only).
//
// This is a guard rail, not a guarantee: the SAP user's authorisations are the real limit.
// Some transactions write on Enter or F8, and no deny list is complete.

import type { SystemConfig } from "./config.js"

/**
 * Transactions refused unless a system's config drops the built-in list: user and role
 * administration, RFC destinations, OS commands and jobs, transport administration, client
 * settings, running arbitrary programs, database utilities, lock/update/process administration,
 * system parameters, ICF, certificates and software maintenance.
 */
export const BUILT_IN_DENIED_TRANSACTIONS: readonly string[] = [
  "SU01", "SU10", "SU12", "SU02", "SU03", "SU24", "SU25", "PFCG",
  "SM59", "SM49", "SM69", "SM36",
  "STMS", "STMS_IMPORT", "STMS_QA",
  "SCC1", "SCC4", "SCC5", "SCC9", "SCCL", "SE06",
  "SA38", "SE38", "SE37", "SE24", "SE80",
  "SE14", "DB02",
  "SM12", "SM13", "SM50", "SM51",
  "RZ10", "RZ11", "SICF", "STRUST", "SPAM", "SAINT", "SNOTE"
]

/** OK-codes refused on every system: the debugger and the table editing mode of SE16N. */
export const BLOCKED_OKCODES: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /^\/h/i, reason: "the debugger (/h) is not available to the agent" },
  { pattern: /&SAP_EDIT/i, reason: "the table editing mode (&SAP_EDIT) is not available to the agent" }
]

/** The virtual key of Save (Ctrl+S) in SAP's standard toolbar. */
export const SAVE_VIRTUAL_KEY = 11

export class PolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PolicyError"
  }
}

/** What an OK-code does to the session, as far as the client parses it. */
export type OkCodeIntent =
  | { kind: "start"; transaction: string; newSession: boolean }
  | { kind: "endTransaction" }
  | { kind: "newSession" }
  | { kind: "endSession" }
  | { kind: "logOff" }
  | { kind: "function"; code: string }

/**
 * Parses the prefixes a client understands (Swooey architecture.md §6.1): `/nCODE`, `/oCODE`,
 * bare `/n`, `/o`, `/i`, `/nex`, `/nend`. Everything else is a function code the server
 * interprets.
 */
export function parseOkCode(okcode: string): OkCodeIntent {
  const text = okcode.trim()
  const upper = text.toUpperCase()
  if (upper === "/NEX" || upper === "/NEND") return { kind: "logOff" }
  if (upper === "/N") return { kind: "endTransaction" }
  if (upper === "/O") return { kind: "newSession" }
  if (upper === "/I") return { kind: "endSession" }
  // A transaction code, optionally in a namespace: /nSM30, /o/SCWM/MON.
  const m = /^\/([NO])\s*((?:\/[A-Z0-9_]+\/)?[A-Z0-9_]+)$/i.exec(text)
  if (m) return { kind: "start", transaction: m[2].toUpperCase(), newSession: m[1].toUpperCase() === "O" }
  return { kind: "function", code: text }
}

/** The per-system policy. */
export class Policy {
  private readonly denied: Set<string>
  private readonly allowed: Set<string> | undefined
  private readonly commit: Set<string>

  constructor(readonly system: Pick<SystemConfig, "name" | "readOnly" | "transactions" | "commitFunctions">) {
    this.denied = new Set([
      ...(system.transactions.builtInDenyList === false ? [] : BUILT_IN_DENIED_TRANSACTIONS),
      ...(system.transactions.deny ?? [])
    ])
    this.allowed = system.transactions.allow ? new Set(system.transactions.allow) : undefined
    this.commit = new Set(system.commitFunctions.map(c => c.toUpperCase()))
  }

  get readOnly(): boolean {
    return this.system.readOnly
  }

  /** Why a transaction may not be used, or undefined when it may. */
  transactionRefusal(transaction: string): string | undefined {
    const code = transaction.trim().toUpperCase()
    if (!code) return undefined
    if (this.denied.has(code)) return `transaction ${code} is not available to the agent on ${this.system.name} (deny list)`
    if (this.allowed && !this.allowed.has(code))
      return `transaction ${code} is not in the allowed list of ${this.system.name} (${[...this.allowed].join(", ")})`
    return undefined
  }

  /** Throws when the transaction may not be started. */
  checkStart(transaction: string): void {
    const refusal = this.transactionRefusal(transaction)
    if (refusal) throw new PolicyError(refusal)
  }

  /**
   * Throws when the agent may not work on a screen of `transaction` (the one the server reports
   * for the current screen). Leaving the screen is always allowed (`allowLeaving`).
   */
  checkScreen(transaction: string | undefined, allowLeaving: boolean): void {
    if (!transaction || allowLeaving) return
    const refusal = this.transactionRefusal(transaction)
    if (refusal) throw new PolicyError(`${refusal}. Leave it with Back (F3), Cancel (F12) or /n.`)
  }

  /** Throws when an OK-code is refused; returns what it does otherwise. */
  checkOkCode(okcode: string): OkCodeIntent {
    for (const blocked of BLOCKED_OKCODES) if (blocked.pattern.test(okcode.trim())) throw new PolicyError(blocked.reason)
    const intent = parseOkCode(okcode)
    if (intent.kind === "start") this.checkStart(intent.transaction)
    if (intent.kind === "function" && this.isCommitCode(intent.code))
      throw new PolicyError(`function ${intent.code} saves; use gui_save`)
    return intent
  }

  /** Whether a function code is configured as committing. */
  isCommitCode(code: string | undefined): boolean {
    if (!code) return false
    return this.commit.has(code.trim().toUpperCase().replace(/^=/, ""))
  }

  /**
   * Whether a trigger commits: Save's virtual key, the function code the current GUI status binds
   * to it (`saveCode`), or a configured commit function.
   */
  isCommit(trigger: { virtualKey?: number; functionCode?: string }, saveCode: string | undefined): boolean {
    if (trigger.virtualKey === SAVE_VIRTUAL_KEY) return true
    const code = trigger.functionCode?.trim().toUpperCase()
    if (!code) return false
    if (saveCode && code === saveCode.trim().toUpperCase()) return true
    return this.isCommitCode(code)
  }

  /** Throws on read-only systems. */
  checkWrite(): void {
    if (this.system.readOnly) throw new PolicyError(`system ${this.system.name} is read-only: saving is disabled`)
  }
}
