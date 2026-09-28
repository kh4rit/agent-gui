// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/InputEnvelope.swift (MIT).

// The reference input envelope (docs/protocol/client-input.md §11): what a client that logs on to a
// real system repeats around the fields it returns. open-diag-go's live-tested client (MIT, read for
// facts) sends, in every input step, the server's DIALOG_STEP_NUMBER, SES and mode_stat back
// unchanged, a CODEPAGE_DIAG_GUI item, the answered screen's DYNN CHL, window and container state,
// the changed fields as an APPL DYNT_ATOM with bit 0x01 of dlg_flag_2 set, a focus item for the
// cursor and a DATAMANAGER document (PV-0774 to PV-0781). Swooey's first live logon step, which sent
// none of that, was rejected as invalid GUI data (PV-0782); the full envelope passed that check and
// was answered with a server error naming an ABAP runtime error during the logon (issue #105); the
// echoes without DYNN CHL were rejected as invalid GUI data again, and the echoes with DYNN CHL
// logged on (PV-0783, PV-0785). Each part is a switchable Reading (R-CI-12 to R-CI-18), so that the
// owner's runs can tell the parts apart; `InputEnvelope.minimal` sends what Swooey sent before.

import { ascii, ByteWriter } from "../wire/index.js"
import { ClientIdentities } from "./clientIdentityPresets.js"
import type { ClientIdentity } from "./clientMessages.js"
import type { DiagHeader } from "./diagHeader.js"
import { DiagItemWalkError, DiagItemWalker, type DiagItem } from "./diagItem.js"
import { ItemPayloadError } from "./diagCodec.js"
import { DyntFocus } from "./screenListValues.js"
import { DialogStepNumber } from "./sessionItems.js"

/**
 * Which parts of the reference input envelope an input step sends (client-input.md §11): an option
 * set, as a number of the mask bits below. The parts are independent Readings, so that an owner-run
 * experiment can add them in stages; `minimal` sends none of them and keeps the item order of R-CI-2
 * byte for byte.
 */
export type InputEnvelope = number

