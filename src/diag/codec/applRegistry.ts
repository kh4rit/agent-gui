// SPDX-License-Identifier: MIT
// Ported from Swooey Sources/DiagCodec/ApplRegistry.swift (MIT).

// The (id, sid) registry of APPL and APPL4 items (docs/protocol/items.md, "APPL id registry" and
// "APPL sid registry"). Names are identifiers from the sources, used for diagnostics and
// dispatch; neither source explains them, and this file states no payload layout. Payloads are
// specified only for the pairs session.md and dynt-atoms.md cover; every other value is opaque
// (IMPL-IT-1, #33).

import { hexByte } from "../wire/index.js"

/**
 * The seventeen APPL ids both sources name (PV-0430–PV-0446). ids 0x00, 0x0D, 0x10, 0x11 and
 * every value above 0x14 have no name.
 */
const APPL_IDS = {
  script: [0x01, "SCRIPT"], // provenance: PV-0430
  graph: [0x02, "GRAPH"], // provenance: PV-0431
  ixos: [0x03, "IXOS"], // provenance: PV-0432
  stUser: [0x04, "ST_USER"], // provenance: PV-0433
  dynn: [0x05, "DYNN"], // provenance: PV-0434
  /** ST_R3INFO. Swift names avoid SAP marks (AGENTS.md, Code style); the protocol's own name is `ApplID.name`. */
  stSystemInfo: [0x06, "ST_R3INFO"], // provenance: PV-0435
  popu: [0x07, "POPU"], // provenance: PV-0436
  rfcTR: [0x08, "RFC_TR"], // provenance: PV-0437
  dynt: [0x09, "DYNT"], // provenance: PV-0438
  container: [0x0a, "CONTAINER"], // provenance: PV-0439
  mnuEntry: [0x0b, "MNUENTRY"], // provenance: PV-0440
  varInfo: [0x0c, "VARINFO"], // provenance: PV-0441
  control: [0x0e, "CONTROL"], // provenance: PV-0442
  uiEvent: [0x0f, "UI_EVENT"], // provenance: PV-0443
  accList: [0x12, "ACC_LIST"], // provenance: PV-0444
  rcui: [0x13, "RCUI"], // provenance: PV-0445
  guiPacket: [0x14, "GUI_PACKET"] // provenance: PV-0446
} as const satisfies Record<string, readonly [number, string]>

/** An APPL id the registry names. */
export type ApplID = keyof typeof APPL_IDS

const APPL_ID_CASES = Object.keys(APPL_IDS) as ApplID[]
const APPL_ID_BY_BYTE = new Map<number, ApplID>(APPL_ID_CASES.map(id => [APPL_IDS[id][0], id]))

export const ApplID = {
  /** The seventeen ids in ascending byte order. */
  allCases: APPL_ID_CASES as readonly ApplID[],

  /** The id of a byte, or undefined for a byte the registry does not name. */
  fromRaw(byte: number): ApplID | undefined {
    return APPL_ID_BY_BYTE.get(byte)
  },

  /** The id byte. */
  rawValue(id: ApplID): number {
    return APPL_IDS[id][0]
  },

  /** The id's name as the registry writes it. */
  name(id: ApplID): string {
    return APPL_IDS[id][1]
  },

  /** The name of `sid` in this id's table, or undefined when the table has no such sid. */
  sidName(id: ApplID, sid: number): string | undefined {
    return ApplItem.sidName(ApplItem.of(APPL_IDS[id][0], sid))
  }
} as const

/**
 * A table of sids under one APPL id (Swift's `ApplSIDTable` protocol): the sid byte and the sid's
 * name as the spec's registry writes it (spaces included), per case.
 */
export interface ApplSIDTable<S extends string> {
  /** The id whose sids this table lists. */
  readonly applID: ApplID
  /** Every sid of the table, in ascending byte order. */
  readonly allCases: readonly S[]
  /** The sid of a byte, or undefined when the table has no such sid. */
  fromRaw(byte: number): S | undefined
  /** The sid byte. */
  rawValue(sid: S): number
  /** The sid's name as the spec's registry writes it (spaces included). */
  name(sid: S): string
}

function sidTable<S extends string>(applID: ApplID, entries: Record<S, readonly [number, string]>): ApplSIDTable<S> {
  const cases = Object.keys(entries) as S[]
  const byByte = new Map<number, S>(cases.map(sid => [entries[sid][0], sid]))
  return {
    applID,
    allCases: cases,
    fromRaw: byte => byByte.get(byte),
    rawValue: sid => entries[sid][0],
    name: sid => entries[sid][1]
  }
}

