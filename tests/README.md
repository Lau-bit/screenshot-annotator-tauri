# Tests

Two suites, plus tools for driving the real app.

## `npm test` — frontend regression suite

```
npm test          # node --test tests/regression.test.mjs
```

Serves the real `src/` over loopback with a mock Tauri bridge injected ahead of
`api.js`, then drives it in headless Edge over CDP. It exercises the shipped
`app.js` rather than an extracted copy, because the bugs it covers live in the
interaction between `app.js` and the DOM.

Every case names a real defect that it failed on before the fix:

| area | what regressed |
|---|---|
| export guards | an over-budget canvas exported `data:,` — a 0-byte `.png` written to disk and reported as "Saved" |
| import guards | an over-budget import threw inside `img.onload`, so the promise never settled and Open Images hung |
| undo history | rotation/brightness sat outside the undo stack, so Ctrl+Z after a rotate silently deleted a drawing |
| split view | leaving split with the right pane focused, then re-entering, bound both panes to one version |
| zoom and view | every window resize called `fitToArea`, discarding a deliberate zoom |
| keyboard | Ctrl+Shift+Z did nothing (only Ctrl+Y redid) |
| cancellation, save/reopen | round-trip fidelity, and that a cancelled dialog writes nothing |

The bridge is served as a same-origin file (`/__mock.js`), not inlined: the page
ships a CSP with `script-src 'self'` that silently drops inline scripts.

## `npm run test:rust` — window geometry + data-URL guards

```
npm run test:rust     # cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Pure-function tests for window save/restore, using this machine's real monitor
layout as the fixture — a 100% display at **negative** desktop x beside two 125%
displays, which is exactly the case that breaks naive handling:

- position must round-trip across a DPI boundary
- size must follow the *target* monitor's scale
- negative coordinates must never be clamped to zero (a `max(0, …)` off-screen
  guard makes a left-of-primary monitor unusable)
- a window saved on a since-disconnected monitor must be pulled back into view
- legacy all-logical records must migrate, not teleport

Plus the Rust-side data-URL guards, so an empty or non-image payload can never
reach `fs::write` as a 0-byte file.

## Driving the real app

`e2e-live.mjs` runs the whole capture-to-export workflow against a **running**
app with real screenshots and the real Rust commands — nothing mocked, including
the Windows clipboard round-trip.

```
td run screenshot-annotator-tauri --json          # note the cdpPort it prints
node tests/e2e-live.mjs <cdpPort> "<screenshotDir>" "<outDir>"
```

Helpers:

- `cdp-eval.mjs <port> "<js>"` — evaluate one expression in the live app
- `window-rect.ps1 -ProcessId <pid>` — a window's **true** physical rect. It opts
  into per-monitor-v2 DPI awareness first; without that Windows feeds a
  DPI-unaware process virtualized coordinates and even reports 96 DPI for a 125%
  display, which silently invalidates any placement measurement.
- `move-window.ps1 -ProcessId <pid> -X <x> -Y <y>` — place a window exactly, via
  `SetWindowPos`. The pointer is never moved or synthesized.