export const InputEnvelope = {
  /**
   * Reading R-CI-12: the DIAG header's mode_stat, DIALOG_STEP_NUMBER and SES as the server last sent
   * them, and its CODEPAGE_DIAG_GUI value (PV-0774, PV-0775). Without an echo the step falls back to
   * Swooey's own step counter and the reference client's SES (R-CI-5).
   */
  echoes: 1 << 0, // not-protocol: option bit
  /** Reading R-CI-13: bit 0x01 of dlg_flag_2 set on every returned edited field (PV-0777). */
  changedBit: 1 << 1, // not-protocol: option bit
  /**
   * Reading R-CI-14: DYNT_ATOM as APPL (a two-byte length), and an empty DYNT_NOFOCUS item when the
   * step returns no field (PV-0778, PV-0779).
   */
  guiCarriers: 1 << 2, // not-protocol: option bit
  /**
   * Reading R-CI-18: the answered screen's VARINFO SCROLL_INFOS2 and CONTAINER RESET, as the server
   * sent them (PV-0774, PV-0776). No from-scratch client sends these; a witnessed GUI sends its own
   * window state.
   */
  screenState: 1 << 3, // not-protocol: option bit
  /**
   * Reading R-CI-15: the answered screen's DYNN CHL, as the server sent it (PV-0774, PV-0776).
   * pysap's from-scratch logon, which reaches real systems, sends a DYNN CHL and nothing else of the
   * screen state (client-input.md §11.4), so this part is switchable on its own.
   */
  dynnCHL: 1 << 6, // not-protocol: option bit
  /**
   * Reading R-CI-16: a DYNT_FOCUS_1 item for the field the cursor is on (PV-0780), and on a function
   * key with no edit that field's atom as received (PV-0779).
   */
  focus: 1 << 4, // not-protocol: option bit
  /**
   * Reading R-CI-17: a bare client DATAMANAGER document in an XMLBLOB before EOM, on every step that
   * fires no UI_EVENT_SOURCE (PV-0781).
   */
  dataManager: 1 << 5, // not-protocol: option bit

  /**
   * Optional comparison of the reference client's input header (msg_info 1, PV-0908). The meaning of
   * the bit remains unspecified; excluded from the default stages.
   */
  referenceHeader: 1 << 7, // not-protocol: option bit

  /** None of the parts: the step of R-CI-1 and R-CI-2 that Swooey sent before the envelope. Live: rejected as invalid GUI data (PV-0782). */
  minimal: 0,
  /**
   * "Echoes only": the echoes, the changed bit and the GUI carriers, without the DYNN CHL echo.
   * Live: rejected as invalid GUI data (PV-0785).
   */
  echoStage: (1 << 0) | (1 << 1) | (1 << 2),
  /**
   * "Echoes and DYNN CHL": the echoes, the changed bit, the carriers and the DYNN CHL echo, the item
   * set of pysap's from-scratch logon with the GUI's echoes and carriers, and without the window
   * state, the focus and the document (client-input.md §11.5). Live: the owner's server accepted a
   * logon with it (PV-0783), so it is the default with the reference identity.
   */
  chlStage: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 6),
  /**
   * "Echoes, window state and focus": `chlStage` with the window state and the focus item, without
   * the document. Not tried live yet.
   */
  stateStage: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 6) | (1 << 3) | (1 << 4),
  /**
   * "Full reference": every part, `stateStage` with the DATAMANAGER document. Live: it passed the
   * structural check, then the logon ended in a runtime error (client-input.md §11.6).
   */
  reference: (1 << 0) | (1 << 1) | (1 << 2) | (1 << 6) | (1 << 3) | (1 << 4) | (1 << 5),

  /**
   * The stages in order of their parts, for a picker: minimal, echoes only, echoes and DYNN CHL,
   * echoes with window state and focus, full reference.
   */
  get stages(): InputEnvelope[] {
    const envelope = InputEnvelope
    return [envelope.minimal, envelope.echoStage, envelope.chlStage, envelope.stateStage, envelope.reference]
  },

  /** Whether `envelope` holds every part of `parts` (Swift `contains`, `isSuperset(of:)`). */
  contains(envelope: InputEnvelope, parts: InputEnvelope): boolean {
    return (envelope & parts) === parts
  },

  /**
   * The envelope a session uses unless told otherwise: `chlStage` with the reference identity and
   * its two variants `reference-norfc` and `reference-nocfw` (the stage the owner's server accepted a
   * logon with, PV-0783), `minimal` with every other one.
   */
  default(identity: ClientIdentity): InputEnvelope {
    return ClientIdentities.referenceEnvelopeIdentities.some(reference => reference.equals(identity)) ? InputEnvelope.chlStage : InputEnvelope.minimal
  },

  /**
   * The parts a client's automatic reply to control traffic carries in the envelope shape
   * (controls/transport.md §2.3, the switchable shape of Reading R-CT-26): this envelope's echoes,
   * changed bit, GUI carriers and DYNN CHL, and never the window state, the focus item or the
   * DATAMANAGER document, which ODG's first control round trip did not carry (PV-0903).
   */
  controlReply(envelope: InputEnvelope): InputEnvelope {
    const e = InputEnvelope
    return envelope & (e.echoes | e.changedBit | e.guiCarriers | e.dynnCHL)
  },

  /** The stage's name, or the parts' names for a mix. */
  name(envelope: InputEnvelope): string {
    const e = InputEnvelope
    switch (envelope) {
      case e.minimal:
        return "minimal"
      case e.echoStage:
        return "echoes only"
      case e.chlStage:
        return "echoes and DYNN CHL"
      case e.stateStage:
        return "echoes, window state and focus"
      case e.reference:
        return "full reference"
      default:
        return InputEnvelope.partNames(envelope).join("+")
    }
  },

  /** The names of the parts it holds, in the order of the items they add. */
  partNames(envelope: InputEnvelope): string[] {
    const e = InputEnvelope
    const names: [number, string][] = [
      [e.echoes, "echoes"],
      [e.changedBit, "changed bit"],
      [e.guiCarriers, "GUI carriers"],
      [e.dynnCHL, "DYNN CHL"],
      [e.screenState, "screen state"],
      [e.focus, "focus"],
      [e.dataManager, "DATAMANAGER"],
      [e.referenceHeader, "reference header"]
    ]
    return names.filter(([part]) => (envelope & part) === part).map(([, name]) => name)
  }
} as const

/** Swift `try? walker.next(in:)`. */
function nextItem(walker: DiagItemWalker, items: Uint8Array): DiagItem | undefined {
  try {
    return walker.next(items)
  } catch (error) {
    if (error instanceof DiagItemWalkError) return undefined
    throw error
  }
}

