# CLAUDE.md — Garuda Studio (web GUI)

Orientation for AI assistants and new developers working in this repo. Read it
before changing code. The user-facing description is in
[USER_MANUAL.md](USER_MANUAL.md).

## What this is

Garuda Studio is the browser GUI for the Garuda sensorless ESC firmware
(dsPIC33AK). It is a static single-page app: React 18 + TypeScript + Vite,
Zustand for state, Recharts for plots. It speaks GSP (Garuda Serial Protocol), a
binary request/response protocol, directly over the Web Serial API at 115200
baud. There is no backend.

It is a port of the standalone Python GUI, which lives in a different repo:
`ProjectGaruda`, branch `ak512-port`, folder `tools/garuda_debug/`
(`garuda_gui/` is the app, `garuda_gsp/` is the protocol library). The Python
side is the **reference**; most files here say which Python file they mirror.

## Commands

```bash
npm install
npm run dev          # Vite dev server; localhost counts as a secure context
npx tsc --noEmit     # type-check — NOT part of the build, run it yourself
npm run build        # production build into dist/
npm run preview      # serve dist/ locally
```

- `npm run build` is `vite build` only. It does **not** type-check. `tsconfig`
  is strict with `noUnusedLocals` and `noUnusedParameters`, so always run
  `npx tsc --noEmit` before committing; it must exit clean.
- There are no unit tests and no linter configured. Verification is: type-check,
  build, then exercise the changed tab in Chrome (ideally against a board).
- The build prints a ">500 kB chunk" warning. It is expected; ignore it.

## Deployment — pushing to `main` publishes

`.github/workflows/pages.yml` builds and deploys to GitHub Pages on **every push
to `main`**. The repo and the page are public:
<https://bhanuprakashjh.github.io/garuda-studio/>.

- A push to `main` is a release. Do not push unverified work to `main`; use a
  branch.
- `vite.config.ts` sets `base: '/garuda-studio/'` to match the repo name. Do not
  change it unless the repo is renamed.
- `dist/` and `node_modules/` are git-ignored; never commit them.
- To confirm a deploy, compare the asset hash in the live page's HTML with the
  `dist/assets/` file names from a local build of the same commit.

## Layout

```
src/
  main.tsx, App.tsx        entry; nav rail, top HUD, tab switch, toasts
  index.css                theme (CSS variables, .glass, .mono, .hud-label)
  web-serial.d.ts          Web Serial type declarations
  protocol/
    serial.ts              SerialManager — thin Web Serial wrapper
    gsp.ts                 framing, CRC, GspParser, CMD ids, scope/ATA decoders
    decode.ts              GET_INFO / GET_SNAPSHOT decoders (by payload length)
    types.ts               GspInfo/GspSnapshot types, state/fault/param/profile
                           name tables, feature-flag names
  store/useEscStore.ts     the single Zustand store (connection, info, snapshot,
                           history, params, scope, toasts, active tab)
  components/              one file per panel; ConnectionBar.tsx owns the
                           serial link and the RX packet switch
  sim/                     pure, dependency-free ports of the Python models:
                           zcsim, fallingZc, zcml (MLP), wizard, diagnose
```

Tabs are declared in `NAV` in `App.tsx` and typed by `TabId` in the store. To
add a tab: extend `TabId`, add a `NAV` entry, add a `case` in `renderTab`.

## How the link works

All of this is in `components/ConnectionBar.tsx`, which exports the shared
`serial` instance other panels import to send commands.

1. `navigator.serial.requestPort()` then open at 115200.
2. Send `GET_INFO`, then `GET_PARAM_LIST` (paged; pages are accumulated and
   committed to the store only when all have arrived).
3. Start two timers: `HEARTBEAT` every 200 ms (the firmware dead-man), and
   `GET_SNAPSHOT` every 33 ms.
4. Every received packet goes through `GspParser` to one `switch` on the
   command id, which updates the store.

Telemetry is **polled**, deliberately. `TELEM_START` unsolicited streaming
exists in the protocol but polling mirrors the proven Python broker and is more
reliable. Do not switch it to streaming without a bench reason.

Frame format: `[0x02][LEN = 1 + payload][CMD][payload…][CRC_hi][CRC_lo]`,
CRC16-CCITT (poly 0x1021, init 0xFFFF) over LEN, CMD and payload.

## Rules that matter

1. **Decode by payload length, never by assumption.** The snapshot has grown
   across firmware versions (68 B Simplified, then 106/114/150/174/198/208/242/
   248/254 B thresholds in `decode.ts`). Every new field must be guarded by a
   length check and default to `0`, `[]` or `null` when absent, so old and new
   firmware both decode. A past bug dropped every 254-byte snapshot because the
   parser's size cap was too small; if the snapshot grows again, check the cap
   in `GspParser` too.
