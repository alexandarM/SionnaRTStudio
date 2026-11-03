"""Pydantic models mirroring the frontend's src/types.ts.

Field names are camelCase on purpose so the JSON the React app already produces
and consumes maps 1:1 with no alias gymnastics.
"""
# Modified in the alexandarM/SionnaRTStudio fork of puloktarafder/SionnaRTStudio.
# Upstream: https://github.com/puloktarafder/SionnaRTStudio

from __future__ import annotations

from typing import Any, List, Literal, Optional, Tuple

from pydantic import BaseModel, Field, model_validator


class ENUVector(BaseModel):
    x: float  # East (m)
    y: float  # North (m)
    z: float  # Up (m)


class BuildingFootprint(BaseModel):
    id: str
    name: Optional[str] = None
    enuPoints: List[ENUVector]
    height: float
    category: Literal["building", "infrastructure", "terrain", "water"]
    material: str = "itu_concrete"
    type: str = ""
    levels: Optional[float] = None
    # `points` (lat/lon) is sent by the frontend but unused by the solver.
    points: Optional[list] = None


class Transmitter(BaseModel):
    id: str = "tx"
    name: str = "Tx"
    enu: ENUVector
    height: float = 10.0
    # None preserves the legacy behaviour (height above a detected roof).
    heightReference: Optional[Literal["agl", "roof", "scene_z"]] = None
    powerDbm: float = 30.0
    antennaArraySize: Tuple[int, int] = (8, 8)  # [horizontal, vertical]
    beamsteeringAzimuth: float = 0.0
    beamsteeringElevation: float = 0.0
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    # Imported inventory metadata; not silently converted into an antenna model.
    site: Optional[str] = None
    transmitterLabel: Optional[str] = None
    antennaModel: Optional[str] = None
    frequencyBand: Optional[str] = None
    carrierFrequencyGhz: Optional[float] = None
    sourcePowerDbm: Optional[float] = None
    powerReference: Optional[Literal["conducted", "eirp"]] = None
    antennaGainDbi: Optional[float] = None
    mechanicalDowntiltDeg: Optional[float] = None
    electricalDowntiltDeg: Optional[float] = None


class Receiver(BaseModel):
    id: str = "rx"
    name: str = "Rx"
    enu: ENUVector
    height: float = 1.5
    antennaArraySize: Tuple[int, int] = (1, 1)
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class PropagationPath(BaseModel):
    id: str
    points: List[ENUVector]
    type: Literal["LOS", "Reflection", "Diffraction", "NLOS"]
    order: int
    distance: float
    pathLossDb: float
    receivedPowerDbm: float
    delayNs: float
    phasesRad: List[float] = Field(default_factory=list)
    materialsReached: List[str] = Field(default_factory=list)
    # Exact per-bounce interaction types (specular/diffuse/refraction/diffraction),
    # straight from paths.interactions — more precise than the coarse `type`.
    interactionKinds: List[str] = Field(default_factory=list)
    # Angles of departure (Tx) and arrival (Rx), degrees. Azimuth is measured
    # clockwise from North (0=N, 90=E); elevation is above the horizon.
    aodAzimuthDeg: Optional[float] = None
    aodElevationDeg: Optional[float] = None
    aoaAzimuthDeg: Optional[float] = None
    aoaElevationDeg: Optional[float] = None
    # Which transmitter this ray departs from (set when several Tx are solved at
    # once, e.g. multi-Tx mobility). None for single-Tx solves.
    txId: Optional[str] = None


class ChannelMetrics(BaseModel):
    totalRxPowerDbm: float
    losStatus: Literal["LOS", "NLOS"]
    numPaths: int
    rmsDelaySpreadNs: float
    # False only when a scalar delay spread is not physically defined (currently
    # non-coherent multi-transmitter power aggregation in mobility mode).
    rmsDelaySpreadValid: bool = True
    strongestPathPowerDbm: float
    strongestPathType: str


class RadioMapCell(BaseModel):
    x: float
    y: float
    z: float
    # Best-RSS serving cell outputs. powerDbm is always the native Sionna RSS
    # converted from W to dBm; metricValue is the currently selected map layer.
    powerDbm: float
    isLos: Optional[bool] = None
    sinr: Optional[float] = None
    servingTx: Optional[int] = None
    bestSinrTx: Optional[int] = None
    bestSinrDb: Optional[float] = None  # highest per-Tx SINR; may differ from RSS serving TX
    bestPathGainTx: Optional[int] = None
    pathGainDb: Optional[float] = None  # strongest path gain, independent of TX power
    effectivePathLossDb: Optional[float] = None
    competingSectorCount: Optional[int] = None
    interferencePowerDbm: Optional[float] = None
    sirDb: Optional[float] = None
    inrDb: Optional[float] = None
    dominanceMarginDb: Optional[float] = None
    topInterfererTx: Optional[int] = None
    topInterfererPowerDbm: Optional[float] = None
    topInterferenceSharePercent: Optional[float] = None
    metricValue: Optional[float] = None


