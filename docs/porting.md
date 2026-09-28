# Porting Swooey's engine to TypeScript

`src/diag` is a faithful TypeScript port of Swooey's portable Swift modules, and `src/engine` of
the session loop Swooey keeps in its app. The Swift sources are at `../swooey` (Swooey revision
`d89e12f`, 2026-09-28; first ported at `7c3ca4b`). To sync, port `git diff <last>..<new>` of the
mapped folders from committed revisions only (`git show`, `git diff`; never the working tree), and
update the revision here. This document holds the rules every port follows, so that the modules fit
together and stay easy to compare with their Swift originals.

## Mapping

| Swift | TypeScript |
|---|---|
| `Sources/DiagWire` | `src/diag/wire` |
| `Sources/DiagCompression` | `src/diag/compression` |
| `Sources/DiagCodec` | `src/diag/codec` |
| `Sources/DiagSession` | `src/diag/session` |
| `Sources/ScreenModel` | `src/diag/screen` |
| `Sources/SwooeyApp`: SessionRunner, ModeRouter, ScreenBridge, TableData, ListData, logon gate, multiple logon, control clicks | `src/engine` |
| `Tests/<Module>Tests/*.swift` | `src/test/diag/<module>/*.test.ts` |
| `Tests/VectorSupport` | `src/test/vectors` |
| `Tests/Vectors` | `test/vectors` (copied; ADT vectors left out: agent-adt covers ADT) |

Not ported: DiagSignposts (no-op), CodeService, CodeText, FakeCodeService, Landscape,
TransactionField, ToolSupport, ToolTransport, FakeScenarios, the app's views, and the app's
developer toggles for experiments (the native-logon comparisons, GUI blob screens, grid column
reports): the engine keeps their readings at Swooey's defaults.

## Files

- One TypeScript file per Swift file, named in camelCase after it: `NIFrameDecoder.swift` →
  `niFrameDecoder.ts`. Each module has an `index.ts` that re-exports its public API. Import across
  modules through the module's `index.js`; inside a module import the file directly. Always use
  the `.js` extension in import paths (NodeNext).
- Header of every file:

  ```ts
  // SPDX-License-Identifier: MIT
  // Ported from Swooey Sources/DiagWire/NIFrameDecoder.swift (MIT).
  ```

- Keep the Swift doc comments (they carry the spec references and the reasoning). They may be
  shortened, never made wrong. Keep every `// provenance: PV-NNNN` and `// not-protocol: …`
  comment on the line of its constant. Keep reading names (`R-CI-20`), IMPL rules and spec-gap
  issue numbers exactly: they point into Swooey's docs/protocol and issues.

## Types

| Swift | TypeScript |
|---|---|
| `[UInt8]`, `Span<UInt8>`, `RawSpan`, `ArraySlice<UInt8>`, `UnsafeRawBufferPointer` | `Uint8Array`. A read-only view is `bytes.subarray(a, b)`; an owned copy is `bytes.slice(a, b)`. Byte arrays built by appending use `ByteWriter` (`src/diag/wire/bytes.ts`). |
| `UInt8`/`UInt16`/`UInt32`/`Int`/`Int32`/`UInt64` | `number`. Keep the value in range explicitly where Swift's type did it (`& 0xFF`, `>>> 0`). Signed views: `toInt32(u)`, `toInt16(u)` in `bytes.ts`. `UInt64` stream offsets stay `number` (safe to 2^53). Use `bigint` only if a value really needs 64 bits. |
| Swift traps on overflow | Check where Swift used checked arithmetic or `UInt32(exactly:)`; throw the Swift code's error. |
| `String` | `string`. Byte ↔ text conversions go through the codec's code-page functions, never `Buffer`. |
| `Bool`, `Double` | `boolean`, `number` |
| `T?` | `T \| undefined` (never `null`) |
| `[K: V]` | `Map<K, V>` for keys that are not plain strings or when order matters; a plain object only for fixed string keys. `Set<T>` → `Set<T>` (for struct elements, key them by a string). |
| enum without payloads | a string literal union (`type CompressionAlgorithm = "lzh" \| "lzc"`), with a `readonly` array of all cases when Swift used `CaseIterable`. Raw values → a `const` object or `switch` function. |
| enum with associated values | a discriminated union on `kind`: `{ kind: "dispatcher"; literal: DispatcherLiteral; payloadLength: number }`. Constructor helpers when Swift code builds many of them. |
| `struct` | an `interface` plus plain object literals for data; a `class` when it has methods or mutable state. Computed properties → getters or functions. |
| `mutating func` on a struct | a method on a class that mutates `this`. |
| `extension` | functions or methods in the file that ported it. |
| `protocol` | an `interface`; generic `where` clauses → plain interface parameters. |
| `static let` | `export const` or `static readonly`. |
| `Hashable`, `Equatable`, `Sendable`, `CustomStringConvertible` | dropped; equality in tests with `assert.deepStrictEqual`. `description` → a `describe…()` function or `toString()`. |
| `throws(SomeError)` with an error enum | `class SomeError extends Error` holding the union in `readonly info`, with a readable `message`. Tests match on `info`. Keep the error names. |
| `precondition`/`fatalError` | `throw new Error("…")` (a programming error). |
| `@inline(__always)`, `@usableFromInline`, `borrowing`, `consuming`, `~Copyable` | dropped |
| `Secret` | the ported `Secret` class: never printable (`toString()`, `toJSON()` and `util.inspect` show `Secret(redacted)`), zeroed by `dispose()`. |

