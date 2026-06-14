# Garuda Studio

Browser-based configurator and live telemetry for the Garuda 6-step BLDC ESC
(dsPIC33AK128MC106 / AK512MC510). Runs entirely in the browser over the
**Web Serial API** — no install, no driver, no Python broker. Hosted as a static
site on GitHub Pages, so anyone on Windows/macOS/Linux can use it from a link.

## Use it

Open the deployed page in **Chrome or Edge** (Web Serial is Chromium-only;
Firefox/Safari are not supported), plug in the ESC over USB, and click
**Connect** → pick the serial port. The page speaks the GSP binary protocol
directly.

> Web Serial requires a secure context. GitHub Pages is HTTPS, so it works from
> the hosted URL. For local dev, `http://localhost` also counts as secure.

## Features (v1)

- **Dashboard** — state/fault/uptime, eRPM, Vbus, duty, and *trustworthy* bus
  current (firmware IIR average + signed PWM-window peak, not the phantom valley
  sample), ZC sync/count/miss.
- **Scope** — live time chart + the on-MCU burst scope.
- **Parameters** — read/edit/save the full GSP parameter set live.
- **Throttle / control** — arm, throttle, profile select.

AKESC 6-step only (the CK/ATA6847 board path was removed for this build).

## Develop

```bash
npm install
npm run dev      # local dev server (localhost = secure context, Web Serial OK)
npm run build    # production build into dist/
npm run preview  # serve the built dist/ locally
```

## Deploy to GitHub Pages

1. Create a repo named **`garuda-studio`** and push this folder to `main`.
   (The Vite `base` in `vite.config.ts` is `/garuda-studio/` to match the repo
   name. If you use a different repo name, change `base` accordingly.)
2. Repo **Settings → Pages → Build and deployment → Source = GitHub Actions**.
3. The included workflow (`.github/workflows/pages.yml`) builds and publishes on
   every push to `main`. The site appears at
   `https://<your-user>.github.io/garuda-studio/`.

## Protocol

The TypeScript GSP decoder (`src/protocol/`) mirrors the Python reference in
`tools/garuda_debug/garuda_gsp/`. The snapshot decode tracks GSP v3, including
the 248-byte snapshot with `ibusAvg`. Keep the two in sync when the firmware
snapshot layout changes.