/**
 * What the server last sent that the reference envelope returns (R-CI-12, R-CI-15): the session
 * keeps the latest value of each, from every message whose items were read, as open-diag-go's client
 * keeps them (PV-0775, PV-0776). Values are kept verbatim; none is interpreted here.
 *
 * A message of several window sections (elements.md Reading R-EL-23: each SES item opens one, and
 * the last is the top window the next step answers) gives its last section's window state only: the
 * DYNN CHL, SCROLL_INFOS2 and CONTAINER RESET after its last SES, never another section's, so that a
 * step never mixes one window's state with another's (issue #142).
 *
 * A Swift struct: `clone()` copies it where Swift copies the value.
 */
export class ServerEcho {
  /** The DIAG header's mode_stat of the latest message. */
  modeStat = 0
  /** The latest ST_USER DIALOG_STEP_NUMBER. */
  stepNumber: number | undefined = undefined
  /** The latest SES value, all 16 bytes. */
  ses: Uint8Array | undefined = undefined
  /** The latest ST_R3INFO CODEPAGE_DIAG_GUI value. */
  codepageDiagGUI: Uint8Array | undefined = undefined
  /** The latest DYNN CHL value. */
  dynnCHL: Uint8Array | undefined = undefined
  /** The latest VARINFO SCROLL_INFOS2 value. */
  scrollInfos2: Uint8Array | undefined = undefined
  /** The value of the first CONTAINER RESET of the latest message that had one. */
  containerReset: Uint8Array | undefined = undefined
  /**
   * Set for a message of several window sections (Reading R-EL-23): its DYNN CHL, SCROLL_INFOS2 and
   * CONTAINER RESET are the top window's, undefined where the last section has none, and `merge`
   * takes them as they are instead of keeping older values, which describe another window.
   */
  replacesWindowState = false

  /**
   * An empty echo, or (Swift `init(items:)`) what one message's items hold: each field is the item's
   * value when the message carries it (the last one for a repeated item, the first CONTAINER RESET),
   * else undefined; with several SES items, the window state of the last section, and
   * `replacesWindowState` (Reading R-EL-23). The walk is tolerant: it keeps what it found before a
   * stop.
   */
  constructor(items?: Uint8Array) {
    if (items === undefined) return
    const walker = new DiagItemWalker()
    let sesCount = 0
    // The window state after the latest SES, once a second SES has come.
    let sectionCHL: Uint8Array | undefined
    let sectionScroll: Uint8Array | undefined
    let sectionReset: Uint8Array | undefined
    for (let item = nextItem(walker, items); item !== undefined; item = nextItem(walker, items)) {
      const range = item.valueRange
      if (item.type === "ses") {
        this.ses = range.of(items).slice()
        sesCount += 1
        sectionCHL = undefined
        sectionScroll = undefined
        sectionReset = undefined
        continue
      }
      const appl = item.appl
      if (appl === undefined) continue
      if (appl.kind === "stUser" && appl.sid === "dialogStepNumber") {
        try {
          this.stepNumber = DialogStepNumber.decode(range.of(items)).step
        } catch (error) {
          if (!(error instanceof ItemPayloadError)) throw error
        }
      } else if (appl.kind === "stSystemInfo" && appl.sid === "codepageDiagGUI") {
        this.codepageDiagGUI = range.of(items).slice()
      } else if (appl.kind === "dynn" && appl.sid === "chl") {
        this.dynnCHL = range.of(items).slice()
        sectionCHL = this.dynnCHL
      } else if (appl.kind === "varInfo" && appl.sid === "scrollInfos2") {
        this.scrollInfos2 = range.of(items).slice()
        sectionScroll = this.scrollInfos2
      } else if (appl.kind === "container" && appl.sid === "reset") {
        const value = range.of(items).slice()
        this.containerReset = this.containerReset ?? value
        sectionReset = sectionReset ?? value
      }
    }
    if (!(sesCount > 1)) return
    this.dynnCHL = sectionCHL
    this.scrollInfos2 = sectionScroll
    this.containerReset = sectionReset
    this.replacesWindowState = true
  }

  /** A copy of this echo. */
  clone(): ServerEcho {
    const copy = new ServerEcho()
    copy.modeStat = this.modeStat
    copy.stepNumber = this.stepNumber
    copy.ses = this.ses?.slice()
    copy.codepageDiagGUI = this.codepageDiagGUI?.slice()
    copy.dynnCHL = this.dynnCHL?.slice()
    copy.scrollInfos2 = this.scrollInfos2?.slice()
    copy.containerReset = this.containerReset?.slice()
    copy.replacesWindowState = this.replacesWindowState
    return copy
  }