// The sid tables, one per id (items.md, "APPL sid registry"). sid numbers are separate per id:
// the same sid value means different things under different ids.

/** SCRIPT (0x01), PV-0450. */
const SCRIPT_SIDS = {
  scriptOTF: [0x01, "SCRIPT_OTF"], // provenance: PV-0450
  scriptScreen: [0x02, "SCRIPT_SCREEN"], // provenance: PV-0450
  scriptPostscript: [0x03, "SCRIPT_POSTSCRIPT"], // provenance: PV-0450
  scriptITF: [0x04, "SCRIPT_ITF"] // provenance: PV-0450
} as const

/** GRAPH (0x02), PV-0451. Both names contain a space in both sources. */
const GRAPH_SIDS = {
  graphRelease3: [0x03, "GRAPH RELEASE 3"], // provenance: PV-0451
  graphRelease5: [0x05, "GRAPH RELEASE 5"] // provenance: PV-0451
} as const

/** IXOS (0x03), PV-0452. */
const IXOS_SIDS = {
  ablage: [0x01, "ABLAGE"], // provenance: PV-0452
  anzeige: [0x02, "ANZEIGE"], // provenance: PV-0452
  ixosCommand: [0x03, "IXOS_COMMAND"] // provenance: PV-0452
} as const

/** ST_USER (0x04), PV-0453. Neither source has an entry for sid 0x0A. */
const ST_USER_SIDS = {
  v1: [0x01, "V1"], // provenance: PV-0453
  /** Payload: session.md §3 (`UserConnect`). */
  connect: [0x02, "CONNECT"], // provenance: PV-0453
  selectedRect: [0x03, "SELECTEDRECT"], // provenance: PV-0453
  fontMetric: [0x04, "FONTMETRIC"], // provenance: PV-0453
  tableMetric: [0x05, "TABLEMETRIC"], // provenance: PV-0453
  guiTime: [0x06, "GUITIME"], // provenance: PV-0453
  guiTimeZone: [0x07, "GUITIMEZONE"], // provenance: PV-0453
  turnTime: [0x08, "TURNTIME"], // provenance: PV-0453
  guiVersion: [0x09, "GUIVERSION"], // provenance: PV-0453
  /** Payload: session.md §5 (`SupportBits`). */
  supportData: [0x0b, "SUPPORTDATA"], // provenance: PV-0453
  rfcConnect: [0x0c, "RFC_CONNECT"], // provenance: PV-0453
  wsize: [0x0d, "WSIZE"], // provenance: PV-0453
  v2: [0x0e, "V2"], // provenance: PV-0453
  turnTime2: [0x0f, "TURNTIME2"], // provenance: PV-0453
  rfcParentUUID: [0x10, "RFC_PARENT_UUID"], // provenance: PV-0453
  rfcNewUUID: [0x11, "RFC_NEW_UUID"], // provenance: PV-0453
  rfcUUIDs: [0x12, "RFC_UUIDS"], // provenance: PV-0453
  rfcUUIDs2: [0x13, "RFC_UUIDS2"], // provenance: PV-0453
  xmlLogin: [0x14, "XML_LOGIN"], // provenance: PV-0453
  xmlTransaction: [0x15, "XML_TRANSACTION"], // provenance: PV-0453
  scrollbarWidth: [0x16, "SCROLLBAR_WIDTH"], // provenance: PV-0453
  toolbarHeight: [0x17, "TOOLBAR_HEIGHT"], // provenance: PV-0453
  passportData: [0x18, "PASSPORT_DATA"], // provenance: PV-0453
  guiState: [0x19, "GUI_STATE"], // provenance: PV-0453
  decimalPoint: [0x1a, "DECIMALPOINT"], // provenance: PV-0453
  language: [0x1b, "LANGUAGE"], // provenance: PV-0453
  username: [0x1c, "USERNAME"], // provenance: PV-0453
  guiPatchLevel: [0x1d, "GUIPATCHLEVEL"], // provenance: PV-0453
  wsizePixel: [0x1e, "WSIZE_PIXEL"], // provenance: PV-0453
  guiOSVersion: [0x1f, "GUI_OS_VERSION"], // provenance: PV-0453
  browserVersion: [0x20, "BROWSER_VERSION"], // provenance: PV-0453
  officeVersion: [0x21, "OFFICE_VERSION"], // provenance: PV-0453
  jdkVersion: [0x22, "JDK_VERSION"], // provenance: PV-0453
  guixtVersion: [0x23, "GUIXT_VERSION"], // provenance: PV-0453
  displaySize: [0x24, "DISPLAY_SIZE"], // provenance: PV-0453
  guiType: [0x25, "GUI_TYPE"], // provenance: PV-0453
  /** Payload: session.md §4.1 (`DialogStepNumber`). */
  dialogStepNumber: [0x26, "DIALOG_STEP_NUMBER"] // provenance: PV-0453
} as const

