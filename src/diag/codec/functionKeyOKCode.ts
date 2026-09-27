// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/FunctionKeyOKCode.swift (MIT).

// A function number written as a command (docs/protocol/client-input.md §7.6, Reading R-CI-20):
// SAP's batch-input OK-code syntax writes a function key as `/` and its number, for example `/11`
// for F11 and `/00` for Enter, and a function code as `=` and the code (PV-0790, SAP Note 12483 by
// number). No source says that the online dialog takes this spelling in VARINFO OKCODE; the
// commands of the command field travel there and work on a live system (PV-0787), and a GUI
// status's entries carry a function number but no function-code text (PV-0791), so this is the one
// spelling a client can build for every entry. The owner's next live run tells (trial-backed).

/** The batch-input spelling of a function key (PV-0790): `/` and the function number with at least two digits. */
export const FunctionKeyOKCode = {
  /** The slash that starts the command (PV-0790). */
  prefix: 0x2f, // provenance: PV-0790
  /** The fewest digits: `/00` to `/99` (PV-0790). */
  minimumDigits: 2, // provenance: PV-0790
  /** The most digits a function number takes (0 to 255). */
  maximumDigits: 3, // not-protocol: UInt8's decimal width
  zero: 0x30, // not-protocol: ASCII digit zero
  nine: 0x39, // not-protocol: ASCII digit nine
  radix: 10, // not-protocol: decimal digits

  /** The command for function number `number` (0–255): `/08` for 8, `/12` for 12, `/32` for 32. */
  text(number: number): string {
    const digits = String(number)
    return "/" + "0".repeat(Math.max(0, FunctionKeyOKCode.minimumDigits - digits.length)) + digits
  },

  /**
   * The function number a command names in this spelling: `/` and two or three ASCII digits with a
   * value up to 255, nothing else (no spaces, no sign); undefined for any other command. `/00` is
   * Enter's 0.
   */
  functionNumber(command: Uint8Array): number | undefined {
    const count = command.length
    if (count < 1 + FunctionKeyOKCode.minimumDigits || count > 1 + FunctionKeyOKCode.maximumDigits || command[0] !== FunctionKeyOKCode.prefix)
      return undefined
    let value = 0
    for (let index = 1; index < count; index++) {
      const byte = command[index]
      if (byte < FunctionKeyOKCode.zero || byte > FunctionKeyOKCode.nine) return undefined
      value = value * FunctionKeyOKCode.radix + (byte - FunctionKeyOKCode.zero)
    }
    return value <= 0xff ? value : undefined
  }
} as const
