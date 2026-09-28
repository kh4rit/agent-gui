# AGENTS.md

Instructions for AI agents working on this repository (`CLAUDE.md` points here).

## What this project is

agent-gui is an MCP server that lets AI agents work in SAP GUI transactions over the DIAG protocol:
log on, start transactions, read screens, fill fields, work with table controls, popups and tree
controls, and save into transport requests. It is a Node/TypeScript sibling of
[agent-adt](https://github.com/kh4rit/agent-adt) and follows its conventions (config file, CLI,
tool style, tests, skill, Copilot CLI guide). MIT licence.

The DIAG engine under `src/diag` is a TypeScript port of the portable Swift modules of the
owner's Swooey project (MIT): DiagWire, DiagCompression, DiagCodec, DiagSession and ScreenModel.
`src/engine` ports the session loop that Swooey keeps in its app (mode routing, input steps,
logon, table paging, control events). [docs/PLAN.md](docs/PLAN.md) is the plan;
[docs/porting.md](docs/porting.md) holds the porting rules.

## Hard rules

- **Development agents never connect to a live SAP system.** While developing and testing, the
  only DIAG server is the loopback fake server (Swooey's `fake-diag-server`, or the replay
  server in the tests). Live systems are used by the owner, through the finished MCP server.
- **Never ask for, read or store credentials, hosts, SIDs or user names of real systems.** Tests
  use invented values. Passwords travel as the non-printable `Secret` type and never appear in
  tool results, logs, audit files or errors.
- **Clean room.** Port only from Swooey's sources and docs (MIT) and public documentation. Never
  copy, port or paraphrase GPL code (pysap, the Wireshark SAP dissectors, sapcomp, the MaxDB
  sources) or unlicensed code. Never inspect SAP binaries. Keep Swooey's
  `// provenance: PV-NNNN` comments on protocol constants; they point to Swooey's PROVENANCE.md.
- **Mock data is invented and deliberately funny** (Swooey's Duck Pond): `ZZ…` transactions,
  programs and fields. Fixtures come from the fake server only and carry `source: fake`.
- No telemetry. The only network connections the server makes are the SAP systems in its config.

## Working in this repo

- `npm test` builds with `tsc` and runs every `dist/test/**/*.test.js`; it must pass before a
  commit. `node scripts/test.mjs wire` runs a subset.
- Byte vectors in `test/vectors` are Swooey's (source: spec). A vector that disagrees with the
  code is checked against Swooey's spec section, never edited to match the code.
- End-to-end tests run against Swooey's fake server when `AGENT_GUI_FAKE_SERVER` names its
  binary and `AGENT_GUI_SCENARIOS` its `Tests/Scenarios` folder; they skip otherwise. Build it
  from Swooey revision `112c04d`, the last whose server takes `--scenario` (later ones serve only
  the Duck Pond), from an export so that the Swooey checkout stays untouched:
  `git -C ../swooey archive 112c04d | tar -x -C <dir>`, then `swift build --product fake-diag-server`
  in `<dir>`.
- Commit messages: imperative subject; AI-assisted commits end with a `Co-Authored-By:` trailer
  naming the model.
- Keep tools thin: logic lives in `src/engine` and the host modules, with tests.