  /**
   * Takes the newer message's values where it has them, and its mode_stat. The window state of a
   * message of several sections replaces the older one whole, a missing value included
   * (`replacesWindowState`, Reading R-EL-23): the step then never echoes one window's state with
   * another's SES.
   */
  merge(newer: ServerEcho, header: DiagHeader | undefined): void {
    if (header !== undefined) this.modeStat = header.modeStat
    this.stepNumber = newer.stepNumber ?? this.stepNumber
    this.ses = newer.ses?.slice() ?? this.ses
    this.codepageDiagGUI = newer.codepageDiagGUI?.slice() ?? this.codepageDiagGUI
    if (newer.replacesWindowState) {
      this.dynnCHL = newer.dynnCHL?.slice()
      this.scrollInfos2 = newer.scrollInfos2?.slice()
      this.containerReset = newer.containerReset?.slice()
    } else {
      this.dynnCHL = newer.dynnCHL?.slice() ?? this.dynnCHL
      this.scrollInfos2 = newer.scrollInfos2?.slice() ?? this.scrollInfos2
      this.containerReset = newer.containerReset?.slice() ?? this.containerReset
    }
  }
}

/**
 * The DYNT_FOCUS_1 value a client sends with its input (Reading R-CI-16, PV-0780): in the layout of
 * PV-0711, focus number 1, the cursor field's row and column as the server sent them, row offset 0,
 * the cursor's column offset in the field, and one container id 0. 10 bytes.
 */
export class InputFocus {
  /**
   * The first byte: 1 in open-diag-go's client and on the owner's logon screen (PV-0780, PV-0740);
   * what it counts is #51.
   */
  static readonly focusNumber = 1 // provenance: PV-0780
  /** The one container id open-diag-go's client sends (PV-0780). A fresh copy on every read. */
  static get containerIDs(): Uint8Array {
    return Uint8Array.of(0)
  }
  /** The value size. */
  static readonly size = DyntFocus.fixedSize + 1 // provenance: PV-0780

  /** The field's row, as its atom carries it. */
  row: number
  /** The field's column, as its atom carries it. */
  col: number
  /**
   * Where the cursor is inside the field: open-diag-go's client sends the length of the field's
   * text (the cursor after the last character). Swooey sends 0 in a password field, so that
   * nothing it writes or reports grows with a password (IMPL-DA-1).
   */
  colOffset: number
  /**
   * The container ids: `containerIDs` (one id 0) unless the cursor sits in a container, whose id
   * elements.md Reading R-EL-17 sends instead.
   */
  containers: Uint8Array

  constructor(row: number, col: number, colOffset = 0, containers: Uint8Array = InputFocus.containerIDs) {
    this.row = row
    this.col = col
    this.colOffset = colOffset
    this.containers = containers
  }

  /** The value bytes: 10 with one container id. */
  get bytes(): Uint8Array {
    const output = new ByteWriter(DyntFocus.fixedSize + this.containers.length)
    DyntFocus.append(
      { areaID: InputFocus.focusNumber, row: this.row, col: this.col, rowOffset: 0, colOffset: this.colOffset, containerIDs: this.containers },
      output
    )
    return output.toBytes()
  }
}

/**
 * The client DATAMANAGER document of Reading R-CI-17: the bare document, the one element
 * `DATAMANAGER` with nothing in it, as the server's own bare document (PV-0930), declared with the
 * client encoding name `sap*` (PV-0931), in ASCII bytes (R-IT-11). A client without controls has
 * nothing to put in it; what a GUI's document holds on its logon step is not in the sources (#20,
 * #83).
 */
export const ClientDataManager = {
  /** The document's bytes (a fresh copy on every read). */
  get bareDocument(): Uint8Array {
    return ascii('<?xml version="1.0" encoding="sap*"?><DATAMANAGER/>') // provenance: PV-0781, PV-0930, PV-0931
  },
  /** Native multiple-logon confirmation's empty GUI node; opt-in until accepted live (a fresh copy on every read). */
  get nativeLogonDocument(): Uint8Array {
    return ascii('<?xml version="1.0" encoding="sap*"?><DATAMANAGER><COPY id="copy"><GUI id="gui"/></COPY></DATAMANAGER>') // provenance: PV-1029
  }
} as const
