# NR PHY Simulation — Sweep Resolution & Absolute Link Budget

**Scope:** FR1 NR PUSCH with configurable sweep resolution and an opt-in
absolute RT channel / link-budget mode.
**Related modules:** Radio Coverage Analytics, Channel Analysis, and Spatial Association & Geolocation, including the persistent 3D radio-map view and normalized PUSCH workflow.

## Added

- Configurable sweep step: 0.5, 1.0 or 2.0 dB.
- Decimal-safe backend sweep-point generation, exact endpoint checks and a
  maximum of 41 points.
- New `channelMode` selector: `normalized` (default) or `absolute`.
- Absolute mode uses the unnormalized ray-traced CFR (`normalize=False`).
- Separate UE conducted Tx-power input (default assumption 23 dBm); it does
  not reuse the BS `tx.powerDbm` field for the reciprocal uplink.
- BS receiver noise figure input (default assumption 7 dB) and 293 K thermal
  noise over the active PUSCH occupied bandwidth.
- Absolute-mode outputs: mean channel gain, mean combined Rx signal power,
  noise power per BS receive branch, mean link-budget reference SNR, approximate
  MCS-equivalent link-budget Eb/N0, UE power and BS noise figure.
- Link-offset sweep around the physical reference point: 0 dB is the modeled
  thermal-noise operating point; positive/negative values reduce/increase the
  AWGN variance accordingly.
- UI diagnostics and mode-specific labels; editable fine sweep step and larger
  slots-per-point choices (up to 512).
- Tests for sweep generation, request validation and absolute link-budget math.

## Preserved

- Radio Coverage Analytics radio-map and advanced interference analytics.
- Channel Analysis batched PathSolver channel analysis, CIR/CFR, path metrics and UI.
- Spatial Association & Geolocation association/geolocation, exports and stable sector-colour logic.
- Persistent 3D radio-map layer when switching between Studio modes.
- Existing `/api/linkkpi` and `/api/phyber` API routes.
- Existing normalized PUSCH mode as the default and previous baseline method.

## Absolute-mode assumptions and cautions

- PUSCH is uplink (UE → BS); UE conducted power is a separate input from the
  BS transmitter's configured `powerDbm`. Default 23 dBm is an assumption, not
  a measured modem value or a universal UE limit. Default BS NF 7 dB is also an
  assumption and should be replaced by device-specific information if known.
- UE total power is assumed to be uniformly spread across active PUSCH
  bandwidth; active occupied bandwidth is `12 × PRB × SCS`.
- Noise uses 293 K and the chosen BS noise figure. `noisePowerDbm` is per BS
  receive branch; returned receive signal power is summed over BS branches.
- The baseline Eb/N0 display is an approximate MCS-equivalent conversion from
  effective SNR using modulation order and target code rate. It does not apply
  a separate exact resource-grid overhead correction.
- Absolute mode is not a calibrated receiver sensitivity or conformance test.
  It does not include uplink power control, inter-cell interference, RF chain
  losses/implementation loss, scheduler, HARQ or upper-layer overhead.
- The channel remains a reciprocal single-link PUSCH uplink derived from the
  BS-to-UE RT solve. The frequency-domain channel does not model ISI/ICI when
  excess delay exceeds CP; the CP display remains an approximate warning.
- Normalized mode still excludes absolute RT path loss; do not compare its
  direct Eb/N0 axis to the absolute mode as if they used the same power model.

## Validation in this build environment

- `python -m pytest -q backend/tests`: **171 passed**.
- `python -m unittest discover -s backend/tests -p 'test_*.py' -q`: **146 passed**.
- `python -m compileall -q backend`: passed.
- TypeScript/TSX transpile parse: **25 source files, no syntax diagnostics**.
- `bash -n run.sh setup.sh scripts/runtime-env.sh`: passed.
- Sweep point generation, FR1 resource-grid validation, request validation,
  reciprocal CIR adapter and pure absolute link-budget equations: passed.

## Not verified in this build environment

- Live Sionna RT PathSolver plus absolute-mode `cir_to_ofdm_channel` in the
  user's Colab runtime.
- Live PUSCH transmitter/receiver execution in absolute mode.
- Full TypeScript type-check and Vite production build (the archive has no
  `node_modules`; `npm run build` stops with `vite: not found`).
- Browser-level visual validation.

Use `NR_ABSOLUTE_LINK_BUDGET_GUIDE.md` for the detailed model
assumptions and `ABSOLUTE_LINK_BUDGET_COLAB_TEST.md` for the new runtime checks.


# NR PHY Reliability Improvements — PHY job polling timeout reliability fix

The `timed out after 15s` message was traced to the frontend status poll
request, not to a fixed 15-second PUSCH runtime limit. This update raises
the status read timeout to 60 seconds, prevents overlapping poll calls,
retries transient polling failures with bounded backoff, and keeps the UI
attached to the running job. The backend status route now runs asynchronously
and reads job snapshots under a lock. The PUSCH worker limits PyTorch CPU
threads and processes each Eb/N0 point in batches of at most 16 slots so that
progress is visible during larger sweeps and the API retains CPU headroom.

Validation recorded for this update: 175 pytest tests and 150 unittest tests pass;
Python compilation and TypeScript/TSX transpile parsing pass (25 files). Full
Vite build and live Colab execution are not confirmed in this environment.
See `docs/PHY_JOB_POLLING_RELIABILITY.md`.

## Channel Matrix persistence regression fix (2026-11-01)

- Fixed the all-pairs `Tx × Rx Link Matrix` disappearing when a user selected any solved matrix cell.
- Result invalidation is now driven by the physical solve context rather than the active TX/RX selection.
- Selection-only changes no longer clear cached matrix results, the radio map, or mobility results.
- Active pair selection still focuses its cached paths/metrics and 3D rays.
- Real changes to scene geometry, devices, materials, carrier frequency, or solver settings continue to invalidate stale results.
- Added `npm run check:link-matrix-persistence` and `docs/CHANNEL_MATRIX_PERSISTENCE_FIX.md`.
