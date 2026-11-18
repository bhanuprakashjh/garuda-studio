# Garuda Studio — User Manual

Garuda Studio is the **web GUI** for the Garuda ESC. It runs entirely in the
browser and talks to the ESC over USB serial using the Web Serial API. There is
nothing to install.

- Live page: <https://bhanuprakashjh.github.io/garuda-studio/>
- Sister tool: the standalone Python desktop GUI (`tools/garuda_debug/` in the
  `ProjectGaruda` repo). Studio is a port of it; see
  [What Studio does not do](#what-studio-does-not-do) for the differences.

---

## 1. Safety first

This tool starts, stops and re-tunes a **real motor**.

- Bench only. Secure the motor, remove the propeller unless you are testing
  with one, and keep clear of the rotor.
- The **Stop** button on Mission Control works in every state. Know where it is
  before you press Start.
- While connected, Studio sends a heartbeat to the ESC every 200 ms. If the
  browser tab is closed, crashes, or the USB cable drops, the heartbeat stops
  and the firmware's dead-man logic takes over. Do not rely on this as your
  only protection.
- Parameter edits change motor behaviour immediately or on the next start.
  A bad startup value can trip over-current. The Parameters tab shows an
  estimated startup current next to the values that imply one; read it.
- Browsers throttle background tabs. Keep the Studio tab in the foreground
  while the motor is running.

---

## 2. What you need

| Item | Requirement |
|---|---|
| Browser | Desktop **Chrome or Edge**. Web Serial is Chromium-only; Firefox and Safari will not work. |
| Connection | USB to the board's serial port, **115200 baud** (fixed). |
| Page origin | HTTPS (the hosted page) or `http://localhost` (local dev). Web Serial is blocked elsewhere. |
| Firmware | Garuda ESC firmware that speaks GSP: the 6-step build, the AN1078 FOC build, the `dspic33AKESC-Simplified` build, and GarudaESE (adds gate-driver diagnostics). |

Only one program can hold the serial port. Close MPLAB Data Visualizer, any
terminal program, and the Python GUI or its broker before connecting.

---

## 3. Quick start

1. Plug the board in over USB and power it.
2. Open the live page in Chrome or Edge.
3. Click **Connect** (top right) and pick the board's serial port in the
   browser dialog.
4. Studio then, on its own: reads the board identity, loads the full parameter
   list, and starts polling telemetry about 30 times a second. The state pill in
   the top bar changes from `OFFLINE` to the ESC state (normally `IDLE`).
5. On **Mission Control**, choose the throttle source:
   - **ADC** — the on-board potentiometer drives the throttle.
   - **GSP** — the on-screen throttle slider drives it.
   - **PWM / DSHOT / AUTO** — shown only when the firmware reports that input.
6. Press **Start**. With GSP selected, move the **GSP Throttle** slider
   (0–2000). Press **Stop** to stop.
7. If the state pill turns red with a fault name, press **Clear Fault** once the
   cause is understood.

The throttle source can only be changed while the motor is idle.

---

## 4. Screen layout

- **Left rail** — one icon per tab (hover for the name).
- **Top bar** — state pill, live eRPM and bus voltage, board name, firmware and
  GSP protocol version, and the Connect button.
- **Main area** — the selected tab.
- **Console dock** (bottom) — a telemetry mirror plus a command line. Available
  on every tab. See [section 6](#6-console-commands).

---

## 5. The tabs

### Mission Control

The everyday view.

- **Monitor** — a multi-channel oscilloscope over live telemetry. Each channel
  has its own units-per-division, position and autoscale; there is a freeze
  button, a timebase selector and **Autoscale all**.
- **Sector bars** — for each of the six commutation sectors, how many
  commutations were *accepted* from a real zero-cross and how many were
  *guessed* by the timer, in events per second. A sector with a tall "guessed"
  bar is where zero-cross detection is failing.
- **Status and gauges** — state, fault, uptime, eRPM, bus voltage, duty and
  bus current.
- **Operating map** — a scatter of peak phase current against eRPM, showing
  where the motor spends its time.
- **Motor Control** — Start, Stop, Clear Fault and the throttle source buttons.
- **GSP Throttle** — the slider (enabled only when the source is GSP).
- **Profile selector** — load a built-in motor profile. Loading a profile
  replaces all parameters, saves to EEPROM so it survives a reset, and opens the
  parameter dialog so you can review what changed. Motor must be idle.

About bus current: the firmware reports more than one view of it. The
instantaneous valley sample is unreliable (it can read a large phantom negative
current at idle). Studio shows the firmware-averaged value where the firmware
provides it; treat that one as the trustworthy figure.

### Scope

- **Live scope** — pick from the full channel list, grouped by topic: FOC
  currents, angles and speed, voltage, power, observer and PI internals, and
  the 6-step motor, bus, BEMF/zero-cross, hardware zero-cross, morph and
  protection signals. There is a preset for checking the AN1078 observer.
- **Burst scope** — the on-chip triggered capture. Telemetry arrives at tens of
  hertz and aliases the real waveform; the burst scope records a short window at
  the control-loop rate inside the MCU and then reads it out. Arm it, wait for
  the trigger, and the capture is downloaded automatically. After a capture the
  **ZC explainer** marks the zero-crossings and reports signal-integrity checks
  (half-period symmetry, DC offset).
- **Diagnosis** — a local rule-based check over the recent telemetry history. It
  gives an overall severity and a list of findings with suggested parameter
  changes. It runs in the browser and makes no network calls.

### ZC Sim

An analytic model, no hardware needed. It shows why the falling-polarity sector
loses a true zero-cross at high speed: where the zero-cross really is, where the
sampler measures it, and how large the timer-extrapolation error is across eRPM.
When a board is connected it uses the live bus voltage.

### ZC Lab

A live model of sensorless zero-cross detection: a motor picker and speed slider
drive capture-percentage-versus-eRPM curves, an animated rotor wheel, and the
floating-phase waveform through a zero-crossing. It also has an in-browser
machine-learning experiment (collect, train, reset) that estimates zero-cross
position. In Studio the training data is synthesised from the model, not
recorded from the board.

### Live Tune

Sliders for the parameters the control loop actually uses, grouped as live,
loop, protection and startup. Each slider says what raising or lowering it does.

Read the badge on each slider:

- **Live while spinning** — only the four AN1078 FOC overrides (angle advance
  base, angle advance speed gain, observer gain, field-weakening current). These
  take effect immediately with the motor running.
- **Idle only** — everything else. The firmware rejects the write unless the
  motor is idle. The 6-step loop reads these values live, but you must stop to
  change them.
- **Startup** values apply on the next start.

Only the sliders relevant to the connected build (6-step or FOC) are shown.

### Motor Wizard

Enter a motor's datasheet numbers (KV, phase-to-phase resistance, pole count,
weight, maximum current, bus voltage, optionally inductance) and the wizard
produces a complete, current-safe parameter profile as C code, with a note on
where each block goes in the firmware. **Copy** or **Download** the result
(`garuda_profile_<name>.c`). The wizard writes nothing to the board; you paste
the profile into the firmware and rebuild.

### Parameters

The full parameter table read from the board, grouped, with a filter box (plain
text or a regular expression, matching the display name or the firmware
variable name).

- Edit a value to write it to the board. Values outside the board's min/max are
  rejected.
- Edits live in RAM until you press **Save to EEPROM**. Unsaved edits are lost
  at power-off.
- **Restore Defaults** reloads the factory values into RAM (press Save to keep
  them).
- Startup amplitude and duty values show an estimated peak current beside them,
  compared with the over-current soft limit.
- Editing requires the motor to be idle.

### Help

A reference list of the firmware's features. When a board is connected, each
feature shows **Enabled** or **Disabled** from the capability flags the board
reports. The hardware summary at the bottom is fixed text describing the
reference board and is not read from the connected board.

---

## 6. Console commands

Type in the box at the bottom of the console dock and press Enter.

| Command | What it does |
|---|---|
| `help` or `?` | List the commands. |
| `clear` | Clear the console. |
| `pause` / `resume` | Stop or restart the telemetry mirror (the connection is unaffected). |
| `params` | Print every parameter and its value. |
| `get <name>` | Print one parameter. |
| `set <name> <int>` | Write one parameter. The name can be the firmware variable name or part of the display name. |
| `reload` | Re-read the parameter list from the board. |
| `save` | Write parameters to flash. Motor must be stopped. |
| `defaults` | Restore factory defaults into RAM (use `save` to keep them). |
| `export` | Download the current parameters as a C initialiser, `garuda_params.c`. |
| `rec` | Start recording telemetry; `rec` again stops and downloads `garuda_telemetry_<N>.csv`. |
| `mark <text>` | Print a marker line (useful while recording or watching). |
| `ata` | GarudaESE only: read the ATA6847 gate-driver status and fault registers. **The read clears the latched fault bits on the device.** |
| `raw` | Dump the raw current-sense values from the latest snapshot. |
| `diagnose` | Run the local diagnosis (same engine as the Scope tab card). |

Files are saved through the browser's normal download mechanism, into your
Downloads folder.

---

## 7. Troubleshooting

| Symptom | What to check |
|---|---|
| No **Connect** dialog, or an error about `navigator.serial` | Wrong browser (use Chrome or Edge on a desktop), or the page is not on HTTPS/localhost. |
| The port is listed but will not open | Another program holds it: MPLAB Data Visualizer, a terminal, the Python GUI or `garuda-broker`. Close it and retry. |
| The port is not listed | Try another USB cable (charge-only cables exist) and port. On Linux, your user needs permission for the serial device (commonly the `dialout` group). |
| Connected but no telemetry | Unplug and replug, reload the page, reconnect. If the board has two serial ports (a debugger port as well), pick the other one. |
| State pill red | A fault is latched. Read the fault name, fix the cause, press **Clear Fault**. |
| A parameter write is refused | The motor is not idle, the value is out of range, or it fails the firmware's cross-check against another parameter. The toast shows the firmware's reason. |
| `save` refused with a cooldown message | The firmware rate-limits flash writes. Wait and retry. |
| Bus voltage reads differently from the Python GUI | Known scaling difference; see below. |

---

## 8. What Studio does not do

Compared with the standalone Python GUI:

- **No session bundles.** Studio records a CSV on demand (`rec`); it does not
  auto-record every run with firmware identity and parameters attached.
- **No port sharing.** Studio owns the serial port while connected. The Python
  broker, which lets the GUI and other tools share one board, has no web
  equivalent.
- **No SPICE "deep-dive"** in ZC Lab, and the ML experiment trains on
  synthesised data rather than recorded captures.
- **No AI-assisted diagnosis** and no one-click debug report; only the local
  rule engine is ported.
- **No simulator connection.** The Python GUI can run against the software
  motor twin; Studio needs a real board.
- **Not yet ported** (in the Python GUI since late 2026): the rising/falling
  zero-cross capture readout, and the 0-based motor-profile names for firmware
  1.x. Against firmware 1.x, Studio may show the wrong profile name.

Known scaling difference: for firmware other than the Simplified build, Studio
converts the raw bus-voltage reading with a divider ratio of 19.8, while the
Python GUI uses 23.2 for the MCLV-48V-300W board and 13.0 for GarudaESE. If the
two tools disagree on bus voltage, trust a multimeter, then the Python GUI.

---

## 9. For developers

See [CLAUDE.md](CLAUDE.md) for the code layout, build and deploy steps, and the
rules for keeping Studio in step with the firmware and the Python GUI.