/** DYNN (0x05), PV-0454. */
const DYNN_SIDS = {
  /** The value is opaque: Wireshark's partial CHL layout is informative only (#32). */
  chl: [0x01, "CHL"], // provenance: PV-0454
  xmlpropDynpro: [0x03, "XMLPROP DYNPRO"] // provenance: PV-0454
} as const

/** ST_R3INFO (0x06), PV-0455. Payloads of the identity items: session.md §6. */
const ST_SYSTEM_INFO_SIDS = {
  modeNumber: [0x01, "MODENUMBER"], // provenance: PV-0455
  dbName: [0x02, "DBNAME"], // provenance: PV-0455
  cpuName: [0x03, "CPUNAME"], // provenance: PV-0455
  rfcTrigger: [0x04, "RFC_TRIGGER"], // provenance: PV-0455
  guiLabel: [0x05, "GUI_LABEL"], // provenance: PV-0455
  diagVersion: [0x06, "DIAGVERSION"], // provenance: PV-0455
  tcode: [0x07, "TCODE"], // provenance: PV-0455
  rfcWaiting: [0x08, "RFC_WAITING"], // provenance: PV-0455
  rfcRefresh: [0x09, "RFC_REFRESH"], // provenance: PV-0455
  imodeNumber: [0x0a, "IMODENUMBER"], // provenance: PV-0455
  message: [0x0b, "MESSAGE"], // provenance: PV-0455
  client: [0x0c, "CLIENT"], // provenance: PV-0455
  dynproName: [0x0d, "DYNPRONAME"], // provenance: PV-0455
  dynproNumber: [0x0e, "DYNPRONUMBER"], // provenance: PV-0455
  cuaName: [0x0f, "CUANAME"], // provenance: PV-0455
  cuaStatus: [0x10, "CUASTATUS"], // provenance: PV-0455
  /** The server's capability mask, the same structure as ST_USER SUPPORTDATA (PV-0537). */
  supportData: [0x11, "SUPPORTDATA"], // provenance: PV-0455
  rfcConnectOK: [0x12, "RFC_CONNECT_OK"], // provenance: PV-0455
  guiFKey: [0x13, "GUI_FKEY"], // provenance: PV-0455
  guiFKeyT: [0x14, "GUI_FKEYT"], // provenance: PV-0455
  stopTrans: [0x15, "STOP_TRANS"], // provenance: PV-0455
  rfcDiagBlockSize: [0x16, "RFC_DIAG_BLOCK_SIZE"], // provenance: PV-0455
  userChecked: [0x17, "USER_CHECKED"], // provenance: PV-0455
  flags: [0x18, "FLAGS"], // provenance: PV-0455
  userID: [0x19, "USERID"], // provenance: PV-0455
  rollCount: [0x1a, "ROLLCOUNT"], // provenance: PV-0455
  guiXTVar: [0x1b, "GUI_XT_VAR"], // provenance: PV-0455
  imodeUUID: [0x1c, "IMODEUUID"], // provenance: PV-0455
  imodeUUIDInvalidate: [0x1d, "IMODEUUID_INVALIDATE"], // provenance: PV-0455
  imodeUUIDs: [0x1e, "IMODEUUIDS"], // provenance: PV-0455
  imodeUUIDs2: [0x1f, "IMODEUUIDS2"], // provenance: PV-0455
  codepage: [0x20, "CODEPAGE"], // provenance: PV-0455
  contextID: [0x21, "CONTEXTID"], // provenance: PV-0455
  autologoutTime: [0x22, "AUTOLOGOUT_TIME"], // provenance: PV-0455
  codepageDiagGUI: [0x23, "CODEPAGE_DIAG_GUI"], // provenance: PV-0455
  codepageAppServer: [0x24, "CODEPAGE_APP_SERVER"], // provenance: PV-0455
  guiTheme: [0x25, "GUI_THEME"], // provenance: PV-0455
  guiUserScripting: [0x26, "GUI_USER_SCRIPTING"], // provenance: PV-0455
  codepageAppServer1: [0x27, "CODEPAGE_APP_SERVER_1"], // provenance: PV-0455
  ticket4GUI: [0x28, "TICKET4GUI"], // provenance: PV-0455
  kernelVersion: [0x29, "KERNEL_VERSION"], // provenance: PV-0455
  stdToolbarItems: [0x2a, "STD_TOOLBAR_ITEMS"] // provenance: PV-0455
} as const

