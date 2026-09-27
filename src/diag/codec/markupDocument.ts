// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/MarkupDocument.swift (MIT).

// An XMLBLOB value read as an XML document for its structure (docs/protocol/controls/datamanager.md
// IMPL-CT-7): the declaration, elements with their attributes, text, comments. Values stay bytes:
// the character set is spec gap #20, so nothing here decodes a value beyond ASCII. A text with a
// zero byte beside each character (UTF-16) is narrowed first, one byte per character.

import { ascii } from "../wire/index.js"

/** How the value's characters were stored (Swift `MarkupDocument.Form`; `MarkupForm.rawValue` gives Swift's raw values). */
export type MarkupForm = "singleByte" | "utf16LittleEndian" | "utf16BigEndian"

export const MarkupForm = {
  rawValue(form: MarkupForm): string {
    switch (form) {
      case "singleByte":
        return "single-byte text"
      case "utf16LittleEndian":
        return "UTF-16LE text"
      case "utf16BigEndian":
        return "UTF-16BE text"
    }
  }
} as const

/**
 * An attribute: its name and its value as the document holds it (quotes removed, character and
 * entity references kept). (Swift `MarkupDocument.Attribute`.)
 */
export interface MarkupAttribute {
  readonly name: Uint8Array
  readonly value: Uint8Array
}

/** Swift `Array(text.utf8)`. */
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

function bytesEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false
  return true
}

/** An element (Swift `MarkupDocument.Element`). */
export class MarkupElement {
  children: MarkupNode[]

  constructor(
    readonly name: Uint8Array,
    readonly attributes: readonly MarkupAttribute[],
    children: MarkupNode[] = []
  ) {
    this.children = children
  }

  /** The value of the attribute named `name`, when the element has one. */
  attribute(name: string): Uint8Array | undefined {
    const bytes = utf8(name)
    return this.attributes.find(attribute => bytesEqual(attribute.name, bytes))?.value
  }
}

/** A node of the document (Swift `MarkupDocument.Node`). */
export type MarkupNode =
  | { readonly kind: "element"; readonly value: MarkupElement }
  /** Character data between tags, white space around it kept; a CDATA section's content. */
  | { readonly kind: "text"; readonly value: Uint8Array }
  /** A comment, by the length of its content. */
  | { readonly kind: "comment"; readonly length: number }
  /** A processing instruction other than the declaration, or a DOCTYPE: by its length. */
  | { readonly kind: "other"; readonly length: number }

/** Why a value does not read as a document (Swift `MarkupError.Reason`; `MarkupErrorReason.rawValue` gives the text). */
export type MarkupErrorReason =
  | "unexpectedEnd"
  | "nameExpected"
  | "equalsExpected"
  | "quoteExpected"
  | "lessThanInValue"
  | "spaceExpected"
  | "declarationEndExpected"
  | "greaterThanExpected"
  | "mismatchedEnd"
  | "unclosedElement"
  | "textOutsideElement"
  | "tooDeep"
  | "tooManyNodes"

export const MarkupErrorReason = {
  rawValue(reason: MarkupErrorReason): string {
    switch (reason) {
      case "unexpectedEnd":
        return "the value ends inside markup"
      case "nameExpected":
        return "a name was expected"
      case "equalsExpected":
        return "an attribute's = was expected"
      case "quoteExpected":
        return "an attribute value's quote was expected"
      case "lessThanInValue":
        return "a < inside an attribute value"
      case "spaceExpected":
        return "white space or the tag's end was expected after an attribute"
      case "declarationEndExpected":
        return "the declaration's ?> was expected"
      case "greaterThanExpected":
        return "a tag's > was expected"
      case "mismatchedEnd":
        return "an end tag that closes no open element of its name"
      case "unclosedElement":
        return "an element is not closed"
      case "textOutsideElement":
        return "text outside the root element"
      case "tooDeep":
        return "elements nested deeper than the reader's limit"
      case "tooManyNodes":
        return "more nodes than the reader's limit"
    }
  }
} as const

/** Why a value does not read as a document: the reason and the offset (in the narrowed text). */
export class MarkupError extends Error {
  readonly info: { readonly offset: number; readonly reason: MarkupErrorReason }

  constructor(offset: number, reason: MarkupErrorReason) {
    super(`${MarkupErrorReason.rawValue(reason)}, at character ${offset}`)
    this.name = "MarkupError"
    this.info = { offset, reason }
  }

  get offset(): number {
    return this.info.offset
  }

  get reason(): MarkupErrorReason {
    return this.info.reason
  }

  /** Swift `description`. */
  get description(): string {
    return this.message
  }
}

/** A document of an XMLBLOB value, read for its structure. */
export class MarkupDocument {
  /** The deepest nesting read. */
  static readonly maxDepth = 64 // not-protocol: a reader's limit
  /** The most nodes read. */
  static readonly maxNodes = 100_000 // not-protocol: a reader's limit

