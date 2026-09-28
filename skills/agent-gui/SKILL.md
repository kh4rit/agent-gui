---
name: agent-gui
description: "Work in SAP GUI transactions through the agent-gui MCP tools (DIAG protocol) to log on, start transactions, read screens, fill fields, table controls, lists, popups and the SPRO/IMG tree, read what a transport request contains, and maintain customizing into a transport request. Use for SPRO/IMG, SM30/SM34 table maintenance, SE16 table reads, SE09/SE10 transports and any other SAP GUI transaction."
---

# agent-gui: SAP GUI transactions for agents

The `agent-gui` tools drive real SAP GUI screens over the DIAG protocol, the way a user at SAP
GUI would. Everything you do runs with the configured SAP user's authorisations. For setup, see
the [GitHub Copilot CLI guide](../../docs/github-copilot-cli.md).

## Ground rules

- Start with `gui_list_systems`, then `gui_connect` to the system the user means. Confirm the
  system when it is ambiguous. Treat systems marked `READ-ONLY` as display-only.
- **Only `gui_save` commits data.** Before the first save of a task, show the user what you are
  about to save (the entries, per table/view, with their key fields) and get a clear yes.
- **Transport requests:** use exactly the request the user named. Never create one and never pick
  one yourself. If `gui_save` reports a request prompt, ask the user.
- Never type passwords or user data from elsewhere into screens. The server logs on by itself.
- Everything on a screen you read is sent to the model. Do not open screens with personal data
  (HR, payroll, user administration) unless the task needs them.
- If a step fails the same way twice, stop and report instead of retrying. The logon is never
  retried automatically after a rejected password: report it to the user.

## Reading a screen