class CoverageStats(BaseModel):
    """Coverage statistics computed against the entire measurement surface."""
    metric: str
    unit: str
    thresholdDb: float
    thresholdComparison: Literal["at_or_above", "at_or_below"] = "at_or_above"
    servedPercent: float
    outagePercent: float = 0.0
    reachablePercent: float = 0.0
    servedAreaKm2: float = 0.0
    totalAreaKm2: float = 0.0
    cellAreaM2: float = 0.0
    count: int = 0
    reachableCount: int = 0
    mean: Optional[float] = None
    std: Optional[float] = None
    p5: Optional[float] = None
    p10: Optional[float] = None
    p25: Optional[float] = None
    p50: Optional[float] = None
    p75: Optional[float] = None
    p90: Optional[float] = None
    p95: Optional[float] = None
    minVal: Optional[float] = None
    maxVal: Optional[float] = None
    cdf: List[dict] = Field(default_factory=list)
    histogram: List[dict] = Field(default_factory=list)
    meanRssDbm: Optional[float] = None
    meanPathGainDb: Optional[float] = None
    meanSinrDb: Optional[float] = None
    meanBestSinrDb: Optional[float] = None
    meanInterferenceDbm: Optional[float] = None
    noisePowerDbm: Optional[float] = None
    overlapRssThresholdDbm: float = -100.0
    overlapPercent: float = 0.0
    meanCompetingSectors: float = 0.0


class TransmitterRadioStats(BaseModel):
    txIndex: int
    txId: str
    txName: str
    site: Optional[str] = None
    frequencyBand: Optional[str] = None
    powerDbm: Optional[float] = None
    meanRssDbm: Optional[float] = None
    rssP5Dbm: Optional[float] = None
    rssP50Dbm: Optional[float] = None
    rssP95Dbm: Optional[float] = None
    meanSinrDb: Optional[float] = None
    sinrP5Db: Optional[float] = None
    sinrP50Db: Optional[float] = None
    sinrP95Db: Optional[float] = None
    meanPathGainDb: Optional[float] = None
    servingCellCount: int = 0
    servingPercent: float = 0.0
    rssCoverageThresholdDbm: float = -100.0
    rssCoveragePercent: float = 0.0
    rssCoverageAreaKm2: float = 0.0
    sinrCoverageThresholdDb: float = 0.0
    sinrCoveragePercent: float = 0.0
    sinrCoverageAreaKm2: float = 0.0



    rssStdDb: Optional[float] = None
    rssMinDbm: Optional[float] = None
    rssMaxDbm: Optional[float] = None
    rssP10Dbm: Optional[float] = None
    rssP25Dbm: Optional[float] = None
    rssP75Dbm: Optional[float] = None
    rssP90Dbm: Optional[float] = None
    sinrStdDb: Optional[float] = None
    sinrMinDb: Optional[float] = None
    sinrMaxDb: Optional[float] = None
    sinrP10Db: Optional[float] = None
    sinrP25Db: Optional[float] = None
    sinrP75Db: Optional[float] = None
    sinrP90Db: Optional[float] = None
    pathGainP5Db: Optional[float] = None
    pathGainP50Db: Optional[float] = None
    pathGainP95Db: Optional[float] = None
    meanSnrDb: Optional[float] = None
    meanInterferenceDbm: Optional[float] = None
    meanSirDb: Optional[float] = None
    meanInrDb: Optional[float] = None
    sinrAssociationCellCount: int = 0
    sinrAssociationPercent: float = 0.0
    pathGainAssociationCellCount: int = 0
    pathGainAssociationPercent: float = 0.0
    rssReachablePercent: float = 0.0
    topInterfererCells: int = 0
    topInterfererCellPercent: float = 0.0
    meanTopInterferenceDbm: Optional[float] = None
    meanTopInterferenceSharePercent: float = 0.0
    leaveOneOut: Optional[dict] = None


class SiteRadioStats(BaseModel):
    site: str
    sectorCount: int
    meanRssDbm: Optional[float] = None
    meanSinrDb: Optional[float] = None
    meanPathGainDb: Optional[float] = None
    rssP5Dbm: Optional[float] = None
    rssP50Dbm: Optional[float] = None
    rssP95Dbm: Optional[float] = None
    servingCellCount: int = 0
    servingPercent: float = 0.0
    rssCoveragePercent: float = 0.0
    rssCoverageAreaKm2: float = 0.0
    sinrCoveragePercent: float = 0.0
    sinrCoverageAreaKm2: float = 0.0


class RadioMapGrid(BaseModel):
    cells: List[RadioMapCell]
    minX: float
    maxX: float
    minY: float
    maxY: float
    gridSize: float
    heightOffset: float
    metric: str = "power"
    unit: str = "dBm"
    stats: Optional[CoverageStats] = None
    txStats: List[TransmitterRadioStats] = Field(default_factory=list)
    siteStats: List[SiteRadioStats] = Field(default_factory=list)
    associationStats: Optional[dict] = None
    mapId: Optional[str] = None
    noisePowerDbm: Optional[float] = None
    simulationConfig: Optional[dict] = None
    samplesPerTx: int = 1_000_000
    seed: int = 42


