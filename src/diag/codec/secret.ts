// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/Secret.swift (MIT).

// A password in memory (AGENTS.md, "Passwords travel as the non-printable `Secret` type";
// docs/credentials.md §4 rule 4). Not a protocol fact: nothing here is sent or read on the wire.

import { inspect } from "node:util"

/** What every description of a secret shows: no byte and no length. */
const PLACEHOLDER = "Secret(redacted)"

/**
 * A password as bytes. It prints nothing: `toString()`, `toJSON()` and `util.inspect` show a fixed
 * placeholder, never a byte and never the length, so string interpolation, `JSON.stringify`,
 * `console.log` and test failure messages cannot leak it. The bytes live in a private field (`#`),
 * which neither reflection nor `assert.deepStrictEqual` sees.
 *
 * The bytes live in one buffer of their own, never shared with the caller's arrays. Swift
 * overwrites them with zeros when the last copy of the value is released; JavaScript has no
 * deinitialiser, so the owner calls `dispose()`, which zero-fills the buffer. Whatever the caller
 * still holds (the array it was built from, a typed line) is the caller's to wipe;
 * `Secret.wiping` does that for an array.
 *
 * The bytes are read only through `withBytes`; the one consumer is the input step's password
 * field (`ClientInputStep.appendField(_:secret:)`).
 */
export class Secret {
  readonly #bytes: Uint8Array

  /** A secret holding a copy of `bytes`. The caller's array is left as it is. */
  constructor(bytes: ArrayLike<number>) {
    this.#bytes = Uint8Array.from(bytes)
  }

  /**
   * A secret holding the bytes of `bytes`, which are then overwritten with zeros; a plain array is
   * also emptied (Swift `init(wiping:)`).
   */
  static wiping(bytes: Uint8Array | number[]): Secret {
    const secret = new Secret(bytes)
    bytes.fill(0)
    if (Array.isArray(bytes)) bytes.length = 0
    return secret
  }

  /** Whether the secret holds no byte. */
  get isEmpty(): boolean {
    return this.#bytes.length === 0
  }

  /**
   * Whether the secret holds at most `maxByteCount` bytes. The only question about its length that
   * can be asked, so that no caller holds the length itself: a field's maximum length bounds the
   * password (credentials.md §5.1).
   */
  fits(maxByteCount: number): boolean {
    return this.#bytes.length <= maxByteCount
  }

  /**
   * Runs `body` with the bytes. The view must not escape `body`, and nothing in `body` may log,
   * print or keep the bytes.
   */
  withBytes<Result>(body: (bytes: Uint8Array) => Result): Result {
    return body(this.#bytes)
  }

  /** Overwrites the bytes with zeros (Swift wipes them in `deinit`). The secret is empty-valued afterwards. */
  dispose(): void {
    this.#bytes.fill(0)
  }

  /** A fixed placeholder: no byte and no length. */
  toString(): string {
    return PLACEHOLDER
  }

  /** A fixed placeholder, so that `JSON.stringify` writes no byte. */
  toJSON(): string {
    return PLACEHOLDER
  }

  /** A fixed placeholder for `util.inspect` and `console.log`. */
  [inspect.custom](): string {
    return PLACEHOLDER
  }
}
