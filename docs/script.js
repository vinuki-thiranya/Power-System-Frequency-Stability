"use strict";
/*
 * Grid frequency model of the 9 February 2025 Sri Lanka blackout.
 *
 * This is the same model as the notebook: the same two equations (swing equation and governor),
 * the same optional battery equation, the same event rules, the same RK4 step and the same 10 ms time step.
 * Part 1 (GridModel) is pure calculation and can run without a browser.
 * Part 2 wires it to the page.
 */

// ------------------------------------------------------------------------------------------------
// Part 1: the model
// ------------------------------------------------------------------------------------------------
const GridModel = (function () {
  const DATA = {
    f0: 50.0,            // [Hz] nominal frequency
    fInit: 50.12,        // [Hz] first recorded value, 11:13:40.0
    pTotal: 1489,        // [MW] estimated total generation
    pEmbedded: 750,      // [MW] embedded (mostly rooftop solar) generation
    tLoss: 0.0,          // [s]  time of the first, voltage-driven solar loss
    // share of surveyed inverters set at 49.5 Hz, between 48 and 49.5 Hz, between 47 and 48 Hz (rest: 47 Hz)
    shares: [177 / 1608, 282 / 1608, 196 / 1608],
    fHigh: 49.5, fMid: 48.0, fLow: 47.0,   // [Hz] inverter band edges
    // load-shedding stages: threshold [Hz], delay [s], load [MW], uses the rate-of-change element?
    stages: [
      { name: "I", threshold: 48.75, delay: 0.1, load: 65.4, rocof: false },
      { name: "II", threshold: 48.5, delay: 0.5, load: 58.5, rocof: false },
      { name: "III", threshold: 48.25, delay: 0.5, load: 65.7, rocof: false },
      { name: "IV", threshold: 48.0, delay: 0.5, load: 75.2, rocof: false },
      { name: "V", threshold: 47.5, delay: 0.0, load: 5.8, rocof: false },
      { name: "V or df/dt", threshold: 47.5, delay: 0.0, load: 23.2, rocof: true },
      { name: "df/dt", threshold: -Infinity, delay: 0.0, load: 112.3, rocof: true }
    ],
    rocofLimit: 0.85, rocofArm: 49.0, rocofDelay: 0.1,   // [Hz/s], [Hz], [s]
    fCollapse: 47.0,     // [Hz] collapse rule
    fFloor: 40.0,        // [Hz] traces are not followed below this
    fBattery: 49.8,      // [Hz] battery starts responding below this
    dfBattery: 0.3,      // [Hz] full battery power this far below fBattery
    tauBattery: 0.25,    // [s]  battery response time
    reserve: 230,        // [MW] spinning reserve on paper
    // recorded frequency: time [s] since 11:13:40.0, frequency [Hz]
    record: [[0.0, 50.12], [5.0, 49.51], [10.0, 48.27], [15.0, 47.48], [16.8, 46.07], [17.8, 44.86], [18.7, 43.48]]
  };

  // Calibrated values printed by the notebook (section 6.10). They are the default settings of this page.
  const CAL = {
    Ek: 6941.303593,     // [MW s]  stored kinetic energy
    D: 36.13398071,      // [MW/Hz] load damping
    K: 9.411158467,      // [MW/Hz] governor gain
    Tg: 0.5498645436,    // [s]     governor lag
    Pcap: 24.32644207,   // [MW]    largest extra governor power
    dP0: 40.08340656,    // [MW]    first solar loss
    relief: 0.4215063921 // [-]     share of each shed block that is real relief
  };

  // Values the notebook prints for the default settings, with the tolerance it states.
  const REFERENCE = { tCollapse: 16.25, tCollapseTol: 0.02, fAt15: 47.274, fAt15Tol: 0.005 };

  const DT = 0.01;         // [s] time step (divides the 100 ms and 500 ms relay delays exactly)
  const SETTLED = 0.002;   // [Hz/s] a run falling more slowly than this is no longer falling
  const CALM_TIME = 5.0;   // [s] it must stay that way this long to count as settled
  const STOP_BELOW = 42.5; // [Hz] a run is not followed below this (the bottom of the chart)

  function clip(x, lo, hi) { return Math.min(Math.max(x, lo), hi); }

  /** Parameter set for one run, from the page controls. */
  function makeParams(c) {
    const shareDay = DATA.pEmbedded / DATA.pTotal;
    const share = c.solarShare === undefined ? shareDay : c.solarShare;            // embedded share of generation
    const wrong = c.wrongShare === undefined ? 1.0 : c.wrongShare;                 // 1 = settings as surveyed
    const reserve = c.governorMW === undefined ? CAL.Pcap : c.governorMW;          // [MW] response delivered
    const reliefDay = c.relief === undefined ? CAL.relief : c.relief;
    const p = {
      f0: DATA.f0, fInit: DATA.fInit, tLoss: DATA.tLoss,
      Ek: CAL.Ek * (c.inertiaFactor === undefined ? 1.0 : c.inertiaFactor) * (1.0 - share) / (1.0 - shareDay),
      D: CAL.D,
      K: CAL.K * reserve / CAL.Pcap, Tg: CAL.Tg, Pcap: reserve,
      dP0: CAL.dP0 * share / shareDay,
      Pemb: share * DATA.pTotal,
      s1: wrong * DATA.shares[0], s2: wrong * DATA.shares[1], s3: wrong * DATA.shares[2],
      relief: clip(reliefDay * (1.0 - share) / (1.0 - shareDay), 0.0, 1.0),
      Pbat: c.batteryMW === undefined ? 0.0 : c.batteryMW,
      tauB: DATA.tauBattery, fB: DATA.fBattery, dfB: DATA.dfBattery
    };
    p.M = 2.0 * p.Ek / p.f0;          // [MW s/Hz]
    p.Kb = p.Pbat / p.dfB;            // [MW/Hz]
    return p;
  }

  /** Rates of change of the state y = [f (Hz), Pg (MW), Pb (MW)]; u = net power change since t = 0 (MW). */
  function rhs(y, u, p) {
    const f = y[0], Pg = y[1], Pb = y[2];
    const dfdt = (u + Pg + Pb - p.D * (f - p.fInit)) / p.M;                        // swing equation
    const target = Math.min(p.Pcap, p.K * Math.max(p.f0 - f, 0.0));                // governor droop with a limit
    const dPg = (target - Pg) / p.Tg;                                              // governor lag
    const bTarget = clip(p.Kb * (p.fB - f), 0.0, p.Pbat);                          // battery droop
    const dPb = (bTarget - Pb) / p.tauB;                                           // battery response time
    return [dfdt, dPg, dPb];
  }

  /** One classical Runge-Kutta step with u held constant. */
  function stepRK4(y, dt, u, p) {
    const k1 = rhs(y, u, p);
    const k2 = rhs([y[0] + 0.5 * dt * k1[0], y[1] + 0.5 * dt * k1[1], y[2] + 0.5 * dt * k1[2]], u, p);
    const k3 = rhs([y[0] + 0.5 * dt * k2[0], y[1] + 0.5 * dt * k2[1], y[2] + 0.5 * dt * k2[2]], u, p);
    const k4 = rhs([y[0] + dt * k3[0], y[1] + dt * k3[1], y[2] + dt * k3[2]], u, p);
    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) out[i] = y[i] + dt / 6.0 * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i]);
    return out;
  }

  /** Share of the embedded pool that has disconnected once frequency has been as low as fmin. */
  function tripFraction(fmin, p) {
    if (fmin <= DATA.fLow) return 1.0;
    if (fmin > DATA.fHigh) return 0.0;
    const band2 = p.s2 * clip((DATA.fHigh - fmin) / (DATA.fHigh - DATA.fMid), 0.0, 1.0);
    const band3 = p.s3 * clip((DATA.fMid - fmin) / (DATA.fMid - DATA.fLow), 0.0, 1.0);
    return p.s1 + band2 + band3;
  }

  /** Run the full model. Returns traces and summary numbers. */
  function simulate(p, T, stopWhenSettled) {
    const nSteps = Math.round(T / DT);
    let y = [p.fInit, 0.0, 0.0];
    let fmin = y[0];
    const nStage = DATA.stages.length;
    const tUf = new Array(nStage).fill(NaN), fired = new Array(nStage).fill(false), tFire = new Array(nStage).fill(NaN);
    let tRc = NaN, shed = 0.0, calm = 0.0, tCollapse = NaN, dfdt = 0.0, lost = 0.0, u = 0.0;
    const pool = p.Pemb - p.dP0;
    const checkEvery = Math.round(0.5 / DT);
    const tr = { t: [], f: [], Pg: [], Pb: [], lost: [], shed: [] };
    let k = 0;
    for (k = 0; k <= nSteps; k++) {
      const t = k * DT;
      const f = y[0];
      lost = (t >= p.tLoss ? p.dP0 : 0.0) + pool * tripFraction(fmin, p);
      u = -lost + p.relief * shed;
      dfdt = (u + y[1] + y[2] - p.D * (f - p.fInit)) / p.M;
      const rcNow = f < DATA.rocofArm && dfdt < -DATA.rocofLimit;
      tRc = rcNow ? (Number.isNaN(tRc) ? t : tRc) : NaN;
      const rcTrip = (t - tRc) >= DATA.rocofDelay - 1e-9;
      let anyFired = false;
      for (let i = 0; i < nStage; i++) {
        const st = DATA.stages[i];
        const below = f <= st.threshold;
        tUf[i] = below ? (Number.isNaN(tUf[i]) ? t : tUf[i]) : NaN;
        const go = (((t - tUf[i]) >= st.delay - 1e-9) || (st.rocof && rcTrip)) && !fired[i];
        if (go) { fired[i] = true; tFire[i] = t; shed += st.load; anyFired = true; }
      }
      if (anyFired) {
        u = -lost + p.relief * shed;
        dfdt = (u + y[1] + y[2] - p.D * (f - p.fInit)) / p.M;
      }
      tr.t.push(t); tr.f.push(f); tr.Pg.push(y[1]); tr.Pb.push(y[2]); tr.lost.push(lost); tr.shed.push(shed);
      if (k % checkEvery === 0) {
        calm = dfdt >= -SETTLED ? calm + 0.5 : 0.0;
        if (stopWhenSettled && (fmin < STOP_BELOW || calm >= CALM_TIME)) break;
      }
      if (k === nSteps) break;
      y = stepRK4(y, DT, u, p);
      y[0] = Math.max(y[0], DATA.fFloor);
      fmin = Math.min(fmin, y[0]);
      if (Number.isNaN(tCollapse) && y[0] < DATA.fCollapse) tCollapse = t + DT;
    }
    const falling = dfdt < -SETTLED;
    return {
      trace: tr, fmin: fmin, tCollapse: tCollapse, tFire: tFire, fired: fired,
      solarLost: lost, shedNominal: shed, shedNet: p.relief * shed, fEnd: y[0], fallingAtEnd: falling,
      collapsed: !Number.isNaN(tCollapse), survived: Number.isNaN(tCollapse) && !falling
    };
  }

  /** Linear interpolation of a trace at time t. */
  function valueAt(tr, key, t) {
    const i = Math.min(Math.floor(t / DT), tr.t.length - 2);
    const w = (t - tr.t[i]) / DT;
    return tr[key][i] + w * (tr[key][i + 1] - tr[key][i]);
  }

  /** Compare the default-settings run with the values printed by the notebook. */
  function referenceCheck() {
    const run = simulate(makeParams({}), 20.0, false);
    const fAt15 = valueAt(run.trace, "f", 15.0);
    const okT = Math.abs(run.tCollapse - REFERENCE.tCollapse) <= REFERENCE.tCollapseTol;
    const okF = Math.abs(fAt15 - REFERENCE.fAt15) <= REFERENCE.fAt15Tol;
    return { tCollapse: run.tCollapse, fAt15: fAt15, pass: okT && okF };
  }

  return { DATA, CAL, REFERENCE, DT, makeParams, simulate, valueAt, referenceCheck };
})();