  private constructor(
    readonly form: MarkupForm,
    /** The declaration's attributes (`version`, `encoding`, …), when the document starts with one. */
    readonly declaration: readonly MarkupAttribute[] | undefined,
    /** The nodes outside any element: normally one root element. */
    readonly nodes: readonly MarkupNode[]
  ) {}

  /** The root element: the first element outside any other. */
  get root(): MarkupElement | undefined {
    for (const node of this.nodes) if (node.kind === "element") return node.value
    return undefined
  }

  /** Reads `value` (an XMLBLOB item's value; Swift `init(reading:)`). Throws `MarkupError`. */
  static read(value: Uint8Array): MarkupDocument {
    const { form, bytes } = MarkupDocument.narrowed(value)
    const { declaration, nodes } = new Reader(bytes).document()
    return new MarkupDocument(form, declaration, nodes)
  }

  /**
   * The value one byte per character: UTF-16 of either byte order (after a byte-order mark, or by
   * its zero bytes) narrowed, a code unit above 0xFF becoming 0x80 so that it counts as non-ASCII;
   * anything else as it is.
   */
  static narrowed(value: Uint8Array): { form: MarkupForm; bytes: Uint8Array } {
    let bytes = value
    let form: MarkupForm | undefined
    const unit = 2 // not-protocol: a UTF-16 code unit's bytes
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      // not-protocol: the UTF-16LE byte-order mark
      form = "utf16LittleEndian"
      bytes = bytes.subarray(unit)
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      // not-protocol: the UTF-16BE byte-order mark
      form = "utf16BigEndian"
      bytes = bytes.subarray(unit)
    } else if (bytes.length >= unit && bytes.length % unit === 0) {
      if (bytes[0] !== 0 && bytes[1] === 0) form = "utf16LittleEndian"
      if (bytes[0] === 0 && bytes[1] !== 0) form = "utf16BigEndian"
    }
    if (form === undefined || bytes.length % unit !== 0) return { form: "singleByte", bytes: value }
    const narrow = new Uint8Array(bytes.length / unit)
    for (let index = 0; index < bytes.length; index += unit) {
      const high = form === "utf16LittleEndian" ? bytes[index + 1] : bytes[index]
      const low = form === "utf16LittleEndian" ? bytes[index] : bytes[index + 1]
      narrow[index / unit] = high !== 0 ? 0x80 : low // not-protocol: a character beyond one byte counts as non-ASCII
    }
    return { form, bytes: narrow }
  }
}

const LESS_THAN = 0x3c // "<"
const GREATER_THAN = 0x3e // ">"
const SLASH = 0x2f // "/"
const QUESTION = 0x3f // "?"
const EQUALS = 0x3d // "="
const DOUBLE_QUOTE = 0x22 // '"'
const SINGLE_QUOTE = 0x27 // "'"

/** A reader over the narrowed bytes (Swift `MarkupDocument.Reader`). */
class Reader {
  private index = 0
  private nodeCount = 0

  constructor(private readonly bytes: Uint8Array) {}

  static isSpace(byte: number): boolean {
    return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d // not-protocol: XML white space
  }

  /** A byte that may be part of a name: anything but white space and the markup characters. */
  static isNameByte(byte: number): boolean {
    return (
      !Reader.isSpace(byte) &&
      byte !== LESS_THAN &&
      byte !== GREATER_THAN &&
      byte !== SLASH &&
      byte !== EQUALS &&
      byte !== QUESTION &&
      byte !== DOUBLE_QUOTE &&
      byte !== SINGLE_QUOTE &&
      byte !== 0
    )
  }

  private startsWith(text: string): boolean {
    const pattern = ascii(text)
    return this.index + pattern.length <= this.bytes.length && bytesEqual(this.bytes.subarray(this.index, this.index + pattern.length), pattern)
  }

  /** Steps over `text` when it comes next. */
  private consume(text: string): boolean {
    if (!this.startsWith(text)) return false
    this.index += text.length
    return true
  }

  /** Steps past the next `text`, returning the offset where it starts. */
  private skipPast(text: string): number {
    const end = this.find(text)
    if (end === undefined) throw this.error("unexpectedEnd")
    this.index = end + text.length
    return end
  }

  private error(reason: MarkupErrorReason): MarkupError {
    return new MarkupError(this.index, reason)
  }

  private skipSpace(): void {
    while (this.index < this.bytes.length && Reader.isSpace(this.bytes[this.index])) this.index += 1
  }

  /** The offset where `text` starts at or after the current one. */
  private find(text: string): number | undefined {
    const pattern = ascii(text)
    if (pattern.length === 0 || this.bytes.length < pattern.length) return undefined
    for (let position = this.index; position + pattern.length <= this.bytes.length; position++) {
      if (this.bytes[position] === pattern[0] && bytesEqual(this.bytes.subarray(position, position + pattern.length), pattern)) return position
    }
    return undefined
  }

