// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagWire/DPTerminalName.swift (MIT).
//
// Swooey reads the host name with gethostname(); here the host passes it in (the engine calls
// os.hostname()), which keeps src/diag free of Node APIs.

/**
 * The terminal name of the DP header: the client machine's own host name, truthfully
 * (IMPL-DP-1), reduced to what the 15-byte ASCII field can hold (IMPL-DP-4).
 *
 * Normalisation (IMPL-DP-4, project policy): every character outside printable ASCII
 * (0x20–0x7E) is dropped, the first 15 bytes of what remains are kept, and the field is filled
 * with `00` after them (R-DP-4). A 15-byte name fills the field with no terminator (R-DP-5). If
 * nothing remains, the field is 15 zero bytes, as when no name is set (PV-0255).
 */
export class DPTerminalName {
  /** Width of the terminal field. */
  static readonly width = 15 // provenance: PV-0023, PV-0226

  /** The characters IMPL-DP-4 keeps. */
  static readonly printableASCII = [0x20, 0x7e] as const // not-protocol: IMPL-DP-4 printable ASCII range

  /** No name: the field is 15 zero bytes (PV-0255). */
  static readonly empty = new DPTerminalName(new Uint8Array(0))

  /** The name's bytes: 0 to 15 printable ASCII bytes. */
  readonly bytes: Uint8Array

  private constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  /**
   * The normalised form of `hostName`. Pass the machine's real host name (IMPL-DP-1): the name is
   * never made up, randomised or borrowed. Tests pass invented names.
   */
  static fromHostName(hostName: string): DPTerminalName {
    return DPTerminalName.normalizing(new TextEncoder().encode(hostName))
  }

  /**
   * Keeps printable ASCII bytes, at most `width` of them. Every byte of a multi-byte UTF-8
   * sequence is 0x80 or above, so dropping bytes drops exactly the non-ASCII characters.
   */
  static normalizing(hostName: ArrayLike<number>): DPTerminalName {
    const kept: number[] = []
    const [low, high] = DPTerminalName.printableASCII
    for (let i = 0; i < hostName.length; i++) {
      const byte = hostName[i]
      if (byte < low || byte > high) continue
      kept.push(byte)
      if (kept.length === DPTerminalName.width) break
    }
    return new DPTerminalName(Uint8Array.from(kept))
  }

  /** The 15 bytes of the terminal field: the name, then `00` up to the width (R-DP-4, PV-0255). */
  get fieldBytes(): Uint8Array {
    const field = new Uint8Array(DPTerminalName.width)
    field.set(this.bytes)
    return field
  }
}
