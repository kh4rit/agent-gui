// SPDX-License-Identifier: MIT
// The kind registry of the vector harness (Swooey Tests/VectorSupport/VectorRunner.swift, MIT).

import { Expectations } from "./expectations.js"
import type { VectorFile } from "./vectorFile.js"

/**
 * Runs one vector of a kind: reads its `expect.*` values from `expect`, compares them with what
 * the code under test produces for `input`, and pushes one message per mismatch to `failures`.
 */
export type KindRunner = (input: Uint8Array, expect: Expectations, failures: string[], vector: VectorFile) => void

const runners = new Map<string, KindRunner>()

/** Registers the runner of a vector kind (called by the `*Runners.ts` modules). */
export function registerKind(kind: string, runner: KindRunner): void {
  if (runners.has(kind)) throw new Error(`vector kind ${kind} registered twice`)
  runners.set(kind, runner)
}

export const registeredKinds = (): string[] => [...runners.keys()].sort()

/** Vectors are goldens: the result of a run is the list of failures, empty when it passed. */
export type VectorOutcome = { status: "passed" } | { status: "failed"; failures: string[] } | { status: "skipped"; reason: string }

/**
 * Runs a vector against the runner its kind names and compares the result with its `expect.*`
 * lines. An unknown kind, a missing required key, a malformed value, and an `expect.*` key no
 * check read all count as failures; a pending kind is skipped with its reason.
 */
export function runVector(vector: VectorFile, pendingKinds: ReadonlyMap<string, string>): VectorOutcome {
  const runner = runners.get(vector.kind)
  if (!runner) {
    const reason = pendingKinds.get(vector.kind)
    if (reason) return { status: "skipped", reason }
    return { status: "failed", failures: [`${vector.path}: unknown kind '${vector.kind}'`] }
  }
  const expect = new Expectations(vector.expectations)
  const failures: string[] = []
  try {
    runner(vector.bytes, expect, failures, vector)
  } catch (e) {
    failures.push(`runner threw: ${(e as Error).stack ?? e}`)
  }
  failures.push(...expect.problems)
  failures.push(...expect.unconsumedKeys.map(k => `expect key ${k} was not consumed by the ${vector.kind} runner`))
  return failures.length ? { status: "failed", failures: failures.map(f => `${vector.path}: ${f}`) } : { status: "passed" }
}
