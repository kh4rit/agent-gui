// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/DyntAtomWalker.swift (MIT).

import { WireBytes } from "../wire/index.js"
import { ByteRange } from "./diagCodec.js"
import {
  DyntAtom,
  DyntAtomHeader,
  DyntAtomLayout,
  DyntDialogFlags,
  DyntElementType,
  DyntField,
  DyntFrame,
  DyntPayloadLayout,
  DyntPushButton,
  DyntRadioButton,
  DyntTabstripButton,
  type DyntFieldForm,
  type DyntPayload
} from "./dyntAtom.js"

/**
 * The part of an atom a truncated sequence ended in (IMPL-DA-3): `length`: fewer than 2 bytes were
 * left for the atom_length field (step 2); `atom`: fewer than atom_length bytes were left for the
 * atom (step 4).
 */
export type DyntAtomPart = "length" | "atom"

/**
 * Why an atom walk stopped. Each aborts the message (IMPL-DA-3); the atoms produced before it are
 * still valid views. The vector error class is given in brackets.
 */
export type DyntAtomWalkErrorInfo =
  /**
   * The value ends inside an atom's length field or before the atom's declared end (steps 2 and 4,
   * IMPL-DA-3). A declared length beyond the bytes left is never shortened. [`truncated`]
   */
  | { readonly kind: "truncated"; readonly atomIndex: number; readonly atomOffset: number; readonly part: DyntAtomPart }
  /** atom_length is below 13, so the atom cannot hold its own header (step 3, R-DA-3). [`bad-atom-length`] */
  | { readonly kind: "badAtomLength"; readonly length: number; readonly atomIndex: number; readonly atomOffset: number }

export class DyntAtomWalkError extends Error {
  constructor(readonly info: DyntAtomWalkErrorInfo) {
    super(
      info.kind === "truncated"
        ? `atom ${info.atomIndex} at offset ${info.atomOffset} truncated in its ${info.part}`
        : `atom ${info.atomIndex} at offset ${info.atomOffset} declares length ${info.length}, below 13`
    )
    this.name = "DyntAtomWalkError"
  }

  /** 1-based index of the atom being read when the walk stopped. */
  get atomIndex(): number {
    return this.info.atomIndex
  }

  /** Offset of the first byte of the atom being read when the walk stopped. */
  get atomOffset(): number {
    return this.info.atomOffset
  }
}

/**
 * Counts of the atoms a walk kept opaque or found out of place. The walk goes on past each of
 * them; the session records them in the diagnostics event log.
 */
export class DyntAtomDiagnostics {
  /** FNAME or XMLPROP atoms with no preceding atom of another type (IMPL-DA-4). */
  orphanChildren = 0
  /** Field atoms whose dlen does not fill the rest of the atom (#36, IMPL-DA-6). */
  dlenMismatches = 0
  /**
   * Payloads that do not fit their specified layout: shorter than the fixed fields, or a tabstrip
   * string without its zero byte (kept opaque until #38 gives a rule).
   */
  malformedPayloads = 0
  /** Atoms whose etype is outside the table (PV-0630). */
  unknownElementTypes = 0
  /** Atoms whose payload has no specified layout and is kept opaque (IMPL-DA-2), unknown element types included. */
  opaquePayloads = 0
  /** Push-button and radio-button atoms whose strings stay opaque (#35). */
  undecodedButtonStrings = 0

  /** Whether the walk met no orphan, no dlen mismatch and no malformed payload. */
  get isClean(): boolean {
    return this.orphanChildren === 0 && this.dlenMismatches === 0 && this.malformedPayloads === 0
  }

  /** A copy (Swift copies the struct on assignment). */
  clone(): DyntAtomDiagnostics {
    return Object.assign(new DyntAtomDiagnostics(), this)
  }
}

/**
 * Walks the atom sequence of one DYNT_ATOM or DYNT_TABSTRIP_BUTTONS item value (dynt-atoms.md,
 * "Walking an atom sequence").
 *
 * Index-based: the walker holds its position and counters, and every call to `next` gets the same
 * item value. The value is exactly the item's value bytes (R-DA-1); the sequence runs to its end.
 * Lengths are compared with the bytes left before anything is read, without overflow (IMPL-DA-3).
 * Errors are sticky: after one, every call throws it again. Payloads are decoded by element type
 * into ranges; no text is decoded (IMPL-DA-5).
 */
export class DyntAtomWalker {
  private _offset = 0
  private _atomCount = 0
  private _error: DyntAtomWalkError | undefined
  private readonly _diagnostics = new DyntAtomDiagnostics()
  /** Index of the most recent atom that is not FNAME or XMLPROP (IMPL-DA-4). */
  private parentIndex: number | undefined

