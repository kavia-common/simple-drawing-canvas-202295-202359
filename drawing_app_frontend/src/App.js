import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * Drawing app notes:
 * - Uses Pointer Events so it works with mouse, touch, and pen.
 * - Uses an offscreen backing store approach by storing drawing directly in the canvas bitmap.
 * - Canvas is scaled for devicePixelRatio for crisp lines.
 *
 * Eraser implementation:
 * - Uses canvas compositing: destination-out removes pixels from existing content.
 * - Works best with a non-transparent background. We keep a white background on init/clear.
 *
 * Undo/redo implementation notes:
 * - We store snapshots as ImageData so they are resolution-independent relative to the actual canvas buffer.
 * - We snapshot at the end of each stroke and after clear.
 * - We cap history size to keep memory usage predictable.
 */

const TOOL = Object.freeze({
  BRUSH: "brush",
  ERASER: "eraser",
});

const HISTORY = Object.freeze({
  MAX: 60,
});

// PUBLIC_INTERFACE
function App() {
  /** Theme is fixed to "light/modern" per requirement; keep the attribute for future extension. */
  const [theme] = useState("light");

  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  const isDrawingRef = useRef(false);
  const lastPointRef = useRef({ x: 0, y: 0 });

  // History (undo/redo)
  const historyRef = useRef(/** @type {ImageData[]} */ ([]));
  const historyIndexRef = useRef(0);
  const skipSnapshotRef = useRef(false); // prevents history growth when applying history
  const [historyMeta, setHistoryMeta] = useState({ canUndo: false, canRedo: false });

  const [activeTool, setActiveTool] = useState(TOOL.BRUSH);
  const [strokeColor, setStrokeColor] = useState("#111827");
  const [brushSize, setBrushSize] = useState(8);

  const palette = useMemo(
    () => [
      { name: "Ink", value: "#111827" },
      { name: "Blue", value: "#3b82f6" },
      { name: "Cyan", value: "#06b6d4" },
      { name: "Slate", value: "#64748b" },
      { name: "Green", value: "#10b981" },
      { name: "Orange", value: "#f59e0b" },
      { name: "Red", value: "#EF4444" },
      { name: "Purple", value: "#8b5cf6" },
    ],
    []
  );

  const brushPresets = useMemo(
    () => [
      { label: "XS", value: 3 },
      { label: "S", value: 6 },
      { label: "M", value: 10 },
      { label: "L", value: 16 },
      { label: "XL", value: 24 },
    ],
    []
  );

  const toolPresets = useMemo(
    () => [
      {
        id: TOOL.BRUSH,
        label: "Brush",
        hint: "Draw",
      },
      {
        id: TOOL.ERASER,
        label: "Eraser",
        hint: "Erase",
      },
    ],
    []
  );

  // Apply theme attribute (template convention)
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const syncHistoryMeta = () => {
    const len = historyRef.current.length;
    const idx = historyIndexRef.current;
    setHistoryMeta({
      canUndo: len > 0 && idx > 1, // index 1 is the first real snapshot (see init)
      canRedo: len > 0 && idx < len,
    });
  };

  const get2DContext = () => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    return ctx;
  };

  const getCanvasCssSize = () => {
    const canvas = canvasRef.current;
    if (!canvas) return { cssWidth: 0, cssHeight: 0 };
    const rect = canvas.getBoundingClientRect();
    return { cssWidth: rect.width, cssHeight: rect.height };
  };

  const fillWhiteBackground = () => {
    const canvas = canvasRef.current;
    const ctx = get2DContext();
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const { cssWidth, cssHeight } = getCanvasCssSize();
    if (!cssWidth || !cssHeight) return;

    // Fill in device pixels; then restore dpr scaling.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cssWidth * dpr, cssHeight * dpr);
    ctx.restore();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  };

  const captureSnapshot = () => {
    const canvas = canvasRef.current;
    const ctx = get2DContext();
    if (!canvas || !ctx) return;

    if (skipSnapshotRef.current) return;

    // If user drew after undoing, drop the redo branch.
    if (historyIndexRef.current < historyRef.current.length) {
      historyRef.current = historyRef.current.slice(0, historyIndexRef.current);
    }

    try {
      const snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
      historyRef.current.push(snap);

      // Cap history size: keep the newest MAX snapshots.
      if (historyRef.current.length > HISTORY.MAX) {
        const overflow = historyRef.current.length - HISTORY.MAX;
        historyRef.current.splice(0, overflow);

        // Adjust index to reflect removal from front.
        historyIndexRef.current = Math.max(0, historyIndexRef.current - overflow);
      }

      historyIndexRef.current = historyRef.current.length;
      syncHistoryMeta();
    } catch {
      // If getImageData fails for any reason, avoid breaking drawing.
    }
  };

  const applySnapshot = (snap) => {
    const canvas = canvasRef.current;
    const ctx = get2DContext();
    if (!canvas || !ctx || !snap) return;

    skipSnapshotRef.current = true;
    try {
      ctx.putImageData(snap, 0, 0);
    } finally {
      skipSnapshotRef.current = false;
    }
  };

  // PUBLIC_INTERFACE
  const undo = () => {
    const idx = historyIndexRef.current;
    if (idx <= 1) return;

    const nextIdx = idx - 1;
    historyIndexRef.current = nextIdx;

    const snap = historyRef.current[nextIdx - 1];
    applySnapshot(snap);
    syncHistoryMeta();
  };

  // PUBLIC_INTERFACE
  const redo = () => {
    const idx = historyIndexRef.current;
    const len = historyRef.current.length;
    if (idx >= len) return;

    const nextIdx = idx + 1;
    historyIndexRef.current = nextIdx;

    const snap = historyRef.current[nextIdx - 1];
    applySnapshot(snap);
    syncHistoryMeta();
  };

  const setCanvasSizeToContainer = () => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // Use container width; keep a pleasant drawing aspect ratio.
    const rect = container.getBoundingClientRect();

    // Cap canvas size to keep UI consistent on very large screens.
    const cssWidth = Math.min(920, Math.max(320, Math.floor(rect.width)));
    const cssHeight = Math.floor(cssWidth * 0.62); // ~ 16:10-ish

    const dpr = window.devicePixelRatio || 1;

    // Preserve existing drawing while resizing:
    const old = document.createElement("canvas");
    old.width = canvas.width;
    old.height = canvas.height;
    const oldCtx = old.getContext("2d");
    if (oldCtx && canvas.width > 0 && canvas.height > 0) {
      oldCtx.drawImage(canvas, 0, 0);
    }

    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);

    const ctx = get2DContext();
    if (!ctx) return;

    // Reset transform then scale to dpr so pointer coordinates can be in CSS pixels.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    // Configure defaults (in CSS pixels)
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.imageSmoothingEnabled = true;

    // Restore old drawing content scaled into the new canvas size.
    if (old.width > 0 && old.height > 0) {
      // Since ctx is dpr-scaled, use CSS-pixel dimensions for drawImage target.
      ctx.drawImage(old, 0, 0, old.width, old.height, 0, 0, cssWidth, cssHeight);
    } else {
      // Initialize with white background for consistent saved image.
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cssWidth, cssHeight);
      ctx.restore();
    }

    // Resizing invalidates ImageData sizes; re-initialize history based on current canvas state.
    historyRef.current = [];
    historyIndexRef.current = 0;
    captureSnapshot(); // baseline
  };

  useEffect(() => {
    // Size on mount and on resize.
    setCanvasSizeToContainer();
    const onResize = () => setCanvasSizeToContainer();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard shortcuts: Ctrl/Cmd+Z for undo, Ctrl/Cmd+Shift+Z for redo (also Ctrl/Cmd+Y).
  useEffect(() => {
    const onKeyDown = (e) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;

      if (!mod) return;

      const key = e.key.toLowerCase();
      const isUndo = key === "z" && !e.shiftKey;
      const isRedo = (key === "z" && e.shiftKey) || key === "y";

      if (!isUndo && !isRedo) return;

      e.preventDefault();
      if (isUndo) undo();
      if (isRedo) redo();
    };

    window.addEventListener("keydown", onKeyDown, { passive: false });
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getPointFromEvent = (evt) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();

    // Pointer events use clientX/clientY
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;

    return { x, y };
  };

  const applyToolToContext = (ctx) => {
    // Configure the drawing/erasing behavior for this stroke.
    ctx.lineWidth = brushSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (activeTool === TOOL.ERASER) {
      // destination-out punches holes in existing pixels (eraser).
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.fillStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = strokeColor;
      ctx.fillStyle = strokeColor;
    }
  };

  const beginStroke = (evt) => {
    const canvas = canvasRef.current;
    const ctx = get2DContext();
    if (!canvas || !ctx) return;

    // Capture pointer to keep receiving events even if leaving canvas bounds while drawing.
    if (canvas.setPointerCapture && evt.pointerId != null) {
      try {
        canvas.setPointerCapture(evt.pointerId);
      } catch {
        // ignore
      }
    }

    isDrawingRef.current = true;

    const p = getPointFromEvent(evt);
    lastPointRef.current = p;

    // Dot on tap/click
    ctx.save();
    applyToolToContext(ctx);
    ctx.beginPath();
    ctx.arc(p.x, p.y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  const continueStroke = (evt) => {
    if (!isDrawingRef.current) return;

    const ctx = get2DContext();
    if (!ctx) return;

    const p = getPointFromEvent(evt);
    const last = lastPointRef.current;

    ctx.save();
    applyToolToContext(ctx);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.restore();

    lastPointRef.current = p;
  };

  const endStroke = () => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;

    // Snapshot after completing a stroke so undo removes the last action.
    captureSnapshot();
  };

  // PUBLIC_INTERFACE
  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = get2DContext();
    if (!canvas || !ctx) return;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // clear full device pixel buffer
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    // Re-apply white background so saved PNG isn't transparent (often expected for drawings).
    fillWhiteBackground();

    captureSnapshot();
  };

  // PUBLIC_INTERFACE
  const saveAsImage = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dataUrl = canvas.toDataURL("image/png");

    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `drawing-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const isEraser = activeTool === TOOL.ERASER;

  return (
    <div className="App" data-app="drawing">
      <header className="appHeader">
        <div className="headerText">
          <h1 className="appTitle">Simple Drawing Canvas</h1>
          <p className="appSubtitle">
            Pick a tool, color and brush size, draw on the canvas, then save your image.
          </p>
        </div>
      </header>

      <main className="appMain">
        <section className="panel" aria-label="Drawing controls and canvas">
          <div className="toolbar" role="region" aria-label="Drawing controls">
            <div className="toolGroup">
              <div className="toolLabelRow">
                <span className="toolLabel">Colors</span>
                <span className="toolHint" aria-hidden="true">
                  {isEraser ? "Disabled for eraser" : "Click to select"}
                </span>
              </div>

              <div className="palette" role="list" aria-label="Color palette">
                {palette.map((c) => {
                  const active = c.value.toLowerCase() === strokeColor.toLowerCase();
                  const disabled = isEraser;
                  return (
                    <button
                      key={c.value}
                      type="button"
                      className={`swatch ${active ? "active" : ""}`}
                      style={{
                        backgroundColor: c.value,
                        opacity: disabled ? 0.45 : 1,
                        cursor: disabled ? "not-allowed" : "pointer",
                      }}
                      onClick={() => {
                        if (!disabled) setStrokeColor(c.value);
                      }}
                      aria-label={`Select color ${c.name}`}
                      aria-pressed={active}
                      title={disabled ? "Color not used while erasing" : c.name}
                      disabled={disabled}
                    />
                  );
                })}
              </div>
            </div>

            <div className="toolGroup">
              <div className="toolLabelRow">
                <span className="toolLabel">Tool</span>
                <span className="toolHint" aria-hidden="true">
                  {isEraser ? "Eraser" : "Brush"}
                </span>
              </div>

              <div className="toolToggle" role="group" aria-label="Tool selection">
                {toolPresets.map((t) => {
                  const active = t.id === activeTool;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={`chip ${active ? "active" : ""}`}
                      onClick={() => setActiveTool(t.id)}
                      aria-pressed={active}
                      title={t.hint}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>

              <div className="toolMeta">
                <span className="toolMetaText">
                  {isEraser ? "Erases existing strokes." : "Draws with selected color."}
                </span>
              </div>
            </div>

            <div className="toolGroup">
              <div className="toolLabelRow">
                <span className="toolLabel">{isEraser ? "Eraser size" : "Brush size"}</span>
                <span className="toolHint" aria-hidden="true">
                  {brushSize}px
                </span>
              </div>

              <div className="brushRow">
                <div className="brushPresets" role="group" aria-label="Brush size presets">
                  {brushPresets.map((p) => {
                    const active = p.value === brushSize;
                    return (
                      <button
                        key={p.value}
                        type="button"
                        className={`chip ${active ? "active" : ""}`}
                        onClick={() => setBrushSize(p.value)}
                        aria-pressed={active}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>

                <label className="rangeLabel">
                  <span className="srOnly">Brush size slider</span>
                  <input
                    type="range"
                    min={1}
                    max={40}
                    value={brushSize}
                    onChange={(e) => setBrushSize(Number(e.target.value))}
                    aria-label={isEraser ? "Eraser size" : "Brush size"}
                  />
                </label>

                <div className="brushPreview" aria-label="Current brush preview">
                  <span
                    className={`brushDot ${isEraser ? "eraser" : ""}`}
                    style={{
                      width: `${Math.max(6, brushSize)}px`,
                      height: `${Math.max(6, brushSize)}px`,
                      backgroundColor: isEraser ? "#ffffff" : strokeColor,
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="toolGroup actions">
              <span className="toolLabel">Actions</span>
              <div className="actionButtons">
                <button
                  type="button"
                  className="btn secondary"
                  onClick={undo}
                  disabled={!historyMeta.canUndo}
                  title="Undo (Ctrl/Cmd+Z)"
                >
                  Undo
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={redo}
                  disabled={!historyMeta.canRedo}
                  title="Redo (Ctrl/Cmd+Shift+Z)"
                >
                  Redo
                </button>
                <button type="button" className="btn secondary" onClick={clearCanvas}>
                  Clear
                </button>
                <button type="button" className="btn primary" onClick={saveAsImage}>
                  Save PNG
                </button>
              </div>
              <div className="toolMeta">
                <span className="toolMetaText">
                  Shortcuts: Undo (Ctrl/Cmd+Z), Redo (Ctrl/Cmd+Shift+Z)
                </span>
              </div>
            </div>
          </div>

          <div className="canvasWrap" ref={containerRef}>
            <canvas
              ref={canvasRef}
              className={`canvas ${isEraser ? "eraserCursor" : ""}`}
              onPointerDown={beginStroke}
              onPointerMove={continueStroke}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
              onPointerLeave={endStroke}
              aria-label="Drawing canvas"
              role="img"
              tabIndex={0}
            />
            <div className="canvasHelp" aria-hidden="true">
              Tip: Select {isEraser ? "Brush to draw again" : "Eraser to remove strokes"}.
            </div>
          </div>
        </section>
      </main>

      <footer className="appFooter">
        <span className="footerText">
          Your drawing stays in your browser. Use “Save PNG” to download it.
        </span>
      </footer>
    </div>
  );
}

export default App;
