# RF Configuration & Reproducibility release notes

## Added

- Exact effective RF/PathSolver configuration snapshot in every measured-location ray-trace response.
- SHA-256 configuration fingerprint based on frequency, TX/RX geometry and antenna settings, solver switches/depth/samples/seed, scene geometry/materials, measurement profile and sampled locations.
- Fingerprint repeated on exported ray-trace CSV rows.
- Visible audit of TX power reference, antenna-model metadata, gain/downtilt metadata and resolved TX height-reference rule.
- Per-run controls for PathSolver max depth, path samples/source and seed.
- Sampled-location RX array dimensions now inherit the active RX device from the main GUI instead of being forced to 1x1.
- Colab convergence acceptance procedure for depth, sample-count and repeatability comparisons.

## Important caveats

- The RF snapshot records what the application passes to Sionna RT; it does not certify that the physical RF profile is correct.
- TX power reference, panel antenna model/gain, mechanical/electrical downtilt and height-reference metadata may remain incomplete.
- NR-ARFCN continues to override the general GUI carrier frequency when available.
- Sionna total received power is not modem SS-RSRP. No radiometric residual, RMSE or MAE is calculated.
- Full Vite build and live Colab PathSolver acceptance must be run in the user's Colab runtime.


## 3D Measurement Overlay — field measurement overlay in 3D

- Added a Field Validation action that creates one marker per unique GPS location for the exact selected radio-identity profile.
- Markers are rendered in the Three.js scene using the Studio WGS84 local-tangent ENU transform (East → +X, North → −Z).
- Marker colours encode location-level median measured RSRP (weak red → strong green); duplicate fixes are grouped and retain their sample count.
- The route is automatically framed when first shown; manual Center route and Hide/Show controls are available.
- Hovering a marker displays its median RSRP, median SINR, sample count, PCI and WGS84 coordinates.
- Overlay state is lifted to App state and persists while switching between Field Validation and 3D Scene. It is cleared when a different dataset is loaded.
- This layer is display-only and does not modify scene geometry, TX/RX, ray paths, radio maps or solver inputs.
- Marker Y is a fixed 1.6 m display offset, not GPS altitude, terrain snap or validated AGL. Exact point-in-mesh/road-surface validation remains future work.