if (typeof globalThis !== "undefined") globalThis.GridModel = GridModel;

// ------------------------------------------------------------------------------------------------
// Part 2: the page
// ------------------------------------------------------------------------------------------------
if (typeof document !== "undefined") (function () {
  const $ = (id) => document.getElementById(id);
  const D = GridModel.DATA;
  const WINDOW_MAX = 60.0;            // [s] longest simulated window
  const SLIDERS = ["solar", "wrong", "battery", "inertia", "relief", "governor"];
  let run = null, shown = 0, playing = false, frame = null, lastStamp = null;

  // A slider left at its default uses the exact calibrated value (for example 50.37% solar, not 50%).
  function read(id, scale) {
    const el = $(id);
    return el.value === el.defaultValue ? undefined : +el.value * scale;
  }
  function controls() {
    return {
      solarShare: read("solar", 0.01),
      wrongShare: read("wrong", 0.01),
      batteryMW: read("battery", 1),
      inertiaFactor: read("inertia", 1),
      relief: read("relief", 1),
      governorMW: read("governor", 1)
    };
  }

  function showValues() {
    $("solarVal").textContent = (+$("solar").value).toFixed(0) + " %";
    $("wrongVal").textContent = (+$("wrong").value).toFixed(0) + " % of them";
    $("batteryVal").textContent = (+$("battery").value).toFixed(0) + " MW";
    $("inertiaVal").textContent = (+$("inertia").value).toFixed(2) + " × (" + Math.round(GridModel.makeParams(controls()).Ek).toLocaleString() + " MW s)";
    $("reliefVal").textContent = (+$("relief").value).toFixed(2);
    $("governorVal").textContent = (+$("governor").value).toFixed(0) + " MW";
  }

  // ---- drawing -------------------------------------------------------------------------------
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function drawChart() {
    const canvas = $("view"), ctx = canvas.getContext("2d");
    const ratio = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * ratio)) { canvas.width = Math.round(W * ratio); canvas.height = Math.round(H * ratio); }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const m = { l: 58, r: 14, t: 12, b: 38 };
    const tMax = run ? Math.max(25, Math.ceil(run.trace.t[run.trace.t.length - 1] / 5) * 5) : 25;
    const fLo = 42.5, fHi = 50.6;
    const X = (t) => m.l + (W - m.l - m.r) * t / tMax;
    const Y = (f) => m.t + (H - m.t - m.b) * (fHi - f) / (fHi - fLo);
    ctx.font = "12px system-ui, sans-serif";
    // grid and axes
    ctx.strokeStyle = cssVar("--line"); ctx.fillStyle = cssVar("--muted"); ctx.lineWidth = 1;
    for (let f = 43; f <= 50; f++) {
      ctx.beginPath(); ctx.moveTo(m.l, Y(f)); ctx.lineTo(W - m.r, Y(f)); ctx.stroke();
      ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(f.toFixed(0), m.l - 6, Y(f));
    }
    for (let t = 0; t <= tMax; t += 5) {
      ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText(t.toFixed(0), X(t), H - m.b + 6);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "bottom"; ctx.fillText("time since 11:13:40 (s)", (m.l + W - m.r) / 2, H - 2);
    ctx.save(); ctx.textBaseline = "top"; ctx.translate(4, (m.t + H - m.b) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText("frequency (Hz)", 0, 0); ctx.restore();
    // threshold lines
    const lines = [[49.5, "49.5 Hz first inverters trip"], [48.75, "48.75 Hz load shedding starts"], [47.5, "47.5 Hz last stage"], [47.0, "47.0 Hz collapse"]];
    ctx.setLineDash([5, 4]);
    lines.forEach(([f, label], i) => {
      ctx.strokeStyle = i === 3 ? cssVar("--bad") : cssVar("--muted");
      ctx.beginPath(); ctx.moveTo(m.l, Y(f)); ctx.lineTo(W - m.r, Y(f)); ctx.stroke();
      ctx.fillStyle = i === 3 ? cssVar("--bad") : cssVar("--muted");
      ctx.textAlign = "right"; ctx.textBaseline = "bottom"; ctx.fillText(label, W - m.r - 4, Y(f) - 2);
    });
    ctx.setLineDash([]);
    // recorded points
    if ($("showRecord").checked) {
      ctx.fillStyle = cssVar("--record");
      D.record.forEach(([t, f]) => { ctx.beginPath(); ctx.arc(X(t), Y(f), 4, 0, 2 * Math.PI); ctx.fill(); });
    }
    if (!run) return;
    // simulated frequency up to the time shown
    const tr = run.trace, n = Math.min(shown, tr.t.length - 1);
    ctx.save(); ctx.beginPath(); ctx.rect(m.l, m.t, W - m.l - m.r, H - m.t - m.b); ctx.clip();   // keep the line inside the axes
    ctx.strokeStyle = cssVar("--accent"); ctx.lineWidth = 2.5; ctx.beginPath();
    for (let i = 0; i <= n; i++) { const x = X(tr.t[i]), y = Y(tr.f[i]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke(); ctx.restore();
    // load-shedding markers
    ctx.fillStyle = cssVar("--good");
    run.tFire.forEach((tf, i) => {
      if (Number.isNaN(tf) || tf > tr.t[n]) return;
      const x = X(tf), y = Y(GridModel.valueAt(tr, "f", Math.min(tf, tr.t[tr.t.length - 2])));
      ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x - 6, y - 15); ctx.lineTo(x + 6, y - 15); ctx.closePath(); ctx.fill();
    });
  }

  function showOutputs() {
    const done = run && shown >= run.trace.t.length - 1;
    if (!run) {
      ["outMin", "outTime", "outSolar", "outShed"].forEach((id) => { $(id).textContent = "–"; });
      $("outStatus").textContent = "Press Start"; $("outStatus").className = "v";
      return;
    }
    const tr = run.trace, i = Math.min(shown, tr.t.length - 1);
    let fmin = Infinity; for (let j = 0; j <= i; j++) fmin = Math.min(fmin, tr.f[j]);
    $("outMin").textContent = fmin.toFixed(2) + " Hz";
    $("outSolar").textContent = tr.lost[i].toFixed(0) + " MW";
    $("outShed").textContent = tr.shed[i].toFixed(0) + " MW";
    const tNow = tr.t[i];
    const st = $("outStatus");
    if (run.collapsed && tNow >= run.tCollapse) {
      $("outTime").textContent = run.tCollapse.toFixed(2) + " s";
      st.textContent = "Collapsed"; st.className = "v bad";
    } else if (done && run.survived) {
      $("outTime").textContent = "Survived";
      st.textContent = "Stable at " + run.fEnd.toFixed(2) + " Hz"; st.className = "v good";
    } else if (done) {
      $("outTime").textContent = "Not settled";
      st.textContent = "Still falling at " + tNow.toFixed(0) + " s"; st.className = "v bad";
    } else {
      $("outTime").textContent = "…";
      st.textContent = "Running, t = " + tNow.toFixed(1) + " s"; st.className = "v";
    }
  }

  // ---- run control -----------------------------------------------------------------------------
  function loop(stamp) {
    if (!playing) return;
    if (lastStamp === null) lastStamp = stamp;
    const speed = +$("speed").value;
    const advance = speed === 0 ? run.trace.t.length : Math.round((stamp - lastStamp) / 1000 * speed / GridModel.DT);
    if (advance > 0) { shown = Math.min(shown + advance, run.trace.t.length - 1); lastStamp = stamp; }
    drawChart(); showOutputs();
    if (shown >= run.trace.t.length - 1) { playing = false; $("startBtn").disabled = true; $("pauseBtn").disabled = true; return; }
    frame = requestAnimationFrame(loop);
  }
  function start() {
    if (!run) { run = GridModel.simulate(GridModel.makeParams(controls()), WINDOW_MAX, true); shown = 0; }
    playing = true; lastStamp = null;
    $("startBtn").disabled = true; $("pauseBtn").disabled = false;
    frame = requestAnimationFrame(loop);
  }
  function pause() {
    playing = false; if (frame) cancelAnimationFrame(frame);
    $("startBtn").disabled = false; $("startBtn").textContent = "Resume"; $("pauseBtn").disabled = true;
  }
  function reset() {
    playing = false; if (frame) cancelAnimationFrame(frame);
    run = null; shown = 0;
    $("startBtn").disabled = false; $("startBtn").textContent = "Start"; $("pauseBtn").disabled = true;
    showValues(); drawChart(); showOutputs();
  }
  function defaults() {
    SLIDERS.forEach((id) => { $(id).value = $(id).defaultValue; });
    reset();
  }

  function showReference() {
    const r = GridModel.referenceCheck(), ref = GridModel.REFERENCE;
    $("refText").textContent =
      "below 47 Hz at " + r.tCollapse.toFixed(2) + " s (notebook " + ref.tCollapse.toFixed(2) + " ± " + ref.tCollapseTol + " s); " +
      "frequency at 15 s " + r.fAt15.toFixed(3) + " Hz (notebook " + ref.fAt15.toFixed(3) + " ± " + ref.fAt15Tol + " Hz)";
    $("refBadge").textContent = r.pass ? "PASS" : "FAIL";
    $("refBadge").className = "badge " + (r.pass ? "good" : "bad");
  }

  $("startBtn").addEventListener("click", start);
  $("pauseBtn").addEventListener("click", pause);
  $("resetBtn").addEventListener("click", reset);
  $("defaultsBtn").addEventListener("click", defaults);
  SLIDERS.forEach((id) => $(id).addEventListener("input", reset));
  $("showRecord").addEventListener("change", drawChart);
  window.addEventListener("resize", drawChart);
  showReference(); reset();

  // Optional: settings in the address, e.g. index.html#wrong=0&battery=40&autorun (handy for sharing a case).
  const wanted = location.hash.slice(1).split("&").filter(Boolean);
  wanted.forEach((item) => {
    const [key, value] = item.split("=");
    if (key === "theme" && (value === "light" || value === "dark")) document.documentElement.dataset.theme = value;
    if (SLIDERS.includes(key) && value !== undefined && !Number.isNaN(+value)) $(key).value = value;
  });
  if (wanted.length) reset();
  if (wanted.includes("autorun")) { $("speed").value = "0"; start(); }
})();