## Conventions the ported modules use

- Enums: a string union, or a union tagged by `kind`, with a same-named const object holding the
  members and helpers (`DiagItemType.name(t)`, `ApplItem.of(id, sid)`, `ApplItem.dynt("atom")`,
  `ApplItem.equals`). An unlabeled associated value becomes the field `value`.
- `Range<Int>` → the class `ByteRange` (`lowerBound`, `upperBound`, `count`, `.of(bytes)`).
- Option sets → plain numbers plus mask constants (`ComFlag`, `DyntAttributes`, `ListRunFlags`).
- Initialisers: throwing `init(parsing:)` / `init(decoding:)` / `init(value:)` → static `parse` /
  `decode`; failable inits → static `fromPayload`, `fromAtom`, `fromValue`, `of` … returning
  `undefined`.
- A Swift `extension` of a type declared in another file: its members go in an object named after
  the Swift file that declares the extension (`DyntText.range(atom, part)` for `atom.range(of:)`,
  `GUIStatus.part(sid)`), or free functions in that file; each with a doc note naming the Swift
  member. This avoids import cycles.
- `extension CodecSpecGap` constants live in `CodecSpecGap` in `src/diag/codec/diagCodec.ts`.
- Encoders append to wire's `ByteWriter`.
- Swift `try?` → catch only the Swift-declared error type, so unexpected errors still surface.
- A method name that clashes with a property gets a descriptive suffix
  (`tabs(inArea:)` → `tabsInArea`).

## Value semantics: the main porting hazard

Swift structs and arrays are **copied** on assignment and when passed; TypeScript objects and
arrays are **shared**. Wherever the Swift code relies on a copy (it assigns a struct to a `var`
and mutates it, stores a value and mutates the original later, or returns a modified copy), the
TypeScript code must copy explicitly (`{ ...x }`, `arr.slice()`, `structuredClone`, or a
`clone()` method). Prefer immutable data: decoded values are built once and never mutated
(`readonly` fields); mutable state lives in classes (decoders, state machines, sessions) that own
it. When in doubt, copy.

## Portability

`src/diag` runs anywhere JavaScript runs: no Node imports (`node:*`) except `node:util` for the
inspect symbol in `Secret`. Text uses the global `TextDecoder`/`TextEncoder`. Timers, sockets and
files belong to `src/engine` and the host.

## Tests

- Port the module's Swift tests (`Tests/<Module>Tests`) with `node:test` and `node:assert/strict`,
  one `*.test.ts` per Swift test file, keeping the test names as the `test()` titles. Tests that
  need Swooey tooling the port does not have (fake-server internals, NIO, signposts) are left
  out with a one-line comment saying why.
- Vector kinds: port the kind's runner from `Tests/VectorSupport` into `src/test/vectors` and
  register it in `src/test/vectors/kinds.ts`. `src/test/vectors.test.ts` runs every vector whose
  kind is registered; unregistered kinds are listed as pending. A pending kind must have a reason
  in `PENDING_KINDS`.
- Mock values stay invented and funny, as in Swooey.

## Checking a port

- `npm test` passes: `tsc` strict, all tests green.
- Every public Swift type and function of the ported files has a counterpart (or a comment saying
  why not).
- The vectors of the module's kinds all pass.