  private count(): void {
    this.nodeCount += 1
    if (!(this.nodeCount <= MarkupDocument.maxNodes)) throw this.error("tooManyNodes")
  }

  private name(): Uint8Array {
    const start = this.index
    while (this.index < this.bytes.length && Reader.isNameByte(this.bytes[this.index])) this.index += 1
    if (!(this.index > start)) throw this.error("nameExpected")
    return this.bytes.slice(start, this.index)
  }

  /** Attributes up to (not including) `/>`, `>` or `?>`. */
  private attributes(): MarkupAttribute[] {
    const attributes: MarkupAttribute[] = []
    const bytes = this.bytes
    for (;;) {
      this.skipSpace()
      if (!(this.index < bytes.length)) throw this.error("unexpectedEnd")
      const byte = bytes[this.index]
      if (byte === GREATER_THAN || byte === SLASH || byte === QUESTION) return attributes
      const name = this.name()
      this.skipSpace()
      if (!(this.index < bytes.length && bytes[this.index] === EQUALS)) throw this.error("equalsExpected")
      this.index += 1
      this.skipSpace()
      if (!(this.index < bytes.length && (bytes[this.index] === DOUBLE_QUOTE || bytes[this.index] === SINGLE_QUOTE))) throw this.error("quoteExpected")
      const quote = bytes[this.index]
      this.index += 1
      const start = this.index
      while (this.index < bytes.length && bytes[this.index] !== quote) {
        if (bytes[this.index] === LESS_THAN) throw this.error("lessThanInValue")
        this.index += 1
      }
      if (!(this.index < bytes.length)) throw this.error("unexpectedEnd")
      attributes.push({ name, value: bytes.slice(start, this.index) })
      this.index += 1
      if (
        !(
          this.index < bytes.length &&
          (Reader.isSpace(bytes[this.index]) || bytes[this.index] === GREATER_THAN || bytes[this.index] === SLASH || bytes[this.index] === QUESTION)
        )
      )
        throw this.error("spaceExpected")
    }
  }

  document(): { declaration: MarkupAttribute[] | undefined; nodes: MarkupNode[] } {
    const bytes = this.bytes
    let declaration: MarkupAttribute[] | undefined
    const stack: MarkupElement[] = []
    const top: MarkupNode[] = []
    const append = (node: MarkupNode): void => {
      if (stack.length === 0) top.push(node)
      else stack[stack.length - 1].children.push(node)
    }
    while (this.index < bytes.length) {
      if (bytes[this.index] !== LESS_THAN) {
        const start = this.index
        while (this.index < bytes.length && bytes[this.index] !== LESS_THAN) this.index += 1
        const text = bytes.slice(start, this.index)
        if (!text.every(Reader.isSpace)) {
          if (stack.length === 0) throw new MarkupError(start, "textOutsideElement")
          this.count()
          append({ kind: "text", value: text })
        }
        continue
      }
      const start = this.index
      if (this.consume("<?")) {
        const target = this.name()
        if (bytesEqual(target, ascii("xml")) && start === 0) {
          declaration = this.attributes()
          if (!this.consume("?>")) throw this.error("declarationEndExpected")
        } else {
          this.skipPast("?>")
          this.count()
          append({ kind: "other", length: this.index - start })
        }
      } else if (this.consume("<!--")) {
        const content = this.index
        const end = this.skipPast("-->")
        this.count()
        append({ kind: "comment", length: end - content })
      } else if (this.consume("<![CDATA[")) {
        const content = this.index
        const end = this.skipPast("]]>")
        if (stack.length === 0) throw new MarkupError(start, "textOutsideElement")
        this.count()
        append({ kind: "text", value: bytes.slice(content, end) })
      } else if (this.consume("<!")) {
        this.skipPast(">")
        this.count()
        append({ kind: "other", length: this.index - start })
      } else if (this.consume("</")) {
        const name = this.name()
        this.skipSpace()
        if (!this.consume(">")) throw this.error("greaterThanExpected")
        const open = stack[stack.length - 1]
        if (open === undefined || !bytesEqual(open.name, name)) throw new MarkupError(start, "mismatchedEnd")
        stack.pop()
        append({ kind: "element", value: open })
      } else {
        this.index += 1
        const name = this.name()
        const attributes = this.attributes()
        this.count()
        const element = new MarkupElement(name, attributes)
        if (this.consume("/>")) {
          append({ kind: "element", value: element })
        } else if (this.consume(">")) {
          if (!(stack.length < MarkupDocument.maxDepth)) throw this.error("tooDeep")
          stack.push(element)
        } else {
          throw this.error("greaterThanExpected")
        }
      }
    }
    if (stack.length > 0) throw this.error("unclosedElement")
    return { declaration, nodes: top }
  }
}