  /** Offset of the next atom's first byte. */
  get offset(): number {
    return this._offset
  }

  /** Number of atoms produced so far. */
  get atomCount(): number {
    return this._atomCount
  }

  /** The error the walk stopped with, if any. */
  get error(): DyntAtomWalkError | undefined {
    return this._error
  }

  /** What the walk kept opaque or found out of place so far (a copy). */
  get diagnostics(): DyntAtomDiagnostics {
    return this._diagnostics.clone()
  }

  /** Returns the next atom, or undefined at the end of the value. */
  next(value: Uint8Array): DyntAtom | undefined {
    if (this._error) throw this._error
    // Step 1: at the end of the value the sequence is complete.
    if (!(this._offset < value.length)) return undefined
    const atomOffset = this._offset
    const index = this._atomCount + 1
    const remaining = value.length - atomOffset
    // Step 2: the length field.
    if (remaining < DyntAtomLayout.lengthSize) return this.fail({ kind: "truncated", atomIndex: index, atomOffset, part: "length" })
    // Step 3: atom_length, u16 BE, counts the whole atom (PV-0602, PV-0603).
    const length = WireBytes.u16BigEndian(value, atomOffset + DyntAtomLayout.lengthOffset) // provenance: PV-0602
    if (length < DyntAtomLayout.headerSize) return this.fail({ kind: "badAtomLength", length, atomIndex: index, atomOffset })
    // Step 4: the whole atom must be present.
    if (length > remaining) return this.fail({ kind: "truncated", atomIndex: index, atomOffset, part: "atom" })
    // Step 5: the header.
    const header = new DyntAtomHeader({
      etype: DyntElementType.fromRaw(value[atomOffset + DyntAtomLayout.etypeOffset]),
      dialogFlags: new DyntDialogFlags({
        flag1: value[atomOffset + DyntAtomLayout.dlgFlag1Offset],
        flag2: value[atomOffset + DyntAtomLayout.dlgFlag2Offset]
      }),
      area: value[atomOffset + DyntAtomLayout.areaOffset],
      block: value[atomOffset + DyntAtomLayout.blockOffset],
      group: value[atomOffset + DyntAtomLayout.groupOffset],
      row: WireBytes.u16BigEndian(value, atomOffset + DyntAtomLayout.rowOffset), // provenance: PV-0610
      col: WireBytes.u16BigEndian(value, atomOffset + DyntAtomLayout.colOffset), // provenance: PV-0611
      attributes: value[atomOffset + DyntAtomLayout.attributeOffset]
    })
    // Step 6: the payload by element type.
    const content = new ByteRange(atomOffset + DyntAtomLayout.headerSize, atomOffset + length)
    const payload = DyntPayloadDecoder.decode(header.etype, content, value)
    this.count(header.etype, payload)
    // IMPL-DA-4: FNAME and XMLPROP belong to the most recent atom of another type.
    let parent: number | undefined
    if (DyntElementType.isChildMetadata(header.etype)) {
      parent = this.parentIndex
      if (parent === undefined) this._diagnostics.orphanChildren += 1
    } else {
      this.parentIndex = index
    }
    // Step 7: advance by atom_length.
    this._offset = atomOffset + length
    this._atomCount = index
    return new DyntAtom({ index, offset: atomOffset, length, header, payload, parentIndex: parent })
  }

  private count(etype: DyntElementType, payload: DyntPayload): void {
    if (!DyntElementType.isKnown(etype)) this._diagnostics.unknownElementTypes += 1
    switch (payload.kind) {
      case "opaque":
        this._diagnostics.opaquePayloads += 1
        break
      case "pushButton":
      case "radioButton":
        this._diagnostics.undecodedButtonStrings += 1
        break
      case "undecodable":
        if (payload.value.kind === "dlenMismatch") this._diagnostics.dlenMismatches += 1
        else this._diagnostics.malformedPayloads += 1
        break
      case "text":
      case "field":
      case "frame":
      case "tabstripButton":
        break
    }
  }

  private fail(info: DyntAtomWalkErrorInfo): never {
    this._error = new DyntAtomWalkError(info)
    throw this._error
  }
}

/**
 * Walks a whole atom sequence at once, for callers that want every atom (tests, tools). The
 * session's hot path uses `DyntAtomWalker` directly.
 */
export const DyntAtoms = {
  /**
   * The atoms of `value`, the error that stopped the walk (the atoms before it still count), and the
   * walk's diagnostics.
   */
  walk(value: Uint8Array): { atoms: DyntAtom[]; error: DyntAtomWalkError | undefined; diagnostics: DyntAtomDiagnostics } {
    const walker = new DyntAtomWalker()
    const atoms: DyntAtom[] = []
    try {
      for (let atom = walker.next(value); atom !== undefined; atom = walker.next(value)) atoms.push(atom)
    } catch (error) {
      if (!(error instanceof DyntAtomWalkError)) throw error
      return { atoms, error, diagnostics: walker.diagnostics }
    }
    return { atoms, error: undefined, diagnostics: walker.diagnostics }
  }
} as const