/** POPU (0x07), PV-0456. */
const POPU_SIDS = {
  dest: [0x02, "DEST"] // provenance: PV-0456
} as const

/** RFC_TR (0x08), PV-0457: the only table whose sids start at 0x00. */
const RFC_TR_SIDS = {
  req: [0x00, "RFC_TR_REQ"], // provenance: PV-0457
  ret: [0x01, "RFC_TR_RET"], // provenance: PV-0457
  err: [0x02, "RFC_TR_ERR"], // provenance: PV-0457
  rqt: [0x03, "RFC_TR_RQT"], // provenance: PV-0457
  mor: [0x04, "RFC_TR_MOR"], // provenance: PV-0457
  mob: [0x05, "RFC_TR_MOB"], // provenance: PV-0457
  rnb: [0x06, "RFC_TR_RNB"], // provenance: PV-0457
  rnt: [0x07, "RFC_TR_RNT"], // provenance: PV-0457
  dis: [0x08, "RFC_TR_DIS"], // provenance: PV-0457
  call: [0x09, "RFC_TR_CALL"], // provenance: PV-0457
  callEnd: [0x0a, "RFC_TR_CALL_END"], // provenance: PV-0457
  res: [0x0b, "RFC_TR_RES"] // provenance: PV-0457
} as const

/**
 * DYNT (0x09): PV-0458 (named by both sources) and PV-0459 (0x13 and 0x14, named by Wireshark
 * only). DYNT_ATOM and DYNT_TABSTRIP_BUTTONS carry atoms (dynt-atoms.md).
 */
const DYNT_SIDS = {
  focus: [0x01, "DYNT_FOCUS"], // provenance: PV-0458
  atom: [0x02, "DYNT_ATOM"], // provenance: PV-0458
  eventUnused: [0x03, "DYNT_EVENT_UNUSED"], // provenance: PV-0458
  tableRowReference: [0x04, "TABLE_ROW_REFERENCE"], // provenance: PV-0458
  tableRowDatInputDummy: [0x05, "TABLE_ROW_DAT_INPUT_DUMMY"], // provenance: PV-0458
  tableInputHeader: [0x06, "TABLE_INPUT_HEADER"], // provenance: PV-0458
  tableOutputHeader: [0x07, "TABLE_OUTPUT_HEADER"], // provenance: PV-0458
  tableRowDataInput: [0x08, "TABLE_ROW_DATA_INPUT"], // provenance: PV-0458
  tableRowDataOutput: [0x09, "TABLE_ROW_DATA_OUTPUT"], // provenance: PV-0458
  noFocus: [0x0a, "DYNT_NOFOCUS"], // provenance: PV-0458
  focus1: [0x0b, "DYNT_FOCUS_1"], // provenance: PV-0458
  tableRowReference1: [0x0c, "TABLE_ROW_REFERENCE_1"], // provenance: PV-0458
  tableFieldNames: [0x0d, "TABLE_FIELD_NAMES"], // provenance: PV-0458
  tableHeader: [0x0e, "TABLE_HEADER"], // provenance: PV-0458
  tabstripHeader: [0x0f, "DYNT_TABSTRIP_HEADER"], // provenance: PV-0458
  tabstripButtons: [0x10, "DYNT_TABSTRIP_BUTTONS"], // provenance: PV-0458
  tableRowReference2: [0x11, "TABLE_ROW_REFERENCE_2"], // provenance: PV-0458
  controlFocus: [0x12, "DYNT_CONTROL_FOCUS"], // provenance: PV-0458
  tableFieldXMLProp: [0x13, "TABLE_FIELD_XMLPROP"], // provenance: PV-0459
  splitterHeader: [0x14, "DYNT_SPLITTER_HEADER"], // provenance: PV-0459
  tcColumnTitleXMLP: [0x15, "DYNT_TC_COLUMN_TITLE_XMLP"], // provenance: PV-0458
  tcRowSelectorName: [0x16, "DYNT_TC_ROW_SELECTOR_NAME"], // provenance: PV-0458
  focusFrame: [0x17, "DYNT_FOCUS_FRAME"] // provenance: PV-0458
} as const

