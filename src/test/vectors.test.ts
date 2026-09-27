// SPDX-License-Identifier: MIT
// Runs every byte vector in test/vectors whose kind has a runner (Swooey's Tests/Vectors, MIT).

import { test } from "node:test"
import assert from "node:assert/strict"
import { PENDING_KINDS } from "./vectors/kinds.js"
import { loadVector, vectorFiles } from "./vectors/paths.js"
import { registeredKinds, runVector } from "./vectors/registry.js"

const files = vectorFiles()

test("the vector directory holds vectors", () => {
  assert.ok(files.length > 200, `only ${files.length} vectors found`)
})

test("no kind is both registered and pending", () => {
  for (const kind of registeredKinds()) assert.ok(!PENDING_KINDS.has(kind), `${kind} is registered and still listed as pending`)
})

for (const path of files) {
  const vector = loadVector(path)
  const outcome = runVector(vector, PENDING_KINDS)
  test(`vector ${path}`, t => {
    if (outcome.status === "skipped") return t.skip(outcome.reason)
    if (outcome.status === "failed") assert.fail(outcome.failures.join("\n"))
  })
}
