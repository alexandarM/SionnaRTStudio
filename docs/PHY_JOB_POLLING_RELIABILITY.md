# NR PHY Reliability Improvements — PHY job polling timeout fix

## Symptom

The UI displayed `timed out after 15s` while a PUSCH BER/BLER sweep was
running. The PHY sweep is a backend background job; the message was produced
by the frontend status-poll request (`POLL_TIMEOUT_MS`), not by a 15-second
limit inside the PUSCH solver. The previous UI also used an async `setInterval`,
which could create overlapping status requests when one request was delayed.
A single transient polling error cleared the job ID even though the backend
worker could still be running.

## Changes

- Increased the PHY status-poll request timeout from 15 to 60 seconds.
- Replaced asynchronous `setInterval` polling with sequential `setTimeout`
  polling: only one status request can be in flight at a time.
- Added retry with bounded backoff for transient network/proxy/CPU delays. The
  UI retains the job ID and does not enable a second sweep while the original
  backend job may still be active.
- The status route is now `async` and snapshots its small in-memory job record
  under a lock, avoiding dependence on FastAPI's sync worker threadpool while
  the PHY worker is CPU-bound.
- Protected job progress/result updates with the same lock.
- Capped PyTorch intra-op CPU threads (up to four, approximately half of the
  available CPUs) and set inter-op threads to one when the runtime permits,
  leaving CPU scheduling headroom for the API.
- Split each Eb/N0 point into batches of at most 16 slots. BER/BLER counters are
  accumulated over all batches, preserving the total number of requested slots;
  progress now updates during a point, not only between Eb/N0 points.

## What the timeout means

A client-side timeout does not prove that the solver failed. In the previous
release the backend worker could continue after the UI stopped polling. Do not
repeatedly click `Run BER Sweep`; the backend intentionally allows only one
active sweep and may respond that a job is already running. Inspect the backend
log or restart the app before retrying if the old job is orphaned.

## Validation

- `python -m pytest -q backend/tests`: 175 passed.
- `python -m unittest discover -s backend/tests -p 'test_*.py' -q`: 150 passed.
- `python -m compileall -q backend`: passed.
- TypeScript/TSX transpile parse: 25 files, zero syntax diagnostics.
- Full TypeScript type-check and Vite production build were not run because
  frontend dependencies are not installed in this build environment.
- Live Colab PUSCH run after this fix remains to be verified.