/** CONTAINER (0x0A), PV-0460. Neither source names sid 0x07 or 0x0B. */
const CONTAINER_SIDS = {
  reset: [0x01, "RESET"], // provenance: PV-0460
  default: [0x02, "DEFAULT"], // provenance: PV-0460
  subscreen: [0x03, "SUBSCREEN"], // provenance: PV-0460
  loop: [0x04, "LOOP"], // provenance: PV-0460
  table: [0x05, "TABLE"], // provenance: PV-0460
  /** The sid named NAME (renamed here because every table has a `name` property). */
  containerName: [0x06, "NAME"], // provenance: PV-0460
  tabstrip: [0x08, "TABSTRIP"], // provenance: PV-0460
  tabstripPage: [0x09, "TABSTRIP_PAGE"], // provenance: PV-0460
  control: [0x0a, "CONTROL"], // provenance: PV-0460
  xmlprop: [0x0c, "XMLPROP"], // provenance: PV-0460
  splitter: [0x0d, "SPLITTER"], // provenance: PV-0460
  splitterCell: [0x0e, "SPLITTER_CELL"] // provenance: PV-0460
} as const

/** MNUENTRY (0x0B), PV-0461. */
const MNU_ENTRY_SIDS = {
  menuAct: [0x01, "MENU_ACT"], // provenance: PV-0461
  menuMnu: [0x02, "MENU_MNU"], // provenance: PV-0461
  menuPfk: [0x03, "MENU_PFK"], // provenance: PV-0461
  menuKyb: [0x04, "MENU_KYB"] // provenance: PV-0461
} as const

/** VARINFO (0x0C), PV-0462. */
const VAR_INFO_SIDS = {
  mestype: [0x01, "MESTYPE"], // provenance: PV-0462
  scrollInfos: [0x02, "SCROLL_INFOS"], // provenance: PV-0462
  mestype2: [0x03, "MESTYPE2"], // provenance: PV-0462
  okcode: [0x04, "OKCODE"], // provenance: PV-0462
  container: [0x05, "CONTAINER"], // provenance: PV-0462
  scrollInfos2: [0x06, "SCROLL_INFOS2"], // provenance: PV-0462
  areaSize: [0x07, "AREASIZE"], // provenance: PV-0462
  areaPixelSize: [0x08, "AREA_PIXELSIZE"], // provenance: PV-0462
  sessionTitle: [0x09, "SESSION_TITLE"], // provenance: PV-0462
  sessionIcon: [0x0a, "SESSION_ICON"], // provenance: PV-0462
  listCellText: [0x0b, "LIST_CELL_TEXT"], // provenance: PV-0462
  containerLoop: [0x0c, "CONTAINER_LOOP"], // provenance: PV-0462
  listFocus: [0x0d, "LIST_FOCUS"], // provenance: PV-0462
  mainAreaPixelSize: [0x0e, "MAINAREA_PIXELSIZE"], // provenance: PV-0462
  serviceRequest: [0x0f, "SERVICE_REQUEST"] // provenance: PV-0462
} as const

/** CONTROL (0x0E), PV-0463. */
const CONTROL_SIDS = {
  controlProperties: [0x01, "CONTROL_PROPERTIES"] // provenance: PV-0463
} as const

/** UI_EVENT (0x0F), PV-0464. */
const UI_EVENT_SIDS = {
  uiEventSource: [0x01, "UI_EVENT_SOURCE"] // provenance: PV-0464
} as const

/** ACC_LIST (0x12), PV-0465. */
const ACC_LIST_SIDS = {
  info4Field: [0x01, "ACC_LIST_INFO4FIELD"], // provenance: PV-0465
  container: [0x02, "ACC_LIST_CONTAINER"] // provenance: PV-0465
} as const