// MARK: - Payload decoding

/**
 * Decodes a payload by element type into ranges and numbers (dynt-atoms.md, the payload sections).
 * Every read is inside `content`, which the walker has checked lies inside the value.
 */
export const DyntPayloadDecoder = {
  decode(etype: DyntElementType, content: ByteRange, value: Uint8Array): DyntPayload {
    switch (etype.kind) {
      case "fname":
      case "xmlprop":
        // PV-0650: the whole payload is one text.
        return { kind: "text", value: content }
      case "efield1":
      case "ofield1":
      case "keyword1_1":
        return DyntPayloadDecoder.field("v1", content, value)
      case "efield2":
      case "ofield2":
      case "keyword2":
        return DyntPayloadDecoder.field("v2", content, value)
      case "frame1":
        return DyntPayloadDecoder.frame(content, value)
      case "tabstripButton":
        return DyntPayloadDecoder.tabstripButton(content, value)
      case "pushbutton2":
        return DyntPayloadDecoder.pushButton(content, value)
      case "radiobutton3":
        return DyntPayloadDecoder.radioButton(content, value)
      default:
        // IMPL-DA-2: the base types, the other buttons, loops, subscreens, properties, icons and
        // every unknown value keep their payload opaque.
        return { kind: "opaque" }
    }
  },

  /**
   * `_1` and `_2` field atoms (PV-0651–PV-0653). The text runs from the end of the fixed fields to
   * the end of the atom, and dlen must equal its length; otherwise the sources read different bytes
   * and the payload stays opaque (#36, IMPL-DA-6).
   */
  field(form: DyntFieldForm, content: ByteRange, value: Uint8Array): DyntPayload {
    const base = content.lowerBound
    let flag1: number
    let dlen: number
    let mlen: number
    let maxNrChars: number
    let textStart: number
    switch (form) {
      case "v1":
        if (content.count < DyntPayloadLayout.field1Text)
          return { kind: "undecodable", value: { kind: "shortContent", needed: DyntPayloadLayout.field1Text, available: content.count } }
        flag1 = value[base + DyntPayloadLayout.field1Flag1]
        dlen = value[base + DyntPayloadLayout.field1Dlen]
        mlen = value[base + DyntPayloadLayout.field1Mlen]
        maxNrChars = WireBytes.u16BigEndian(value, base + DyntPayloadLayout.field1MaxNrChars) // provenance: PV-0653
        textStart = base + DyntPayloadLayout.field1Text
        break
      case "v2":
        if (content.count < DyntPayloadLayout.field2Text)
          return { kind: "undecodable", value: { kind: "shortContent", needed: DyntPayloadLayout.field2Text, available: content.count } }
        flag1 = WireBytes.u16BigEndian(value, base + DyntPayloadLayout.field2Flag1) // provenance: PV-0651
        dlen = value[base + DyntPayloadLayout.field2Dlen]
        mlen = value[base + DyntPayloadLayout.field2Mlen]
        maxNrChars = WireBytes.u16BigEndian(value, base + DyntPayloadLayout.field2MaxNrChars) // provenance: PV-0651
        textStart = base + DyntPayloadLayout.field2Text
        break
    }
    const remaining = content.upperBound - textStart
    if (dlen !== remaining) return { kind: "undecodable", value: { kind: "dlenMismatch", dlen, remaining } }
    const field = new DyntField({ form, flag1, dlen, mlen, maxNrChars, textRange: new ByteRange(textStart, content.upperBound) })
    return { kind: "field", value: field }
  },

  /** Frame 127: drows, dcols, then the caption to the end of the atom (PV-0654). */
  frame(content: ByteRange, value: Uint8Array): DyntPayload {
    const base = content.lowerBound
    if (content.count < DyntPayloadLayout.frameText)
      return { kind: "undecodable", value: { kind: "shortContent", needed: DyntPayloadLayout.frameText, available: content.count } }
    const drows = WireBytes.u16BigEndian(value, base + DyntPayloadLayout.frameDrows) // provenance: PV-0654
    const dcols = WireBytes.u16BigEndian(value, base + DyntPayloadLayout.frameDcols) // provenance: PV-0654
    return { kind: "frame", value: new DyntFrame({ drows, dcols, textRange: new ByteRange(base + DyntPayloadLayout.frameText, content.upperBound) }) }
  },

  /** Tabstrip button 116: fixed fields, then text, function code and id, each ending at a zero byte (PV-0656). */
  tabstripButton(content: ByteRange, value: Uint8Array): DyntPayload {
    const base = content.lowerBound
    if (content.count < DyntPayloadLayout.tabStrings)
      return { kind: "undecodable", value: { kind: "shortContent", needed: DyntPayloadLayout.tabStrings, available: content.count } }
    // The three strings, in order; each ends at the first zero byte after its start.
    const text = DyntPayloadDecoder.zeroTerminated(base + DyntPayloadLayout.tabStrings, content.upperBound, value)
    if (text === undefined) return { kind: "undecodable", value: { kind: "unterminatedString", value: "text" } }
    const functionCode = DyntPayloadDecoder.zeroTerminated(text.upperBound + 1, content.upperBound, value)
    if (functionCode === undefined) return { kind: "undecodable", value: { kind: "unterminatedString", value: "functionCode" } }
    const id = DyntPayloadDecoder.zeroTerminated(functionCode.upperBound + 1, content.upperBound, value)
    if (id === undefined) return { kind: "undecodable", value: { kind: "unterminatedString", value: "id" } }
    const button = new DyntTabstripButton({
      vLength: value[base + DyntPayloadLayout.tabVLength],
      vHeight: value[base + DyntPayloadLayout.tabVHeight],
      pageID: value[base + DyntPayloadLayout.tabPageID],
      functionCodeOffset: WireBytes.u16BigEndian(value, base + DyntPayloadLayout.tabFunctionCodeOffset), // provenance: PV-0656
      textOffset: WireBytes.u16BigEndian(value, base + DyntPayloadLayout.tabTextOffset), // provenance: PV-0656
      idOffset: WireBytes.u16BigEndian(value, base + DyntPayloadLayout.tabIDOffset), // provenance: PV-0656
      textRange: text,
      functionCodeRange: functionCode,
      idRange: id,
      trailingByteCount: content.upperBound - (id.upperBound + 1)
    })
    return { kind: "tabstripButton", value: button }
  },

  /** The bytes from `start` up to the next zero byte before `end`, or undefined when there is none. */
  zeroTerminated(start: number, end: number, value: Uint8Array): ByteRange | undefined {
    let index = start
    while (index < end && value[index] !== DyntPayloadLayout.stringTerminator) index += 1
    return index < end ? new ByteRange(start, index) : undefined
  },

  /** Push button 115: the fixed fields; the two strings after them stay opaque (#35). */
  pushButton(content: ByteRange, value: Uint8Array): DyntPayload {
    const base = content.lowerBound
    if (content.count < DyntPayloadLayout.pushFixedSize)
      return { kind: "undecodable", value: { kind: "shortContent", needed: DyntPayloadLayout.pushFixedSize, available: content.count } }
    return {
      kind: "pushButton",
      value: new DyntPushButton({
        vLength: value[base + DyntPayloadLayout.pushVLength],
        vHeight: value[base + DyntPayloadLayout.pushVHeight],
        functionCodeOffset: WireBytes.u16BigEndian(value, base + DyntPayloadLayout.pushFunctionCodeOffset), // provenance: PV-0657
        textOffset: WireBytes.u16BigEndian(value, base + DyntPayloadLayout.pushTextOffset), // provenance: PV-0657
        stringsRange: new ByteRange(base + DyntPayloadLayout.pushFixedSize, content.upperBound)
      })
    }
  },

  /** Radio button 129: the fixed fields; the text stays opaque (#35). */
  radioButton(content: ByteRange, value: Uint8Array): DyntPayload {
    const base = content.lowerBound
    if (content.count < DyntPayloadLayout.radioFixedSize)
      return { kind: "undecodable", value: { kind: "shortContent", needed: DyntPayloadLayout.radioFixedSize, available: content.count } }
    return {
      kind: "radioButton",
      value: new DyntRadioButton({
        button: value[base + DyntPayloadLayout.radioButton],
        visibleLabelLength: WireBytes.u16BigEndian(value, base + DyntPayloadLayout.radioVisibleLabelLength), // provenance: PV-0655
        eventIDOffset: WireBytes.u16BigEndian(value, base + DyntPayloadLayout.radioEventIDOffset), // provenance: PV-0655
        eventIDLength: value[base + DyntPayloadLayout.radioEventIDLength],
        textOffset: WireBytes.u16BigEndian(value, base + DyntPayloadLayout.radioTextOffset), // provenance: PV-0655
        textLength: WireBytes.u16BigEndian(value, base + DyntPayloadLayout.radioTextLength), // provenance: PV-0655
        restRange: new ByteRange(base + DyntPayloadLayout.radioFixedSize, content.upperBound)
      })
    }
  }
} as const
