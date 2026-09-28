// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/FrontendTableRegistry.swift (MIT).

import type { ControlCall, ControlCallInvocation } from "./controlCall.js"
import { DataField, DataObject, parseInteger } from "./dataProviderQueue.js"
import type { FrontendTableRequest } from "./frontendTableRequest.js"

/** `util.inspect`'s custom hook, without importing node:util (src/diag stays portable). */
const INSPECT = Symbol.for("nodejs.util.inspect.custom")

/** Why a registration or a retrieval is refused (Swift `FrontendTableRegistry.Problem`). */
export type FrontendTableRegistryProblemInfo =
  | { readonly kind: "capacity" }
  | { readonly kind: "unsupportedURL" }
  | { readonly kind: "missingBinding" }
  | { readonly kind: "missingSnapshot" }
  | { readonly kind: "nodeKey" }
  | { readonly kind: "unknownURL" }
  | { readonly kind: "schema" }

export class FrontendTableRegistryProblem extends Error {
  constructor(readonly info: FrontendTableRegistryProblemInfo) {
    super(`frontend table registry: ${info.kind}`)
    this.name = "FrontendTableRegistryProblem"
  }
}

function fail(kind: FrontendTableRegistryProblemInfo["kind"]): never {
  throw new FrontendTableRegistryProblem({ kind })
}

/**
 * Control ids and their actual expanded node keys, supplied by the UI at submission. A missing
 * control is unavailable; an explicitly empty set means no expanded nodes. (Swift
 * `FrontendTableRegistry.ExpandedTrees`.)
 */
export type FrontendTableExpandedTrees = ReadonlyMap<number, ReadonlySet<string>>

/** A helper object the registry follows (Swift's private `enum Object`). */
type RegistryObject =
  | { readonly kind: "shell"; readonly id: number }
  | { readonly kind: "provider" }
  | { readonly kind: "formats"; readonly provider: number }
  | { readonly kind: "format"; readonly provider: number }

/**
 * Experimental in-memory provider state for one mode. It never opens a URL.
 * Bindings follow PV-1037; registration lifetime follows PV-1036.
 *
 * A Swift struct: `clone()` copies it where Swift copies the value ("run on a copy").
 */
export class FrontendTableRegistry {
  static readonly keyWidth = 12 // provenance: PV-1035
  static readonly rowLimit = 4096 // not-protocol: bounded experiment
  static readonly tableLimit = 64 // not-protocol: per-mode registration cap
  static readonly objectLimit = 512 // not-protocol: per-mode helper cap

  private objects = new Map<number, RegistryObject>()
  private expandedSources = new Map<number, number>()
  private saved = new Map<string, DataObject>()

  /** A copy of this registry (Swift copies the struct on assignment); saved tables are immutable. */
  clone(): FrontendTableRegistry {
    const copy = new FrontendTableRegistry()
    copy.objects = new Map(this.objects)
    copy.expandedSources = new Map(this.expandedSources)
    copy.saved = new Map(this.saved)
    return copy
  }