/** RCUI (0x13), PV-0466. Neither source decodes any RCUI value. */
const RCUI_SIDS = {
  stream: [0x01, "RCUI_STREAM"], // provenance: PV-0466
  systemError: [0x02, "RCUI_SYSTEM_ERROR"], // provenance: PV-0466
  spagpa: [0x03, "RCUI_SPAGPA"], // provenance: PV-0466
  memoryID: [0x04, "RCUI_MEMORYID"], // provenance: PV-0466
  txOption: [0x05, "RCUI_TXOPTION"], // provenance: PV-0466
  value: [0x06, "RCUI_VALUE"], // provenance: PV-0466
  command: [0x07, "RCUI_COMMAND"], // provenance: PV-0466
  bdcMsg: [0x08, "RCUI_BDCMSG"], // provenance: PV-0466
  connectData: [0x09, "RCUI_CONNECT_DATA"] // provenance: PV-0466
} as const

/** GUI_PACKET (0x14), PV-0467. */
const GUI_PACKET_SIDS = {
  state: [0x01, "GUI_PACKET_STATE"], // provenance: PV-0467
  data: [0x02, "GUI_PACKET_DATA"] // provenance: PV-0467
} as const

export type ApplSIDScript = keyof typeof SCRIPT_SIDS
export type ApplSIDGraph = keyof typeof GRAPH_SIDS
export type ApplSIDIxos = keyof typeof IXOS_SIDS
export type ApplSIDStUser = keyof typeof ST_USER_SIDS
export type ApplSIDDynn = keyof typeof DYNN_SIDS
export type ApplSIDStSystemInfo = keyof typeof ST_SYSTEM_INFO_SIDS
export type ApplSIDPopu = keyof typeof POPU_SIDS
export type ApplSIDRfcTr = keyof typeof RFC_TR_SIDS
export type ApplSIDDynt = keyof typeof DYNT_SIDS
export type ApplSIDContainer = keyof typeof CONTAINER_SIDS
export type ApplSIDMnuEntry = keyof typeof MNU_ENTRY_SIDS
export type ApplSIDVarInfo = keyof typeof VAR_INFO_SIDS
export type ApplSIDControl = keyof typeof CONTROL_SIDS
export type ApplSIDUIEvent = keyof typeof UI_EVENT_SIDS
export type ApplSIDAccList = keyof typeof ACC_LIST_SIDS
export type ApplSIDRcui = keyof typeof RCUI_SIDS
export type ApplSIDGuiPacket = keyof typeof GUI_PACKET_SIDS

/**
 * The sid tables, one per id (items.md, "APPL sid registry"): Swift's `ApplSID.Script`,
 * `ApplSID.StUser` and so on. The case types are `ApplSIDScript`, `ApplSIDStUser`, ….
 */
export const ApplSID = {
  Script: sidTable<ApplSIDScript>("script", SCRIPT_SIDS),
  Graph: sidTable<ApplSIDGraph>("graph", GRAPH_SIDS),
  Ixos: sidTable<ApplSIDIxos>("ixos", IXOS_SIDS),
  StUser: sidTable<ApplSIDStUser>("stUser", ST_USER_SIDS),
  Dynn: sidTable<ApplSIDDynn>("dynn", DYNN_SIDS),
  StSystemInfo: sidTable<ApplSIDStSystemInfo>("stSystemInfo", ST_SYSTEM_INFO_SIDS),
  Popu: sidTable<ApplSIDPopu>("popu", POPU_SIDS),
  RfcTr: sidTable<ApplSIDRfcTr>("rfcTR", RFC_TR_SIDS),
  Dynt: {
    ...sidTable<ApplSIDDynt>("dynt", DYNT_SIDS),
    /** Whether only Wireshark names this sid (PV-0459). */
    isNamedByWiresharkOnly(sid: ApplSIDDynt): boolean {
      return sid === "tableFieldXMLProp" || sid === "splitterHeader"
    }
  },
  Container: sidTable<ApplSIDContainer>("container", CONTAINER_SIDS),
  MnuEntry: sidTable<ApplSIDMnuEntry>("mnuEntry", MNU_ENTRY_SIDS),
  VarInfo: sidTable<ApplSIDVarInfo>("varInfo", VAR_INFO_SIDS),
  Control: sidTable<ApplSIDControl>("control", CONTROL_SIDS),
  UIEvent: sidTable<ApplSIDUIEvent>("uiEvent", UI_EVENT_SIDS),
  AccList: sidTable<ApplSIDAccList>("accList", ACC_LIST_SIDS),
  Rcui: sidTable<ApplSIDRcui>("rcui", RCUI_SIDS),
  GuiPacket: sidTable<ApplSIDGuiPacket>("guiPacket", GUI_PACKET_SIDS)
} as const