# ── Request / response envelopes ────────────────────────────────────────────

class SolverOptions(BaseModel):
    """Per-interaction-type ray tracing switches + Tx/Rx antenna config.

    Mirrors the feature checkboxes / antenna array panel of NVIDIA's
    sionna-rt-gui. Interaction switches and Tx configuration apply to both
    solvers; Rx configuration applies to PathSolver because RadioMapSolver uses
    its documented ideal map-receiver model.
    """
    los: bool = True
    specularReflection: bool = True
    diffuseReflection: bool = False
    refraction: bool = False
    diffraction: bool = False
    edgeDiffraction: bool = False
    txPattern: Literal["iso", "dipole", "hw_dipole", "tr38901"] = "tr38901"
    txPolarization: Literal["V", "H", "VH", "cross"] = "V"
    rxPattern: Literal["iso", "dipole", "hw_dipole", "tr38901"] = "iso"
    rxPolarization: Literal["V", "H", "VH", "cross"] = "V"
    # PathSolver shooting-and-bouncing controls. These are distinct from the
    # RadioMapSolver's samplesPerTx/seed because the algorithms differ.
    pathSamplesPerSource: int = Field(default=1_000_000, ge=10_000, le=10_000_000)
    pathSeed: int = Field(default=42, ge=0, le=2_147_483_647)


class MaterialConfig(BaseModel):
    """Per-material electromagnetic + scattering overrides applied to the scene.

    `id` matches the frontend material id (e.g. ``itu_concrete``). Scattering
    fields map to Sionna's RadioMaterial. When permittivity/conductivity are set,
    a custom RadioMaterial replaces the ITU preset for that id.
    """
    id: str
    scatteringCoefficient: float = 0.0  # S in [0, 1]
    xpdCoefficient: float = 0.0         # cross-pol discrimination in [0, 1]
    scatteringPattern: Literal["none", "lambertian", "directive", "backscattering"] = "none"
    relativePermittivity: Optional[float] = None
    conductivity: Optional[float] = None  # S/m
    thickness: Optional[float] = None     # m




class OSMQueryRequest(BaseModel):
    """A bounded OSM tile request forwarded by the backend to Overpass."""
    south: float = Field(ge=-90, le=90)
    west: float = Field(ge=-180, le=180)
    north: float = Field(ge=-90, le=90)
    east: float = Field(ge=-180, le=180)


class SolveRequest(BaseModel):
    tx: Transmitter
    rx: Receiver
    buildings: List[BuildingFootprint]
    freqGhz: float = 28.0
    maxDepth: int = 3  # max ray-tracing interaction depth (reflections/diffractions)
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)


class SolveResponse(BaseModel):
    paths: List[PropagationPath]
    metrics: ChannelMetrics


class RadioMapRequest(BaseModel):
    tx: Optional[Transmitter] = None          # single transmitter (legacy)
    txs: Optional[List[Transmitter]] = None   # multiple transmitters (best-server)
    buildings: List[BuildingFootprint]
    freqGhz: float = 28.0
    gridSize: float = 5.0
    gridHeight: float = 1.5
    maxDepth: int = 3
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)
    # Which Sionna metric to map: best-server received power, or interference-aware SINR.
    metric: Literal["power", "path_gain", "path_loss", "sinr", "best_sinr", "interference", "sir", "inr", "dominance"] = "power"
    bandwidthHz: float = 100e6   # sets scene.bandwidth → thermal noise for SINR
    noiseFigureDb: float = 7.0   # receiver noise figure added to thermal noise
    coverageThresholdDb: Optional[float] = None  # selected metric threshold
    rssCoverageThresholdDb: float = -100.0
    sinrCoverageThresholdDb: float = 0.0
    # Research/reproducibility controls passed directly to RadioMapSolver.
    samplesPerTx: int = Field(default=1_000_000, ge=1_000, le=10_000_000)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)

    def transmitters(self) -> List[Transmitter]:
        """All transmitters to map, accepting either `txs` or legacy `tx`."""
        if self.txs:
            return self.txs
        if self.tx is not None:
            return [self.tx]
        raise ValueError("RadioMapRequest needs `txs` or `tx`")


# ── Mobility (Rx trajectory) ────────────────────────────────────────────────

class TxLinkMetrics(BaseModel):
    """One transmitter's link to the receiver at a single mobility waypoint.

    Lets the UI show every Tx the moving Rx sees (and association changes),
    not just the serving one. ``receivedPowerDbm`` is this Tx's total over its
    own multipath; the strongest of these per waypoint is the serving Tx.
    """
    txId: str
    txName: str
    receivedPowerDbm: float
    rmsDelaySpreadNs: float
    numPaths: int
    maxDopplerHz: float
    losStatus: Literal["LOS", "NLOS"]


