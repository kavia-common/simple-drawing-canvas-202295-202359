import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * Drawing app notes:
 * - Uses Pointer Events so it works with mouse, touch, and pen.
 * - Uses an offscreen backing store approach by storing drawing directly in the canvas bitmap.
 * - Canvas is scaled for devicePixelRatio for crisp lines.
 */

// PUBLIC_INTERFACE
function App() {
  /** Theme is fixed to "light/modern" per requirement; keep the attribute for future extension. */
  const [theme] = useState("light");

  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  const isDrawingRef = useRef(false);
  const lastPointRef = useRef({ x: 0, y: 0 });

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

  // Apply theme attribute (template convention)
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const get2DContext = () => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const ctx = canvas.getContext("2d");
    return ctx;
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
      // old was in device pixels; draw it into the new device pixel canvas by temporarily undoing css scaling.
      // Since ctx is dpr-scaled, use CSS-pixel dimensions for drawImage target.
      ctx.drawImage(
        old,
        0,
        0,
        old.width,
        old.height,
        0,
        0,
        cssWidth,
        cssHeight
      );
    } else {
      // Initialize with white background for consistent saved image.
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, cssWidth, cssHeight);
      ctx.restore();
    }
  };

  useEffect(() => {
    // Size on mount and on resize.
    setCanvasSizeToContainer();
    const onResize = () => setCanvasSizeToContainer();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
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
    ctx.fillStyle = strokeColor;
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
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = brushSize;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.restore();

    lastPointRef.current = p;
  };

  const endStroke = () => {
    isDrawingRef.current = false;
  };

  // PUBLIC_INTERFACE
  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = get2DContext();
    if (!canvas || !ctx) return;

    // Since ctx is dpr-scaled, use CSS pixel size from styles.
    const rect = canvas.getBoundingClientRect();

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // clear full device pixel buffer
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    // Re-apply white background so saved PNG isn't transparent (often expected for drawings).
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width * dpr, rect.height * dpr);
    ctx.restore();

    // Restore scaling transform.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
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

  return (
    <div className="App" data-app="drawing">
      <header className="appHeader">
        <div className="headerText">
          <h1 className="appTitle">Simple Drawing Canvas</h1>
          <p className="appSubtitle">
            Pick a color and brush size, draw on the canvas, then save your image.
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
                  Click to select
                </span>
              </div>

              <div className="palette" role="list" aria-label="Color palette">
                {palette.map((c) => {
                  const active = c.value.toLowerCase() === strokeColor.toLowerCase();
                  return (
                    <button
                      key={c.value}
                      type="button"
                      className={`swatch ${active ? "active" : ""}`}
                      style={{ backgroundColor: c.value }}
                      onClick={() => setStrokeColor(c.value)}
                      aria-label={`Select color ${c.name}`}
                      aria-pressed={active}
                      title={c.name}
                    />
                  );
                })}
              </div>
            </div>

            <div className="toolGroup">
              <div className="toolLabelRow">
                <span className="toolLabel">Brush</span>
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
                    aria-label="Brush size"
                  />
                </label>

                <div className="brushPreview" aria-label="Current brush preview">
                  <span
                    className="brushDot"
                    style={{
                      width: `${Math.max(6, brushSize)}px`,
                      height: `${Math.max(6, brushSize)}px`,
                      backgroundColor: strokeColor,
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="toolGroup actions">
              <span className="toolLabel">Actions</span>
              <div className="actionButtons">
                <button type="button" className="btn secondary" onClick={clearCanvas}>
                  Clear
                </button>
                <button type="button" className="btn primary" onClick={saveAsImage}>
                  Save PNG
                </button>
              </div>
            </div>
          </div>

          <div className="canvasWrap" ref={containerRef}>
            <canvas
              ref={canvasRef}
              className="canvas"
              onPointerDown={beginStroke}
              onPointerMove={continueStroke}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
              onPointerLeave={endStroke}
              aria-label="Drawing canvas"
              role="img"
            />
            <div className="canvasHelp" aria-hidden="true">
              Tip: Use mouse, touch, or pen to draw.
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