/** The table of each registered id. */
const TABLES: Record<ApplID, ApplSIDTable<string>> = {
  script: ApplSID.Script,
  graph: ApplSID.Graph,
  ixos: ApplSID.Ixos,
  stUser: ApplSID.StUser,
  dynn: ApplSID.Dynn,
  stSystemInfo: ApplSID.StSystemInfo,
  popu: ApplSID.Popu,
  rfcTR: ApplSID.RfcTr,
  dynt: ApplSID.Dynt,
  container: ApplSID.Container,
  mnuEntry: ApplSID.MnuEntry,
  varInfo: ApplSID.VarInfo,
  control: ApplSID.Control,
  uiEvent: ApplSID.UIEvent,
  accList: ApplSID.AccList,
  rcui: ApplSID.Rcui,
  guiPacket: ApplSID.GuiPacket
}

/**
 * The (id, sid) pair of an APPL or APPL4 item, resolved against the registry. Every pair of bytes
 * has a value: a pair the registry does not name is `unknownID` or `unknownSID`, and is stepped
 * over by its length and counted (IMPL-IT-1).
 *
 * Dispatch is on (id, sid) alone, the same for both carriers (IMPL-IT-9): Swift's
 * `case .stUser(.connect)?:` is `appl?.kind === "stUser" && appl.sid === "connect"`, and
 * `item.appl == .dynt(.atom)` is `ApplItem.equals(item.appl, ApplItem.dynt("atom"))`.
 */
export type ApplItem =
  | { readonly kind: "script"; readonly sid: ApplSIDScript }
  | { readonly kind: "graph"; readonly sid: ApplSIDGraph }
  | { readonly kind: "ixos"; readonly sid: ApplSIDIxos }
  | { readonly kind: "stUser"; readonly sid: ApplSIDStUser }
  | { readonly kind: "dynn"; readonly sid: ApplSIDDynn }
  | { readonly kind: "stSystemInfo"; readonly sid: ApplSIDStSystemInfo }
  | { readonly kind: "popu"; readonly sid: ApplSIDPopu }
  | { readonly kind: "rfcTR"; readonly sid: ApplSIDRfcTr }
  | { readonly kind: "dynt"; readonly sid: ApplSIDDynt }
  | { readonly kind: "container"; readonly sid: ApplSIDContainer }
  | { readonly kind: "mnuEntry"; readonly sid: ApplSIDMnuEntry }
  | { readonly kind: "varInfo"; readonly sid: ApplSIDVarInfo }
  | { readonly kind: "control"; readonly sid: ApplSIDControl }
  | { readonly kind: "uiEvent"; readonly sid: ApplSIDUIEvent }
  | { readonly kind: "accList"; readonly sid: ApplSIDAccList }
  | { readonly kind: "rcui"; readonly sid: ApplSIDRcui }
  | { readonly kind: "guiPacket"; readonly sid: ApplSIDGuiPacket }
  /** A registered id with a sid its table does not list (for example ST_USER 0x0A). */
  | { readonly kind: "unknownSID"; readonly applID: ApplID; readonly sid: number }
  /** An id the registry does not list. */
  | { readonly kind: "unknownID"; readonly id: number; readonly sid: number }

/** The registered cases of `ApplItem` (those whose `kind` is an `ApplID`). */
type RegisteredApplItem = Exclude<ApplItem, { kind: "unknownSID" } | { kind: "unknownID" }>