class MobilityStep(BaseModel):
    index: int
    rxPosition: ENUVector
    # Scalar KPIs describe the SERVING (best-server) transmitter at this waypoint,
    # so the existing per-step metrics stay meaningful with one or many Tx.
    receivedPowerDbm: float
    rmsDelaySpreadNs: float
    rmsDelaySpreadValid: bool = True
    numPaths: int
    maxDopplerHz: float
    losStatus: Literal["LOS", "NLOS"]
    # Rays from EVERY transmitter to this waypoint (each tagged with its txId),
    # sorted strongest-first — so the 3D scene shows all Tx, not only the server.
    paths: List[PropagationPath]
    # Best-server transmitter and the per-Tx breakdown behind the scalar KPIs.
    servingTxId: Optional[str] = None
    servingTxName: Optional[str] = None
    perTx: List[TxLinkMetrics] = Field(default_factory=list)


class HandoverConfig(BaseModel):
    """A3-event association parameters applied to the mobility RSS series.

    ``hysteresisDb`` and ``timeToTriggerMs`` mirror the 3GPP A3 event: a
    neighbor must exceed the serving cell by the hysteresis continuously for
    the time-to-trigger before a handover fires. TTT is honored in seconds via
    the waypoint spacing and receiver speed.
    """
    hysteresisDb: float = Field(default=3.0, ge=0.0, le=15.0)
    timeToTriggerMs: float = Field(default=160.0, ge=0.0, le=5120.0)
    # A handover back to the cell just left within this window is a ping-pong.
    pingPongWindowS: float = Field(default=1.0, ge=0.0, le=10.0)


class HandoverEvent(BaseModel):
    stepIndex: int
    timeS: float          # trajectory time of the handover
    fromTxId: str
    fromTxName: str
    toTxId: str
    toTxName: str
    pingPong: bool = False


class HandoverAnalysis(BaseModel):
    """A3 (hysteresis + TTT) association over the mobility per-Tx RSS series.

    ``instantaneousChangeCount`` is the hysteresis-free baseline — how often the
    per-step ``servingTxId`` (instantaneous argmax) flips — so the suppression
    of ping-pong by the A3 parameters is directly visible.
    """
    hysteresisDb: float
    timeToTriggerMs: float
    pingPongWindowS: float
    servingTxIds: List[Optional[str]]  # A3 serving cell per step (None = unreachable)
    events: List[HandoverEvent] = Field(default_factory=list)
    handoverCount: int
    pingPongCount: int
    instantaneousChangeCount: int


class MobilityRequest(BaseModel):
    # `txs` ray-traces every transmitter to each waypoint (best-server mobility);
    # `tx` is the legacy single-transmitter form. At least one is required.
    tx: Optional[Transmitter] = None
    txs: Optional[List[Transmitter]] = None
    rx: Receiver
    buildings: List[BuildingFootprint]
    waypoints: List[ENUVector]
    freqGhz: float = 28.0
    speedKmh: float = 30.0
    maxDepth: int = 3
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)
    # How to collapse multiple transmitters into each waypoint's scalar KPIs:
    #   "best_server" — report the single strongest Tx (instantaneous association)
    #   "sum"         — report non-coherent incident power over ALL Tx
    # Either way the scene still renders the union of every transmitter's rays.
    combineMode: Literal["best_server", "sum"] = "best_server"
    # Research/validation control. The UI uses "auto"; experiments can require
    # the batched result or run an identical-payload serial reference.
    executionMode: Literal["auto", "batched", "serial_reference"] = "auto"
    # A3 handover parameters; the analysis runs whenever ≥ 2 Tx are solved.
    handover: HandoverConfig = Field(default_factory=HandoverConfig)

    def transmitters(self) -> List[Transmitter]:
        """All transmitters to ray-trace, accepting either `txs` or legacy `tx`."""
        if self.txs:
            return self.txs
        if self.tx is not None:
            return [self.tx]
        raise ValueError("MobilityRequest needs `txs` or `tx`")


class MobilityExecution(BaseModel):
    """Auditable execution metadata for one mobility API call.

    ``strategy`` makes a defensive serial fallback visible instead of silently
    presenting it as the one-dispatch fast path used in performance claims.
    ``solveTimeMs`` is measured while holding the solver lock, so it excludes
    HTTP transfer and time waiting for another request to finish.
    """
    strategy: Literal[
        "single_batched_dispatch", "serial_pair_fallback", "serial_reference"
    ]
    batchedResultUsed: bool
    transmitterCount: int
    waypointCount: int
    pairCount: int
    successfulPathSolverDispatches: int
    samplesPerSource: int
    seed: int
    solveTimeMs: float = 0.0


class MobilityResponse(BaseModel):
    steps: List[MobilityStep]
    execution: MobilityExecution
    # A3 hysteresis/TTT association — present when ≥ 2 transmitters were solved.
    handover: Optional[HandoverAnalysis] = None


# ── Channel impulse / frequency response export ─────────────────────────────

