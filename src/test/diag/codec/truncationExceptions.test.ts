// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagCodecTests/TruncationExceptionsTests.swift (MIT).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { PENDING_KINDS } from "../../vectors/kinds.js"
import { loadVector, vectorFiles } from "../../vectors/paths.js"
import { runVector } from "../../vectors/registry.js"
import { VectorFile } from "../../vectors/vectorFile.js"
import { NO_ERROR } from "../../vectors/wireRunners.js"
import { INSIGNIFICANT_LAST_BYTE } from "../../support/allVectors.js"

/**
 * Task #43: the truncation check of AllVectorsTests skips no positive vector silently. A vector is
 * positive when its expected error is `none`, or when its kind has no error classes at all
 * (test/vectors/README.md, "ni-payload": every input gets a class). Dropping the last input byte of
 * a positive vector must be noticed, unless the spec itself makes that byte insignificant; those
 * vectors, and only those, are listed in `INSIGNIFICANT_LAST_BYTE` with the spec's reason. Derived
 * here from the README, independently of the harness's own selection.
 *
 * The vectors checked are those the harness runs: every kind not in PENDING_KINDS (Swift's
 * `AllVectorsTests.paths`).
 */
describe("All vectors: truncation exceptions", () => {
  for (const path of vectorFiles()) {
    const vector = loadVector(path)
    if (PENDING_KINDS.has(vector.kind)) continue
    test(`everyPositiveVectorWithAnInsignificantLastByteIsListed(${path})`, () => {
      const listed = INSIGNIFICANT_LAST_BYTE.has(path)
      // The ADT kinds hold text documents and request bodies, not byte layouts; the truncation rule
      // does not apply to them.
      if (vector.kind.startsWith("adt-")) {
        assert.ok(!listed, `${path}: ADT vectors are not listed`)
        return
      }
      const positive = (vector.expectations.get("expect.error") ?? NO_ERROR) === NO_ERROR
      if (!positive || vector.bytes.length === 0) {
        assert.ok(!listed, `${path}: listed, but it is negative or has no input byte to drop`)
        return
      }
      const shorter = new VectorFile(vector.path, vector.header, vector.bytes.subarray(0, -1))
      const unnoticed = runVector(shorter, PENDING_KINDS).status === "passed"
      assert.equal(
        unnoticed,
        listed,
        `${path}: dropping the last input byte is ${unnoticed ? "unnoticed" : "noticed"}, but the vector is ${listed ? "" : "not "}listed`
      )
    })
  }
})
