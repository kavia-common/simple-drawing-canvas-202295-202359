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
 *
 * Shapes implementation notes (line/rectangle/circle):
 * - Shapes use a "preview while dragging" approach:
 *   1) On pointer down, capture a base ImageData snapshot.
 *   2) On pointer move, restore base snapshot then draw the current shape on top.
 *   3) On pointer up/cancel, draw final shape once and commit a history snapshot.
 * - This ensures shapes integrate cleanly with undo/redo and do not permanently paint intermediate previews.
 */

const TOOL = Object.freeze({
  BRUSH: "brush",
  ERASER: "eraser",
  LINE: "line",
  RECT: "rect",
  CIRCLE: "circle",
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

  // Shapes: track the drag start point and store a base snapshot for preview.
  const shapeStartRef = useRef(null);
  const shapeBaseSnapRef = useRef(null);

  // History (undo/redo)
  const historyRef = useRef(/** @type {ImageData[]} */ ([]));
  const historyIndexRef = useRef(0);
  const skipSnapshotRef = useRef(false); // prevents history growth when applying history
  const [historyMeta, setHistoryMeta] = useState({ canUndo: false, canRedo: false });

  const [activeTool, setActiveTool] = useState(TOOL.BRUSH);
  const [strokeColor, setStrokeColor] = useState("#111827");
  const [brushSize, setBrushSize] = useState(8);

  // Shapes fill mode:
  // - Only applies to RECT and CIRCLE.
  // - LINE is always stroke-only.
  const [shapeFillMode, setShapeFillMode] = useState(/** @type {"stroke" | "fill"} */ ("stroke"));

  // Canvas background color (fill). This is baked into exports so saved PNGs match what users see.
  const [backgroundColor, setBackgroundColor] = useState("#ffffff");

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
      { id: TOOL.BRUSH, label: "Brush", hint: "Freehand draw" },
      { id: TOOL.ERASER, label: "Eraser", hint: "Erase pixels" },
      { id: TOOL.LINE, label: "Line", hint: "Draw a straight line" },
      { id: TOOL.RECT, label: "Rect", hint: "Draw a rectangle (stroke or fill)" },
      { id: TOOL.CIRCLE, label: "Circle", hint: "Draw a circle (stroke or fill)" },
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

  const fillCanvasBackground = (color) => {
    const canvas = canvasRef.current;
    const ctx = get2DContext();
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const { cssWidth, cssHeight } = getCanvasCssSize();
    if (!cssWidth || !cssHeight) return;

    // Fill in device pixels; then restore dpr scaling.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, cssWidth * dpr, cssHeight * dpr);
    ctx.restore();

    // Restore the expected dpr-scaled coordinate system for drawing.
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
      // Initialize with current background color for consistent exports.
      ctx.save();
      ctx.fillStyle = backgroundColor;
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

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = get2DContext();
    if (!canvas || !ctx) return;

    // Paint the chosen background behind the current bitmap.
    // This preserves any existing drawing and also colors "erased" (transparent) areas.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    // Snapshot so undo/redo includes background changes.
    captureSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backgroundColor]);

  const clampBrushSize = (val) => Math.max(1, Math.min(40, val));

  const cycleTool = () => {
    setActiveTool((t) => (t === TOOL.BRUSH ? TOOL.ERASER : TOOL.BRUSH));
  };

  const isShapeTool = (tool) => tool === TOOL.LINE || tool === TOOL.RECT || tool === TOOL.CIRCLE;

  const getToolLabel = (tool) => {
    switch (tool) {
      case TOOL.BRUSH:
        return "Brush";
      case TOOL.ERASER:
        return "Eraser";
      case TOOL.LINE:
        return "Line";
      case TOOL.RECT:
        return "Rectangle";
      case TOOL.CIRCLE:
        return "Circle";
      default:
        return "Tool";
    }
  };

  // PUBLIC_INTERFACE
  const saveAsImage = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Export using an offscreen canvas so the background is guaranteed to be included
    // even if the user used the eraser (which creates transparency).
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;

    const outCtx = out.getContext("2d");
    if (!outCtx) return;

    outCtx.save();
    outCtx.globalCompositeOperation = "source-over";
    outCtx.fillStyle = backgroundColor;
    outCtx.fillRect(0, 0, out.width, out.height);
    outCtx.drawImage(canvas, 0, 0);
    outCtx.restore();

    const dataUrl = out.toDataURL("image/png");

    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `drawing-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // Keyboard shortcuts:
  // - Undo/Redo: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y
  // - Tool selection: B (Brush), E (Eraser), X (Toggle between Brush/Eraser)
  // - Shapes: L (Line), R (Rect), C (Circle)
  // - Clear: Delete/Backspace (when not typing), or Ctrl/Cmd+K
  // - Save: Ctrl/Cmd+S
  // - Brush size: [ / ] (decrease/increase)
  // - Quick colors: 1-8 (palette order) when Brush/Shape tool is active (not eraser)
  useEffect(() => {
    const isTypingTarget = (target) => {
      if (!(target instanceof Element)) return false;
      const tag = target.tagName?.toLowerCase?.() ?? "";
      return (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        target.isContentEditable === true
      );
    };

    const onKeyDown = (e) => {
      // Avoid hijacking shortcuts while typing in form controls.
      // (Canvas has tabindex=0, so it can receive key events too.)
      if (isTypingTarget(e.target)) return;

      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;

      const key = e.key.toLowerCase();

      // --- Undo/redo (keep existing behavior and precedence) ---
      if (mod) {
        const isUndo = key === "z" && !e.shiftKey;
        const isRedo = (key === "z" && e.shiftKey) || key === "y";

        if (isUndo || isRedo) {
          e.preventDefault();
          if (isUndo) undo();
          if (isRedo) redo();
          return;
        }
      }

      // --- Save ---
      if (mod && key === "s") {
        e.preventDefault();
        saveAsImage();
        return;
      }

      // --- Clear ---
      // Backspace/Delete are browser navigation keys in some contexts; preventDefault.
      if (key === "backspace" || key === "delete") {
        e.preventDefault();
        clearCanvas();
        return;
      }
      // Alternate clear shortcut: Ctrl/Cmd+K (common "command palette" style, but safe here)
      if (mod && key === "k") {
        e.preventDefault();
        clearCanvas();
        return;
      }

      // --- Tool selection/toggle ---
      if (key === "b") {
        e.preventDefault();
        setActiveTool(TOOL.BRUSH);
        return;
      }
      if (key === "e") {
        e.preventDefault();
        setActiveTool(TOOL.ERASER);
        return;
      }
      if (key === "x") {
        e.preventDefault();
        cycleTool();
        return;
      }

      // Shapes shortcuts
      if (key === "l") {
        e.preventDefault();
        setActiveTool(TOOL.LINE);
        return;
      }
      if (key === "r") {
        e.preventDefault();
        setActiveTool(TOOL.RECT);
        return;
      }
      if (key === "c") {
        e.preventDefault();
        setActiveTool(TOOL.CIRCLE);
        return;
      }

      // --- Brush size adjustments ---
      // Keep these unmodified so they are quick to use while drawing.
      if (key === "[") {
        e.preventDefault();
        setBrushSize((s) => clampBrushSize(s - 1));
        return;
      }
      if (key === "]") {
        e.preventDefault();
        setBrushSize((s) => clampBrushSize(s + 1));
        return;
      }

      // --- Quick palette colors ---
      // 1..8 selects palette color (only when not erasing)
      if (!mod && !e.shiftKey && key.length === 1 && key >= "1" && key <= "8") {
        if (activeTool === TOOL.ERASER) return;
        const idx = Number(key) - 1;
        const color = palette[idx]?.value;
        if (!color) return;
        e.preventDefault();
        setStrokeColor(color);
      }
    };

    window.addEventListener("keydown", onKeyDown, { passive: false });
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, palette, saveAsImage]);

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

  const drawShapePreviewOrCommit = ({ start, end, isPreview }) => {
    const ctx = get2DContext();
    if (!ctx) return;

    ctx.save();
    // Shapes should always "draw" (never erase). If user wants to remove, they can use eraser tool.
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = strokeColor;
    ctx.lineWidth = brushSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Make preview slightly translucent for clarity while dragging.
    if (isPreview) {
      // For fill we keep it a touch more opaque so it's easy to see as a filled region.
      ctx.globalAlpha = shapeFillMode === "fill" ? 0.6 : 0.75;
    }

    const x1 = start.x;
    const y1 = start.y;
    const x2 = end.x;
    const y2 = end.y;

    if (activeTool === TOOL.LINE) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (activeTool === TOOL.RECT) {
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const w = Math.abs(x2 - x1);
      const h = Math.abs(y2 - y1);

      ctx.beginPath();
      ctx.rect(left, top, w, h);

      if (shapeFillMode === "fill") {
        // Filled shapes ignore stroke width by default; we still allow stroke-only via toggle.
        ctx.fill();
      } else {
        ctx.stroke();
      }

      ctx.restore();
      return;
    }

    if (activeTool === TOOL.CIRCLE) {
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      const rx = Math.abs(x2 - x1) / 2;
      const ry = Math.abs(y2 - y1) / 2;

      // Draw an ellipse (circle tool uses ellipse so it behaves intuitively even if drag isn't square).
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2);

      if (shapeFillMode === "fill") {
        ctx.fill();
      } else {
        ctx.stroke();
      }

      ctx.restore();
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

    const p = getPointFromEvent(evt);

    // --- Shapes: start preview session ---
    if (isShapeTool(activeTool)) {
      isDrawingRef.current = true;
      shapeStartRef.current = p;

      // Capture base snapshot for preview restore.
      try {
        shapeBaseSnapRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
      } catch {
        shapeBaseSnapRef.current = null;
      }

      // For line tool, give immediate feedback with a tiny dot.
      // This mirrors the brush behavior (tap creates a dot) and makes shapes feel responsive.
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = strokeColor;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1, brushSize / 3), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Restore base snapshot because the dot is only for feedback; actual shape will commit on release.
      if (shapeBaseSnapRef.current) {
        applySnapshot(shapeBaseSnapRef.current);
      }

      return;
    }

    // --- Brush/Eraser: existing freehand behavior ---
    isDrawingRef.current = true;
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

    const canvas = canvasRef.current;
    const ctx = get2DContext();
    if (!canvas || !ctx) return;

    const p = getPointFromEvent(evt);

    // --- Shapes: preview while dragging ---
    if (isShapeTool(activeTool)) {
      const start = shapeStartRef.current;
      if (!start) return;

      // Restore base snapshot then draw preview shape on top.
      if (shapeBaseSnapRef.current) {
        applySnapshot(shapeBaseSnapRef.current);
      }

      drawShapePreviewOrCommit({ start, end: p, isPreview: true });
      return;
    }

    // --- Brush/Eraser: freehand stroke ---
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

  const endStroke = (evt) => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;

    const canvas = canvasRef.current;
    const ctx = get2DContext();
    if (!canvas || !ctx) return;

    // --- Shapes: commit on release ---
    if (isShapeTool(activeTool)) {
      const start = shapeStartRef.current;
      shapeStartRef.current = null;

      const end = evt ? getPointFromEvent(evt) : lastPointRef.current;
      // Restore base (removes preview), then draw final shape.
      if (shapeBaseSnapRef.current) {
        applySnapshot(shapeBaseSnapRef.current);
      }
      shapeBaseSnapRef.current = null;

      if (start) {
        drawShapePreviewOrCommit({ start, end, isPreview: false });
      }

      // Snapshot after completing a shape so undo removes the last action.
      captureSnapshot();
      return;
    }

    // --- Brush/Eraser: snapshot after completing a stroke ---
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

    // Re-apply background so saved PNG isn't transparent and matches user selection.
    fillCanvasBackground(backgroundColor);

    captureSnapshot();
  };

  const isEraser = activeTool === TOOL.ERASER;
  const isShape = isShapeTool(activeTool);

  return (
    <div className="App" data-app="drawing">
      <header className="appHeader">
        <div className="headerText">
          <h1 className="appTitle">Simple Drawing Canvas</h1>
          <p className="appSubtitle">
            Pick a tool, color and size, draw on the canvas, then save your image.
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
                  {getToolLabel(activeTool)}
                </span>
              </div>

              <div className="segmented" role="group" aria-label="Tool selection">
                {toolPresets.map((t) => {
                  const active = t.id === activeTool;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={`segBtn ${active ? "active" : ""}`}
                      onClick={() => setActiveTool(t.id)}
                      aria-pressed={active}
                      title={t.hint}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>

              {(activeTool === TOOL.RECT || activeTool === TOOL.CIRCLE) && (
                <div className="toolMeta" style={{ marginTop: 10 }}>
                  <div className="toolLabelRow" style={{ marginBottom: 8 }}>
                    <span className="toolLabel">Shape</span>
                    <span className="toolHint" aria-hidden="true">
                      {shapeFillMode === "fill" ? "Fill" : "Stroke"}
                    </span>
                  </div>

                  <div className="segmented small" role="group" aria-label="Shape fill mode">
                    <button
                      type="button"
                      className={`segBtn small ${shapeFillMode === "stroke" ? "active" : ""}`}
                      onClick={() => setShapeFillMode("stroke")}
                      aria-pressed={shapeFillMode === "stroke"}
                      title="Draw outline only"
                    >
                      Stroke
                    </button>
                    <button
                      type="button"
                      className={`segBtn small ${shapeFillMode === "fill" ? "active" : ""}`}
                      onClick={() => setShapeFillMode("fill")}
                      aria-pressed={shapeFillMode === "fill"}
                      title="Draw filled shape"
                    >
                      Fill
                    </button>
                  </div>
                </div>
              )}

              <div className="toolMeta">
                <span className="toolMetaText">
                  {isEraser
                    ? "Erases existing pixels."
                    : isShape
                      ? activeTool === TOOL.RECT || activeTool === TOOL.CIRCLE
                        ? `Click-drag to preview, release to commit (${shapeFillMode}).`
                        : "Click-drag to preview, release to commit."
                      : "Draws with selected color."}
                </span>
              </div>
            </div>

            <div className="toolGroup">
              <div className="toolLabelRow">
                <span className="toolLabel">
                  {isEraser ? "Eraser size" : isShape ? "Stroke size" : "Brush size"}
                </span>
                <span className="toolHint" aria-hidden="true">
                  {brushSize}px
                </span>
              </div>

              <div className="brushRow">
                <div className="brushPresets" role="group" aria-label="Size presets">
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
                  <span className="srOnly">Size slider</span>
                  <input
                    type="range"
                    min={1}
                    max={40}
                    value={brushSize}
                    onChange={(e) => setBrushSize(Number(e.target.value))}
                    aria-label={isEraser ? "Eraser size" : isShape ? "Stroke size" : "Brush size"}
                  />
                </label>

                <div className="brushPreview" aria-label="Current size preview">
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

            <div className="toolGroup">
              <div className="toolLabelRow">
                <span className="toolLabel">Background</span>
                <span className="toolHint" aria-hidden="true">
                  Fill
                </span>
              </div>

              <div className="bgControl" role="group" aria-label="Background color">
                <label className="bgPicker">
                  <span className="srOnly">Background color</span>
                  <input
                    type="color"
                    value={backgroundColor}
                    onChange={(e) => setBackgroundColor(e.target.value)}
                    aria-label="Background color"
                  />
                </label>

                <div className="bgPresets" role="group" aria-label="Background presets">
                  {[
                    { label: "White", value: "#ffffff" },
                    { label: "Paper", value: "#f8fafc" },
                    { label: "Warm", value: "#fff7ed" },
                    { label: "Cool", value: "#ecfeff" },
                  ].map((p) => {
                    const active = p.value.toLowerCase() === backgroundColor.toLowerCase();
                    return (
                      <button
                        key={p.value}
                        type="button"
                        className={`chip ${active ? "active" : ""}`}
                        onClick={() => setBackgroundColor(p.value)}
                        aria-pressed={active}
                        title={p.label}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>

                <div className="toolMeta">
                  <span className="toolMetaText">Included in “Save PNG”.</span>
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
                <button
                  type="button"
                  className="btn secondary"
                  onClick={clearCanvas}
                  title="Clear (Del/Backspace)"
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={saveAsImage}
                  title="Save (Ctrl/Cmd+S)"
                >
                  Save PNG
                </button>
              </div>
              <div className="toolMeta">
                <span className="toolMetaText">
                  Shortcuts: Undo (Ctrl/Cmd+Z), Redo (Ctrl/Cmd+Shift+Z), Save (Ctrl/Cmd+S), Clear
                  (Del/Backspace), Brush (B), Eraser (E), Line (L), Rect (R), Circle (C), Toggle
                  Brush/Eraser (X), Size ([ / ]), Colors (1–8)
                </span>
              </div>
            </div>
          </div>

          <div className="canvasWrap" ref={containerRef}>
            <canvas
              ref={canvasRef}
              className={`canvas ${isEraser ? "eraserCursor" : ""}`}
              style={{ backgroundColor }}
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
              Tip: {isShape ? "Drag to preview the shape, then release to commit." : "Try the shape tools for clean geometry."}
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