class CIRRequest(BaseModel):
    """Export the raw channel impulse response (CIR) and channel frequency
    response (CFR) for one or more devices — the same arrays you get in Python
    via ``a, tau = paths.cir(...)`` and ``h = paths.cfr(frequencies=...)``.

    ``tx``/``rx`` are the legacy single-link form. ``txs``/``rxs`` place all
    devices into one Sionna scene so the returned tensors retain their native
    receiver and transmitter axes.
    """
    tx: Optional[Transmitter] = None
    rx: Optional[Receiver] = None
    txs: Optional[List[Transmitter]] = None
    rxs: Optional[List[Receiver]] = None
    buildings: List[BuildingFootprint]
    freqGhz: float = 28.0
    maxDepth: int = 3
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)
    # OFDM grid the CFR is sampled on (mirrors sionna.rt.subcarrier_frequencies).
    numSubcarriers: int = 1024
    subcarrierSpacing: float = 30_000.0  # Hz (5G NR numerology µ=1 → 30 kHz)
    normalizeDelays: bool = True
    format: Literal["npz", "cir_npz", "cir_csv", "cfr_csv"] = "npz"

    def transmitters(self) -> List[Transmitter]:
        """All transmitters, accepting either the scene-tensor or legacy form."""
        if self.txs:
            return self.txs
        if self.tx is not None:
            return [self.tx]
        raise ValueError("CIRRequest needs `txs` or `tx`")

    def receivers(self) -> List[Receiver]:
        """All receivers, accepting either the scene-tensor or legacy form."""
        if self.rxs:
            return self.rxs
        if self.rx is not None:
            return [self.rx]
        raise ValueError("CIRRequest needs `rxs` or `rx`")

    def validate_format_scope(self) -> None:
        """Reject lossy/ambiguous CSV flattening of multi-device tensors."""
        if self.format in ("cir_csv", "cfr_csv") and (
            len(self.transmitters()) > 1 or len(self.receivers()) > 1
        ):
            raise ValueError(
                "CSV export supports one Tx→Rx link; "
                "use .npz for the multi-device tensor"
            )


# ── Standalone Mitsuba/Sionna scene export ──────────────────────────────────

class SceneExportRequest(BaseModel):
    """Export the ray-tracing scene as a standalone Sionna RT project.

    Produces the Mitsuba scene the backend traces (``scene.xml`` + ``meshes/``)
    plus a generated ``load_scene.py`` that replays everything Sionna keeps in
    Python rather than in the XML: carrier frequency, radio-material overrides,
    exact Tx/Rx ``PlanarArray`` configurations, the devices themselves, and the
    ``PathSolver`` switches. Mixed arrays are replayed as compatible groups.
    Running that script in a notebook reproduces the app's solves without the app.

    Devices are optional — with none, the export is geometry only.
    """
    tx: Optional[Transmitter] = None
    rx: Optional[Receiver] = None
    txs: Optional[List[Transmitter]] = None
    rxs: Optional[List[Receiver]] = None
    buildings: List[BuildingFootprint]
    freqGhz: float = 28.0
    maxDepth: int = 3
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)
    # OFDM grid the generated script samples the CFR on.
    numSubcarriers: int = 1024
    subcarrierSpacing: float = 30_000.0  # Hz
    normalizeDelays: bool = True

    def transmitters(self) -> List[Transmitter]:
        """All transmitters; empty is allowed (geometry-only export)."""
        if self.txs:
            return list(self.txs)
        return [self.tx] if self.tx is not None else []

    def receivers(self) -> List[Receiver]:
        """All receivers; empty is allowed (geometry-only export)."""
        if self.rxs:
            return list(self.rxs)
        return [self.rx] if self.rx is not None else []


# ── Link-level channel KPIs (Tier 1 — no PHY package) ──────────────────────

class LinkKpiRequest(BaseModel):
    """Compute Shannon-capacity KPIs for one Tx→Rx link from its ray-traced CFR.

    Same solve as the CIR/CFR export, but instead of returning raw arrays the
    backend reduces them to capacity / spectral-efficiency / spatial-structure
    KPIs (backend/linklevel.py). Noise is thermal over the OFDM band
    (numSubcarriers × subcarrierSpacing) plus the receiver noise figure —
    the same convention as the radio map's SINR floor.
    """
    tx: Transmitter
    rx: Receiver
    buildings: List[BuildingFootprint]
    freqGhz: float = 28.0
    maxDepth: int = 3
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)
    numSubcarriers: int = 1024
    subcarrierSpacing: float = 30_000.0  # Hz
    normalizeDelays: bool = True
    noiseFigureDb: float = 7.0
    # Evaluate the capacity KPIs at this receive SNR instead of the link budget's
    # (uniform-precoding reference). The capacity-vs-SNR curve is returned anyway.
    snrOverrideDb: Optional[float] = None


class LinkKpiCurve(BaseModel):
    """Mean capacity [bit/s/Hz] vs receive SNR [dB] (uniform-precoding reference)."""
    snrDb: List[float]
    openLoop: List[float]
    beamformed: List[float]


