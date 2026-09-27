// SPDX-License-Identifier: MIT
// Ported from Swooey Tests/DiagSessionTests/SecretTests.swift (MIT).

// DiagCodec's Secret (AGENTS.md: passwords travel as a non-printable `Secret`; credentials.md §4
// rule 4). Invented passwords follow docs/testing.md §8 (D15).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { inspect } from "node:util"
import { Secret } from "../../../diag/codec/index.js"
import { utf8 } from "../../support/sessionTestSupport.js"

describe("Secret: a password that never prints", () => {
  const password = "sardines-4-ever" // secret-scan: allow invented test password (D15)

  /** description, debug description, interpolation, dump and reflection show a fixed placeholder, no byte and no length */
  test("neverPrints", () => {
    for (const text of ["!", password, "herring".repeat(9)]) {
      const secret = new Secret(utf8(text))
      const shown = [
        String(secret),
        `${secret}`,
        secret.toString(),
        JSON.stringify(secret),
        inspect(secret),
        inspect(secret, { depth: Infinity, showHidden: true })
      ]
      for (const view of shown) {
        assert.ok(!view.includes(text), view)
        assert.ok(!view.includes("sardines"))
        assert.ok(!/\d/.test(view), `no length: ${view}`)
      }
      // The port's placeholder is "Secret(redacted)" (Swift: "Secret(withheld)"; docs/porting.md).
      assert.equal(String(secret), "Secret(redacted)")
      // Swift's Mirror has no children: the port keeps the bytes in a private field.
      assert.deepStrictEqual(Reflect.ownKeys(secret), [])
    }
  })

  /** the bytes are read only through withBytes; length questions are yes or no */
  test("bytes", () => {
    const secret = new Secret(utf8(password))
    assert.deepStrictEqual(secret.withBytes(bytes => bytes.slice()), utf8(password))
    assert.ok(!secret.isEmpty)
    assert.ok(secret.fits(40))
    assert.ok(secret.fits(utf8(password).length))
    assert.ok(!secret.fits(utf8(password).length - 1))
    assert.ok(new Secret([]).isEmpty)
    const copy = secret
    assert.equal(copy.withBytes(bytes => bytes.length), utf8(password).length, "copies share the bytes")
  })

  /** init(wiping:) zeroes and empties the caller's array; the secret keeps its own copy */
  test("wiping", () => {
    const typed = Array.from(utf8(password))
    const secret = Secret.wiping(typed)
    assert.equal(typed.length, 0)
    assert.deepStrictEqual(secret.withBytes(bytes => bytes.slice()), utf8(password))
  })

  /** a caller's array is never shared with the secret: changing it later changes nothing */
  test("ownBuffer", () => {
    const bytes = utf8(password)
    const secret = new Secret(bytes)
    bytes[0] = "X".charCodeAt(0)
    assert.equal(secret.withBytes(view => view[0]), "s".charCodeAt(0))
  })

  /** not Codable, Equatable or Hashable */
  test("noConformances", () => {
    // TypeScript has no conformances to test: the port's counterparts are that JSON carries only the
    // placeholder, nothing decodes a secret, and there is no equality or hash method.
    const secret = new Secret(utf8(password))
    assert.equal(JSON.stringify(secret), JSON.stringify("Secret(redacted)"))
    const members = (value: object): string[] => Object.getOwnPropertyNames(value)
    for (const name of ["decode", "fromJSON", "parse"]) assert.ok(!members(Secret).includes(name), `Secret.${name}`)
    for (const name of ["equals", "hash", "hashCode", "compare"]) assert.ok(!members(Secret.prototype).includes(name), `secret.${name}`)
  })
})
