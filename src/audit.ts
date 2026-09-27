// SPDX-License-Identifier: MIT
// The audit log: one JSON line per action the agent took, in one file per day under
// <dataDir>/audit, owner-only. It records what was done, never a password.

import { appendFileSync, chmodSync, mkdirSync } from "node:fs"
import { join } from "node:path"

export interface AuditEntry {
  /** Tool that acted, e.g. gui_step. */
  tool: string
  system: string
  client?: string
  user?: string
  session?: string
  /** Transaction and screen the action was taken on. */
  transaction?: string
  program?: string
  screen?: string
  /** What was sent: the trigger (Enter, F8, function code …). */
  trigger?: string
  /** Fields changed in the step: technical name (or label) and value, unless values are off. */
  changes?: { field: string; value?: string }[]
  /** The outcome: the next screen's transaction/program and its status message. */
  result?: { transaction?: string; program?: string; screen?: string; messageType?: string; message?: string }
  /** Error text when the action failed. */
  error?: string
}

/** Appends audit entries; failures to write never break a tool call. */
export class AuditLog {
  private readonly dir: string

  constructor(
    dataDir: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.dir = join(dataDir, "audit")
  }

  /** The file of the given day. */
  fileFor(date: Date): string {
    return join(this.dir, `${date.toISOString().slice(0, 10)}.jsonl`)
  }

  /** Writes one entry. `withValues: false` drops field values. */
  record(entry: AuditEntry, withValues: boolean): void {
    const time = this.now()
    const clean: AuditEntry = withValues ? entry : { ...entry, changes: entry.changes?.map(c => ({ field: c.field })) }
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const file = this.fileFor(time)
      appendFileSync(file, JSON.stringify({ time: time.toISOString(), ...clean }) + "\n", { mode: 0o600 })
      try {
        chmodSync(file, 0o600)
      } catch {
        // not supported on this file system
      }
    } catch (e) {
      console.error(`agent-gui: cannot write the audit log in ${this.dir}: ${(e as Error).message}`)
    }
  }
}