class LinkKpiSpectrum(BaseModel):
    """Per-subcarrier series (decimated for display): beamformed channel gain
    [dB] and open-loop capacity [bit/s/Hz] at the operating SNR."""
    frequencyHz: List[float]  # baseband subcarrier offsets
    gainDb: List[float]
    capacity: List[float]


class LinkKpiResponse(BaseModel):
    reachable: bool          # False when no ray-traced path reaches the Rx
    numTxAnt: int
    numRxAnt: int
    numSubcarriers: int
    bandwidthHz: float
    noisePowerDbm: float
    snrSource: Literal["link_budget", "override"]
    rxPowerDbm: Optional[float]
    effectiveSnrDb: Optional[float]
    # Mean over subcarriers at the operating SNR [bit/s/Hz].
    capacityOpenLoopBitsHz: float    # log2 det(I + rho/Nt · H Hᴴ), no CSIT
    capacityBeamformedBitsHz: float  # single-stream MRT/MRC upper reference
    capacityUniformBitsHz: float     # the app's sum/sqrt(Nt) steered precoder
    throughputMbps: float            # Shannon-rate upper bound × bandwidth; not scheduled NR goodput
    beamformingGainDb: Optional[float]  # MRT vs the steered uniform beam
    # Spatial structure of the frequency-averaged transmit covariance.
    conditionNumberDb: Optional[float]
    effectiveRank: Optional[float]
    spatialEigenvaluesDb: List[float] = Field(default_factory=list)
    coherenceBw50Hz: Optional[float] = None  # None = flat over the measured band
    curve: LinkKpiCurve
    spectrum: LinkKpiSpectrum


# ── Full PHY chain: NR PUSCH BER/BLER sweep (Tier 2, optional package) ──────

class PhyBerRequest(BaseModel):
    """FR1 NR PUSCH BER/BLER sweep over a reciprocal ray-traced CIR.

    ``channelMode="normalized"`` normalizes the RT CFR and sweeps the requested
    Eb/N0 values. ``channelMode="absolute"`` preserves RT path gain and derives
    baseline receiver noise from UE conducted Tx power, occupied bandwidth,
    receiver NF, and 293 K thermal noise. In absolute mode, the sweep bounds
    are Eb/N0 offsets around the physical link-budget operating point; offset
    zero is the actual modeled link-budget point. Neither mode includes
    inter-cell interference, UE power control, HARQ, or a complete NR scheduler.

    A nominal channel bandwidth determines the PRB count from the FR1 3GPP
    TS 38.104 table. Legacy callers may still pass ``numPrb`` directly when
    ``channelBandwidthMHz`` is omitted.
    """
    tx: Transmitter
    rx: Receiver
    buildings: List[BuildingFootprint]
    freqGhz: float = 28.0
    maxDepth: int = 3
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)
    # FR1 PUSCH resource grid and TS 38.214 MCS table selection.
    mcsIndex: int = Field(default=14, ge=0, le=28)
    mcsTable: Literal[1, 2, 3] = 1
    channelBandwidthMHz: Optional[int] = Field(default=None, ge=5, le=100)
    numPrb: int = Field(default=24, ge=4, le=273)
    subcarrierSpacing: float = 30_000.0  # Hz; FR1 supports 15/30/60 kHz here
    nCellId: int = Field(default=1, ge=0, le=1007)
    cyclicPrefix: Literal["normal", "extended"] = "normal"
    dmrsConfigType: Literal[1, 2] = 1
    dmrsAdditionalPosition: int = Field(default=0, ge=0, le=3)
    channelMode: Literal["normalized", "absolute"] = "normalized"
    # PUSCH is uplink: this is UE conducted Tx power, not the BS tx.powerDbm
    # value used for the reciprocal RT geometry/array response.
    ueTxPowerDbm: float = Field(default=23.0, ge=-10.0, le=33.0)
    receiverNoiseFigureDb: float = Field(default=7.0, ge=0.0, le=20.0)
    # solve_cir plumbing: CFR is re-sampled on the PUSCH grid; normalized
    # delays retain relative excess delay so CP suitability can be reported.
    numSubcarriers: int = 64
    normalizeDelays: bool = True
    snrMinDb: float = -10.0
    snrMaxDb: float = 14.0
    # In normalized mode these are Eb/N0 dB. In absolute mode they are dB
    # offsets around the link-budget-derived baseline Eb/N0.
    snrStepDb: float = Field(default=1.0, gt=0.0)
    slotsPerPoint: int = Field(default=32, ge=4, le=512)
    seed: int = Field(default=42, ge=0, le=2_147_483_647)

    @model_validator(mode="after")
    def validate_nr_configuration(self):
        from .nr_config import build_sweep_points, resolve_fr1_resource_grid, validate_mcs_index

        scs_hz = int(round(self.subcarrierSpacing))
        if float(scs_hz) != float(self.subcarrierSpacing) or scs_hz not in (15_000, 30_000, 60_000):
            raise ValueError("FR1 PUSCH SCS must be exactly 15000, 30000, or 60000 Hz")
        if self.channelBandwidthMHz is not None:
            grid = resolve_fr1_resource_grid(self.channelBandwidthMHz, scs_hz)
            # The standards table is authoritative when a nominal channel
            # bandwidth is provided; this also keeps older default numPrb from
            # accidentally overriding the selected FR1 bandwidth.
            self.numPrb = grid.num_prb
        validate_mcs_index(int(self.mcsTable), int(self.mcsIndex))
        if self.cyclicPrefix == "extended" and scs_hz != 60_000:
            raise ValueError("Extended cyclic prefix is only supported at 60 kHz SCS")
        build_sweep_points(self.snrMinDb, self.snrMaxDb, self.snrStepDb)
        return self


