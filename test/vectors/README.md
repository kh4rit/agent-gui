# Independent test vectors

Byte vectors written independently of any implementation, from [protocol spec v2](../../docs/protocol/README.md). They are the "Independent vectors" test layer of docs/testing.md §3. Implementers drive table tests from them: a harness in `Tests/VectorSupport` parses each file, runs the decoder its `kind` names, and compares the result with the file's `expect.*` lines. Nothing else needs to be read to run them.

## Rules

- **From the spec, not from the code.** Any session may add or change vectors (D22), but only to follow the spec: a vector that disagrees with the implementation is checked against its spec section, never edited to match the code. Vectors are goldens for the `test-integrity` job (docs/testing.md §1).
- **Every byte follows from the spec.** Each vector names the spec section and the PROVENANCE rows its bytes follow from, and says in one `derivation` line how. Bytes the spec treats as opaque (payloads, XMLBLOB values, bytes after a dispatcher literal) are arbitrary and say so. A spec statement that depends on a reading names the reading (`R-…`), and a negative vector that depends on project policy names the rule (`IMPL-…`).
- **No captured traffic.** Vectors are built by hand from the spec text. None of them contains bytes from SAP GUI, from pysap's or Wireshark's test data, from open-diag-go's or sap-tui's captures and test data, from abap-adt-api's or the VS Code extension's test directories, from a live system or from an employer system. Every vector carries `source: spec`. A vector for a `trial-derived` fact (CLEANROOM.md §1 rule 4c) is built the same way, from the spec text, and may be committed (D21, D23).
- **Invented texts (D15).** Texts that carry no protocol fact (captions, labels, field values) are invented, as all mock data is (docs/testing.md §8): they never copy a real SAP screen's texts or well-known demo values, and a text longer than a placeholder such as `X` or `AB` is deliberately funny, like the caption `Socks lost` and the value `Quack` in `dynt/`. The only real names are the ones the spec itself cites, such as the `RSYST-*` field names.
- **One fault per negative vector.** A negative vector contains exactly one defect, so the order of checks never matters.
- **Coverage.** docs/testing.md §3 asks for at least one vector per item kind and compression mode. v1 covers NI frames and payloads, the DP header, the DIAG header and error body, the compression header, LZH and LZC data, every item type of known size, APPL and APPL4, the simple-item layouts, CONNECT, SUPPORTDATA, DIALOG_STEP_NUMBER and DYNT atoms. Not covered, because the spec leaves them open or they need inputs of tens of kilobytes: XMLBLOB value content (#20), OKC's size (#30), APPL payloads other than those above (#33), LZH with a full 16 KiB history and the 16 122 distance limit, LZC width growth beyond 10 bits and maxbits 16 with a full dictionary. Implementation round-trip tests against Swooey's own encoders cover the large cases (docs/testing.md §3).
- **Coverage in v2.** v2 adds the server-screen value layouts (window and area sizes, font metric, container geometry, scrolling, list focus, DYNT_FOCUS_1, IMODEUUIDS2, the zero-terminated strings of CONTAINER NAME and KERNEL_VERSION, menu entries) and screen-identity extraction; a server logon-style screen, a server logoff header and a client input step for the existing `items`, `dynt-atoms` and `diag-header` kinds; the twelve kinds of the ADT specification, which run since the ADT client exists ([ADT kinds](#adt-kinds)); and the Control Framework kinds, which wait for their milestone ([Kinds without an implementation yet](#kinds-without-an-implementation-yet)). Not covered in v2: the inside of UI_EVENT_SOURCE (no kind yet; with NAVIGATION_DATA clear its event-data width is #56), and the parts of ADT the [ADT kinds](#adt-kinds) list as not covered.

## Layout

| Directory | Kinds | Spec |
|---|---|---|
| `ni/` | `ni-stream`, `ni-payload` | [ni-framing.md](../../docs/protocol/ni-framing.md) |
| `dp-header/` | `dp-header` | [dp-header.md](../../docs/protocol/dp-header.md) |
| `diag-header/` | `diag-header` | [diag-header.md](../../docs/protocol/diag-header.md) |
| `diag-error-body/` | `diag-error-body` | [diag-header.md, Error body layout](../../docs/protocol/diag-header.md#error-body-layout) |
| `compression-header/` | `compression-header` | [compression-header.md](../../docs/protocol/compression-header.md) |
| `compression/` | `decompress` | [compression-lzh.md](../../docs/protocol/compression-lzh.md), [compression-lzc.md](../../docs/protocol/compression-lzc.md) |
| `items/` | `items`, `simple-item-fields` | [items.md](../../docs/protocol/items.md) |
| `session/` | `connect`, `support-bits`, `dialog-step` | [session.md](../../docs/protocol/session.md) |
| `dynt/` | `dynt-atoms` | [dynt-atoms.md](../../docs/protocol/dynt-atoms.md) |
| `server-screen/` (v2) | `appl-fields`, `imode-uuids`, `dynt-focus`, `stringz-fields`, `menu-entries`, `screen-identity` | [server-screen.md](../../docs/protocol/server-screen.md) |
| `adt/` (v2) | `adt-request`, `adt-response-class`, `adt-exception`, `adt-link`, `adt-search-results`, `adt-object-structure`, `adt-versions-feed`, `adt-transports`, `adt-usage-references`, `adt-outline`, `adt-dumps-feed`, `adt-position` | [adt/](../../docs/protocol/adt/README.md) |
| `controls/` (v2), one directory per group: `control-properties/`, `rfc-items/` (v2.2), `rfc-table-content/`, `rfc-compressed-table/`, `cfw-streams/`, `datamanager/`, `alv-packets/` | `control-properties`, `rfc-items` (v2.2), `rfc-table-content`, `rfc-compressed-table`, `cfw-verbs`, `cfw-descriptors`, `cfw-values`, `datamanager`, `alv-catalog`, `alv-rows`, `alv-colour-cells` | [controls/](../../docs/protocol/controls/README.md) |

File names are lowercase words joined by hyphens, ending in `.vec`. Negative vectors start with `neg-`. The harness dispatches on `kind`, not on the directory. v2 vectors of the existing kinds `items`, `dynt-atoms` and `diag-header` (from the server-screen, client-input and Control Framework topics) sit in `items/`, `dynt/` and `diag-header/`, and their `spec` lines name the v2 file they come from.

## File format

A vector file is UTF-8 text with LF line endings. Example:

```
# source: spec
# spec: docs/protocol/items.md#xmlblob
# provenance: PV-0100, PV-0105, PV-0106, PV-0107
# kind: items
# description: A single XMLBLOB with a 4-byte value.
# derivation: Type byte 0x11, u32 BE length 4, value bytes arbitrary.
# expect.items: 1
# expect.item.1.type: xmlblob
# expect.item.1.offset: 5
# expect.item.1.length: 4
# expect.error: none
hex:
11                     # type XMLBLOB
00 00 00 04            # length 4, u32 BE
A1 B2 C3 D4            # value (opaque)
```

### Header

- Every line from the first line up to the `hex:` line is a header line of the form `# <key>: <value>`: a `#`, one space, the key, a colon, one space, and the value (the rest of the line, trimmed). Blank lines and free comments are not allowed in the header.
- A key matches `[a-z0-9][a-z0-9_.-]*` and appears at most once. Key order carries no meaning.

Required keys:

| Key | Value |
|---|---|
| `source` | `spec` for every vector |
| `spec` | the spec section the bytes follow from: a path from the repository root plus a heading anchor, `docs/protocol/<file>.md#<anchor>` |
| `provenance` | comma-separated `PV-NNNN` IDs, each a row of [PROVENANCE.md](../../PROVENANCE.md) |
| `kind` | one of the kinds below |
| `description` | one line: what the vector shows |
| `derivation` | one line: how each byte follows from the spec |

Every other key starts with `expect.` and is defined by the kind. A few kinds take inputs besides the hex section as `expect.` keys marked **input** in their tables (for example `expect.id` and `expect.sid` of `appl-fields`, `expect.column_lengths` of `alv-rows`, and the `expect.in.…`, `expect.arg.…` and `expect.op` keys of the ADT kinds). The harness passes them to the code under test and does not compare them.

### Hex section

- The line `hex:` (exactly, with nothing after it) ends the header.
- The rest of the file is the input bytes. `#` starts a comment that runs to the end of the line. After comments are removed, the text splits on whitespace into tokens, and each token is exactly two hex digits (spec vectors use uppercase). Tokens are bytes in input order.
- The section may be empty: the input then has zero bytes.

### Value types

| Type | Syntax |
|---|---|
| `int` | decimal, no sign, no separators |
| `byte` | `0x` and two uppercase hex digits, e.g. `0x5A` |
| `hex` | two-digit hex bytes separated by single spaces, or `none` |
| `name` | one token from the kind's list |
| `names` | tokens from the kind's list joined by commas without spaces, or `none` |
| `text` (v2) | the rest of the header line after `: `, trimmed like every header value: printable ASCII, inner spaces allowed. `none` means the value is absent (or, where the kind says so, empty). Vectors never use a text that is literally `none` and never one with leading or trailing spaces; such a value is given as `hex` |
| `uri` (v2) | a `text` value that is a path, optionally with `?query` and `#fragment`, exactly as sent or received |
| `ints` (v2) | decimal integers joined by commas without spaces |

## Kinds

One kind per decoder or value codec. Each has its own input, its own `expect.*` keys and its own error classes from the [shared vocabulary](#error-classes). v1 defined the thirteen kinds from `ni-stream` to `dynt-atoms`; v2 adds six kinds for server screens (`appl-fields` to `screen-identity`, below), which run like the v1 kinds, the twelve [ADT kinds](#adt-kinds), which run since 2026-09-27, and the ten Control Framework kinds of [Kinds without an implementation yet](#kinds-without-an-implementation-yet). v2.2 (2026-09-25) adds `rfc-items`, the RFC item walk and Swooey's item encoder, which runs like the v1 kinds.

### ni-stream

**Input:** the bytes one peer sends on a TCP connection, from the start of the connection to the moment the peer closes it.
**Under test:** the NI framer ([ni-framing.md, Reading a byte stream](../../docs/protocol/ni-framing.md#reading-a-byte-stream)). Feed it the input, then signal end of stream.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.frames` | int | always | number of complete frames produced |
| `expect.frame.<n>.offset` | int | for n = 1…frames | offset in the input of frame n's first payload byte |
| `expect.frame.<n>.length` | int | for n = 1…frames | payload length of frame n; the expected payload is `input[offset ..< offset + length]` |
| `expect.error` | name: `none`, `truncated` | always | state at end of stream: `none` if the input ended on a frame boundary, `truncated` if it ended inside a length field or payload |
| `expect.trailing` | int | always | input bytes after the last complete frame (0 when `error` is `none`) |

**Harness rules (IMPL-NI-3):** run each vector at least (a) as one read, (b) one byte per read, and (c) split into two reads at every position from 0 to the input length. Every run must give the same frames and the same error. Frames produced before a `truncated` error count. Run with a size cap of at least 256 bytes (IMPL-NI-1). No vector tests the cap, because it is not a protocol value. Keep-alive and dispatcher frames are ordinary frames to the framer; their payloads are classified by the `ni-payload` kind.

### ni-payload

**Input:** one complete frame payload received by the client from the server.
**Under test:** the payload classifier ([ni-framing.md, Payload classification](../../docs/protocol/ni-framing.md#payload-classification)) and the keep-alive reply (IMPL-NI-4).

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.class` | name: `empty`, `keepalive-ping`, `keepalive-pong`, `dispatcher-dptmmsg`, `dispatcher-dptmopc`, `diag` | always | the class from classification rules 1–5 |
| `expect.reply` | hex | always | the payload the client sends back (`NI_PONG\0` for a ping), or `none` |
| `expect.reply.frame` | hex | always | the complete bytes the client writes on the wire in reply: the u32 BE length of the reply, then the reply payload (PV-0201), or `none` |

**Harness rules:**
- `expect.reply.frame`, when not `none`, must equal the u32 BE length of `expect.reply` followed by `expect.reply`. The harness checks this consistency and then compares the bytes the implementation would write.
- Dispatcher payloads are classified by their 12-byte prefix whatever their length (R-NI-9). Vectors cover the bare literal and the 14- and 17-byte payloads pysap expects; the bytes after the literal are arbitrary because their content is gap #3.
- `ni-payload` has no negative vectors: every input gets a class.

### dp-header

**Input:** the complete payload of the first frame a client sends: the 200-byte DP header, then the rest of the first message (DIAG header and items), which this kind treats as opaque. A vector may hold fewer than 200 bytes to test truncation.
**Under test:** the fake server's first-message decoder (IMPL-DP-3) and, through the round trip, the client's DP header encoder (IMPL-DP-2, IMPL-DP-4) ([dp-header.md](../../docs/protocol/dp-header.md)).

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `truncated`, `length-mismatch` | always | result |
| `expect.length` | int | when `error` is `none` or `length-mismatch` | the DP length field: bytes 30–33 read as u32 LE |
| `expect.body_length` | int | when `error` is `none` or `length-mismatch` | input length − 200: the bytes after the DP header |
| `expect.terminal` | hex (exactly 15 bytes) | when `error` is `none` | bytes 81–95 |
| `expect.terminal.length` | int (0–15) | when `error` is `none` | the number of terminal bytes before the first `00`, or 15 if there is no `00` |
| `expect.template` | name: `yes`, `no` | when `error` is `none` | `yes` if every byte outside 30–33 and 81–95 equals the [first-message template](../../docs/protocol/dp-header.md#first-message-template) |

**Checks, in order (IMPL-DP-3):**
1. If the input is shorter than 200 bytes, the result is `truncated`.
2. Otherwise, if `expect.length` ≠ input length − 200, compared with checked arithmetic, the result is `length-mismatch`.
3. Otherwise the result is `none`. Bytes that differ from the template do not cause an error; they give `expect.template: no`.

**Round trip:** when `error` is `none` and `template` is `yes`, the encoder is given the name (the first `terminal.length` bytes of `expect.terminal`) and the body length (`expect.body_length`), and must reproduce exactly the first 200 input bytes. Every `template: yes` vector has only `00` bytes after the name, as R-DP-4 requires.

**Negative vectors:** a `truncated` vector carries only `expect.error`. A `length-mismatch` vector carries `expect.error`, `expect.length` and `expect.body_length`, so the harness can tell a wrong byte order from a wrong count.

### diag-header

**Input:** the bytes at which a DIAG header starts: offset 0 of a server frame payload, or right after the DP header in the client's first message. Vectors hold exactly 8 bytes, or fewer for truncation.
**Under test:** the DIAG header decoder plus body classification ([diag-header.md, Body classification](../../docs/protocol/diag-header.md#body-classification)) and, where marked, the client header encoder.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `truncated`, `unknown-compress` | always | result |
| `expect.mode`, `expect.com_flag`, `expect.mode_stat`, `expect.err_no`, `expect.msg_type`, `expect.msg_info`, `expect.msg_rc`, `expect.compress` | byte | when `error` is `none` | the eight fields at offsets 0–7 |
| `expect.com_flag.names` | names from `EOS`, `EOC`, `NOP`, `EOP`, `INI`, `CAS`, `NNM`, `GRA` | when `error` is `none` | flags set in com_flag, in ascending mask order (0x01 first) |
| `expect.body` | name: `items`, `compressed`, `error-text`, `compressed-error-text`, `snc` | when `error` is `none` | what follows the header (table below) |
| `expect.client_message` | name: `first`, `later`, `close` | no | the input is the header a client sends in this message role ([Client message headers](../../docs/protocol/diag-header.md#client-message-headers)); the harness also runs the client header encoder for that role and requires exactly the input bytes. For `later`, the encoder is given mode 0 and the vector's `expect.compress` |

| err_no | compress | `expect.body` |
|---|---|---|
| 0 | 0 | `items` |
| 0 | 1 | `compressed` |
| ≠ 0 | 0 | `error-text` (an error body: text, `0C`, items) |
| ≠ 0 | 1 | `compressed-error-text` (the decompressed data is an error body) |
| any | 2 or 3 | `snc` |
| any | 4–255 | error `unknown-compress` |

**Round trip:** when `error` is `none`, encoding the eight decoded fields gives back exactly the input.

### diag-error-body

**Input:** an error body: the bytes after the DIAG header of a message with err_no ≠ 0 and compress 0, or the decompressed data of one with compress 1 ([diag-header.md, Error body layout](../../docs/protocol/diag-header.md#error-body-layout)).
**Under test:** the error-body splitter. It finds the first byte `0C` (R-DH-6), takes the bytes before it as the error text and the bytes after it as an item sequence. The text is not decoded, because its byte order is gap #8. The items are not walked, because the `items` kind covers that.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `missing-terminator` | always | result |
| `expect.text.length` | int | when `error` is `none` | number of text bytes; the text is `input[0 ..< text.length]` |
| `expect.items.offset` | int | when `error` is `none` | offset of the first byte after the terminator (always text.length + 1) |
| `expect.items.length` | int | when `error` is `none` | number of bytes from items.offset to the end of the input (0 for an empty item sequence) |

Negative vectors carry only `expect.error`. Spec vectors keep `0C` out of the text bytes; whether a real text can contain `0C` inside a UTF-16 code unit is part of #8.

### compression-header

**Input:** the bytes right after a DIAG header whose compress byte is 1. Vectors hold exactly the 8-byte header, or fewer for truncation.
**Under test:** the compression header decoder ([compression-header.md](../../docs/protocol/compression-header.md#layout)), with checks in the order of IMPL-CH-4: `truncated`, `bad-magic`, `unknown-algorithm`, then for LZC only `bad-maxbits`.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `truncated`, `bad-magic`, `unknown-algorithm`, `bad-maxbits` | always | result |
| `expect.uncompressed_length` | int | when `error` is `none` | bytes 0–3, u32 LE |
| `expect.algorithm` | name: `lzh`, `lzc` | when `error` is `none` | from the low nibble of byte 4 |
| `expect.version` | int | when `error` is `none` | high nibble of byte 4 |
| `expect.level` | int | when `algorithm` is `lzh` | byte 7 |
| `expect.maxbits` | int | when `algorithm` is `lzc` | byte 7 & 0x1F (R-CH-5 as corrected in v1) |
| `expect.block_mode` | int, 0 or 1 | no; only when `algorithm` is `lzc` | bit 0x80 of byte 7; when absent, 1 |
| `expect.unused_bits` | byte | no; only when `algorithm` is `lzc` | byte 7 & 0x60; when absent, 0x00. Decoders ignore these bits; the key exists only so that the round trip can reproduce the input |

**Round trip:** when `error` is `none`, encoding (uncompressed_length, version, algorithm, and level, or maxbits, block_mode and unused_bits) gives back exactly the input. For LZH, byte 7 = level. For LZC, byte 7 = maxbits | unused_bits | (block_mode << 7).

### decompress

**Input:** the bytes right after a DIAG header whose compress byte is 1, up to the end of the frame: the 8-byte compression header, then the compressed data.
**Under test:** the compression header decoder (checks as for `compression-header`), then the decoder the algorithm nibble selects: LZH ([compression-lzh.md](../../docs/protocol/compression-lzh.md)) or LZC ([compression-lzc.md](../../docs/protocol/compression-lzc.md)). The declared uncompressed length is the expected output size.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `truncated`, `bad-magic`, `unknown-algorithm`, `bad-maxbits`, `bad-block-type`, `bad-code-lengths`, `bad-symbol`, `bad-distance`, `bad-code`, `data-truncated`, `length-mismatch` | always | result |
| `expect.algorithm` | name: `lzh`, `lzc` | when `error` is not `truncated`, `bad-magic` or `unknown-algorithm` | from the low nibble of header byte 4 |
| `expect.uncompressed_length` | int | same as `expect.algorithm` | header bytes 0–3, u32 LE |
| `expect.block_mode` | int, 0 or 1 | when `algorithm` is `lzc` | header byte 7 bit 0x80: 1 is block mode, 0 single-block mode (PV-0312) |
| `expect.output_length` | int | when `error` is `none` | number of decompressed bytes; always equals `expect.uncompressed_length` |
| `expect.output` | hex | when `error` is `none` | the decompressed bytes |

**Harness rules:**
- Run the decoder on the whole input at once. Compressed data is not decoded incrementally, so there is no split-read rule as for `ni-stream`.
- Run with an output cap of at least 1 MiB (IMPL-CH-5). No vector tests the cap, because it is not a protocol value.
- A negative vector produces no output. A decoder that returns partial output together with an error fails the vector (PV-0374, IMPL-LZH-3, IMPL-LZC-1).
- Vectors whose names start with `lzh-` or `neg-lzh-` use algorithm byte 0x12; `lzc-` and `neg-lzc-` use 0x11.
- `truncated` means the 8-byte header is incomplete. Data that ends too early is `data-truncated` for LZH (before the final end-of-block symbol) and `length-mismatch` for LZC (fewer codes than the declared length needs).

**Bit notation in derivations:** "bit *p*" is bit (*p* mod 8) of data byte ⌊*p* / 8⌋, counted from the first byte after the compression header, where bit *k* has the mask `1 << k` ([compression-lzh.md, Bit order](../../docs/protocol/compression-lzh.md#bit-order)). Huffman codes are written as binary strings in the order they are sent (most significant bit first); integer fields and LZC codes are given as values, packed least significant bit first.

### items

**Input:** an item sequence: the bytes after the DIAG header of an uncompressed message with err_no 0, or the decompressed bytes of a compressed one.
**Under test:** the item walker ([items.md, Walking an item sequence](../../docs/protocol/items.md#walking-an-item-sequence)). It runs to the end of the input and does **not** stop at EOM (R-IT-1).

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.items` | int | always | number of complete items produced before the walk ended or stopped |
| `expect.item.<n>.type` | name: `xmlblob`, `appl`, `appl4`, `ses`, `ico`, `tit`, `diagmessage`, `chl`, `sfe`, `sba`, `eom`, `slc`, `sba2` | for n = 1…items | item type. `okc` is not a valid value: OKC always stops the walk (IMPL-IT-8) |
| `expect.item.<n>.id` | byte | for `appl` and `appl4` items | the id byte (offset 1 of the item) |
| `expect.item.<n>.sid` | byte | for `appl` and `appl4` items | the sid byte (offset 2 of the item) |
| `expect.item.<n>.id_name` | name | optional, `appl` and `appl4` only | the id's name in the [APPL id registry](../../docs/protocol/items.md#appl-id-registry), or `unknown`. Checked when present |
| `expect.item.<n>.sid_name` | name | optional, `appl` and `appl4` only | the sid's name in its id's table ([APPL sid registry](../../docs/protocol/items.md#appl-sid-registry)), or `unknown`. Checked when present |
| `expect.item.<n>.offset` | int | for n = 1…items | offset in the input of the item's first value byte: item start + 5 (APPL, XMLBLOB), + 7 (APPL4) or + 1 (simple items, EOM included) |
| `expect.item.<n>.length` | int | for n = 1…items | value length: the declared length (APPL, APPL4, XMLBLOB) or the fixed size (simple items; 0 for EOM). The expected value is `input[offset ..< offset + length]` |
| `expect.error` | name: `none`, `truncated`, `unknown-simple-type` | always | result |
| `expect.error.item` | int | when `error` is not `none` | 1-based index of the item being read when the walk stopped |
| `expect.error.type` | byte | when `error` is `unknown-simple-type` | the type byte that stopped the walk |

**Name tokens.** A registry name that contains a space is written with an underscore instead (`GRAPH RELEASE 3` becomes `GRAPH_RELEASE_3`, `XMLPROP DYNPRO` becomes `XMLPROP_DYNPRO`). All other names are written exactly as in the registry tables. The harness looks up names by (id, sid) in the implementation's registry and compares the token.

**Negative vectors:** `truncated`: the input ends inside an id, a sid, a length field or a value, of any item type (IMPL-IT-5). `unknown-simple-type`: the type byte is not one of the ten simple types of known size and not 0x10–0x12; this includes 0x08 (OKC), whose size is unknown (IMPL-IT-2, IMPL-IT-8). Items produced before an error count: the walker yields items as it goes. The product still discards a message that fails (IMPL-IT-2), but the harness checks the prefix.

### simple-item-fields

**Input:** exactly one simple item: its type byte followed by its value. A negative vector holds fewer value bytes than the type's size.
**Under test:** the decoder of simple-item values ([items.md, Simple item layouts](../../docs/protocol/items.md#simple-item-layouts)), for the types whose layout is specified: SES, SFE, SBA and SLC.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.type` | name: `ses`, `sfe`, `sba`, `slc` | when `error` is `none` | the item type |
| `expect.field.<name>` | int | when `error` is `none`, one per field of the type | the decoded field value (unsigned, decimal) |
| `expect.error` | name: `none`, `truncated` | always | result |

Every field of the type must be present, and no others:

| Type | Keys (in value order) |
|---|---|
| `ses` | `expect.field.event_array`, `expect.field.event_id_1`, `expect.field.event_id_2`, `expect.field.event_id_3`, `expect.field.event_id_4`, `expect.field.event_id_5`, `expect.field.screen_flag`, `expect.field.modal_number`, `expect.field.x_pos`, `expect.field.y_pos`, `expect.field.imode`, `expect.field.flag_1`, `expect.field.dim_row`, `expect.field.dim_col` (the filler at value bytes 12–13 is not a field, R-IT-12) |
| `sfe` | `expect.field.format`, `expect.field.color`, `expect.field.extended` |
| `sba` | `expect.field.y`, `expect.field.x` |
| `slc` | `expect.field.field_length` (u16 BE) |

**Round trip:** when `error` is `none`, encoding the fields gives back exactly the input, except that an SES encoder writes the filler as `00 00` (R-IT-12). `fields-ses.vec` deliberately uses `EE EE` there, to show that decoders ignore it, and is exempt from the round-trip check.

**Negative vectors:** `truncated` only: the input ends inside the value.

### connect

**Input:** the value bytes of an `ST_USER CONNECT` item (the 12 bytes after its APPL header), or fewer for truncation.
**Under test:** the CONNECT decoder ([session.md, §3](../../docs/protocol/session.md#3-st_user-connect-payload)).

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `truncated` | always | `truncated` if fewer than 12 bytes |
| `expect.protocol_version` | int | when `error` is `none` | bytes 0–3, u32 BE |
| `expect.code_page` | int | when `error` is `none` | bytes 4–7, u32 BE |
| `expect.ws_type` | int | when `error` is `none` | bytes 8–11, u32 BE |

**Round trip:** when `error` is `none`, encoding (protocol_version, code_page, ws_type) as three u32 BE gives back exactly the input.

### support-bits

**Input:** the value bytes of an `ST_USER` or `ST_R3INFO` SUPPORTDATA item (the 32-byte mask), or fewer for truncation.
**Under test:** the SUPPORTDATA decoder ([session.md, §5](../../docs/protocol/session.md#5-supportdata-capability-mask)).

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `truncated` | always | `truncated` if fewer than 32 bytes |
| `expect.length` | int | when `error` is `none` | value length in bytes (32 for a well-formed mask) |
| `expect.set_bits` | names | when `error` is `none` | the **named** support bits that are set, in ascending bit order (byte 0 first, and within a byte mask `0x01` before `0x80`). Names are those of [session.md §5.2](../../docs/protocol/session.md#52-named-bits). A set bit with no name is not listed |

**Round trip:** when `error` is `none`, setting exactly `set_bits` in a 32-byte zero buffer (each at byte ⌊N/8⌋, mask `1 << (N mod 8)`) gives back exactly the input, provided the input sets only named bits.

### dialog-step

**Input:** the value bytes of an `ST_USER DIALOG_STEP_NUMBER` item (4 bytes), or fewer for truncation.
**Under test:** the DIALOG_STEP_NUMBER decoder ([session.md, §4.1](../../docs/protocol/session.md#41-dialog_step_number-payload)).

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `truncated` | always | `truncated` if fewer than 4 bytes |
| `expect.step` | int | when `error` is `none` | bytes 0–3, u32 BE |

**Round trip:** when `error` is `none`, encoding `step` as u32 BE gives back exactly the input.

### dynt-atoms

**Input:** the value bytes of a DYNT_ATOM item (id `0x09`, sid `0x02`): a back-to-back sequence of atoms, with no surrounding item header (R-DA-1).
**Under test:** the atom walker ([dynt-atoms.md, Walking an atom sequence](../../docs/protocol/dynt-atoms.md#walking-an-atom-sequence)). It runs to the end of the input, yielding atoms as it goes.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.atoms` | int | always | number of complete atoms produced before the walk ended or stopped |
| `expect.atom.<n>.etype` | int | for n = 1…atoms | the etype byte at atom offset 4 |
| `expect.atom.<n>.length` | int | for n = 1…atoms | `atom_length` (u16 BE at atom offset 0), counting the whole atom |
| `expect.atom.<n>.dlg_flag_1` | byte | for n = 1…atoms | atom offset 2 |
| `expect.atom.<n>.dlg_flag_2` | byte | for n = 1…atoms | atom offset 3 |
| `expect.atom.<n>.area` | int | for n = 1…atoms | atom offset 5 |
| `expect.atom.<n>.block` | int | for n = 1…atoms | atom offset 6 |
| `expect.atom.<n>.group` | int | for n = 1…atoms | atom offset 7 |
| `expect.atom.<n>.row` | int | for n = 1…atoms | u16 BE at atom offset 8 |
| `expect.atom.<n>.col` | int | for n = 1…atoms | u16 BE at atom offset 10 |
| `expect.atom.<n>.attr` | byte | for n = 1…atoms | attribute byte at atom offset 12 |
| `expect.atom.<n>.attr.names` | names from `PROTECTED`, `INVISIBLE`, `INTENSIFY`, `JUSTRIGHT`, `MATCHCODE`, `PROPFONT`, `YES3D`, `COMBOSTYLE` | for n = 1…atoms | attribute bits set, in ascending mask order (PROTECTED first); `none` if zero |
| `expect.atom.<n>.content_offset` | int | for n = 1…atoms | offset in the input of the atom's first payload byte: atom start + 13 |
| `expect.atom.<n>.content_length` | int | for n = 1…atoms | `atom_length − 13` |
| `expect.atom.<n>.text_offset` | int | when the etype has a decoded text | offset in the input of the atom's text |
| `expect.atom.<n>.text_length` | int | when the etype has a decoded text | byte length of the atom's text |
| `expect.atom.<n>.field.dlen` | int | for etypes 121–123 and 130–132 | the dlen field |
| `expect.atom.<n>.field.mlen` | int | for etypes 121–123 and 130–132 | the mlen field |
| `expect.atom.<n>.field.maxnrchars` | int | for etypes 121–123 and 130–132 | the maxnrchars field |
| `expect.error` | name: `none`, `truncated`, `bad-atom-length` | always | state at the end of the walk |
| `expect.error.atom` | int | when `error` is not `none` | 1-based index of the atom being read when the walk stopped |

- The text keys apply to the etypes whose payload is one decoded text: FNAME (114), XMLPROP (120), frame (127, text after drows and dcols), and the field variants (121–123: text of dlen bytes at payload offset 5; 130–132: at payload offset 6). For an opaque etype ([Other etypes](../../docs/protocol/dynt-atoms.md#other-etypes)) only the content keys are given.
- The field keys are defined only for atoms whose dlen equals the rest of the atom (PV-0652, PV-0653). No vector covers a mismatching dlen (#36, IMPL-DA-6), and push-button (115) and radio-button (129) atoms have no text keys (#35).
- Atoms produced before an error count, as items do. The product still discards a message that fails (IMPL-DA-3), but the harness checks the prefix.
- **Harness note:** the walker is fed one complete item value (R-DA-1), never a partial stream, so each vector is run as a single buffer. There is no split-at-every-position rule as for `ni-stream`.

### appl-fields

**Input:** the value bytes of one APPL item whose (id, sid) has a fixed-size numeric layout in [server-screen.md](../../docs/protocol/server-screen.md#8-screen-element-layouts): the item's value only, without its 5-byte header.
**Under test:** the value decoder for that (id, sid).

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.id` | byte | always | **input:** the item's id, which selects the layout |
| `expect.sid` | byte | always | **input:** the item's sid |
| `expect.error` | name: `none`, `truncated`, `overlong` | always | `truncated` if the input is shorter than the layout, `overlong` if longer (IMPL-SS-3) |
| `expect.field.<name>` | int | when `error` is `none`, one per field of the layout | the decoded field (unsigned, decimal) |

Layouts and field names (every multi-byte field is big-endian):

| (id, sid) | Item | Fields in order (width in bytes) | PV |
|---|---|---|---|
| (`0C`, `07`) | VARINFO AREASIZE | `window_height` (4), `window_width` (4), `area_height` (4), `area_width` (4) | PV-0704 |
| (`04`, `0D`) | ST_USER WSIZE | as AREASIZE | PV-0705 |
| (`0C`, `08`) | VARINFO AREA_PIXELSIZE | as AREASIZE | PV-0706 |
| (`0A`, `01`), (`0A`, `04`), (`0A`, `05`), (`0A`, `08`), (`0A`, `09`), (`0A`, `0A`) | CONTAINER RESET, LOOP, TABLE, TABSTRIP, TABSTRIP_PAGE, CONTROL | `container_id` (1), `row` (2), `col` (2), `width` (2), `height` (2) | PV-0712 |
| (`0C`, `02`) | VARINFO SCROLL_INFOS | `total_height`, `total_width`, `data_height`, `data_width`, `height_offset`, `width_offset` (4 each) | PV-0714 |
| (`0C`, `06`) | VARINFO SCROLL_INFOS2 | the six of SCROLL_INFOS, then `visible_height` (4), `visible_width` (4), `scroll_flag` (1) | PV-0715 |
| (`0C`, `0C`) | VARINFO CONTAINER_LOOP | `lines_per_loop_row` (2) | PV-0716 |
| (`0C`, `0D`) | VARINFO LIST_FOCUS | `version` (1), `row` (2), `col` (2) | PV-0717 |
| (`04`, `04`) | ST_USER FONTMETRIC | `var_y`, `var_x`, `fixed_y`, `fixed_x` (2 each) | PV-0728 |

Every field of the selected layout must be present, and no others. The field keys in use are: `expect.field.window_height`, `expect.field.window_width`, `expect.field.area_height`, `expect.field.area_width`, `expect.field.container_id`, `expect.field.row`, `expect.field.col`, `expect.field.width`, `expect.field.height`, `expect.field.total_height`, `expect.field.total_width`, `expect.field.data_height`, `expect.field.data_width`, `expect.field.height_offset`, `expect.field.width_offset`, `expect.field.visible_height`, `expect.field.visible_width`, `expect.field.scroll_flag`, `expect.field.lines_per_loop_row`, `expect.field.version`, `expect.field.var_y`, `expect.field.var_x`, `expect.field.fixed_y`, `expect.field.fixed_x`.

**Round trip:** when `error` is `none`, encoding the fields in order gives back exactly the input.

### imode-uuids

**Input:** the value bytes of an `ST_R3INFO IMODEUUIDS2` item (id `06`, sid `1F`).
**Under test:** the IMODEUUIDS2 decoder ([server-screen.md §5.2](../../docs/protocol/server-screen.md#52-internal-mode-uuids)).

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `truncated`, `overlong` | always | `truncated` if the input is empty or shorter than 1 + 17·n; `overlong` if longer (IMPL-SS-3) |
| `expect.count` | int | when `error` is `none` | byte 0 |
| `expect.uuid.<n>` | hex (16 bytes) | for n = 1…count | the n-th UUID |
| `expect.active.<n>` | byte | for n = 1…count | the n-th active-context byte |

**Round trip:** when `error` is `none`, writing the count and then each UUID with its active byte gives back exactly the input.

### dynt-focus

**Input:** the value bytes of a `DYNT DYNT_FOCUS_1` item (id `09`, sid `0B`).
**Under test:** the DYNT_FOCUS_1 decoder ([server-screen.md §8.5](../../docs/protocol/server-screen.md#85-lists-scrolling-and-focus)).

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `truncated` | always | `truncated` if fewer than 9 bytes |
| `expect.area_id` | int | when `error` is `none` | byte 0 |
| `expect.row`, `expect.col`, `expect.row_offset`, `expect.col_offset` | int | when `error` is `none` | u16 BE at offsets 1, 3, 5, 7 |
| `expect.containers` | hex | when `error` is `none` | the bytes from offset 9 to the end (one container id each), or `none` |

**Round trip:** when `error` is `none`, encoding the five fields and appending the container ids gives back exactly the input.

### stringz-fields

**Input:** the value bytes of an APPL item whose layout is a fixed number of zero-terminated strings.
**Under test:** the string splitter for that (id, sid).

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.id`, `expect.sid` | byte | always | **input:** selects the layout |
| `expect.error` | name: `none`, `truncated` | always | `truncated` if the value ends before the zero byte of one of the strings (IMPL-SS-3) |
| `expect.strings` | int | when `error` is `none` | the layout's string count |
| `expect.string.<n>.offset` | int | for n = 1…strings | offset of the n-th string's first byte |
| `expect.string.<n>.length` | int | for n = 1…strings | its length in bytes, without the zero byte |
| `expect.trailing` | int | when `error` is `none` | bytes after the last string's zero byte (reported, not an error; IMPL-SS-3, #39) |

Layouts: (`0A`, `06`) CONTAINER NAME, 3 strings (PV-0713); (`06`, `29`) KERNEL_VERSION, 3 strings (PV-0535).

**Round trip:** when `error` is `none`, writing each string with one zero byte and then the trailing bytes gives back exactly the input.

### menu-entries

**Input:** the value bytes of an `MNUENTRY` item (id `0B`, any sid; carried in APPL4).
**Under test:** the menu-entry decoder ([server-screen.md §8.1](../../docs/protocol/server-screen.md#81-menu-entries-mnuentry)). For each entry, at offset *p*: if fewer than 20 bytes remain, `truncated`; find the text, accelerator and info strings from *p* + 20, each ended by a zero byte inside the value, else `truncated`; if the length field (u16 BE at *p*) differs from the bytes from *p* to just after the info's zero byte, `entry-length-mismatch`; otherwise produce the entry and continue after it. An empty input has no entries.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.entries` | int | always | entries produced before the walk ended or stopped |
| `expect.entry.<n>.offset` | int | for n = 1…entries | offset of the entry's length field |
| `expect.entry.<n>.length` | int | for n = 1…entries | the length field |
| `expect.entry.<n>.position_1`, `expect.entry.<n>.position_2`, `expect.entry.<n>.position_3`, `expect.entry.<n>.position_4` | int | for n = 1…entries | bytes 2, 3, 4 and 5 of the entry |
| `expect.entry.<n>.flags` | byte | for n = 1…entries | byte 6 |
| `expect.entry.<n>.flags.names` | names from `UNK1`, `SEL`, `MEN`, `SEP`, `VKEY`, `UNK6`, `UNK7`, `UNK8` | for n = 1…entries | flag bits set, in ascending mask order (PV-0721), or `none` |
| `expect.entry.<n>.virtual_key` | int | for n = 1…entries | byte 7 |
| `expect.entry.<n>.return_codes` | hex (6 bytes) | for n = 1…entries | bytes 8–13 |
| `expect.entry.<n>.function_codes` | hex (6 bytes) | for n = 1…entries | bytes 14–19 |
| `expect.entry.<n>.text_offset`, `expect.entry.<n>.text_length` | int | for n = 1…entries | where the text starts in the input, and its length without the zero byte |
| `expect.entry.<n>.accelerator_offset`, `expect.entry.<n>.accelerator_length` | int | for n = 1…entries | the same for the accelerator |
| `expect.entry.<n>.info_offset`, `expect.entry.<n>.info_length` | int | for n = 1…entries | the same for the info string |
| `expect.error` | name: `none`, `truncated`, `entry-length-mismatch` | always | result |
| `expect.error.entry` | int | when `error` is not `none` | 1-based index of the entry being read when the walk stopped |

**Round trip:** when `error` is `none`, encoding each entry (length = 20 + the three strings with their zero bytes) gives back exactly the input.

### screen-identity

**Input:** an item sequence sent by a server (the bytes after the DIAG header of an uncompressed message with err_no 0).
**Under test:** screen-identity extraction ([server-screen.md §7](../../docs/protocol/server-screen.md#7-screen-identity-a-decoder-reads)): the item walker, then the text, AREASIZE, atom and menu decoders, with R-SS-4 trimming.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.dbname`, `expect.client`, `expect.cpuname`, `expect.tcode` | text | always | ST_R3INFO `02`, `0C`, `03`, `07`, trimmed (R-SS-4), or `none` |
| `expect.dynproname`, `expect.dynpronumber`, `expect.cuaname`, `expect.cuastatus`, `expect.gui_theme` | text | always | ST_R3INFO `0D`, `0E`, `0F`, `10`, `25`, trimmed, or `none` |
| `expect.session_title`, `expect.session_icon` | text | always | VARINFO `09`, `0A`, trimmed, or `none` |
| `expect.area` | name: `present`, `none` | always | whether a VARINFO AREASIZE item is present |
| `expect.area.window_height`, `expect.area.window_width`, `expect.area.area_height`, `expect.area.area_width` | int | when `area` is `present` | its four fields (PV-0704) |
| `expect.atoms` | int | always | atoms in all DYNT_ATOM items (`09`, `02`, APPL or APPL4) |
| `expect.efields` | int | always | atoms of etype 101, 121 or 130 (the EFIELD family, R-DA-4) |
| `expect.efields.invisible` | int | always | those of them with INVISIBLE (`0x02`) set |
| `expect.menus` | int | always | MNUENTRY items (id `0B`, any sid) |
| `expect.menu_entries` | int | always | entries in all MNUENTRY items |
| `expect.error` | name: `none` | always | every vector of this kind is well-formed; a failing walk reports the walker's own class |

**Harness notes:** each identity item appears at most once in a vector (#54). A leading DIALOG_STEP_NUMBER or trailing EOM changes nothing (R-SS-7, R-SE-2). No round trip: the kind extracts, it does not re-encode.

### rfc-items

*New in v2.2 (2026-09-25).*
**Input:** an RFC item stream: an RFC_TR value, or a run of items from one.
**Under test:** the RFC item walker ([controls/rfc-tr.md §3.1](../../docs/protocol/controls/rfc-tr.md#31-item-ids-wireshark-names), IMPL-CT-2) and Swooey's item encoder ([§7.8](../../docs/protocol/controls/rfc-tr.md#78-swooeys-answer-2026-09-25), IMPL-CT-12), in both directions: the harness walks the input, then writes the walked items again with the encoder, each with its id as the trailing pair and the end item as `FF FF 00 00 FF FF`, and compares the result with the input.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `truncated` | always | `truncated`: the input ends inside an id, a length or a value |
| `expect.error.item` | int | when `error` is `truncated` | 1-based index of the item being read |
| `expect.items` | int | always | items walked before the end of the input, the end item `FF FF` or the error; the end item counts |
| `expect.item.<n>.id` | hex | for n = 1…items | the two id bytes |
| `expect.item.<n>.length` | int | for n = 1…items | the value's length |
| `expect.item.<n>.value` | hex | for n = 1…items whose value has at most 64 bytes | the value (`none` if empty) |
| `expect.item.<n>.trailer` | name: `matches`, `differs`, `missing` | for n = 1…items | whether the two bytes after the value repeat the id (PV-0919), differ, or are cut off |
| `expect.end` | name: `yes`, `no` | always | whether the walk reached the end item |
| `expect.reencodes` | name: `yes`, `no` | when `error` is `none` | whether the encoder, fed the walked items, writes the input byte for byte: `no` for a trailing pair that differs or bytes after the end item |

The walk steps over bytes after the end item without reading them (IMPL-CT-2); a stream Swooey writes has none (PV-0920).

## Kinds without an implementation yet

The Control Framework kinds have no runner yet. Their vectors were committed with the spec, so that they are independent of the implementation that comes later. The twelve ADT kinds left this table on 2026-09-27, when the `CodeService` module (Swooey's ADT client) and its runners in `Tests/VectorSupport/ADTVectorRunners.swift` arrived; their vectors gate like the others.

| Kinds | Implemented in | Milestone ([PLAN.md](../../docs/PLAN.md) §4) |
|---|---|---|
| `control-properties`, `rfc-table-content`, `rfc-compressed-table`, `cfw-verbs`, `cfw-descriptors`, `cfw-values`, `datamanager`, `alv-catalog`, `alv-rows`, `alv-colour-cells` | the Control Framework decoders of `DiagCodec` and the control layer | **M5** Controls I (spike C) |

**Harness rule.** The vector harness skips exactly these kinds, with the reason "no implementation until M5" (Control Framework kinds), and reports every vector it skips. Any other unknown kind still fails. A kind leaves this table in the PR that adds its runner; from then on its vectors gate like the others. The six server-screen kinds are **not** in this table: their runners exist, and their vectors gate like the others.

### ADT kinds

The twelve `adt-…` kinds test Swooey's ADT client ([docs/protocol/adt/](../../docs/protocol/adt/README.md)). ADT is an HTTP interface, so these vectors hold XML documents and request descriptions, not DIAG bytes.

- **Hex section.** For the response kinds it is the response body (UTF-8 bytes); for `adt-request` it is the request body, or empty; for `adt-link` and `adt-position` it is empty.
- **Inputs.** Header lines starting with `expect.in.` are further inputs (a base URI, a status code, a response header), and for `adt-request` so are `expect.op` and `expect.arg.<name>`; the harness passes them to the code under test and never compares them.
- **Errors.** `expect.error` (name) is `none`, `not-xml` (the body is not well-formed XML with namespaces) or `wrong-root` (the root element is not the kind's root). A negative vector carries only `expect.error` and its `expect.in.*` inputs. `adt-request`, `adt-response-class`, `adt-link` and `adt-position` have no negative vectors.
- **Lists** are 1-based (`expect.hit.1.…`, `expect.hit.2.…`). A count key (`expect.hits`) always precedes them, and every listed field of every element is given.
- **Opaque values.** Where the spec treats a value as opaque (link hrefs of feeds, versions links, version sources, `tm:pgmid`, component types, `visibility`, `level`, `usageInformation`, `objectIdentifier`, `$query` strings), the vectors use obviously invented values (`ZZID`, `ZZ/M`, `zz-vis-a`, `/sap/bc/adt/zz/opaque/…`) and the `derivation` line says so.
- **Unknown namespace URIs.** Where the spec gives no namespace URI for a prefix (the `usageReferences` prefix of the where-used response, and the discovery document, #57), a vector binds the prefix to the invented URN `urn:zz:unknown:{prefix}`, so the document is namespace-well-formed without a real-looking URI. Decoders match qualified names (R-ADT-4) and must not check such a binding.
- **Mock data (D15).** Every name, text, user, number and id is invented: `ZZ_COFFEE_ROBOT`, `ZCL_ZZ_UNICORN_STABLE`, `ZZ_I_DRAGON_FLEET`, `ZZDK900042` "Teach the robot to make espresso", runtime error `ZZ_COFFEE_OVERFLOW`, user `ZZ_BARISTA_BOT`, target `ZZQ`, client `042`. The CSRF token value contains `fake`, so the secret scan recognises it as a placeholder.
- **Not covered:** the discovery document (#57), the feed catalogue (no decoder output Swooey relies on beyond R-ADT-25), the transport-checks resource (#74) and the where-used snippets (optional).

#### adt-request

**Under test:** the request builder of Swooey's ADT client ([session.md](../../docs/protocol/adt/session.md), [objects.md](../../docs/protocol/adt/objects.md), [versions.md](../../docs/protocol/adt/versions.md), [transports.md](../../docs/protocol/adt/transports.md), [navigation.md](../../docs/protocol/adt/navigation.md), [dumps.md](../../docs/protocol/adt/dumps.md)). The harness gives the builder the operation and its arguments, in a session whose stored CSRF token is `expect.arg.token` (absent for `logon`), and compares the request it would send.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.op` | name | always | **input:** the operation (table below) |
| `expect.arg.<name>` | text | per operation | **input:** the operation's arguments |
| `expect.method` | name: `GET`, `POST` | always | request method |
| `expect.path` | uri | always | the request path, byte for byte (percent-encoded as sent) |
| `expect.query` | text | always | the query as `name=value` pairs joined by `&`, percent-encoded, or `none`. The harness percent-decodes names and values on both sides and compares the pairs as a multiset: order and encoding choices do not matter (IMPL-ADT-1), a missing or extra pair does |
| `expect.header.<name>` | text | per vector | a request header the request must carry with exactly this value; the name is lowercase and compared case-insensitively (IMPL-ADT-2). Headers not listed are not constrained (for example `User-Agent`, `Cookie`) |
| `expect.body` | name: `none`, `xml`, `hex` | always | `none`: no body. `hex`: the body is exactly the hex section. `xml`: the body is XML equal to the hex section's document in element and attribute qualified names, namespace bindings and trimmed text (the XML declaration and white space between elements are not compared) |

Keys in use: `expect.arg.client`, `expect.arg.column`, `expect.arg.first_column`, `expect.arg.language`, `expect.arg.last_column`, `expect.arg.line`, `expect.arg.name`, `expect.arg.number`, `expect.arg.object_type`, `expect.arg.pattern`, `expect.arg.pgmid`, `expect.arg.query`, `expect.arg.src`, `expect.arg.token`, `expect.arg.type`, `expect.arg.uri`, `expect.arg.user`, `expect.arg.version`; `expect.header.accept`, `expect.header.content-type`, `expect.header.x-csrf-token`, `expect.header.x-sap-adt-sessiontype`.

Operations and arguments:

| Operation | Arguments | Spec |
|---|---|---|
| `logon` | `client`, `language` | session.md §3 (R-ADT-2, R-ADT-3, R-ADT-6, R-ADT-7) |
| `discovery` | `token` | session.md §2.1 |
| `search` | `token`, `pattern` (as typed by the user), optional `object_type`, optional `max` (default 50) | objects.md §4.1 (R-ADT-12) |
| `object-structure` | `token`, `uri`, `version` | objects.md §2.1 |
| `source` | `token`, `uri`, `version` | objects.md §5.2 (R-ADT-14) |
| `versions` | `token`, `uri` (the resolved versions link) | versions.md §2 |
| `version-source` | `token`, `src` | versions.md §4 |
| `transports-by-user` | `token`, `user` | transports.md §3.1 |
| `transport-details` | `token`, `number` | transports.md §5 |
| `transport-reference` | `token`, `pgmid`, `type`, `name` | transports.md §4 |
| `where-used` | `token`, `uri`, optional `line` and `column` | navigation.md §2.1 |
| `outline` | `token`, `uri` | navigation.md §3.1 |
| `definition` | `token`, `uri`, `line`, `first_column`, `last_column`; the hex section is the source text given to the operation | navigation.md §4 |
| `mainprograms` | `token`, `uri` | objects.md §5.5 |
| `nodepath` | `token`, `uri` | objects.md §6 |
| `dumps` | `token`, optional `query` (a query string offered by the catalogue) | dumps.md §3.1 |
| `feeds` | `token` | dumps.md §2 |
| `logoff` | `token` | session.md §6.4 |

#### adt-response-class

**Under test:** the response classifier of [session.md §8.4](../../docs/protocol/adt/session.md#84-response-classification). The hex section is the body (possibly empty).

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.in.status` | int | always | **input:** the HTTP status |
| `expect.in.reason` | text | no | **input:** the reason phrase, when the HTTP layer exposes one |
| `expect.in.header.<name>` | text | no | **input:** a response header (lowercase name); in use: `expect.in.header.content-type`, `expect.in.header.x-csrf-token` |
| `expect.class` | name: `ok`, `login-required`, `csrf-failed`, `session-lost`, `sso-challenge`, `adt-exception`, `http-error` | always | the class of the first matching rule |

#### adt-exception

**Under test:** the decoder of the ADT exception document ([session.md §8.1](../../docs/protocol/adt/session.md#81-the-adt-exception-document)). Root `exc:exception`.

| Key | Type | Meaning |
|---|---|---|
| `expect.error` | name | as above |
| `expect.namespace` | text | `id` of `namespace` |
| `expect.type` | text | `id` of `type` |
| `expect.message` | text | text of `message` |
| `expect.localized_message` | text | text of `localizedMessage` |
| `expect.properties` | int | number of `properties/entry` elements |
| `expect.property.<n>.key`, `expect.property.<n>.value` | text | `key` attribute; text with leading and trailing white space removed |

#### adt-link

**Under test:** href resolution ([objects.md §3](../../docs/protocol/adt/objects.md#3-resolving-hrefs), R-ADT-11, IMPL-ADT-11). Hex section empty.

| Key | Type | Meaning |
|---|---|---|
| `expect.in.base` | uri | **input:** the object URI |
| `expect.in.href` | uri | **input:** the link's `href` |
| `expect.result` | uri | the resolved path |

#### adt-search-results

**Under test:** the quick-search decoder ([objects.md §4.2](../../docs/protocol/adt/objects.md#42-response), R-ADT-27). Root `adtcore:objectReferences`.

| Key | Type | Meaning |
|---|---|---|
| `expect.error` | name | as above |
| `expect.hits` | int | number of `adtcore:objectReference` children |
| `expect.hit.<n>.uri`, `expect.hit.<n>.type`, `expect.hit.<n>.name`, `expect.hit.<n>.package`, `expect.hit.<n>.description` | text | `adtcore:uri`, `adtcore:type`, `adtcore:name` and `adtcore:description` after R-ADT-27, `adtcore:packageName`; `none` when absent |

#### adt-object-structure

**Under test:** the structure decoder and the source-URI rule ([objects.md §2](../../docs/protocol/adt/objects.md#2-the-object-structure-resource), §5.1), plus the versions link ([versions.md §1](../../docs/protocol/adt/versions.md#1-finding-the-versions-feed)). Any root name.

| Key | Type | Meaning |
|---|---|---|
| `expect.error` | name | `none` or `not-xml` |
| `expect.in.uri` | uri | **input:** the object URI the structure was read from (base of all links) |
| `expect.name`, `expect.type`, `expect.version`, `expect.description`, `expect.changed_by`, `expect.changed_at` | text | root attributes `adtcore:name`, `adtcore:type`, `adtcore:version`, `adtcore:description`, `adtcore:changedBy`, `adtcore:changedAt` (as text) |
| `expect.is_class` | name: `yes`, `no` | root carries `class:visibility` |
| `expect.source_uri` | uri | main source URI by objects.md §5.1, resolved |
| `expect.versions_uri` | uri | resolved versions link: for a class, of the `main` include; otherwise of the root; `none` if absent |
| `expect.includes` | int | number of `class:include` children (0 for non-classes) |
| `expect.include.<n>.type`, `expect.include.<n>.version` | text | `class:includeType`, `adtcore:version` |
| `expect.include.<n>.source_uri`, `expect.include.<n>.versions_uri` | uri | resolved `text/plain` link, resolved versions link |

#### adt-versions-feed

**Under test:** the versions-feed decoder ([versions.md §3](../../docs/protocol/adt/versions.md#3-response)). Root `atom:feed`.

| Key | Type | Meaning |
|---|---|---|
| `expect.error` | name | as above |
| `expect.versions` | int | number of `atom:entry` elements |
| `expect.version.<n>.uri`, `expect.version.<n>.title`, `expect.version.<n>.date`, `expect.version.<n>.author`, `expect.version.<n>.transport` | text | the five fields of versions.md §3, in document order |

#### adt-transports

**Under test:** the transport decoder ([transports.md §3](../../docs/protocol/adt/transports.md#3-requests-of-a-user), §5, R-ADT-19, R-ADT-20). Root `tm:root`.

| Key | Type | Meaning |
|---|---|---|
| `expect.error` | name | as above |
| `expect.in.shape` | name: `list`, `details` | **input:** `list`: the tree of §3.2; `details`: `tm:request` children directly under the root (§5) |
| `expect.targets` | int | number of `tm:target` elements (0 for `details`) |
| `expect.target.<n>.kind` | name: `workbench`, `customizing` | enclosing element |
| `expect.target.<n>.name`, `expect.target.<n>.desc` | text | `tm:name`, `tm:desc` |
| `expect.requests` | int | number of `tm:request` elements |
| `expect.request.<n>.number`, `expect.request.<n>.owner`, `expect.request.<n>.desc`, `expect.request.<n>.status`, `expect.request.<n>.uri` | text | the request attributes |
| `expect.request.<n>.target` | int | 1-based index of its target, 0 for `details` |
| `expect.request.<n>.list` | name: `modifiable`, `released`, `none` | enclosing element (`none` for `details`) |
| `expect.request.<n>.released` | name: `yes`, `no` | R-ADT-20: `no` when the status contains `D` or `L` |
| `expect.request.<n>.tasks` | int | number of its `tm:task` children |
| `expect.tasks` | int | number of `tm:task` elements |
| `expect.task.<n>.number`, `expect.task.<n>.owner`, `expect.task.<n>.status`, `expect.task.<n>.request` | text | all tasks in document order, with the number of their request |
| `expect.objects` | int | number of `tm:abap_object` elements |
| `expect.object.<n>.pgmid`, `expect.object.<n>.type`, `expect.object.<n>.name`, `expect.object.<n>.parent` | text | all `tm:abap_object` elements in document order, with the number of the request or task they are listed under |

Requests are numbered in document order across targets and lists.

#### adt-usage-references

**Under test:** the where-used decoder ([navigation.md §2.2](../../docs/protocol/adt/navigation.md#22-response), R-ADT-23). Root `usageReferences:usageReferenceResult`.

| Key | Type | Meaning |
|---|---|---|
| `expect.error` | name | as above |
| `expect.refs` | int | number of `usageReferences:referencedObject` elements |
| `expect.ref.<n>.uri`, `expect.ref.<n>.parent_uri`, `expect.ref.<n>.usage_information` | text | attributes `uri`, `parentUri`, `usageInformation` |
| `expect.ref.<n>.is_result`, `expect.ref.<n>.can_have_children` | name: `yes`, `no` | attribute equal to `true` |
| `expect.ref.<n>.object_identifier` | text | text of the `objectIdentifier` child |
| `expect.ref.<n>.name`, `expect.ref.<n>.type` | text | `adtcore:name`, `adtcore:type` of `usageReferences:adtObject` |
| `expect.ref.<n>.package` | text | `adtcore:name` of its `adtcore:packageRef` |

#### adt-outline

**Under test:** the outline decoder ([navigation.md §3.2](../../docs/protocol/adt/navigation.md#32-response)). Root `abapsource:objectStructureElement`.

| Key | Type | Meaning |
|---|---|---|
| `expect.error` | name | as above |
| `expect.elements` | int | number of elements, root included, flattened in document order (pre-order) |
| `expect.element.<n>.name`, `expect.element.<n>.type`, `expect.element.<n>.visibility`, `expect.element.<n>.level`, `expect.element.<n>.description` | text | attributes |
| `expect.element.<n>.depth` | int | 0 for the root |
| `expect.element.<n>.flags` | names from `constant`, `constructor`, `testmethod`, `redefinition`, `final` | the flag attributes whose value is `true`, in that order, or `none` |

#### adt-dumps-feed

**Under test:** the runtime-error feed decoder ([dumps.md §3.2](../../docs/protocol/adt/dumps.md#32-response), R-ADT-26), matching local names.

| Key | Type | Meaning |
|---|---|---|
| `expect.error` | name | as above; `wrong-root` compares the local name |
| `expect.feed.href`, `expect.feed.title`, `expect.feed.updated` | text | feed `link@href`, `title`, `updated` |
| `expect.dumps` | int | number of `entry` elements |
| `expect.dump.<n>.error` | text | `term` of the category labelled `ABAP runtime error` |
| `expect.dump.<n>.program` | text | `term` of the category labelled `Terminated ABAP program`, or `none` |
| `expect.dump.<n>.id`, `expect.dump.<n>.author`, `expect.dump.<n>.summary_type`, `expect.dump.<n>.summary` | text | `id`, `author/name`, `summary@type`, `summary` text after entity decoding |
| `expect.dump.<n>.links` | int | number of `link` elements |

#### adt-position

**Under test:** the position parser ([navigation.md §1](../../docs/protocol/adt/navigation.md#1-source-positions-in-uris), R-ADT-22). Hex section empty.

| Key | Type | Meaning |
|---|---|---|
| `expect.in.uri` | uri | **input:** the URI with position |
| `expect.path` | uri | the part before `?` and `#` |
| `expect.context` | text | the percent-decoded `context` query value, or `none` |
| `expect.start_line`, `expect.start_column`, `expect.end_line`, `expect.end_column` | int | the position; a missing `start` is 0,0; a missing `end` equals `start` |
| `expect.part.type`, `expect.part.name` | text | percent-decoded `type` and `name` fragment parts, or `none` |

### Control Framework kinds

The ten Control Framework kinds test decoders of [docs/protocol/controls/](../../docs/protocol/controls/README.md). Their vectors sit in one directory per group under `controls/`; the harness dispatches on `kind`. The four vectors of the existing `items` kind that come with this topic (a control-opening server message, `RFC_TR` calls and an answer, a client control event) are in `items/` and run now.

- **Normativity.** Kinds `cfw-verbs`, `cfw-descriptors`, `cfw-values`, `alv-catalog`, `alv-rows` and `alv-colour-cells` rest on `odg-only` PROVENANCE rows. They are normative only if the owner accepts the rule of Q-controls-2 ([docs/protocol/README.md](../../docs/protocol/README.md#open-owner-questions-v2)); if not, they move to an informative directory that the harness runs as non-gating diagnostics. Until milestone M5 no kind of this group is run in any case.
- **Inputs.** `alv-rows` and `alv-colour-cells` take a second input besides the hex section, as an `expect.` key marked **input**.
- **Mock data (D15).** All content is invented and silly: `ZZ…` names, snacks, tea breaks. Protocol vocabulary (DATAMANAGER element and attribute names, verb names such as `CreateObject`, the `_RESULT` slot name, item and property names) is used as is. No byte comes from a capture, from open-diag-go's or sap-tui's test data, or from a live system.

#### control-properties

**Input:** the value of a `CONTROL CONTROL_PROPERTIES` item (id `0E`, sid `01`), without its APPL header.
**Under test:** the entry decoder ([controls/transport.md §3.1](../../docs/protocol/controls/transport.md#31-layout), IMPL-CT-1).

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.entries` | int | always | complete entries decoded before the end or the error |
| `expect.entry.<n>.id` | int | for n = 1…entries | the u16 BE property id |
| `expect.entry.<n>.id_name` | name: `CONTROL_AREA`, `CONTROL_ID`, `CONTROL_VISIBLE`, `CONTROL_ROW`, `CONTROL_COLUMN`, `CONTROL_ROWS`, `CONTROL_COLUMNS`, `unknown` | for n = 1…entries | the name of the id (PV-0936) |
| `expect.entry.<n>.value_offset` | int | for n = 1…entries | offset in the input of the value's first text byte |
| `expect.entry.<n>.value_length` | int | for n = 1…entries | number of text bytes, without the zero byte |
| `expect.error` | name: `none`, `truncated` | always | `truncated`: the input ends inside an id, or a text ends without its zero byte |
| `expect.error.entry` | int | when `error` is not `none` | 1-based index of the entry being read |

#### rfc-table-content

**Input:** RFC items starting at the id of the first table-content item (`03 05`, or `03 06` for an empty table).
**Under test:** table reassembly ([controls/rfc-tr.md §4](../../docs/protocol/controls/rfc-tr.md#4-table-content-split-into-rows), IMPL-CT-3).

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.rows` | int | always | `03 05` items consumed |
| `expect.row.<n>.offset` | int | for n = 1…rows | offset in the input of the row's first value byte |
| `expect.row.<n>.length` | int | for n = 1…rows | the row's declared length |
| `expect.content_length` | int | when `error` is `none` | length of the concatenated values |
| `expect.content` | hex | when `error` is `none` and the content has at most 64 bytes | the concatenated values (`none` if empty) |
| `expect.end_length` | int | when `error` is `none` | the `03 06` item's declared length |
| `expect.trailing` | int | when `error` is `none` | input bytes after the `03 06` item's length field |
| `expect.error` | name: `none`, `truncated`, `bad-table-item` | always | result |
| `expect.error.row` | int | when `error` is not `none` | 1-based index of the item being read |

The trailing id pair after each row is stepped over and not checked (IMPL-CT-2); vectors write the row's own id there (PV-0919).

#### rfc-compressed-table

**Input:** reassembled table content.
**Under test:** the compressed-table prefix ([controls/rfc-tr.md §5](../../docs/protocol/controls/rfc-tr.md#5-compressed-table-content), IMPL-CT-4), with the v1 compression-header checks. The compressed data is not decompressed by this kind. The offset-4 length is reported and never checked, because what it counts is a conflict (#82).

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `truncated`, `bad-magic`, `unknown-algorithm`, `bad-maxbits` | always | result; `truncated` if the input is shorter than 16 bytes |
| `expect.length_field` | int | when `error` is `none` | L, the u32 BE at offset 4, as found |
| `expect.uncompressed_length` | int | when `error` is `none` | header bytes 0–3 (u32 LE) |
| `expect.algorithm` | name: `lzh`, `lzc` | when `error` is `none` | the header's algorithm nibble |
| `expect.version` | int | when `error` is `none` | the header's version nibble |
| `expect.level` | int | when `algorithm` is `lzh` | header byte 7 |
| `expect.maxbits`, `expect.block_mode` | int | when `algorithm` is `lzc` | as in the v1 `compression-header` kind |
| `expect.data_offset` | int | when `error` is `none` | always 16 |
| `expect.data_length` | int | when `error` is `none` | input length − 16: every byte after the header goes to the v1 decoder, which ignores what follows the compressed data (IMPL-LZH-5, IMPL-LZC-3) |

#### cfw-verbs

**Input:** a decompressed VERBS stream. **Under test:** [controls/rfc-tr.md §7.2](../../docs/protocol/controls/rfc-tr.md#72-the-verbs-stream), IMPL-CT-6.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `bad-record-length` | always | result |
| `expect.verbs` | int | when `error` is `none` | number of 53-byte records |
| `expect.verb.<n>.object_id` | text | per record | bytes 0–8 without padding |
| `expect.verb.<n>.name` | text | per record | bytes 10–51 without trailing spaces |
| `expect.verb.<n>.flag` | name: `call`, `set`, `get`, `unknown` | per record | byte 52 (PV-0923) |
| `expect.verb.<n>.flag_byte` | byte | per record | byte 52 |

#### cfw-descriptors

**Input:** a decompressed SVARS descriptor stream. **Under test:** [controls/rfc-tr.md §7.3](../../docs/protocol/controls/rfc-tr.md#73-the-svars-descriptor-stream), IMPL-CT-6.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `bad-record-length`, `bad-descriptor` | always | result |
| `expect.error.slot` | int | when `error` is `bad-descriptor` | 1-based index of the bad record |
| `expect.slots` | int | when `error` is `none` | number of 44-byte records |
| `expect.slot.<n>.group` | int | per record | column 1 |
| `expect.slot.<n>.type` | int | per record | column 2 |
| `expect.slot.<n>.type_name` | name: `string`, `integer`, `unknown` | per record | PV-0925 |
| `expect.slot.<n>.name` | text | per record | column 3 |
| `expect.slot.<n>.result` | name: `yes`, `no` | per record | whether column 3 is `_RESULT` |
| `expect.slot.<n>.pointer` | int | per record | column 4 |

#### cfw-values

**Input:** a decompressed SVARS value stream. **Under test:** [controls/rfc-tr.md §7.4](../../docs/protocol/controls/rfc-tr.md#74-the-svars-value-stream), IMPL-CT-6.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `bad-record-length` | always | result |
| `expect.records` | int | when `error` is `none` | number of 337-byte records |
| `expect.record.<n>.name` | text | per record | bytes 0–31 without trailing spaces (`none` if blank) |
| `expect.record.<n>.result` | name: `yes`, `no` | per record | whether the name is `_RESULT` |
| `expect.record.<n>.value` | text | per record | bytes 32–336 without trailing spaces, reported as found (the nine `0` characters and any space after them included) |

#### datamanager

**Input:** the value of an XMLBLOB item. **Under test:** the DATAMANAGER decoder ([controls/datamanager.md](../../docs/protocol/controls/datamanager.md#4-parsing-and-encoding-rules-for-swooey), IMPL-CT-7). Vectors are ASCII only (#20).

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `malformed-xml` | always | result |
| `expect.root` | text | when `error` is `none` | the root element's name |
| `expect.encoding` | text | when `error` is `none` | the declaration's `encoding` value, or `none` |
| `expect.children` | names (element names as written) | when `error` is `none` | the root's child elements in order, or `none` |
| `expect.events` | int | when `error` is `none` | `EVENT` elements inside `EVENTS` |
| `expect.event.<n>.shellid` | text | per event | `SHELLID` |
| `expect.event.<n>.eventid` | int | per event | `EVENTID` |
| `expect.event.<n>.shellevent` | text | per event | `SHELLEVENT`, or `none` |
| `expect.event.<n>.params` | int | per event | its `PARAM` elements |
| `expect.event.<n>.param.<m>.pid` | int | per param | `PID` |
| `expect.event.<n>.param.<m>.value` | hex | per param | the bytes of `VALUE` |
| `expect.controls` | int | when `error` is `none` | `CONTROL` elements inside `CONTROLS` |
| `expect.control.<n>.shellid` | text | per control | `SHELLID` |
| `expect.control.<n>.properties` | int | per control | its `PROPERTY` elements |
| `expect.control.<n>.property.<m>.name` | text | per property | `NAME` |
| `expect.control.<n>.property.<m>.value` | hex | per property | the bytes of `VALUE` |
| `expect.datachanges` | int | when `error` is `none` | `DATACHANGES` elements inside `TABLES` |
| `expect.datachange.<n>.handle` | int | per element | `HANDLE` |
| `expect.datachange.<n>.items` | int | per element | its `IT` elements |
| `expect.datachange.<n>.item.<m>.idx`, `expect.datachange.<n>.item.<m>.c1`, `expect.datachange.<n>.item.<m>.c2` | int | per `IT` | `IDX`, `C1`, `C2` |
| `expect.datachange.<n>.item.<m>.op` | text | per `IT` | `OP` |
| `expect.datarequests` | int | when `error` is `none` | `DATAREQUEST` elements inside `TABLES` |
| `expect.datarequest.<n>.handle`, `expect.datarequest.<n>.nlines`, `expect.datarequest.<n>.firstline` | int | per element | `HANDLE`, `NLINES`, `FIRSTLINE` |

#### alv-catalog

**Input:** a decompressed field-catalog stream. **Under test:** [controls/alv-grid.md §2.2](../../docs/protocol/controls/alv-grid.md#22-in-the-nested-compressed-streams), IMPL-CT-10.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.error` | name: `none`, `bad-record-length` | always | result |
| `expect.columns` | int | when `error` is `none` | number of 904-byte records |
| `expect.column.<n>.name` | text | per record | bytes 0–29 without trailing spaces |
| `expect.column.<n>.length` | int | per record | u32 LE at 160 |
| `expect.column.<n>.type_word` | int | per record | u32 LE at 164 |
| `expect.column.<n>.type` | byte | per record | the low byte of the type word |

#### alv-rows

**Input:** a stream holding a plain row packet, plus `expect.column_lengths`. **Under test:** [controls/alv-grid.md §3.1](../../docs/protocol/controls/alv-grid.md#31-plain-packet), IMPL-CT-9.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.column_lengths` | ints | always | **input:** the catalog's column lengths in order |
| `expect.error` | name: `none`, `missing-marker`, `bad-row-width`, `truncated` | always | result |
| `expect.marker_offset` | int | when `error` is `none` | offset of the first `FF FF FF FF 01` |
| `expect.row_count`, `expect.row_width` | int | when `error` is `none` | the header fields |
| `expect.row.<r>.cell.<c>.text_offset` | int | per cell | offset in the input of the cell's first byte |
| `expect.row.<r>.cell.<c>.text_length` | int | per cell | the cell's length without trailing spaces |

#### alv-colour-cells

**Input:** a coloured row packet, plus `expect.column_count`. **Under test:** [controls/alv-grid.md §3.2](../../docs/protocol/controls/alv-grid.md#32-coloured-packet), IMPL-CT-9.

| Key | Type | Required | Meaning |
|---|---|---|---|
| `expect.column_count` | int | always | **input:** the number of columns |
| `expect.error` | name: `none`, `bad-record-length`, `bad-row-marker` | always | result |
| `expect.error.row` | int | when `error` is `bad-row-marker` | 1-based row |
| `expect.rows` | int | when `error` is `none` | rows (input length / ((1 + columns) × 448)) |
| `expect.row.<r>.number` | int | per row | the marker slot's row number |
| `expect.row.<r>.cell.<c>.column`, `expect.row.<r>.cell.<c>.row_index`, `expect.row.<r>.cell.<c>.colour_field` | int | per cell | the slot's three u32 LE fields |
| `expect.row.<r>.cell.<c>.colour` | int | per cell | (field − 1) & 0x07, or 0 when the field is 0 |
| `expect.row.<r>.cell.<c>.intensified`, `expect.row.<r>.cell.<c>.inverse` | int (0 or 1) | per cell | bits 0x08 and 0x10 of field − 1 |
| `expect.row.<r>.cell.<c>.text_offset` | int | per cell | slot start + 12 |
| `expect.row.<r>.cell.<c>.text_length` | int | per cell | the text without trailing spaces |

## Error classes

Negative vectors say only `expect.error: <class>`, plus the keys each kind lists (counts of what came before, or the header fields that decoded). Each implementation maps its typed errors onto these class names in one place in its test support, which keeps the vectors independent of the implementation. One class has one meaning across all kinds.

| Class | Meaning | Kinds | Basis |
|---|---|---|---|
| `truncated` | the input ends inside a fixed-size or declared structure: a length field, frame payload, DP header (shorter than 200 bytes), DIAG header, compression header, item, simple-item value, CONNECT, SUPPORTDATA or DIALOG_STEP_NUMBER value, or atom; since v2 also a fixed-size item value, a counted entry, a zero-terminated string whose value ends before its zero byte, an RFC item, or a compressed-table prefix shorter than 16 bytes | `ni-stream`, `dp-header`, `diag-header`, `compression-header`, `decompress`, `items`, `simple-item-fields`, `connect`, `support-bits`, `dialog-step`, `dynt-atoms`; v2: `appl-fields`, `imode-uuids`, `dynt-focus`, `stringz-fields`, `menu-entries`, `control-properties`, `rfc-table-content`, `rfc-compressed-table`, `alv-rows`; v2.2: `rfc-items` | layout sizes; IMPL-NI-6, IMPL-DP-3, IMPL-DH-1, IMPL-CH-4, IMPL-IT-5, IMPL-DA-3; PV-0020, PV-0504, PV-0124, PV-0125, PV-0140; v2: IMPL-SS-3, IMPL-SS-5, IMPL-CT-1, IMPL-CT-2, IMPL-CT-3, IMPL-CT-4, IMPL-CT-9 |
| `length-mismatch` | a length the input declares disagrees with the actual length: in `dp-header` the DP length field (u32 LE at offset 30) is not the payload length minus 200; in `decompress` the decoded output is shorter than, or would exceed, the declared uncompressed length | `dp-header`, `decompress` | PV-0021, PV-0022, PV-0221, IMPL-DP-3; PV-0314, IMPL-LZH-3, IMPL-LZH-4, IMPL-LZC-1, IMPL-LZC-2 |
| `unknown-compress` | the DIAG compress byte is 4–255 | `diag-header` | PV-0050–PV-0053; IMPL-DH-2 |
| `missing-terminator` | an error body contains no `0C` byte | `diag-error-body` | PV-0303; IMPL-DH-7 |
| `bad-magic` | compression header bytes 5–6 are not `1F 9D` | `compression-header`, `decompress`, `rfc-compressed-table` | PV-0067; IMPL-CH-2 |
| `unknown-algorithm` | the algorithm nibble of byte 4 is neither 1 (LZC) nor 2 (LZH) | `compression-header`, `decompress`, `rfc-compressed-table` | PV-0063–PV-0065; IMPL-CH-1 |
| `bad-maxbits` | LZC maxbits (byte 7 & 0x1F) is outside 9–16 | `compression-header`, `decompress`, `rfc-compressed-table` | PV-0080, PV-0310, PV-0311; IMPL-CH-4, IMPL-LZC-4 |
| `bad-block-type` | an LZH block type is 0 or 3 | `decompress` | PV-0073, PV-0356 |
| `bad-code-lengths` | an LZH dynamic code header is invalid: counts above 286 or 30, a run that overflows its sequence, symbol 16 with no previous length, an over-subscribed or incomplete code, or no length for symbol 256 | `decompress` | PV-0367, PV-0370, PV-0372; IMPL-LZH-7 |
| `bad-symbol` | an LZH literal/length symbol 286 or 287, or a distance symbol 30 or 31, was decoded | `decompress` | PV-0358, PV-0362 |
| `bad-distance` | an LZH distance exceeds 16 122 or the bytes produced so far in the message | `decompress` | PV-0071; R-LZH-5; IMPL-LZH-2 |
| `bad-code` | an LZC code is not decodable: ≥ 256 (other than a block-mode clear) with no previous code, or greater than next free | `decompress` | PV-0393 |
| `data-truncated` | the LZH data ends before the end-of-block symbol of the final block | `decompress` | PV-0374; IMPL-LZH-1 |
| `unknown-simple-type` | the item type byte is not a known type, or is OKC (0x08, size unknown) | `items` | PV-0417, PV-0409; IMPL-IT-2, IMPL-IT-8 |
| `bad-atom-length` | an atom's `atom_length` is less than 13, so it cannot hold its own header | `dynt-atoms` | PV-0140, PV-0603; R-DA-3 |
| `overlong` (v2) | a value is longer than its fixed-size layout, or longer than the length its own count implies (IMODEUUIDS2: 1 + 17·n) | `appl-fields`, `imode-uuids` | PV-0704–PV-0717, PV-0728; IMPL-SS-3 (provisional policy of #39) |
| `entry-length-mismatch` (v2) | a menu entry's length field differs from 20 plus the bytes of its three zero-terminated strings | `menu-entries` | PV-0718, PV-0719; IMPL-SS-5 (#50) |
| `not-xml` (v2) | an ADT response body is not well-formed XML with namespaces | the ADT response kinds | IMPL-ADT-10 |
| `wrong-root` (v2) | the root element's qualified name (local name for the dump feed) is not the kind's root | the ADT response kinds except `adt-object-structure` | R-ADT-4 and the root of each resource |
| `bad-table-item` (v2) | an RFC item id other than `03 05` or `03 06` where table content is expected | `rfc-table-content` | PV-0912, PV-0913; IMPL-CT-3 |
| `bad-record-length` (v2) | a fixed-width stream is not a whole number of records (53, 44, 337, 904 bytes, or one coloured-row stride) | `cfw-verbs`, `cfw-descriptors`, `cfw-values`, `alv-catalog`, `alv-colour-cells` | PV-0922, PV-0924, PV-0926, PV-0942, PV-0943; IMPL-CT-6, IMPL-CT-9, IMPL-CT-10 |
| `bad-descriptor` (v2) | a descriptor record without exactly four columns, or with a non-number where a number is needed | `cfw-descriptors` | PV-0924; IMPL-CT-6 |
| `malformed-xml` (v2) | a DATAMANAGER document that is not well formed | `datamanager` | IMPL-CT-7 |
| `missing-marker` (v2) | no `FF FF FF FF 01` in a plain row-packet stream | `alv-rows` | PV-0940; IMPL-CT-9 |
| `bad-row-width` (v2) | a plain packet's declared row width differs from the catalog's sum | `alv-rows` | PV-0941; IMPL-CT-9 |
| `bad-row-marker` (v2) | a coloured row does not start with `FF FF FF FF` | `alv-colour-cells` | PV-0943; IMPL-CT-9 |
| `length-over-cap` | a declared length exceeds the implementation's size cap | none: the cap is not a protocol value, so implementation tests cover it | IMPL-NI-1, IMPL-CH-5 |

## Adding a vector

1. Write the spec text first, with its PROVENANCE rows. A vector never states more than the spec.
2. Add the `.vec` file with every required key. Name the readings and IMPL rules it depends on in `derivation`.
3. Document any new kind, key or error class in this README in the same PR. Reuse an existing error class only if its meaning above fits exactly.
4. Run the spec checks: `Scripts/ci/check-fixtures.py` (every `spec` link resolves to an existing heading, every `provenance` ID exists, the kind and its keys are documented here, and the hex parses).
5. A new kind whose implementation belongs to a later milestone goes into [Kinds without an implementation yet](#kinds-without-an-implementation-yet), with that milestone.
