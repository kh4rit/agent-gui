# The screen snapshot

What `gui_screen` and every step's result show the model, in order. The format is plain text,
compact by default (`detail: "full"` adds menus, disabled functions and positions).

```
S1 · DEV · SM30 · SAPL0ZZ 0100 · popup      session, system, transaction, program and screen
popup: "Title" over PROGRAM 0100 "Title"      a modal dialog on top (act on it first)
title: "Window title"                         (no popup)
server error: …                               the server refused the step
message: E Text (CLASS 123)                   S success, I information, W warning, E error, A/X abort
functions: k2 Save [Ctrl+S] · k9 New Entries [F5 NEWL] · …
tabs: f20 "General" (active) → k31 · …
fields:
  f2 input "Label" (TABLE-FIELD) = "value"  [required, F4, max 3]
  f3 read-only "Label" (TABLE-FIELD) = "value"
  f4 text "Label" = "value" (TABLE-FIELD)
  f5 password "Label"
  f6 checkbox [x] "Caption" (TABLE-FIELD)
  f7 radio (•) "Caption" group g12 (TABLE-FIELD)
  f8 dropdown "Label" (TABLE-FIELD) = "EN English"  options: EN="English", DE="German"
  f9 button "Caption" → k17
  -- Frame caption --
  f10 label "Text"
table t1 NAME: rows 1-15 of 1000, rows can be marked (gui_table t1 reads more); a cell is t1:ROW:COLUMN
  | row | mark | Title (TABLE-FIELD)* | … |      * marks key columns
  | 1 | [ ] | 001 | … |
list: lines 1-20 of 215
  head| fixed header lines
     1| body lines
tree c105 in CONTAINER: 42 nodes loaded
  [-] Folder  {NODEKEY}                       [+] closed folder, [-] open folder
        Leaf  {NODEKEY}  | column texts
grid c106 in CONTAINER: 3 rows
  | row | Title (FIELD) | … |
cursor: f2
notice: …                                     parts of the screen that could not be read
```

- **References** name what the tools take back: `f…` fields, `k…` functions, `t…` tables,
  `t1:ROW:COLUMN` cells, `c…` controls and `{NODEKEY}` tree nodes. They are valid for the screen
  they came from.
- **Texts** are shown without SAP's icon codes. The traffic lights become `(green)`, `(yellow)` and `(red)`.
- **Labels:** labels that name an input field, or repeat a table column title, are left out in compact mode.
- **Row selectors** of table controls are shown as the table's `mark` column, not as fields.
- **Password fields** never show a value.