class PhyBerPoint(BaseModel):
    ebNoDb: float
    linkBudgetOffsetDb: Optional[float] = None
    ber: float
    bler: float
    berCi95Lower: float
    berCi95Upper: float
    blerCi95Lower: float
    blerCi95Upper: float
    goodputMbps: float
    bitErrors: int
    bits: int
    blockErrors: int
    blocks: int


class PhyBerResult(BaseModel):
    points: List[PhyBerPoint]
    mcsIndex: int
    mcsTable: int
    modulationOrder: int      # bits per QAM symbol
    targetCoderate: float
    numPrb: int
    numSubcarriers: int
    subcarrierSpacingHz: float
    channelBandwidthMHz: Optional[int] = None
    occupiedBandwidthHz: int
    nCellId: int
    cyclicPrefix: str
    dmrsConfigType: int
    dmrsAdditionalPosition: int
    numSymbolsPerSlot: int
    slotDurationSeconds: float
    maxExcessDelayNs: float
    approxMinimumCpNs: float
    channelNormalized: bool
    channelDirection: str
    interferenceModel: str
    numRxAnt: int             # base-station elements (uplink receive side)
    numTxAnt: int             # effective PUSCH streams (currently one)
    numUeArrayPorts: int      # physical UE ports under the uniform precoder
    numPaths: int
    slotsPerPoint: int
    transportBlockBits: int
    seed: int
    channelMode: Literal["normalized", "absolute"] = "normalized"
    sweepAxis: Literal["ebno", "link_budget_offset"] = "ebno"
    # Absolute-mode diagnostics. rxPowerDbm is mean combined signal power
    # across BS receive branches; noisePowerDbm is thermal+NF noise over
    # occupied bandwidth for one BS receive branch.
    linkBudgetEbNoDb: Optional[float] = None
    # Mean link-budget reference SNR from averaged channel gain; not a per-RE
    # equalizer/decoder output SINR.
    effectiveSnrDb: Optional[float] = None
    rxPowerDbm: Optional[float] = None
    noisePowerDbm: Optional[float] = None
    noiseBandwidthHz: Optional[float] = None
    meanChannelGainDb: Optional[float] = None
    ueTxPowerDbm: Optional[float] = None
    receiverNoiseFigureDb: Optional[float] = None
    noiseTemperatureK: Optional[float] = None


class PhyBerJobStatus(BaseModel):
    jobId: str
    status: Literal["running", "cancelling", "done", "error", "cancelled"]
    progress: float           # 0..1
    message: str = ""
    result: Optional[PhyBerResult] = None


# ── Per-cell ray-traced channel grid ────────────────────────────────────────

class ChannelAnalysisRequest(BaseModel):
    """Run PathSolver at selected cells from a cached RadioMapSolver grid."""
    cellIndices: List[int] = Field(min_length=1, max_length=12)
    txMode: Literal["serving", "serving_and_interferer", "selected", "all"] = "serving_and_interferer"
    txIndex: Optional[int] = Field(default=None, ge=0)
    rxArraySize: Tuple[int, int] = (1, 1)
    numSubcarriers: int = Field(default=64, ge=8, le=256)
    subcarrierSpacingHz: float = Field(default=30_000.0, gt=0, le=10_000_000)
    pathsToReturn: int = Field(default=24, ge=1, le=100)

    @model_validator(mode="after")
    def validate_selection(self):
        if len(set(self.cellIndices)) != len(self.cellIndices):
            raise ValueError("cellIndices must not contain duplicates")
        if any(index < 0 for index in self.cellIndices):
            raise ValueError("cellIndices must be non-negative")
        if len(self.rxArraySize) != 2 or any(int(value) < 1 for value in self.rxArraySize):
            raise ValueError("rxArraySize must contain two positive integers")
        if self.txMode == "selected" and self.txIndex is None:
            raise ValueError("txIndex is required when txMode is 'selected'")
        return self


