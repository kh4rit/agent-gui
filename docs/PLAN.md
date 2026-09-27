# agent-gui — Project Plan

**Status:** 0.1.0 implemented on 2026-09-27; live validation on the target system is next. **Licence:** MIT.
**Target:** GitHub Copilot CLI on Windows (the same setup as agent-adt); any other MCP client works too.

agent-gui is an MCP server that lets AI agents work in SAP GUI transactions. It speaks the DIAG protocol directly: no SAP GUI installation, no GUI Scripting and no screen scraping. It is the sibling of [agent-adt](https://github.com/kh4rit/agent-adt), which covers code over ADT/HTTP, and it follows agent-adt's route: a Node/TypeScript package installed with `git clone` + `npm install`.

---

## 0. Summary

**Acceptance scenario.** In Copilot CLI on Windows:

> "Transport DEVK9xxxxx holds the customizing for warehouse A. Find out what it contains, go to SPRO, find the IMG activities for those settings, enter the same settings for warehouse B and record them in transport DEVK9yyyyy."

The agent does all of it through agent-gui tools:
1. read the request's objects and table keys;
2. read warehouse A's current entries;
3. find and run the IMG activities in the SPRO tree;
4. create warehouse B's entries in the maintenance views;
5. save into the named request;
6. re-read and compare.

The scenario is EWM, but nothing in agent-gui or its skill is module-specific: the agent works out any module from the transport and the IMG.

**Approach.**
- The DIAG engine is a **TypeScript port** of the portable Swift modules of the owner's Swooey project (MIT): DiagWire, DiagCompression, DiagCodec, DiagSession and ScreenModel. Swooey's app keeps the session loop (mode routing, input steps, logon, table paging, control events); that is ported too, into `src/engine`.
- Swooey itself is not changed. Its spec, byte vectors and fake server serve as the reference and the test backend.
- The MCP host follows agent-adt: `systems.json`, the CLI (`--check`, `--call`), thin tools, a skill, and a Copilot CLI guide.

**Target system.** The system where agent-gui runs allows direct agent use. It has nothing in common with Swooey's use case; Swooey's rules for its own development stay in Swooey.

---

## 1. What we reuse

| From | What |
|---|---|
| **agent-adt** | The product shape: a stdio MCP server; `systems.json` with `${env:…}` placeholders; `readOnly` per system; `--check`, `--call`, `--help`; thin tools over services; the `node --test` suite on Windows and Linux CI; a skill file plus a Copilot CLI setup guide; the CHANGELOG style. |
| **Swooey** (revision `7c3ca4b`) | The DIAG engine's Swift sources, ported file by file ([porting.md](porting.md)); 268 byte vectors (`test/vectors`, source: spec); the protocol readings and live-learned facts in its code comments and provenance; the loopback `fake-diag-server` with its invented Duck Pond scenarios as the end-to-end backend. |

---

## 2. Architecture

```
 Copilot CLI ──stdio/MCP──▶ agent-gui (Node ≥ 20, TypeScript)
   src/tools.ts        MCP tools (§4)
   src/policy.ts       read-only, transaction allow/deny, commit functions
   src/snapshot.ts     Screen → compact text for the model (§4.2)
   src/sessions.ts     systems, sessions/modes, per-session queue, idle logoff, busy/wait
   src/credentials.ts  Windows Credential Manager / macOS Keychain / env; attempt budget
   src/audit.ts        JSONL audit log of every step
   src/engine/         the session loop (port of Swooey's app loop) + the Node socket transport
   src/diag/screen     ScreenModel: screens, elements, tables, lists, popups, controls
   src/diag/session    DiagSession: session state machine, logon step, control traffic
   src/diag/codec      DiagCodec: DIAG header, items, atoms, client input, RFC_TR, flush answers
   src/diag/compression DiagCompression: LZH/LZC
   src/diag/wire       DiagWire: NI framing, keep-alive, DP header
```

- `src/diag` is pure TypeScript with no Node APIs; it takes bytes and returns bytes and models.
- `src/engine` owns the socket (`node:net`), timers and the session loop. For each connection it:
  - answers keep-alive pings;
  - routes messages to modes;
  - answers the Control Framework's flush calls;
  - pages table controls;
  - builds input steps from edits and triggers.
- The host holds configuration, credentials, policy, audit and the MCP tools.

**The engine's API** (used by the host):
- `GuiConnection.open(system)` returns the first screen;
- `logOn(credentials)`;
- `screen(mode)`;
- `step(mode, edits, trigger)` returns the next screen;
- `readTable(mode, table, from, count)`;
- `tree(…)` and `grid(…)` actions;
- `logOff()` and `close()`.

---

## 3. What the scenario needs from the engine

Status of Swooey's implementation (and so of the port) on 2026-09-27. "Live" means confirmed on a real system. `SW-NNN` names an issue in Swooey's tracker (Swooey is not public yet).

| Step | Screens and protocol features | Swooey status | Open points |
|---|---|---|---|
| Log on | logon step, multiple-logon popup, password-expired detection | ✅ live with the `reference` identity; multiple-logon popup built | SW-148, SW-149; password change not built |
| Read the request | SE16 on E070/E071/E071K with standard-list output (preferred), or SE09/SE10 | lists decode; start-menu tree and grid double-click live | list paging `P+` (SW-111); ALV paging (SW-89); SE09's tree not seen (SW-88) |
| Read warehouse A's entries | SM30/SM34 display, the "Determine Work Area" popup, table-control paging | fake server only | SW-110 table-control items, SW-112 popups, SW-109 tabstrips |
| Find the IMG activity | SPRO tree: read, expand, find, execute | trees render from their data tables; node event 25 live | SW-88 IMG tree, SW-84 expand and item click, SW-170/SW-171 front-end data path |
| Create warehouse B's entries | New Entries / Copy As, cell edits, row marks, Enter checks | fake server only | SW-55 `/NN` function keys (only `/08` live), SW-34, SW-107/SW-108/SW-115 |
| Save into the request | Save, the customizing-request popup, request F4, status message | fake server only | SW-112, SW-114, SW-113 |
| Verify | re-read B's entries and the request keys | as above | as above |

**Where the open points get settled.** The owner runs agent-gui itself on the target system. A structure-only trace (§5.4) turns what the server sent into fixes and fake-server scenarios.

**Fallback while the IMG tree is not ready.** The maintenance views are reachable directly through SM30/SM34, and SM30's *Customizing* button names the IMG activity.

---

## 4. MCP tools

Every tool has the prefix `gui_` and an optional `system` parameter, as in agent-adt. Sessions are addressed by `session` (for example `S1`); one SAP mode is one session.

### 4.1 Tool set

| Tool | Class | What it does |
|---|---|---|
| `gui_list_systems` | read | Configured systems with host, client, user, `READ-ONLY`, and open sessions. |
| `gui_connect` | session | Logs on with the stored credential (never one from the agent). Returns the session id and the first screen; optional `transaction`. |
| `gui_disconnect` | session | Logs off cleanly (`/nex`, then the close message). |
| `gui_screen` | read | The current screen as a compact snapshot (§4.2). `detail: compact\|full`. |
| `gui_start` | navigate | Starts a transaction (`/n` by default; `newSession` → `/o`). Checked against the transaction policy. |
| `gui_step` | navigate | **One dialog step**, as DIAG does it: any number of edits (fields, checkboxes, radio buttons, dropdowns, table cells, row marks) plus one trigger: `enter`, `key` (F1–F12 with Shift/Ctrl, page keys), `function` (a code, or the visible text of a toolbar, menu or push button), `okcode`, `choose` (F2), `valueHelp` (F4). Refuses commit functions and points to `gui_save`. |
| `gui_table` | read | Rows of a table control or list beyond the visible page. The engine pages the server and restores the position; it refuses while edits are unsent. |
| `gui_tree` | navigate | Tree controls (SPRO, Easy Access, SE09): `read` as an indented outline with node keys; `select`, `open` (double-click). `expand`, `clickItem` and server search follow the open points of §3. |
| `gui_grid` | read | ALV grid rows with field names and headings; `open` (double-click a cell). |
| `gui_save` | **commit** | Presses the screen's Save. If a transport prompt appears, fills `transport` and confirms. Without `transport` it cancels the prompt and returns the choices, so nothing is saved. Refused on read-only systems. |
| `gui_wait` | read | Waits for a long-running step. |

**Composite tools come after their recipe is proven live.** Candidates are `gui_read_table` (SE16) and `gui_transport_contents` (E070/E071/E071K). Until then these flows are recipes in the skill.

**Copilot CLI approvals.** Only `gui_save` commits, so the setup guide recommends allowing the read and navigate tools (`--allow-tool='agent-gui(gui_screen)'` …) and always asking for saves. Every tool also carries MCP annotations: `readOnlyHint`, and `destructiveHint` on `gui_save`.

### 4.2 Screen snapshot

**Rules:**
- compact text;
- stable references (`f3`, `t1`, `b7`, `tree1`) derived from `ScreenElementID`;
- technical field names next to the labels;
- the status message and any popup first;
- long tables and trees truncated with a pointer to `gui_table` or `gui_tree`;
- password fields as `(password)`;
- after a step, a one-line "what changed" header.

Illustrative example with invented data:

```
S1 · DEV/100 · ZZPOND_CFG · ZZ_POND_CFG 0100 · main window
title   Change View "Pond Rules": Overview
message S  Data was saved
functions Enter · Save(Ctrl+S) · Back(F3) · Cancel(F12) · New Entries(F5 NEWL) · Copy As(F6 KOPE)
fields
  f1  Pond            ZZV_RULES-POND   [001]  input w3 F4 required
table t1 "Pond rules"  rows 1–12 of 57 · row marks · gui_table for more
  row mark | POND (key) | DUCK_LIMIT | QUACK_LEVEL
  1   [ ]  | 001        | 12         | LOUD
```

---

## 5. Safety, credentials, configuration and diagnostics

### 5.1 Safety model

A GUI agent can do whatever the SAP user can, so the user's authorisations are the real limit. agent-gui adds:

1. **Commit separation.** Save goes only through `gui_save`. `gui_step` refuses the function bound to Ctrl+S in the current GUI status, and the per-system `commitFunctions`.
2. **`readOnly: true`** per system (set it for QA and production). `gui_save` and the commit functions are refused.
3. **Transaction policy** per system:
   - `transactions.allow` (if set, only those) and `transactions.deny`;
   - a built-in deny list covering user administration, RFC destinations, OS commands, transport release and import, client settings, program execution, table editing modes and `/h`;
   - checked against the transaction the server reports on every screen.
4. **Transport requests.** The agent never creates or picks one; `gui_save` needs the request the user named. The skill makes the agent show the planned entries and ask before the first save.
5. **Audit log.** One JSONL file per day in `~/.agent-gui/audit/`, owner-only: every step's transaction, program/screen, trigger, changed field names and values (never passwords), and the resulting message.
6. **Honest limits.** Some transactions write on Enter or F8; a deny list is never complete; screen contents go to the model provider.

### 5.2 Credentials

- **The agent never sees a password.** It is never a tool argument, never in a tool result, never logged.
- **Where the password comes from:**
  - `password: "${credential}"`: the Windows Credential Manager (macOS Keychain on a Mac), written by `agent-gui --set-password --system DEV` at an interactive prompt;
  - `password: "${env:NAME}"`, as in agent-adt.
- **Attempt budget.** After a rejected automatic logon the account is suspended in `~/.agent-gui/state.json`. There is no further automatic attempt until a successful logon or a new `--set-password`, so an agent in a retry loop cannot lock the user.
- **Password expired or change screen:** agent-gui stops and says so.
- **Multiple logon:** `whenAlreadyLoggedOn: fail | continue | endOthers`, default `fail`.

### 5.3 Configuration

`~/.agent-gui/systems.json` (or `AGENT_GUI_CONFIG`, `--config`); a UTF-8 byte order mark is tolerated.

```json
{
  "defaultSystem": "DEV",
  "systems": {
    "DEV": {
      "host": "sap-dev.example.com", "instance": "00",
      "client": "100", "user": "YOURUSER", "language": "EN",
      "password": "${credential}",
      "readOnly": false,
      "transactions": { "allow": ["SPRO", "SM30", "SM34", "SE16", "SE09", "SE10"] },
      "commitFunctions": ["BU", "SAVE"],
      "whenAlreadyLoggedOn": "fail",
      "identity": "reference",
      "maxSessions": 2, "idleLogoffMinutes": 15, "stepTimeoutSeconds": 60
    }
  }
}
```

- **`identity`** picks what the first message declares. Swooey's presets are `reference`, `reference-norfc`, `reference-nocfw`, `minimal` and `placeholder`.
  - The default is `reference`, the only one confirmed to log on so far.
  - The terminal name is the machine's host name.
- **Single-system environment variables:** `SAP_HOST`, `SAP_INSTANCE`/`SAP_PORT`, `SAP_CLIENT`, `SAP_USER`, `SAP_PASSWORD`, `SAP_LANGUAGE`, `SAP_READ_ONLY`.
- **CLI:** `--check`, `--call <tool> --args <json|@file|->`, `--set-password`, `--forget-password`, `--system`, `--help`.

### 5.4 Diagnostics

**`--trace <file>`** (or `trace` in the config) writes a structure-only trace of every message, in Swooey's style:
- item types and ids, lengths, screen structure and control calls;
- never field values or passwords.

The owner shares it when something on the target system behaves unexpectedly. It becomes a fake-server scenario and a test, then a fix.

---

## 6. Implementation phases

The port runs in waves, following the dependency order of Swooey's modules. Each wave's modules pass their ported Swift tests and their vectors before the next wave builds on them.

| Wave | Scope | Exit |
|---|---|---|
| **W0** | Scaffold, porting rules, DiagWire, the vector harness, the compression API | ✅ 31 wire vectors pass |
| **W1** | DiagCompression (LZH/LZC decoders, LZH encoder); DiagCodec foundation: headers, items, APPL registry, session items, code pages, error text, DYNT atoms, walker, encoder | ✅ all their vectors pass |
| **W2** | DiagCodec screen side (DYNT elements, identity, menus, GUI status, lists, table items, messages, UI events) and control side (RFC_TR, control calls, automation records, flush answers, DataManager, data provider) | ✅ screen and `rfc-items` vectors pass |
| **W3** | DiagCodec client side (client messages, identity presets, client input, input envelope); DiagSession | ✅ logon, keep-alive and Control Framework answers end to end against the fake server |
| **W4** | ScreenModel (controls and core) | ✅ the ScreenModel tests pass, the Duck Pond ones against the fake server |
| **W5** | `src/engine`: Node transport, session loop, logon, modes, table paging, control events, agent view | ✅ log on, ZZPOND_CFG paged, edited and saved, trees and grids, lists, popups end to end |
| **W6** | Host: config, credentials, policy, audit, trace, snapshot, MCP tools, CLI | ✅ 11 end-to-end tool tests through an MCP client; `--check`, `--call` and stdio checked |
| **W7** | Skill, Copilot CLI guide, README, examples, CI | ✅ written; CI runs on Windows, Linux and macOS |
| **Live** (owner) | agent-gui on the target system: read-only first, then writes in a sandbox client, then the scenario | The §0 scenario end to end in Copilot CLI, with the owner approving each `gui_save` |

---

**Test totals on 2026-09-27:** 1,669 tests, all passing with Swooey's fake server; 41 skipped (the 40 Control Framework vectors Swooey does not run yet, and the opt-in credential-store test).

**Next, on the target system (owner):**
1. `--check`, then read-only work: SE16 on E070/E071/E071K, SM30 in display mode, the SPRO tree.
2. Writes in a sandbox client with a test request.
3. The acceptance scenario.

The `trace` option records what the server sent, for fixes to the open points of §3.

## 7. Testing

- **Unit (Node, `node --test`, Windows and Linux CI):**
  - the ported Swift tests of every module;
  - config, credentials (mocked), attempt budget, policy, snapshot and tool arguments.
- **Vectors:** Swooey's 268 byte vectors, run by the ported vector harness.
- **End to end:** Swooey's `fake-diag-server` (loopback only) when `AGENT_GUI_FAKE_SERVER` and `AGENT_GUI_SCENARIOS` are set; skipped otherwise.
  - Scenarios for agent-gui's own flows are invented scenario files kept in this repository (`test/scenarios`) and loaded with `--scenario PATH`.
- **Mock data is invented and deliberately funny** (Duck Pond, `ZZ…` names). Fixtures come only from the fake server.
- **LLM evals (owner-run):** the acceptance prompt against the fake scenarios in Copilot CLI, recording success, tool calls and tokens, to tune the snapshot and the tool descriptions.

---

## 8. Decisions

| # | Decision |
|---|---|
| D-1 | **Stack:** Node/TypeScript, the same route as agent-adt. No executable. The DIAG engine is a TypeScript port of Swooey's Swift modules. (2026-09-27) |
| D-2 | **Swooey is not changed.** Its sources, spec, vectors and fake server are read and used as the reference and the test backend. (2026-09-27) |
| D-3 | **Target system:** a system where direct agent use is allowed, unrelated to Swooey's use case. Development agents still use only the loopback fake server. (2026-09-27) |
| D-4 | **Scope:** module-agnostic. The scenario is EWM, but the agent works out any module from the transport and the IMG. (2026-09-27) |
| D-5 | **Release** can happen at any moment; Swooey follows strict clean-room rules. MIT. (2026-09-27) |

---

## 9. Top risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Control-framework gaps block the SPRO tree (SW-84, SW-88, SW-170, SW-171) | High | Read and write value first; SM30/SM34 fallback; the trace (§5.4) feeds fixes from the target system. |
| R2 | Table-control readings are invented (SW-110) and `/NN` keys untried (SW-55) | High | First live runs on the target system in display mode; the trace; scenario and test per finding. |
| R3 | Porting mistakes (value semantics, integer widths) | High | File-by-file port with the Swift tests and the vectors; end-to-end runs against Swooey's fake server. |
| R4 | The agent writes wrong customizing | High | Plan-then-confirm in the skill; `gui_save` always asks; sandbox client first; audit log; everything in a request that is reviewed before release. |
| R5 | The target system expects another client identity | Medium | `identity` per system; `--check` reports the server's answer. |
| R6 | Account lockout from agent retries | Medium | Attempt budget. |
| R7 | Screens flood the model's context | Medium | Compact snapshots, truncation, paging tools, evals tracking tokens. |
| R8 | Swooey and agent-gui drift apart | Low | Ports name their Swift file and revision; later Swooey fixes are ported by diffing from the recorded revision. |