export const ApplItem = {
  /** Resolves a pair of bytes (Swift `ApplItem(id:sid:)`). */
  of(id: number, sid: number): ApplItem {
    const applID = ApplID.fromRaw(id)
    if (applID === undefined) return { kind: "unknownID", id, sid }
    const resolved = TABLES[applID].fromRaw(sid)
    if (resolved === undefined) return { kind: "unknownSID", applID, sid }
    return { kind: applID, sid: resolved } as ApplItem
  },

  // Constructor helpers: Swift's `.stUser(.connect)` is `ApplItem.stUser("connect")`.
  script: (sid: ApplSIDScript): ApplItem => ({ kind: "script", sid }),
  graph: (sid: ApplSIDGraph): ApplItem => ({ kind: "graph", sid }),
  ixos: (sid: ApplSIDIxos): ApplItem => ({ kind: "ixos", sid }),
  stUser: (sid: ApplSIDStUser): ApplItem => ({ kind: "stUser", sid }),
  dynn: (sid: ApplSIDDynn): ApplItem => ({ kind: "dynn", sid }),
  stSystemInfo: (sid: ApplSIDStSystemInfo): ApplItem => ({ kind: "stSystemInfo", sid }),
  popu: (sid: ApplSIDPopu): ApplItem => ({ kind: "popu", sid }),
  rfcTR: (sid: ApplSIDRfcTr): ApplItem => ({ kind: "rfcTR", sid }),
  dynt: (sid: ApplSIDDynt): ApplItem => ({ kind: "dynt", sid }),
  container: (sid: ApplSIDContainer): ApplItem => ({ kind: "container", sid }),
  mnuEntry: (sid: ApplSIDMnuEntry): ApplItem => ({ kind: "mnuEntry", sid }),
  varInfo: (sid: ApplSIDVarInfo): ApplItem => ({ kind: "varInfo", sid }),
  control: (sid: ApplSIDControl): ApplItem => ({ kind: "control", sid }),
  uiEvent: (sid: ApplSIDUIEvent): ApplItem => ({ kind: "uiEvent", sid }),
  accList: (sid: ApplSIDAccList): ApplItem => ({ kind: "accList", sid }),
  rcui: (sid: ApplSIDRcui): ApplItem => ({ kind: "rcui", sid }),
  guiPacket: (sid: ApplSIDGuiPacket): ApplItem => ({ kind: "guiPacket", sid }),
  unknownSID: (applID: ApplID, sid: number): ApplItem => ({ kind: "unknownSID", applID, sid }),
  unknownID: (id: number, sid: number): ApplItem => ({ kind: "unknownID", id, sid }),

  /** The registered id, or undefined for `unknownID`. */
  applID(item: ApplItem): ApplID | undefined {
    switch (item.kind) {
      case "unknownSID":
        return item.applID
      case "unknownID":
        return undefined
      default:
        return item.kind
    }
  },

  /** The id byte. */
  id(item: ApplItem): number {
    if (item.kind === "unknownID") return item.id
    // Every other case has a registered id.
    return ApplID.rawValue(ApplItem.applID(item)!)
  },

  /** The sid byte. */
  sid(item: ApplItem): number {
    switch (item.kind) {
      case "unknownSID":
      case "unknownID":
        return item.sid
      default:
        return (TABLES[item.kind] as ApplSIDTable<string>).rawValue(item.sid)
    }
  },

  /** The id's registry name, or undefined for an unregistered id. */
  idName(item: ApplItem): string | undefined {
    const applID = ApplItem.applID(item)
    return applID === undefined ? undefined : ApplID.name(applID)
  },

  /** The sid's registry name in its id's table, or undefined when the pair is not registered. */
  sidName(item: ApplItem): string | undefined {
    if (item.kind === "unknownSID" || item.kind === "unknownID") return undefined
    const registered = item as RegisteredApplItem
    return (TABLES[registered.kind] as ApplSIDTable<string>).name(registered.sid)
  },

  /** Whether the registry names the pair. */
  isRegistered(item: ApplItem): boolean {
    return ApplItem.sidName(item) !== undefined
  },

  /** "ID SID" for diagnostics, for example `ST_USER CONNECT`, with hex for unnamed parts. */
  displayName(item: ApplItem): string {
    return (
      (ApplItem.idName(item) ?? "id " + hex(ApplItem.id(item))) + " " + (ApplItem.sidName(item) ?? "sid " + hex(ApplItem.sid(item)))
    )
  },

  /** Swift's `==`: the same case with the same associated values. */
  equals(a: ApplItem | undefined, b: ApplItem | undefined): boolean {
    if (a === undefined || b === undefined) return a === b
    if (a.kind !== b.kind || a.sid !== b.sid) return false
    if (a.kind === "unknownSID") return a.applID === (b as typeof a).applID
    if (a.kind === "unknownID") return a.id === (b as typeof a).id
    return true
  }
} as const

function hex(value: number): string {
  return "0x" + hexByte(value) // not-protocol: hex formatting
}