class ChannelGridRequest(BaseModel):
    """Build a per-cell channel grid by ray-tracing every radio-map cell.

    Unlike the frontend's coverage-derived proxy, this keeps the real
    ``paths.cfr()`` Tx- and Rx-antenna axes plus ray-traced LOS and received
    power. Cells are solved in ``chunkSize``-receiver PathSolver batches.
    """
    tx: Transmitter
    # The position is ignored because `cells` supplies every target position.
    # Array size plus SolverOptions' Rx pattern/polarization configure the one
    # scene.rx_array shared by all cell receivers, exactly as in Sionna RT.
    rx: Optional[Receiver] = None
    buildings: List[BuildingFootprint]
    # Receiver positions = radio-map cell centers (ENU), sent verbatim so the
    # dataset coordinates match the displayed coverage grid exactly.
    cells: List[ENUVector]
    freqGhz: float = 28.0
    maxDepth: int = 3
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)
    # OFDM grid the CFR is sampled on (mirrors sionna.rt.subcarrier_frequencies).
    numSubcarriers: int = 64
    subcarrierSpacing: float = 30_000.0  # Hz
    normalizeDelays: bool = True
    chunkSize: int = 512                 # receivers per GPU dispatch (bounds memory)


class MeasurementSceneBounds(BaseModel):
    xMin: float
    xMax: float
    yMin: float
    yMax: float

    @model_validator(mode="after")
    def validate_bounds(self):
        if self.xMin > self.xMax or self.yMin > self.yMax:
            raise ValueError("Scene bounds minimum must not exceed maximum")
        return self


class MeasurementGeospatialAuditRequest(BaseModel):
    anchorLatitude: float = Field(ge=-90.0, le=90.0)
    anchorLongitude: float = Field(ge=-180.0, le=180.0)
    sceneBounds: Optional[MeasurementSceneBounds] = None


class MeasurementMatchingAuditRequest(BaseModel):
    """Build an identity/geospatial candidate audit for measured radio records."""
    anchorLatitude: float = Field(ge=-90.0, le=90.0)
    anchorLongitude: float = Field(ge=-180.0, le=180.0)
    sceneBounds: Optional[MeasurementSceneBounds] = None
    transmitters: List[Transmitter] = Field(default_factory=list, max_length=128)
    rat: Optional[str] = Field(default="NR5G-NSA", max_length=32)
    profileId: Optional[str] = Field(default=None, max_length=64)
    pci: Optional[int] = Field(default=None, ge=0, le=1007)
    band: Optional[int] = Field(default=None, ge=1, le=1024)
    arfcn: Optional[int] = Field(default=None, ge=0, le=3_279_165)
    previewLimit: int = Field(default=12, ge=1, le=100)


class MeasurementRayTraceRequest(BaseModel):
    """Run a bounded downlink PathSolver sample at real measurement positions."""
    anchorLatitude: float = Field(ge=-90.0, le=90.0)
    anchorLongitude: float = Field(ge=-180.0, le=180.0)
    sceneBounds: Optional[MeasurementSceneBounds] = None
    profileId: str = Field(min_length=1, max_length=64)
    tx: Transmitter
    buildings: List[BuildingFootprint]
    freqGhz: float = Field(default=3.5, gt=0.1, le=300.0)
    maxDepth: int = Field(default=3, ge=0, le=10)
    options: SolverOptions = Field(default_factory=SolverOptions)
    materials: List[MaterialConfig] = Field(default_factory=list)
    rxHeightM: float = Field(default=1.5, ge=0.2, le=10.0)
    sampleCount: int = Field(default=25, ge=1, le=100)
    rxArraySize: Tuple[int, int] = (1, 1)


# ── Persistent experiment history and configuration presets ────────────────

class ExperimentCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    kind: str = Field(min_length=1, max_length=80)
    status: Literal["running", "done", "error", "cancelled"] = "done"
    startedAtUtc: Optional[str] = None
    completedAtUtc: Optional[str] = None
    durationMs: Optional[float] = Field(default=None, ge=0.0)
    configurationFingerprint: Optional[str] = Field(default=None, max_length=128)
    seed: Optional[int] = None
    configuration: dict[str, Any] = Field(default_factory=dict)
    parameters: dict[str, Any] = Field(default_factory=dict)
    results: dict[str, Any] = Field(default_factory=dict)
    error: Optional[str] = Field(default=None, max_length=4000)
    replay: Optional[dict[str, Any]] = None


class ExperimentUpdateRequest(BaseModel):
    status: Optional[Literal["running", "done", "error", "cancelled"]] = None
    configurationFingerprint: Optional[str] = Field(default=None, max_length=128)
    completedAtUtc: Optional[str] = None
    durationMs: Optional[float] = Field(default=None, ge=0.0)
    results: Optional[dict[str, Any]] = None
    error: Optional[str] = Field(default=None, max_length=4000)
    replay: Optional[dict[str, Any]] = None


class ConfigurationPresetCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=500)
    configuration: dict[str, Any]


class MeasurementRayTraceJobStatus(BaseModel):
    jobId: str
    status: Literal["running", "cancelling", "done", "error", "cancelled"]
    progress: float = Field(ge=0.0, le=1.0)
    message: str = ""
    result: Optional[dict[str, Any]] = None
