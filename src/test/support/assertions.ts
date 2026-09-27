// SPDX-License-Identifier: MIT
// Test helper: the TypeScript form of Swift's `#expect(throws: SomeError.case(...)) { ... }`.

import assert from "node:assert/strict"

/** An error class of the port: it carries its Swift error case in `info`. */
type InfoErrorClass<Info> = abstract new (...args: never[]) => Error & { readonly info: Info }

/** Asserts that `body` throws an `errorClass` whose `info` deep-equals `info`. */
export function assertThrowsInfo<Info>(errorClass: InfoErrorClass<Info>, info: Info, body: () => unknown, message?: string): void {
  assert.throws(
    body,
    (error: unknown) => {
      assert.ok(error instanceof errorClass, `expected ${errorClass.name}, got ${String(error)}${message ? ` (${message})` : ""}`)
      assert.deepEqual(error.info, info, message)
      return true
    },
    message
  )
}