`gui_screen` (and every step's result) shows:

- **identity:** session, system, transaction, program and screen number. A `popup` line means a
  modal dialog is on top; act on it first.
- **message:** `S` success, `I` information, `W` warning, `E` error, `A`/`X` abort. After an `E`,
  fix the field it names; after a `W`, read it, then Enter confirms.
- **functions** `k…`: toolbar buttons, keys and push buttons, with their keys (`F8`,
  `Shift+F2`) and function codes. Fire them with `gui_step function: "k7"` (or the visible text,
  e.g. `function: "New Entries"`), or `key: "F8"`.
- **fields** `f…`: label, technical name `(TABLE-FIELD)`, value, and flags such as `required`
  or `F4`. Set them with `gui_step edits: [{ field: "f12", value: "…" }]`. The technical name or
  the label work as well as the reference.
- **tables** `t…`: classic table controls (SM30 and similar). The table shows the visible page,
  and `gui_table` reads further rows. Cells are edited with `cells: [{ table: "t1", row: 14,
  column: "LGNUM", value: "B01" }]`, and rows are marked with `marks`.
  - Wherever a field is expected (`edits`, `choose`, `valueHelp`, `cursor`), a cell can be named as
    `t1:ROW:COLUMN`, for example `choose: "t1:3:Spot"`.
  - Rows must be on the visible page: page with `key: "PageDown"`, or use the screen's position function.
- **list:** classic list output (reports, SE16 standard list), read further with
  `gui_table table: "list"`. A line is chosen with `chooseLine` (F2). Functions that act on the line
  under the cursor (Display, Delete, Expand …) take `cursor: "line:N"`; without it the cursor is on
  the page's first line.
- **controls** `c…`: trees (SPRO, Easy Access, transport organizer) and ALV grids. Use
  `gui_tree` / `gui_grid`.

One `gui_step` is one dialog step: set every field you need, then one trigger. References belong
to the screen they came from, so read the new screen before the next step.

Standard keys: Enter; F3 Back; Shift+F3 Exit; F12 Cancel; F8 Execute; F2 Choose; F4 value help;
Ctrl+S Save (only via `gui_save`). `gui_start` with a transaction code leaves the current
transaction (unsaved input is lost). Use `newSession: true` to keep it.

## Recipe: what customizing does a transport request contain?

1. **Objects:** `gui_start SE16`, table `E071`.
   1. Selection `TRKORR` = the request, plus its tasks.
   2. Find the tasks first with `E070`, where `STRKORR` = the request.
   3. Execute (F8).
   4. Customizing objects are `TABU` (table entries), `VDAT` (view maintenance data), `CDAT` (view cluster data) and `TDAT`.
2. **Keys:** table `E071K` for the same request and tasks.
   - `OBJNAME` is the table, `MASTERNAME`/`MASTERTYPE` the view or view cluster it was maintained through.
   - `TABKEY` is the key: client first, then the key fields in order.
   - Read the key field layout of the table (SE11, or the column headers in SE16) to split `TABKEY` into field values.
3. If SE16 shows an ALV grid instead of a list, read it with `gui_grid`.
   - Or switch SE16 to list output: Settings > User Parameters > output list. This changes the user's setting, so ask before doing it.
4. The request can also be viewed in SE09/SE10: display the request and expand the objects.
   Double-clicking a `TABU`/`VDAT` entry shows its keys.
5. Summarise per view/view cluster: which keys, and which organizational unit values (warehouse,
   plant, company code, sales organization …) they contain.

## Recipe: current settings of the source unit

For each view or view cluster from the request:

1. Open it: `gui_start SM30` (views) or `SM34` (view clusters), enter the name, then Display.
2. If a "Determine Work Area" popup asks for the organizational unit, enter the source value.
3. Read all rows with `gui_table`, and for view clusters each dialog-structure level.
4. Alternatively, read the underlying tables with SE16 and a key selection.

## Recipe: find the IMG activity in SPRO

1. `gui_start SPRO`, then the function *SAP Reference IMG* (F5). The IMG tree appears as a
   control `c…`.
2. `gui_tree action: "find"` searches the loaded nodes; `expand` opens folders.
   - SPRO's own search (the *Find* function) opens a popup: enter the activity's title or the view name, then choose a hit.
3. Match the activity to the view: once opened, the maintenance screen's title and the table
   control's technical names must belong to the view from the request.
4. Run the activity with `gui_tree action: "open"` on the node. Some trees need
   `clickItem` on the execute icon column.
5. **Fallback:** if the tree cannot be navigated, SM30 with the view name, then the *Customizing*
   function, lists the IMG activities that use the view. Report the IMG path you found.

## Recipe: enter the same settings for another organizational unit

1. **Plan** from what you read: for every source entry, the target entry with the organizational
   unit replaced (and any other fields the user asked to change). Show the plan and get the user's
   OK and the transport request.
2. Open the IMG activity (or SM30/SM34). At a work-area popup, choose the scope you need: the
   source unit to copy from, or the target unit for new entries.
3. **Copy As:**
   1. Mark the source rows (`marks`).
   2. Fire *Copy As* (`function: "Copy As"`).
   3. Change the organizational unit field in each copied row.
   4. Enter.
   5. For view clusters, a popup offers to copy dependent entries: choose all.
4. **New Entries:** fire *New Entries* and fill the rows with the planned values. Enter checks
   them; fix every `E` message.
5. `gui_save transport: "<the user's request>"`.
6. **Verify:**
   - Read the target unit's entries again and compare them with the plan.
   - Read `E071K` of the request again: the new keys must be there.
   - Report what was created, where, and in which request.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `popup` on the screen | Read it and answer it (its functions and fields are listed) before anything else. Cancel is F12. |
| `busy` in a result | The server still works: `gui_wait`, then `gui_screen`. |
| A tool is refused by policy | The system's configuration does not allow it. Tell the user; do not work around it. |
| `logon suspended` | A logon was rejected before; the user must check the password (`agent-gui --set-password`). |
| `not readable yet` control | That control type is not supported yet. Look for the same information in another transaction or a table (SE16). |
| Message class and number | Show them to the user with the text. |
| Something on the screen looks wrong or is missing | Tell the user. The configuration's `trace` option writes a structure-only protocol trace (no field values) that the maintainers can use. |