  /**
   * Run on a copy; commit that copy only after the corresponding answer is written. Returned
   * strings are keyed by SaveDataToUrl's verb index, for the answer encoder
   * (`FlushCallAnswerOptions.registeredURLs`). `handles` is the answer's handle by verb index
   * (`FlushAnswerSummary.handlesByVerb`). Throws `FrontendTableRegistryProblem`; what the verbs
   * before the refused one changed stays changed, as in Swift's mutating method.
   */
  apply(call: ControlCall, handles: ReadonlyMap<number, number>, expandedTrees: FrontendTableExpandedTrees): Map<number, string> {
    const R = FrontendTableRegistry
    const local = new Map<number, number>()
    const urls = new Map<number, string>()
    const handle = (record: number): number | undefined => {
      const known = local.get(record)
      if (known !== undefined) return known
      const value = call.record(record)?.value
      if (value === undefined) return undefined
      return parseInteger(value.startsWith("O") ? value.slice(1) : value)
    }
    const argument = (n: number, verb: ControlCallInvocation): number | undefined => {
      const found = verb.argument(n)
      return found === undefined ? undefined : handle(found.record)
    }
    for (const verb of call.invocations) {
      const target = handle(verb.target)
      const result = handles.get(verb.index)
      if (verb.result !== undefined && result !== undefined) local.set(verb.result, result)
      const targetObject = target === undefined ? undefined : this.objects.get(target)
      switch (verb.name) {
        case "CreateControl":
        case "CreateControl2": {
          // provenance: PV-1009
          const id = parseInteger(call.argument(1, verb) ?? "")
          if (result !== undefined && id !== undefined) {
            // Reusing a control id invalidates its old handle.
            for (const [key, object] of this.objects) if (object.kind === "shell" && object.id === id) this.objects.delete(key)
            for (const [key, source] of this.expandedSources) if (source === id) this.expandedSources.delete(key)
            this.objects.set(result, { kind: "shell", id })
          }
          break
        }
        case "CreateObject": // provenance: PV-1009
          if (result !== undefined && call.argument(1, verb)?.includes("DataProvider") === true) this.objects.set(result, { kind: "provider" })
          break
        case "formats": // provenance: PV-1037
          if (target !== undefined && targetObject?.kind === "provider" && result !== undefined)
            this.objects.set(result, { kind: "formats", provider: target })
          break
        case "Force": // provenance: PV-1037
          if (
            targetObject?.kind === "formats" &&
            result !== undefined &&
            call.argument(1, verb)?.toUpperCase() === "APPLICATION" &&
            call.argument(2, verb)?.toUpperCase() === "X-R3TABLE"
          )
            this.objects.set(result, { kind: "format", provider: targetObject.provider })
          break
        case "AssignProperty2": {
          // provenance: PV-1037 — reverse direction only.
          if (!(call.argument(2, verb) === "ExpandedKeys" && call.argument(4, verb) === "data")) break
          const source = argument(1, verb)
          const shell = source === undefined ? undefined : this.objects.get(source)
          if (shell?.kind !== "shell") break
          const destination = argument(3, verb)
          const format = destination === undefined ? undefined : this.objects.get(destination)
          if (format?.kind === "format") this.expandedSources.set(format.provider, shell.id)
          break
        }
        case "SaveDataToUrl": {
          const id = target === undefined ? undefined : this.expandedSources.get(target)
          if (!(target !== undefined && targetObject?.kind === "provider" && id !== undefined)) fail("missingBinding")
          const keys = expandedTrees.get(id)
          if (keys === undefined) fail("missingSnapshot")
          if (
            !(
              ["", "APPLICATION"].includes(call.argument(1, verb)?.toUpperCase() ?? "?") &&
              ["", "X-R3TABLE"].includes(call.argument(2, verb)?.toUpperCase() ?? "?")
            )
          )
            fail("missingBinding")
          const url = call.argument(3, verb)
          if (url === undefined || !R.isLocalURL(url)) fail("unsupportedURL")
          if (!(keys.size <= R.rowLimit && (this.saved.has(url) || this.saved.size < R.tableLimit))) fail("capacity")
          // provenance: PV-1035 — the observed expanded-key schema is C12.
          // Non-ASCII keys need a verified code-page conversion before export.
          const rows: Uint8Array[] = []
          for (const key of Array.from(keys).sort()) {
            const bytes = new TextEncoder().encode(key)
            if (!(bytes.length > 0 && bytes.length <= R.keyWidth && bytes.every(byte => byte >= 0x20 && byte < 0x7f))) fail("nodeKey")
            const row = new Uint8Array(R.keyWidth).fill(0x20)
            row.set(bytes)
            rows.push(row)
          }
          this.saved.set(
            url,
            new DataObject(0, url, "APPLICATION", "X-R3TABLE", undefined, [new DataField(1, 0, R.keyWidth, DataField.text)], R.keyWidth, rows)
          )
          urls.set(verb.index, url)
          break
        }
        case "FreeObject": {
          // provenance: PV-1010
          const released = argument(1, verb)
          if (released !== undefined) {
            this.objects.delete(released)
            this.expandedSources.delete(released)
          }
          break
        }
        default:
          break
      }
      if (!(this.objects.size <= R.objectLimit && this.expandedSources.size <= R.objectLimit)) fail("capacity")
    }
    return urls
  }

  /**
   * A matching table stays registered until its answer was written (Swift `table(for:)`); throws
   * `FrontendTableRegistryProblem`.
   */
  table(request: FrontendTableRequest): DataObject {
    const object = this.saved.get(request.url)
    if (object === undefined) fail("unknownURL")
    if (
      !(
        request.rowWidth === object.rowWidth &&
        DataField.listsEqual(request.fields, object.fields) &&
        (request.type.length === 0 || request.type.toUpperCase() === object.type) &&
        (request.subtype.length === 0 || request.subtype.toUpperCase() === object.subtype)
      )
    )
      fail("schema")
    return object
  }

  consumed(url: string): void {
    this.saved.delete(url)
  }

  get tableCount(): number {
    return this.saved.size
  }

  static isLocalURL(url: string): boolean {
    const bytes = new TextEncoder().encode(url)
    return url.startsWith("sapr3://") && bytes.length > 8 && bytes.length <= 256 && bytes.every(byte => byte > 0x20 && byte < 0x7f)
  }

  /** Counts only: URLs, keys and control ids are withheld. */
  get description(): string {
    return `frontend registry: ${this.objects.size} object(s), ${this.saved.size} table(s); values withheld`
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