2. **The 68-byte Simplified snapshot overlaps the production layout.** Its tail
   carries real units computed on-chip at offsets that mean something else in
   the full snapshot. `decode.ts` trusts that tail only for the exact 68-byte
   case. Keep that guard.
3. **Keep three places in step when the firmware protocol changes:** the
   firmware headers (`gsp/gsp_commands.h`, `gsp/gsp_params.h`, the snapshot
   struct), the Python reference (`garuda_gsp/protocol.py`, `decode.py`), and
   this repo (`protocol/gsp.ts`, `decode.ts`, `types.ts`). Change the Python
   reference first or at the same time, and port from it.
4. **Respect the firmware's idle gate.** `SET_PARAM` is rejected unless the
   motor is idle, except parameter ids `0x90`–`0x93` (AN1078 live overrides).
   `LiveTunePanel.tsx` encodes this in each spec's `liveRun` flag. Do not mark a
   parameter live unless the firmware whitelists it.
5. **`sim/` stays pure.** No React, no store, no network, no dependencies. These
   files are line-for-line ports with the Python name noted beside each export
   so the maths can be cross-checked. If you change the model, change the Python
   original too.
6. **No network calls.** The page is a static tool that touches only the serial
   port. The Python GUI's Claude-assisted diagnosis was intentionally not
   ported.
7. **This drives a real motor.** Never make Start, throttle or parameter writes
   happen without an explicit user action. Never remove or slow the heartbeat.
   Stop must stay reachable in every state.

## Known rough edges (verify before relying on, fix deliberately)

- **Bus-voltage scaling.** For non-Simplified firmware the raw reading is
  converted with a hard-coded divider of `19.8`, repeated in about ten places
  (`App.tsx`, `GaugePanel`, `MonitorPanel`, `ScopePanel`, `ConsolePanel`,
  `ParamPanel`, `ParamModal`, `WizardPanel`, `FallingZcSimPanel`). The Python
  reference uses `23.2` for the MCLV-48V-300W board (noted there as verified
  2026-07-25) and `13.0` for GarudaESE, selected from the board id. Studio has
  no per-board scaling. If you fix this, centralise it in one helper keyed on
  `info.boardId` and confirm against a multimeter on the bench.
- **Command-id leftovers.** `CMD` in `gsp.ts` still lists CK-board burst
  commands, and `AUTO_DETECT` and `BURST_ARM` share `0x20`. The CK board path
  was removed from this build; these are dead entries.
- **Help tab hardware block** (`HW_INFO` in `HelpPanel.tsx`) is static text and
  is out of date in places (it says GSP v2 and 24 kHz PWM). The feature list is
  static too; only the Enabled/Disabled badges are live.
- **Profile names.** Firmware 1.x (`garuda-ak512-6step`) renumbered profiles
  from zero. Display goes through `profileDisplayName(id, fwMajor)` in
  `types.ts`, which picks `PROFILE_NAMES_V1` for major ≥ 1 (same rule as the
  Python side). `ProfileSelector.tsx` — the buttons that LOAD a profile — still
  uses the older `PROFILE_NAMES` array and is wrong for firmware 1.x.
- **Reused snapshot slots.** `capRisePm` / `capFallPm` / `piNoCap` are read from
  the speed-PI slots at offsets 208–219 and are valid only when byte 208 is the
  `0xDD` marker (`capDiagValid`). Keep that gate. Ported 2026-11-18, type-checked
  and built but not yet run against a board.
- **`TabId` includes `'console'`** but there is no console tab; the console is
  the bottom dock.

## Conventions

- Function components, inline `style` objects, theme colours through CSS
  variables (`var(--accent-cyan)` etc.). Follow the neighbouring panel's style
  rather than adding a styling library.
- Read from the store with selectors (`useEscStore(s => s.x)`). Telemetry
  arrives ~30 times a second; anything expensive (charts) must be throttled or
  memoised the way `MonitorPanel` does it.
- Each panel that ports a Python feature carries a header comment naming the
  original. Keep that comment accurate.
- Commit messages are short imperative summaries of the user-visible change.

## Working with the firmware and the Python reference

Neither is in this repo. If the task needs them, ask where the `ProjectGaruda`
checkout is (branch `ak512-port` holds the current Python GUI and firmware) and
read the relevant header or Python file before changing a decoder here. Do not
guess offsets.
