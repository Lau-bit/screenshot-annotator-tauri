'use strict';

const UNDO_LIMIT = 50;
const ERASE_RADIUS = 15;

// Browsers refuse to back a canvas past a fixed edge/area budget (16384px per
// side, 16384^2 total in Chromium/WebView2). Past it the 2D context silently
// paints nothing and toDataURL() returns the empty URL "data:," — which used to
// travel all the way to disk as a 0-byte .png reported as "Saved". Both the
// import and the export path have to know the budget rather than discover it.
const MAX_CANVAS_EDGE = 16384;
const MAX_CANVAS_AREA = 16384 * 16384;

// Largest multiplier that keeps w x h inside both budgets (1 when it fits).
function canvasFitFactor(w, h) {
  return Math.min(1, MAX_CANVAS_EDGE / w, MAX_CANVAS_EDGE / h, Math.sqrt(MAX_CANVAS_AREA / (w * h)));
}

function exceedsCanvasBudget(w, h) {
  return w > MAX_CANVAS_EDGE || h > MAX_CANVAS_EDGE || w * h > MAX_CANVAS_AREA;
}

const state = {
  versions: [],
  activeVersion: -1,
  focusedEditorIndex: 0,
  splitMode: false,
  tool: 'rect',
  color: '#ff9500',
  textSize: 24,
  saveFolder: null,
  // Relative-measurement layer. Ephemeral (never saved to a version or disk) and
  // global — the same guides render over every version and in both split panes,
  // so flipping versions gives a quick cross-version compare.
  // Coordinates are fractions (0..1) of the SCREENSHOT (image), so the layer is
  // anchored to the image content: guides follow the image's pan/zoom and stay
  // glued to the actual UI. They stay screen-axis-aligned though — the render
  // applies translate+scale but NOT the image's rotation.
  measure: {
    on: false,
    axis: 'h',                    // which axis new markers land on: 'h' width, 'v' height
    ref: { x: 0, y: 0, w: 1, h: 1 }, // reference region = "the view" that counts as 100% (image fractions)
    refSet: false,                // has the user positioned the reference? drives the default on activate
    hMarks: [],                   // vertical dividers, fraction 0..1 across ref width
    vMarks: [],                   // horizontal dividers, fraction 0..1 across ref height
  },
};

const tabBar = document.getElementById('tab-bar');
const btnClearWorkspace = document.getElementById('btn-clear-workspace');
const btnSettings = document.getElementById('btn-settings');
const settingsMenu = document.getElementById('settings-menu');
const settingSaveWindowShape = document.getElementById('setting-save-window-shape');
const settingSquareAppCorners = document.getElementById('setting-square-app-corners');
const canvasArea = document.getElementById('canvas-area');
const colorPickerInput = document.getElementById('color-picker-input');
const btnCustomColor = document.getElementById('btn-custom-color');
const folderDisplay = document.getElementById('folder-display');
const btnPickFolder = document.getElementById('btn-pick-folder');
const btnOpenFolder = document.getElementById('btn-open-folder');
const btnSave = document.getElementById('btn-save');
const btnSaveAs = document.getElementById('btn-save-as');
const btnCopyImage = document.getElementById('btn-copy-image');
const btnToggleSplit = document.getElementById('btn-toggle-split');
const scaleDropdown = document.getElementById('scale-dropdown');
const scaleTrigger = document.getElementById('scale-trigger');
const scaleTriggerLabel = document.getElementById('scale-trigger-label');
const scaleMenu = document.getElementById('scale-menu');
let copyScale = 1;
const textSizeSelect = document.getElementById('text-size-select');
const toast = document.getElementById('toast');
const brightnessSlider = document.getElementById('brightness-slider');
const contrastSlider = document.getElementById('contrast-slider');
const brightnessValue = document.getElementById('brightness-value');
const contrastValue = document.getElementById('contrast-value');
const rotationDisplay = document.getElementById('rotation-display');
const btnRotateCW = document.getElementById('btn-rotate-cw');
const btnRotateCCW = document.getElementById('btn-rotate-ccw');
const btnResetRotation = document.getElementById('btn-reset-rotation');
const btnResetBrightness = document.getElementById('btn-reset-brightness');
const btnResetContrast = document.getElementById('btn-reset-contrast');
const btnMeasure = document.getElementById('btn-measure');
const measureControls = document.getElementById('measure-controls');
const tabSpacer = document.querySelector('.tab-spacer');
const measureAxisButtons = document.querySelectorAll('.measure-axis');
const btnMeasureBake = document.getElementById('btn-measure-bake');
const btnMeasureReset = document.getElementById('btn-measure-reset');
const btnMeasureScope = document.getElementById('btn-measure-scope');
const settingMeasureDefaultScreenshot = document.getElementById('setting-measure-default-screenshot');
const settingMeasureOpacity = document.getElementById('setting-measure-opacity');
const settingAutoCrop = document.getElementById('setting-auto-crop');
const btnAutoCrop = document.getElementById('btn-auto-crop');

function getCtx(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}

function makeEditor(index, ids) {
  const editor = {
    index,
    pane: document.getElementById(ids.pane),
    emptyHint: document.getElementById(ids.emptyHint),
    canvasWrapper: document.getElementById(ids.canvasWrapper),
    baseCanvas: document.getElementById(ids.baseCanvas),
    canvas: document.getElementById(ids.canvas),
    cropOverlay: document.getElementById(ids.cropOverlay),
    textInputWrapper: document.getElementById(ids.textInputWrapper),
    textInput: document.getElementById(ids.textInput),
    textDragHandle: document.getElementById(ids.textDragHandle),
    measureLayer: document.getElementById(ids.measureLayer),
    versionIndex: -1,
    zoom: 1,
    panX: 0,
    panY: 0,
    isDrawing: false,
    startX: 0,
    startY: 0,
    snapshot: null,
    preActionSnapshot: null,
    cropFrame: { x: 0, y: 0, w: 0, h: 0 },
    cropDragging: null,
    isPanning: false,
    panStartX: 0,
    panStartY: 0,
    isRotating: false,
    viewAdjusted: false,
    rotateCenter: { x: 0, y: 0 },
    rotateStartAngle: 0,
    rotateStartMouseAngle: 0,
    textClickX: 0,
    textClickY: 0,
    textDragging: false,
  };
  editor.baseCtx = getCtx(editor.baseCanvas);
  editor.ctx = getCtx(editor.canvas);
  return editor;
}

const editors = [
  makeEditor(0, {
    pane: 'editor-left',
    emptyHint: 'empty-hint',
    canvasWrapper: 'canvas-wrapper',
    baseCanvas: 'base-canvas',
    canvas: 'canvas',
    cropOverlay: 'crop-overlay',
    textInputWrapper: 'text-input-wrapper',
    textInput: 'text-input',
    textDragHandle: 'text-drag-handle',
    measureLayer: 'measure-layer',
  }),
  makeEditor(1, {
    pane: 'editor-right',
    emptyHint: 'empty-hint-right',
    canvasWrapper: 'canvas-wrapper-right',
    baseCanvas: 'base-canvas-right',
    canvas: 'canvas-right',
    cropOverlay: 'crop-overlay-right',
    textInputWrapper: 'text-input-wrapper-right',
    textInput: 'text-input-right',
    textDragHandle: 'text-drag-handle-right',
    measureLayer: 'measure-layer-right',
  }),
];

let appSettings = defaultAppSettings();
let toastTimer;

function defaultAppSettings() {
  return { squareAppCorners: false, measureOpacity: 0.9, measureDefaultScreenshot: true, autoCropToZoom: true };
}

function normalizeAppSettings(settings) {
  const s = settings || {};
  return {
    ...defaultAppSettings(),
    ...s,
    squareAppCorners: !!s.squareAppCorners,
    measureOpacity: Number.isFinite(s.measureOpacity) ? clamp(s.measureOpacity, 0.2, 1) : 0.9,
    // default true unless explicitly disabled
    measureDefaultScreenshot: s.measureDefaultScreenshot !== false,
    autoCropToZoom: s.autoCropToZoom !== false,
  };
}

function applyAppSettingsInputs() {
  settingSquareAppCorners.checked = appSettings.squareAppCorners;
  settingAutoCrop.checked = appSettings.autoCropToZoom;
  updateAutoCropIndicator();
  settingMeasureDefaultScreenshot.checked = appSettings.measureDefaultScreenshot;
  settingMeasureOpacity.value = Math.round(appSettings.measureOpacity * 100);
  const scopeShot = appSettings.measureDefaultScreenshot;
  btnMeasureScope.classList.toggle('active', scopeShot);
  btnMeasureScope.title = scopeShot
    ? 'Reference locked to screenshot dimensions — click to use full app area'
    : 'Reference locked to full app area — click to use screenshot dimensions';
}

async function loadAppSettings() {
  try {
    appSettings = normalizeAppSettings(await window.annotatorAPI.getSettings());
  } catch (error) {
    console.error('Failed to load app settings:', error);
    appSettings = defaultAppSettings();
  }
  applyAppSettingsInputs();
}

async function saveAppSettings() {
  try {
    await window.annotatorAPI.setSettings(appSettings);
  } catch (error) {
    console.error('Failed to save app settings:', error);
  }
  applyAppSettingsInputs();
}

function showToast(msg) {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function setSettingsMenuOpen(open) {
  settingsMenu.classList.toggle('open', open);
  settingsMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
  btnSettings.classList.toggle('active', open);
}

btnSettings.addEventListener('click', (e) => {
  e.stopPropagation();
  setSettingsMenuOpen(!settingsMenu.classList.contains('open'));
});

settingsMenu.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => setSettingsMenuOpen(false));

settingSaveWindowShape.addEventListener('click', async () => {
  try {
    await window.annotatorAPI.saveWindowShape();
    showToast('Window shape saved');
  } catch (error) {
    console.error('Failed to save window shape:', error);
    showToast('Failed to save window shape');
  }
});

settingSquareAppCorners.addEventListener('change', async () => {
  appSettings.squareAppCorners = settingSquareAppCorners.checked;
  await saveAppSettings();
  try {
    await window.annotatorAPI.setWindowSquareCorners(appSettings.squareAppCorners);
  } catch (error) {
    console.error('Failed to set square app corners:', error);
  }
});

async function setAutoCropToZoom(on) {
  appSettings.autoCropToZoom = !!on;
  updateAutoCropIndicator();
  await saveAppSettings();
}

settingAutoCrop.addEventListener('change', () => setAutoCropToZoom(settingAutoCrop.checked));
btnAutoCrop.addEventListener('click', () => setAutoCropToZoom(!appSettings.autoCropToZoom));

function activeEditor() {
  return editors[state.focusedEditorIndex];
}

function activeVersion() {
  const editor = activeEditor();
  return editor.versionIndex >= 0 ? state.versions[editor.versionIndex] : null;
}

function visibleEditors() {
  return editors.filter((editor) => !editor.pane.hidden);
}

function otherVisibleEditor(editor) {
  return visibleEditors().find((candidate) => candidate !== editor) || null;
}

function isVersionOpenInOtherEditor(editor, versionIndex) {
  const other = otherVisibleEditor(editor);
  return !!other && other.versionIndex === versionIndex;
}

function firstAvailableVersionIndex(editor, preferredIndex = -1) {
  if (preferredIndex >= 0 && preferredIndex < state.versions.length && !isVersionOpenInOtherEditor(editor, preferredIndex)) {
    return preferredIndex;
  }
  for (let i = 0; i < state.versions.length; i++) {
    if (!isVersionOpenInOtherEditor(editor, i)) return i;
  }
  return -1;
}

function ensureUniqueVisibleEditors() {
  const [left, right] = editors;
  if (!state.splitMode || right.pane.hidden) return;
  if (left.versionIndex < 0 || right.versionIndex < 0) return;
  if (left.versionIndex !== right.versionIndex) return;

  const replacement = firstAvailableVersionIndex(right, right.versionIndex);
  if (replacement >= 0 && replacement !== left.versionIndex) {
    right.versionIndex = replacement;
    loadVersionToEditor(right, state.versions[replacement], { fit: true });
  } else {
    clearEditor(right);
  }
}

function hasActiveTextInput() {
  return editors.some((editor) => document.activeElement === editor.textInput);
}

function focusEditor(editor, { updateControls = true } = {}) {
  if (editor.pane.hidden) return;
  state.focusedEditorIndex = editor.index;
  state.activeVersion = editor.versionIndex;
  editors.forEach((candidate) => {
    candidate.pane.classList.toggle('focused', candidate === editor);
  });
  if (updateControls) updateActiveControls();
  renderTabs();
}

function clearEditor(editor) {
  editor.versionIndex = -1;
  editor.zoom = 1;
  editor.panX = 0;
  editor.panY = 0;
  editor.viewAdjusted = false;
  editor.isDrawing = false;
  editor.snapshot = null;
  editor.preActionSnapshot = null;
  editor.cropDragging = null;
  editor.isPanning = false;
  editor.isRotating = false;
  editor.textDragging = false;
  editor.baseCanvas.width = 0;
  editor.baseCanvas.height = 0;
  editor.canvas.width = 0;
  editor.canvas.height = 0;
  editor.baseCanvas.style.filter = '';
  editor.canvasWrapper.style.transform = '';
  editor.cropOverlay.classList.remove('active');
  editor.textInputWrapper.style.display = 'none';
  editor.emptyHint.style.display = '';
}

function imageDataToCanvas(imageData) {
  const tmp = document.createElement('canvas');
  tmp.width = imageData.width;
  tmp.height = imageData.height;
  tmp.getContext('2d').putImageData(imageData, 0, 0);
  return tmp;
}

function getCanvasPos(editor, e) {
  const v = editor.versionIndex >= 0 ? state.versions[editor.versionIndex] : null;
  const rotation = v ? v.rotation : 0;

  if (rotation === 0) {
    const rect = editor.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / editor.zoom,
      y: (e.clientY - rect.top) / editor.zoom,
    };
  }

  const areaRect = editor.pane.getBoundingClientRect();
  const screenCX = areaRect.left + editor.panX + editor.canvas.width * editor.zoom / 2;
  const screenCY = areaRect.top + editor.panY + editor.canvas.height * editor.zoom / 2;
  const dx = e.clientX - screenCX;
  const dy = e.clientY - screenCY;
  const rad = -rotation * Math.PI / 180;
  const udx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const udy = dx * Math.sin(rad) + dy * Math.cos(rad);

  return {
    x: udx / editor.zoom + editor.canvas.width / 2,
    y: udy / editor.zoom + editor.canvas.height / 2,
  };
}

function setupCtx(editor) {
  editor.ctx.strokeStyle = state.color;
  editor.ctx.fillStyle = state.color;
  editor.ctx.lineWidth = 2;
  editor.ctx.lineJoin = 'round';
  editor.ctx.lineCap = 'round';
  editor.ctx.globalCompositeOperation = 'source-over';
}

function drawShapePreview(editor, x1, y1, x2, y2) {
  const { ctx } = editor;
  ctx.beginPath();
  if (state.tool === 'rect') {
    ctx.rect(x1, y1, x2 - x1, y2 - y1);
    ctx.stroke();
  } else if (state.tool === 'circle') {
    const rx = Math.abs(x2 - x1) / 2;
    const ry = Math.abs(y2 - y1) / 2;
    const cx = x1 + (x2 - x1) / 2;
    const cy = y1 + (y2 - y1) / 2;
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (state.tool === 'line') {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
}

// An undo entry is the whole editable state of a version, not just its pixels.
// Rotation, brightness and contrast used to sit outside the history, so Ctrl+Z
// after a rotate skipped past it and silently threw away the previous drawing.
function versionSnapshot(editor, v) {
  if (!v || !editor.canvas.width || !editor.canvas.height) return null;
  return {
    image: editor.ctx.getImageData(0, 0, editor.canvas.width, editor.canvas.height),
    rotation: v.rotation,
    brightness: v.brightness,
    contrast: v.contrast,
  };
}

function restoreVersionSnapshot(editor, v, snap) {
  editor.ctx.putImageData(snap.image, 0, 0);
  v.annotationData = snap.image;
  v.rotation = snap.rotation;
  v.brightness = snap.brightness;
  v.contrast = snap.contrast;
  applyBC(editor);
  applyTransform(editor);
}

function pushUndo(editor, snapshot) {
  const v = editor.versionIndex >= 0 ? state.versions[editor.versionIndex] : null;
  if (!v || !snapshot) return;
  v.undoStack.push(snapshot);
  if (v.undoStack.length > UNDO_LIMIT) v.undoStack.shift();
  v.redoStack = [];
}

// Record the pre-change state for an edit that isn't a canvas stroke
// (rotate buttons, ctrl+drag rotate, the brightness/contrast sliders).
function pushVersionUndo(editor = activeEditor()) {
  const v = editor.versionIndex >= 0 ? state.versions[editor.versionIndex] : null;
  pushUndo(editor, versionSnapshot(editor, v));
}

function saveEditorCanvasToVersion(editor) {
  if (editor.versionIndex < 0 || editor.canvas.width === 0) return;
  state.versions[editor.versionIndex].annotationData =
    editor.ctx.getImageData(0, 0, editor.canvas.width, editor.canvas.height);
}

function saveVisibleEditorsToVersions() {
  visibleEditors().forEach(saveEditorCanvasToVersion);
}

function applyTransform(editor) {
  const v = editor.versionIndex >= 0 ? state.versions[editor.versionIndex] : null;
  const rotation = v ? v.rotation : 0;
  const cx = editor.canvas.width / 2;
  const cy = editor.canvas.height / 2;
  editor.canvasWrapper.style.transform =
    `translate(${editor.panX}px,${editor.panY}px) scale(${editor.zoom}) ` +
    `translate(${cx}px,${cy}px) rotate(${rotation}deg) translate(${-cx}px,${-cy}px)`;

  if (editor === activeEditor()) {
    rotationDisplay.textContent = Math.round(((rotation % 360) + 360) % 360) + '°';
    updateAutoCropIndicator();
  }

  // Keep the image-anchored measure overlay glued to the image as it pans/zooms.
  // (renderMeasureEditor is a function declaration, hoisted, so this is safe here.)
  if (state.measure.on) renderMeasureEditor(editor);
}

// The zoom at which the image is fully shown along its tighter axis — exactly
// what a paste lands on. Zooming out past it only shrinks an already-complete
// picture into the middle of the pane, so it is the floor. Capped at 1 so an
// image smaller than the pane (whose fit blows it up) can still be brought back
// to native 1:1; both ends of that cap are a "100%" view, of the pane or of the
// pixels, and neither hides part of the image.
function fitZoomFor(editor) {
  const availW = editor.pane.clientWidth;
  const availH = editor.pane.clientHeight;
  if (!availW || !availH || !editor.canvas.width || !editor.canvas.height) return null;
  return Math.min(availW / editor.canvas.width, availH / editor.canvas.height);
}

function minZoomFor(editor) {
  const fit = fitZoomFor(editor);
  return fit === null ? 0.05 : Math.min(fit, 1);
}

// True when the view sits on that floor — the state in which the whole image is
// on show and auto-crop deliberately stands down, however the image is panned.
function atMinZoom(editor) {
  if (editor.versionIndex < 0) return true;
  return editor.zoom <= minZoomFor(editor) * 1.001;
}

function fitToArea(editor) {
  const fit = fitZoomFor(editor);
  if (fit === null) return;
  editor.zoom = fit;
  editor.panX = (editor.pane.clientWidth - editor.canvas.width * editor.zoom) / 2;
  editor.panY = (editor.pane.clientHeight - editor.canvas.height * editor.zoom) / 2;
  editor.viewAdjusted = false;
  applyTransform(editor);
}

// Keep the image from being panned out of reach. Either way round it must keep
// `over` pixels inside the pane so it can never be lost off-screen — but that is
// the ONLY constraint: at minimum zoom the image may still be pushed past the
// pane edges, so an edge can be worked on without it sitting under a toolbar.
function clampPan(editor) {
  const imgW = editor.canvas.width * editor.zoom;
  const imgH = editor.canvas.height * editor.zoom;
  if (!imgW || !imgH) return;
  const clampAxis = (pan, img, pane) => {
    const over = Math.min(60, img);
    return img >= pane
      ? clamp(pan, pane - over - img, over)   // large: cover the pane, ±over margin
      : clamp(pan, over - img, pane - over);  // small: free to leave, `over` stays
  };
  editor.panX = clampAxis(editor.panX, imgW, editor.pane.clientWidth);
  editor.panY = clampAxis(editor.panY, imgH, editor.pane.clientHeight);
}

// A pane that grew (a resize, a DPI change, leaving split view) raises the floor
// under a view the user set by hand. Pull the zoom back up around the pane centre
// rather than leaving it below the minimum it is now supposed to obey.
function clampView(editor) {
  const min = minZoomFor(editor);
  if (editor.zoom < min) {
    const paneW = editor.pane.clientWidth;
    const paneH = editor.pane.clientHeight;
    const canvasX = (paneW / 2 - editor.panX) / editor.zoom;
    const canvasY = (paneH / 2 - editor.panY) / editor.zoom;
    editor.zoom = min;
    editor.panX = paneW / 2 - canvasX * min;
    editor.panY = paneH / 2 - canvasY * min;
  }
  clampPan(editor);
}

// The slice of the image, in image pixels, that the pane is showing right now —
// the inverse of applyTransform's CSS (pan, then zoom, then rotate about the
// canvas centre). Under rotation the visible region is a rotated rectangle, and
// this returns its axis-aligned bounding box, which is what a crop can express.
function visibleImageRect(editor) {
  const paneW = editor.pane.clientWidth;
  const paneH = editor.pane.clientHeight;
  const z = editor.zoom;
  if (!paneW || !paneH || !z || !editor.canvas.width || !editor.canvas.height) return null;

  const v = editor.versionIndex >= 0 ? state.versions[editor.versionIndex] : null;
  const rad = -(v ? v.rotation : 0) * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = editor.canvas.width / 2;
  const cy = editor.canvas.height / 2;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [sx, sy] of [[0, 0], [paneW, 0], [0, paneH], [paneW, paneH]]) {
    const ux = (sx - editor.panX) / z - cx;
    const uy = (sy - editor.panY) / z - cy;
    const x = ux * cos - uy * sin + cx;
    const y = ux * sin + uy * cos + cy;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const x = Math.floor(minX);
  const y = Math.floor(minY);
  return { x, y, w: Math.ceil(maxX) - x, h: Math.ceil(maxY) - y };
}

function intersectRect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function currentCropRect(editor) {
  return editor.cropFrame.w > 0 && editor.cropFrame.h > 0
    ? editor.cropFrame
    : { x: 0, y: 0, w: editor.canvas.width, h: editor.canvas.height };
}

// Will the NEXT copy be cropped to the visible area? Off when the setting is
// off, when there is no image, and — the point of the minimum-zoom floor — when
// the whole image is already on show, whatever the pan. Also off when a zoom
// above the floor still leaves nothing hidden (a picture smaller than the pane),
// so the lamp only claims a difference that the clipboard will actually show.
function autoCropActive(editor) {
  if (!appSettings.autoCropToZoom || editor.versionIndex < 0) return false;
  if (atMinZoom(editor)) return false;
  const visible = visibleImageRect(editor);
  if (!visible) return false;
  const crop = currentCropRect(editor);
  const inter = intersectRect(crop, visible);
  return !!inter && (inter.w < crop.w || inter.h < crop.h);
}

function updateAutoCropIndicator() {
  if (!btnAutoCrop) return;
  const editor = activeEditor();
  const on = !!appSettings.autoCropToZoom;
  const active = on && autoCropActive(editor);
  btnAutoCrop.classList.toggle('state-active', active);
  btnAutoCrop.classList.toggle('state-armed', on && !active);
  btnAutoCrop.classList.toggle('state-off', !on);
  btnAutoCrop.setAttribute('aria-pressed', on ? 'true' : 'false');
  btnAutoCrop.title = !on
    ? 'Auto-crop off — Copy takes the whole image (click to turn on)'
    : active
      ? 'Auto-crop on — Copy takes only the visible area (click to turn off)'
      : 'Auto-crop on but idle — at minimum zoom the whole image is copied (click to turn off)';
}

function initCropFrame(editor) {
  editor.cropFrame = {
    x: 0,
    y: 0,
    w: editor.canvas.width,
    h: editor.canvas.height,
  };
  updateCropOverlayDOM(editor);
  editor.cropOverlay.classList.toggle('active', editor.canvas.width > 0);
}

function updateCropOverlayDOM(editor) {
  const { x, y, w, h } = editor.cropFrame;
  editor.cropOverlay.style.left = x + 'px';
  editor.cropOverlay.style.top = y + 'px';
  editor.cropOverlay.style.width = w + 'px';
  editor.cropOverlay.style.height = h + 'px';
}

function applyBC(editor) {
  const v = editor.versionIndex >= 0 ? state.versions[editor.versionIndex] : null;
  if (!v) {
    editor.baseCanvas.style.filter = '';
    return;
  }
  editor.baseCanvas.style.filter = `brightness(${v.brightness / 100}) contrast(${v.contrast / 100})`;
}

function updateActiveControls() {
  updateAutoCropIndicator();
  const v = activeVersion();
  if (!v) {
    brightnessSlider.value = 100;
    contrastSlider.value = 100;
    brightnessValue.textContent = '100';
    contrastValue.textContent = '100';
    rotationDisplay.textContent = '0°';
    return;
  }
  brightnessSlider.value = v.brightness;
  contrastSlider.value = v.contrast;
  brightnessValue.textContent = v.brightness;
  contrastValue.textContent = v.contrast;
  rotationDisplay.textContent = Math.round(((v.rotation % 360) + 360) % 360) + '°';
}

function loadVersionToEditor(editor, v, { preserveView = false, fit = false } = {}) {
  const sameSize = editor.canvas.width === v.annotationData.width && editor.canvas.height === v.annotationData.height;
  editor.baseCanvas.width = v.baseImageData.width;
  editor.baseCanvas.height = v.baseImageData.height;
  editor.baseCtx.putImageData(v.baseImageData, 0, 0);
  editor.canvas.width = v.annotationData.width;
  editor.canvas.height = v.annotationData.height;
  editor.ctx.putImageData(v.annotationData, 0, 0);
  editor.emptyHint.style.display = 'none';
  applyBC(editor);
  applyTransform(editor);
  if (!preserveView || !sameSize) initCropFrame(editor);
  else updateCropOverlayDOM(editor);
  if (fit) fitToArea(editor);
}

function refreshEditorsForVersion(versionIndex, exceptEditor = null) {
  visibleEditors().forEach((editor) => {
    if (editor !== exceptEditor && editor.versionIndex === versionIndex) {
      loadVersionToEditor(editor, state.versions[versionIndex], { preserveView: true });
    }
  });
  updateActiveControls();
}

function markVersionChanged(editor) {
  const v = editor.versionIndex >= 0 ? state.versions[editor.versionIndex] : null;
  if (!v) return;
  v.modified = true;
  saveEditorCanvasToVersion(editor);
  refreshEditorsForVersion(editor.versionIndex, editor);
}

function eraseAtPoint(editor, x, y) {
  editor.ctx.save();
  editor.ctx.globalCompositeOperation = 'destination-out';
  editor.ctx.fillStyle = 'rgba(255,255,255,1)';
  editor.ctx.beginPath();
  editor.ctx.arc(x, y, ERASE_RADIUS, 0, Math.PI * 2);
  editor.ctx.fill();
  editor.ctx.restore();
}

function onCanvasMouseDown(editor, e) {
  focusEditor(editor);
  if (editor.versionIndex < 0) return;
  if (e.button !== 0) return;
  if (e.ctrlKey) return;
  if (state.tool === 'text') return;

  const { x, y } = getCanvasPos(editor, e);
  editor.isDrawing = true;
  editor.startX = x;
  editor.startY = y;
  editor.preActionSnapshot = versionSnapshot(editor, state.versions[editor.versionIndex]);

  if (state.tool === 'erase') {
    eraseAtPoint(editor, x, y);
    return;
  }

  setupCtx(editor);

  if (state.tool === 'draw') {
    editor.ctx.beginPath();
    editor.ctx.moveTo(x, y);
    editor.ctx.lineTo(x + 0.1, y);
    editor.ctx.stroke();
    editor.ctx.beginPath();
    editor.ctx.moveTo(x, y);
  } else {
    editor.snapshot = editor.ctx.getImageData(0, 0, editor.canvas.width, editor.canvas.height);
  }
}

function onCanvasMouseMove(editor, e) {
  if (!editor.isDrawing) return;
  const { x, y } = getCanvasPos(editor, e);

  if (state.tool === 'erase') {
    eraseAtPoint(editor, x, y);
  } else if (state.tool === 'draw') {
    editor.ctx.lineTo(x, y);
    editor.ctx.stroke();
    editor.ctx.beginPath();
    editor.ctx.moveTo(x, y);
  } else {
    editor.ctx.putImageData(editor.snapshot, 0, 0);
    setupCtx(editor);
    drawShapePreview(editor, editor.startX, editor.startY, x, y);
  }
}

function finishDrawing(editor, e = null) {
  if (!editor.isDrawing) return;
  editor.isDrawing = false;

  if (state.tool === 'erase') {
    pushUndo(editor, editor.preActionSnapshot);
    editor.preActionSnapshot = null;
    markVersionChanged(editor);
    return;
  }

  if (state.tool !== 'draw') {
    if (e) {
      const { x, y } = getCanvasPos(editor, e);
      editor.ctx.putImageData(editor.snapshot, 0, 0);
      setupCtx(editor);
      drawShapePreview(editor, editor.startX, editor.startY, x, y);
    }
    editor.snapshot = null;
  } else {
    editor.ctx.closePath();
  }

  pushUndo(editor, editor.preActionSnapshot);
  editor.preActionSnapshot = null;
  markVersionChanged(editor);
}

function onCanvasMouseLeave(editor) {
  if (state.tool === 'draw' || state.tool === 'erase') finishDrawing(editor);
}

function commitText(editor) {
  const val = editor.textInput.value.trim();
  editor.textInputWrapper.style.display = 'none';
  if (!val || editor.versionIndex < 0) return;
  pushVersionUndo(editor);
  setupCtx(editor);
  editor.ctx.font = `${state.textSize}px "Segoe UI", system-ui, sans-serif`;
  editor.ctx.strokeStyle = '#000';
  editor.ctx.lineWidth = 1.5;
  editor.ctx.lineJoin = 'miter';
  editor.ctx.strokeText(val, editor.textClickX, editor.textClickY);
  editor.ctx.fillStyle = state.color;
  editor.ctx.fillText(val, editor.textClickX, editor.textClickY);
  markVersionChanged(editor);
}

function attachEditorEvents(editor) {
  editor.pane.addEventListener('mousedown', (e) => {
    focusEditor(editor);
    if (e.button === 1) {
      e.preventDefault();
      return;
    }
    if (e.button === 2) {
      e.preventDefault();
      editor.isPanning = true;
      editor.panStartX = e.clientX - editor.panX;
      editor.panStartY = e.clientY - editor.panY;
      document.body.style.cursor = 'grabbing';
      return;
    }
    if (e.button === 0 && e.ctrlKey && editor.versionIndex >= 0) {
      e.preventDefault();
      pushVersionUndo(editor);
      editor.isRotating = true;
      const v = state.versions[editor.versionIndex];
      editor.rotateStartAngle = v.rotation;
      const areaRect = editor.pane.getBoundingClientRect();
      const centerX = editor.panX + editor.canvas.width * editor.zoom / 2;
      const centerY = editor.panY + editor.canvas.height * editor.zoom / 2;
      editor.rotateCenter = { x: areaRect.left + centerX, y: areaRect.top + centerY };
      editor.rotateStartMouseAngle = Math.atan2(
        e.clientY - editor.rotateCenter.y,
        e.clientX - editor.rotateCenter.x
      ) * 180 / Math.PI;
      document.body.style.cursor = 'grab';
    }
  });

  editor.pane.addEventListener('wheel', (e) => {
    if (editor.versionIndex < 0) return;
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = clamp(editor.zoom * factor, minZoomFor(editor), 20);
    // A wheel that hits the floor changes nothing, so it must not count as the
    // user "adjusting the view" — that flag is what stops a later resize refitting.
    if (newZoom === editor.zoom) return;
    const rect = editor.pane.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const canvasX = (mouseX - editor.panX) / editor.zoom;
    const canvasY = (mouseY - editor.panY) / editor.zoom;
    editor.zoom = newZoom;
    editor.panX = mouseX - canvasX * newZoom;
    editor.panY = mouseY - canvasY * newZoom;
    editor.viewAdjusted = true;
    clampPan(editor);
    applyTransform(editor);
  }, { passive: false });

  editor.pane.addEventListener('contextmenu', (e) => e.preventDefault());
  editor.canvas.addEventListener('mousedown', (e) => onCanvasMouseDown(editor, e));
  editor.canvas.addEventListener('mousemove', (e) => onCanvasMouseMove(editor, e));
  editor.canvas.addEventListener('mouseup', (e) => finishDrawing(editor, e));
  editor.canvas.addEventListener('mouseleave', () => onCanvasMouseLeave(editor));
  editor.canvas.addEventListener('click', (e) => {
    focusEditor(editor);
    if (state.tool !== 'text' || editor.versionIndex < 0) return;
    const { x, y } = getCanvasPos(editor, e);
    editor.textClickX = x;
    editor.textClickY = y;
    editor.textInputWrapper.style.left = x + 'px';
    editor.textInputWrapper.style.top = (y - 32) + 'px';
    editor.textInput.style.color = state.color;
    editor.textInput.style.fontSize = state.textSize + 'px';
    editor.textInputWrapper.style.display = 'block';
    editor.textInput.value = '';
    editor.textInput.focus();
  });

  editor.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitText(editor);
    }
    if (e.key === 'Escape') {
      editor.textInputWrapper.style.display = 'none';
    }
    e.stopPropagation();
  });

  editor.textInput.addEventListener('blur', (e) => {
    if (editor.textInputWrapper.style.display === 'none') return;
    if (e.relatedTarget === textSizeSelect) return;
    commitText(editor);
  });

  editor.textDragHandle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    focusEditor(editor);
    e.preventDefault();
    e.stopPropagation();
    editor.textDragging = true;
    document.body.style.cursor = 'move';
  });

  editor.cropOverlay.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    focusEditor(editor);
    const isHandle = e.target.classList.contains('crop-handle');
    const mode = isHandle ? e.target.dataset.dir : 'move';
    editor.cropDragging = {
      mode,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startFrame: { ...editor.cropFrame },
    };
    document.body.style.cursor = isHandle ? getComputedStyle(e.target).cursor : 'move';
    e.stopPropagation();
    e.preventDefault();
  });
}

editors.forEach(attachEditorEvents);

document.addEventListener('mousemove', (e) => {
  const rotating = editors.find((editor) => editor.isRotating);
  if (rotating) {
    if (rotating.versionIndex < 0) return;
    const v = state.versions[rotating.versionIndex];
    const mouseAngle = Math.atan2(
      e.clientY - rotating.rotateCenter.y,
      e.clientX - rotating.rotateCenter.x
    ) * 180 / Math.PI;
    v.rotation = rotating.rotateStartAngle + (mouseAngle - rotating.rotateStartMouseAngle);
    v.modified = true;
    visibleEditors()
      .filter((editor) => editor.versionIndex === rotating.versionIndex)
      .forEach(applyTransform);
    updateActiveControls();
    return;
  }

  const panning = editors.find((editor) => editor.isPanning);
  if (panning) {
    panning.panX = e.clientX - panning.panStartX;
    panning.panY = e.clientY - panning.panStartY;
    panning.viewAdjusted = true;
    clampPan(panning);
    applyTransform(panning);
    return;
  }

  const textEditor = editors.find((editor) => editor.textDragging);
  if (textEditor) {
    textEditor.textClickX += e.movementX / textEditor.zoom;
    textEditor.textClickY += e.movementY / textEditor.zoom;
    textEditor.textInputWrapper.style.left = textEditor.textClickX + 'px';
    textEditor.textInputWrapper.style.top = (textEditor.textClickY - 32) + 'px';
    return;
  }

  const cropEditor = editors.find((editor) => editor.cropDragging);
  if (!cropEditor) return;

  const dx = (e.clientX - cropEditor.cropDragging.startMouseX) / cropEditor.zoom;
  const dy = (e.clientY - cropEditor.cropDragging.startMouseY) / cropEditor.zoom;
  const sf = cropEditor.cropDragging.startFrame;
  const imgW = cropEditor.canvas.width;
  const imgH = cropEditor.canvas.height;
  const min = 10;
  let { x, y, w, h } = sf;
  const mode = cropEditor.cropDragging.mode;

  if (mode === 'move') {
    x = Math.max(0, Math.min(sf.x + dx, imgW - sf.w));
    y = Math.max(0, Math.min(sf.y + dy, imgH - sf.h));
  } else {
    if (mode.includes('n')) {
      const ny = sf.y + dy;
      const nh = sf.h - dy;
      if (nh >= min) { y = ny; h = nh; }
    }
    if (mode.includes('s')) {
      const nh = sf.h + dy;
      if (nh >= min) h = nh;
    }
    if (mode.includes('w')) {
      const nx = sf.x + dx;
      const nw = sf.w - dx;
      if (nw >= min) { x = nx; w = nw; }
    }
    if (mode.includes('e')) {
      const nw = sf.w + dx;
      if (nw >= min) w = nw;
    }
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > imgW) w = imgW - x;
    if (y + h > imgH) h = imgH - y;
    w = Math.max(min, w);
    h = Math.max(min, h);
  }

  cropEditor.cropFrame = { x, y, w, h };
  updateCropOverlayDOM(cropEditor);
});

document.addEventListener('mouseup', (e) => {
  const rotating = editors.find((editor) => editor.isRotating);
  if (rotating && e.button === 0) {
    rotating.isRotating = false;
    document.body.style.cursor = '';
    return;
  }
  const panning = editors.find((editor) => editor.isPanning);
  if (panning && e.button === 2) {
    panning.isPanning = false;
    document.body.style.cursor = '';
    return;
  }
  const textEditor = editors.find((editor) => editor.textDragging);
  if (textEditor && e.button === 0) {
    textEditor.textDragging = false;
    document.body.style.cursor = '';
    textEditor.textInput.focus();
    return;
  }
  const cropEditor = editors.find((editor) => editor.cropDragging);
  if (!cropEditor) return;
  cropEditor.cropDragging = null;
  document.body.style.cursor = '';
});

function undo() {
  const editor = activeEditor();
  if (editor.versionIndex < 0) return;
  const v = state.versions[editor.versionIndex];
  if (!v.undoStack.length) return;
  const current = versionSnapshot(editor, v);
  if (!current) return;
  v.redoStack.push(current);
  restoreVersionSnapshot(editor, v, v.undoStack.pop());
  v.modified = true;
  refreshEditorsForVersion(editor.versionIndex, editor);
  showToast('Undo');
}

function redo() {
  const editor = activeEditor();
  if (editor.versionIndex < 0) return;
  const v = state.versions[editor.versionIndex];
  if (!v.redoStack.length) return;
  const current = versionSnapshot(editor, v);
  if (!current) return;
  v.undoStack.push(current);
  restoreVersionSnapshot(editor, v, v.redoStack.pop());
  v.modified = true;
  refreshEditorsForVersion(editor.versionIndex, editor);
  showToast('Redo');
}

function renderTabs() {
  // Full rebuild collapses scrollWidth to 0 mid-way, which resets scrollLeft;
  // save and restore it so wheel-scrolled tab position survives a re-render.
  const savedScroll = tabBar.scrollLeft;
  tabBar.querySelectorAll('.tab').forEach((tab) => tab.remove());
  const focused = activeEditor();

  state.versions.forEach((v, i) => {
    const tab = document.createElement('div');
    const unavailable = isVersionOpenInOtherEditor(focused, i);
    tab.className =
      'tab' +
      (i === focused.versionIndex ? ' active' : '') +
      (unavailable ? ' unavailable' : '');
    if (unavailable) tab.title = 'Already open in the other editor';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = String(i + 1);
    tab.appendChild(nameSpan);

    if (i > 0) {
      const closeBtn = document.createElement('span');
      closeBtn.className = 'tab-close';
      closeBtn.textContent = 'x';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeVersion(i);
      });
      tab.appendChild(closeBtn);
    }

    tab.addEventListener('click', () => switchFocusedEditorToVersion(i));
    tabBar.insertBefore(tab, tabSpacer);
  });

  tabBar.scrollLeft = savedScroll;
}

function switchFocusedEditorToVersion(idx) {
  const editor = activeEditor();
  if (idx < 0 || idx >= state.versions.length) return;
  if (isVersionOpenInOtherEditor(editor, idx)) {
    showToast('That tab is already open in the other editor');
    return;
  }
  const prevW = editor.canvas.width;
  const prevH = editor.canvas.height;
  saveVisibleEditorsToVersions();
  editor.versionIndex = idx;
  state.activeVersion = idx;
  const v = state.versions[idx];
  // Compare the incoming version's size to the current canvas (loadVersionToEditor
  // is about to overwrite canvas.width, so this must be read from v, not the canvas).
  // Fit on a size change; otherwise preserve the current zoom/pan.
  const sizeChanged = v.annotationData.width !== prevW || v.annotationData.height !== prevH;
  loadVersionToEditor(editor, v, { fit: sizeChanged });
  renderTabs();
  updateActiveControls();
}

function makeVersion(baseImageData, annotationData, filePath = null) {
  return {
    name: String(state.versions.length + 1),
    baseImageData,
    annotationData,
    brightness: 100,
    contrast: 100,
    rotation: 0,
    filePath,
    manualFileName: false,
    modified: false,
    undoStack: [],
    redoStack: [],
  };
}

function closeVersion(idx) {
  if (idx === 0 || idx >= state.versions.length) return;
  saveVisibleEditorsToVersions();
  state.versions.splice(idx, 1);
  state.versions.forEach((v, i) => { v.name = String(i + 1); });

  editors.forEach((editor) => {
    if (editor.versionIndex === idx) {
      editor.versionIndex = Math.min(idx, state.versions.length - 1);
    } else if (editor.versionIndex > idx) {
      editor.versionIndex -= 1;
    }
    if (editor.versionIndex >= 0 && !editor.pane.hidden) {
      loadVersionToEditor(editor, state.versions[editor.versionIndex], { fit: true });
    }
  });

  ensureUniqueVisibleEditors();
  state.activeVersion = activeEditor().versionIndex;
  renderTabs();
  updateActiveControls();
}

function clearWorkspace(showMessage = true) {
  state.versions = [];
  state.activeVersion = -1;
  editors.forEach(clearEditor);
  // Drop measurement guides so they don't re-anchor onto a future, unrelated image.
  state.measure.refSet = false;
  state.measure.ref = { x: 0, y: 0, w: 1, h: 1 };
  state.measure.hMarks = [];
  state.measure.vMarks = [];
  focusEditor(editors[0]);
  renderTabs();
  updateActiveControls();
  renderMeasure();
  if (showMessage) showToast('Workspace cleared');
}

btnClearWorkspace.addEventListener('click', () => clearWorkspace());

// Vertical wheel over the tab-bar scrolls it horizontally, so tabs stay
// reachable as they accumulate past the visible width.
tabBar.addEventListener('wheel', (e) => {
  if (e.deltaY === 0) return;
  if (tabBar.scrollWidth <= tabBar.clientWidth) return;
  tabBar.scrollLeft += e.deltaY;
  e.preventDefault();
}, { passive: false });

function setSplitMode(on) {
  saveVisibleEditorsToVersions();
  state.splitMode = on;
  btnToggleSplit.classList.toggle('active', on);
  btnToggleSplit.textContent = on ? 'Single' : 'Split';

  const left = editors[0];
  const right = editors[1];
  right.pane.hidden = !on;

  if (on) {
    if (right.versionIndex < 0 && state.versions.length) {
      right.versionIndex = firstAvailableVersionIndex(right, state.versions.length > 1 && left.versionIndex === 0 ? 1 : 0);
    }
    if (right.versionIndex >= 0) {
      loadVersionToEditor(right, state.versions[right.versionIndex], { fit: true });
    } else {
      clearEditor(right);
    }
    // Leaving split with the RIGHT pane focused copies its version into the left
    // pane while the right pane keeps its own — so re-entering split would bind
    // BOTH panes to one version, which makes that tab render as active *and*
    // "already open in the other editor", unselectable in either pane.
    ensureUniqueVisibleEditors();
    fitToArea(left);
    focusEditor(activeEditor().pane.hidden ? left : activeEditor());
  } else {
    if (state.focusedEditorIndex === 1 && right.versionIndex >= 0) {
      left.versionIndex = right.versionIndex;
      loadVersionToEditor(left, state.versions[left.versionIndex], { fit: true });
    }
    focusEditor(left);
    fitToArea(left);
  }

  renderTabs();
  renderMeasure();
}

btnToggleSplit.addEventListener('click', () => setSplitMode(!state.splitMode));

function addImageFromDataURL(dataURL, { filePath = null, saveCurrent = true, toastMessage = null } = {}) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // Everything below can throw on a big picture — an over-budget canvas
      // reads back as blank, and the ImageData allocation is refused outright.
      // An escaping throw here never settles the promise, so callers that await
      // it (Open Images loops over every file) hang with no error and no toast.
      try {
        if (exceedsCanvasBudget(img.width, img.height)) {
          showToast(`Image too large to open (${img.width}x${img.height})`);
          resolve(false);
          return;
        }
        if (saveCurrent) saveVisibleEditorsToVersions();
        const baseTmp = document.createElement('canvas');
        baseTmp.width = img.width;
        baseTmp.height = img.height;
        const baseTmpCtx = baseTmp.getContext('2d');
        baseTmpCtx.drawImage(img, 0, 0);
        const baseImageData = baseTmpCtx.getImageData(0, 0, img.width, img.height);
        const annotationData = new ImageData(img.width, img.height);
        const newIdx = state.versions.length;
        state.versions.push(makeVersion(baseImageData, annotationData, filePath));
        const editor = activeEditor();
        editor.versionIndex = newIdx;
        state.activeVersion = newIdx;
        loadVersionToEditor(editor, state.versions[newIdx], { fit: true });
        renderTabs();
        updateActiveControls();
        if (toastMessage) showToast(toastMessage(newIdx));
        resolve(true);
      } catch (error) {
        console.error('Failed to import image:', error);
        showToast('Could not open that image — out of memory');
        resolve(false);
      }
    };
    img.onerror = () => resolve(false);
    img.src = dataURL;
  });
}

async function pasteFromClipboard() {
  const dataURL = await window.annotatorAPI.readClipboardImage();
  if (!dataURL) {
    showToast('No image in clipboard');
    return;
  }
  await addImageFromDataURL(dataURL, {
    toastMessage: (idx) => `Pasted as ${idx + 1}`,
  });
}

document.addEventListener('keydown', (e) => {
  // e.key is 'Z' (uppercase) while Shift is held, so both cases are matched
  // explicitly; Ctrl+Shift+Z is the usual redo alias alongside Ctrl+Y.
  const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  if (e.ctrlKey && key === 'z' && !e.shiftKey && !hasActiveTextInput()) {
    e.preventDefault();
    undo();
  }
  if (e.ctrlKey && (key === 'y' || (key === 'z' && e.shiftKey)) && !hasActiveTextInput()) {
    e.preventDefault();
    redo();
  }
  if (e.ctrlKey && e.key === 'v') {
    e.preventDefault();
    pasteFromClipboard();
  }
  if (e.ctrlKey && e.key === 'c' && !hasActiveTextInput()) {
    e.preventDefault();
    copyImage();
  }
  if (e.ctrlKey && e.key === 's') {
    e.preventDefault();
    save();
  }
});

document.addEventListener('paste', (e) => {
  // Let a focused text-annotation input receive the native text paste instead of
  // hijacking it into an image paste.
  if (hasActiveTextInput()) return;
  e.preventDefault();
  pasteFromClipboard();
});

document.querySelectorAll('.tool-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.tool = btn.dataset.tool;
    document.querySelectorAll('.tool-btn').forEach((candidate) => candidate.classList.remove('active'));
    btn.classList.add('active');
    editors.forEach((editor) => {
      editor.canvas.style.cursor = state.tool === 'text' ? 'text' : 'crosshair';
      if (state.tool !== 'text') editor.textInputWrapper.style.display = 'none';
    });
  });
});

function setColor(hex) {
  state.color = hex;
  colorPickerInput.value = hex;
  editors.forEach((editor) => {
    if (editor.textInputWrapper.style.display !== 'none') editor.textInput.style.color = hex;
  });
}

function markColorActive(activeEl) {
  document.querySelectorAll('.color-swatch').forEach((swatch) => swatch.classList.remove('active'));
  btnCustomColor.classList.remove('active');
  if (activeEl) activeEl.classList.add('active');
}

document.querySelectorAll('.color-swatch').forEach((swatch) => {
  swatch.addEventListener('mousedown', (e) => {
    if (editors.some((editor) => editor.textInputWrapper.style.display !== 'none')) e.preventDefault();
  });
  swatch.addEventListener('click', () => {
    setColor(swatch.dataset.color);
    markColorActive(swatch);
    btnCustomColor.style.color = swatch.dataset.color;
  });
});

btnCustomColor.addEventListener('mousedown', (e) => {
  if (editors.some((editor) => editor.textInputWrapper.style.display !== 'none')) e.preventDefault();
});

btnCustomColor.addEventListener('click', () => colorPickerInput.click());

colorPickerInput.addEventListener('input', () => {
  setColor(colorPickerInput.value);
  btnCustomColor.style.color = colorPickerInput.value;
  markColorActive(null);
  btnCustomColor.classList.add('active');
  const editor = activeEditor();
  if (editor.textInputWrapper.style.display !== 'none') editor.textInput.focus();
});

btnCustomColor.style.color = state.color;

textSizeSelect.addEventListener('change', () => {
  state.textSize = parseInt(textSizeSelect.value, 10);
  editors.forEach((editor) => {
    if (editor.textInputWrapper.style.display !== 'none') {
      editor.textInput.style.fontSize = state.textSize + 'px';
      editor.textInput.focus();
    }
  });
});

// A slider drag fires `input` continuously; record the pre-drag state once at
// the start of the gesture and commit that single entry on `change` (release),
// so one drag is one undo step rather than a hundred.
const sliderGestureSnapshots = new Map();

function beginSliderUndo(slider) {
  if (sliderGestureSnapshots.has(slider)) return;
  const editor = activeEditor();
  const snap = versionSnapshot(editor, activeVersion());
  if (snap) sliderGestureSnapshots.set(slider, snap);
}

function endSliderUndo(slider) {
  const snap = sliderGestureSnapshots.get(slider);
  sliderGestureSnapshots.delete(slider);
  if (snap) pushUndo(activeEditor(), snap);
}

brightnessSlider.addEventListener('change', () => endSliderUndo(brightnessSlider));
contrastSlider.addEventListener('change', () => endSliderUndo(contrastSlider));

brightnessSlider.addEventListener('input', () => {
  const v = activeVersion();
  if (!v) return;
  beginSliderUndo(brightnessSlider);
  v.brightness = parseInt(brightnessSlider.value, 10);
  v.modified = true;
  brightnessValue.textContent = v.brightness;
  visibleEditors()
    .filter((editor) => editor.versionIndex === activeEditor().versionIndex)
    .forEach(applyBC);
});

contrastSlider.addEventListener('input', () => {
  const v = activeVersion();
  if (!v) return;
  beginSliderUndo(contrastSlider);
  v.contrast = parseInt(contrastSlider.value, 10);
  v.modified = true;
  contrastValue.textContent = v.contrast;
  visibleEditors()
    .filter((editor) => editor.versionIndex === activeEditor().versionIndex)
    .forEach(applyBC);
});

btnResetBrightness.addEventListener('click', () => {
  const v = activeVersion();
  if (!v) return;
  pushVersionUndo();
  v.brightness = 100;
  v.modified = true;
  visibleEditors()
    .filter((editor) => editor.versionIndex === activeEditor().versionIndex)
    .forEach(applyBC);
  updateActiveControls();
});

btnResetContrast.addEventListener('click', () => {
  const v = activeVersion();
  if (!v) return;
  pushVersionUndo();
  v.contrast = 100;
  v.modified = true;
  visibleEditors()
    .filter((editor) => editor.versionIndex === activeEditor().versionIndex)
    .forEach(applyBC);
  updateActiveControls();
});

btnRotateCW.addEventListener('click', () => {
  const v = activeVersion();
  if (!v) return;
  pushVersionUndo();
  v.rotation = ((v.rotation + 90) % 360 + 360) % 360;
  v.modified = true;
  refreshEditorsForVersion(activeEditor().versionIndex);
  visibleEditors()
    .filter((editor) => editor.versionIndex === activeEditor().versionIndex)
    .forEach(applyTransform);
});

btnRotateCCW.addEventListener('click', () => {
  const v = activeVersion();
  if (!v) return;
  pushVersionUndo();
  v.rotation = ((v.rotation - 90) % 360 + 360) % 360;
  v.modified = true;
  refreshEditorsForVersion(activeEditor().versionIndex);
  visibleEditors()
    .filter((editor) => editor.versionIndex === activeEditor().versionIndex)
    .forEach(applyTransform);
});

btnResetRotation.addEventListener('click', () => {
  const v = activeVersion();
  if (!v) return;
  pushVersionUndo();
  v.rotation = 0;
  v.modified = true;
  visibleEditors()
    .filter((editor) => editor.versionIndex === activeEditor().versionIndex)
    .forEach(applyTransform);
  updateActiveControls();
});

function getOutputDataURL(editor, scale = 1, { autoCrop = false } = {}) {
  const v = editor.versionIndex >= 0 ? state.versions[editor.versionIndex] : null;
  if (!v) return null;

  const baseTmp = imageDataToCanvas(v.baseImageData);
  const annTmp = imageDataToCanvas(v.annotationData);
  const fullW = v.baseImageData.width;
  const fullH = v.baseImageData.height;
  let crop = currentCropRect(editor);
  if (!(crop.w > 0 && crop.h > 0)) crop = { x: 0, y: 0, w: fullW, h: fullH };
  let cropped = false;
  if (autoCrop) {
    // Narrow the crop to what the pane is showing at this instant. Intersected,
    // never substituted: a manual crop frame still bounds the result, and the
    // empty pane around a panned-away image never reaches the output.
    const visible = visibleImageRect(editor);
    const inter = visible && intersectRect(crop, visible);
    if (inter) {
      cropped = inter.w < crop.w || inter.h < crop.h;
      crop = inter;
    }
  }
  const x = Math.max(0, Math.min(crop.x, fullW - 1));
  const y = Math.max(0, Math.min(crop.y, fullH - 1));
  const w = Math.max(1, Math.min(crop.w, fullW - x));
  const h = Math.max(1, Math.min(crop.h, fullH - y));
  const rad = v.rotation * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));

  // Rotation inflates the output (a 45deg turn of a square needs ~2x the area),
  // so a picture that imported fine can still overflow the canvas budget here.
  // Shrink to fit rather than emit an empty image, and say so.
  let s = scale;
  let note = null;
  const wantW = Math.max(1, Math.round((w * cos + h * sin) * s));
  const wantH = Math.max(1, Math.round((w * sin + h * cos) * s));
  const fit = canvasFitFactor(wantW, wantH);
  if (fit < 1) s = scale * fit;

  const outW = Math.max(1, Math.round((w * cos + h * sin) * s));
  const outH = Math.max(1, Math.round((w * sin + h * cos) * s));
  if (fit < 1) note = `downscaled to ${outW}x${outH} (canvas limit)`;

  const tmp = document.createElement('canvas');
  tmp.width = outW;
  tmp.height = outH;
  const tCtx = tmp.getContext('2d');

  tCtx.translate(outW / 2, outH / 2);
  tCtx.rotate(rad);
  tCtx.translate(-(w * s) / 2, -(h * s) / 2);
  tCtx.filter = `brightness(${v.brightness / 100}) contrast(${v.contrast / 100})`;
  tCtx.drawImage(baseTmp, x, y, w, h, 0, 0, w * s, h * s);
  tCtx.filter = 'none';
  tCtx.drawImage(annTmp, x, y, w, h, 0, 0, w * s, h * s);

  const dataURL = tmp.toDataURL('image/png');
  // Last line of defence: never hand a caller something that isn't a PNG. An
  // over-budget canvas yields the 6-character "data:," and every downstream
  // consumer (disk, clipboard) would accept it silently.
  if (!dataURL.startsWith('data:image/png') || dataURL.length < 64) return null;
  if (cropped) note = note ? `visible area, ${note}` : 'visible area';
  return { dataURL, note };
}

function autoTimestamp() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

function joinPath(folder, name) {
  return folder.replace(/[\\/]+$/, '') + '/' + name;
}

async function ensureSaveFolder() {
  if (!state.saveFolder) {
    const folder = await window.annotatorAPI.getDefaultSaveFolder();
    if (!folder) {
      showToast('No save folder available');
      return null;
    }
    state.saveFolder = folder;
    localStorage.setItem('saveFolder', folder);
    updateFolderDisplay();
  }
  const ok = await window.annotatorAPI.ensureFolder(state.saveFolder);
  if (!ok) {
    showToast('Save folder unavailable');
    return null;
  }
  return state.saveFolder;
}

async function save() {
  const editor = activeEditor();
  if (editor.versionIndex < 0) {
    showToast('No image loaded');
    return;
  }
  saveVisibleEditorsToVersions();
  const v = state.versions[editor.versionIndex];
  let filePath = v.filePath;
  let savedName = null;

  if (!filePath) {
    const folder = await ensureSaveFolder();
    if (!folder) return;
    savedName = `screenshot_${autoTimestamp()}_${editor.versionIndex + 1}.png`;
    filePath = joinPath(folder, savedName);
  }

  const out = getOutputDataURL(editor, 1);
  if (!out) {
    showToast('Export failed — image too large to render');
    return;
  }

  const ok = await window.annotatorAPI.saveFile({ path: filePath, dataURL: out.dataURL });
  if (ok) {
    v.filePath = filePath;
    v.modified = false;
    const base = savedName ? `Saved: ${savedName}` : 'Saved';
    showToast(out.note ? `${base} — ${out.note}` : base);
  } else {
    showToast('Save failed');
  }
}

async function saveAs() {
  const editor = activeEditor();
  if (editor.versionIndex < 0) return;
  saveVisibleEditorsToVersions();
  const out = getOutputDataURL(editor, 1);
  if (!out) {
    showToast('Export failed — image too large to render');
    return;
  }
  const filePath = await window.annotatorAPI.saveFileAs({
    dataURL: out.dataURL,
    defaultName: `screenshot_${autoTimestamp()}_${editor.versionIndex + 1}.png`,
  });
  if (filePath) {
    const v = state.versions[editor.versionIndex];
    v.filePath = filePath;
    v.manualFileName = true;
    v.modified = false;
    showToast(out.note ? `Saved — ${out.note}` : 'Saved');
  }
}

async function copyImage() {
  const editor = activeEditor();
  if (editor.versionIndex < 0) {
    showToast('No image loaded');
    return;
  }
  saveVisibleEditorsToVersions();
  const out = getOutputDataURL(editor, copyScale, { autoCrop: autoCropActive(editor) });
  if (!out) {
    showToast('Copy failed — image too large to render');
    return;
  }
  const ok = await window.annotatorAPI.writeClipboardImage(out.dataURL);
  if (!ok) {
    showToast('Copy failed');
    return;
  }
  showToast(out.note ? `Copied — ${out.note}` : 'Copied to clipboard');
}

btnSave.addEventListener('click', save);
btnSaveAs.addEventListener('click', saveAs);
btnCopyImage.addEventListener('click', copyImage);

function setScaleMenuOpen(open) {
  scaleDropdown.classList.toggle('open', open);
  scaleTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
}

scaleTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  setScaleMenuOpen(!scaleDropdown.classList.contains('open'));
});

scaleMenu.addEventListener('click', (e) => {
  const option = e.target.closest('.scale-option');
  if (!option) return;
  copyScale = parseFloat(option.dataset.value);
  scaleTriggerLabel.textContent = option.textContent;
  scaleMenu.querySelectorAll('.scale-option').forEach((el) =>
    el.classList.toggle('selected', el === option));
  setScaleMenuOpen(false);
});

document.addEventListener('click', () => setScaleMenuOpen(false));

function updateFolderDisplay() {
  folderDisplay.textContent = state.saveFolder || 'No folder selected';
}

btnOpenFolder.addEventListener('click', async () => {
  const picked = await window.annotatorAPI.pickImages(state.saveFolder);
  if (!picked) return;
  const filePaths = Array.isArray(picked) ? picked : [picked];
  let opened = 0;
  for (const filePath of filePaths) {
    const dataURL = await window.annotatorAPI.readImageFile(filePath);
    if (dataURL && await addImageFromDataURL(dataURL)) opened++;
  }
  if (opened === 0) {
    showToast('No supported images opened');
  } else {
    showToast(opened === 1 ? 'Opened 1 image' : `Opened ${opened} images`);
  }
});

btnPickFolder.addEventListener('click', async () => {
  const folder = await window.annotatorAPI.pickFolder();
  if (!folder) return;
  state.saveFolder = folder;
  localStorage.setItem('saveFolder', folder);
  updateFolderDisplay();
  showToast('Folder set');
});

/* ── Relative measurement layer ─────────────────────────────────────────── */

let measureDrag = null;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// Pointer position as a fraction (0..1) of the SCREENSHOT, via the editor's
// pan/zoom (rotation ignored so guides stay screen-axis-aligned).
function imgFracFromEvent(editor, e) {
  const r = editor.pane.getBoundingClientRect();
  const W = editor.canvas.width;
  const H = editor.canvas.height;
  const z = editor.zoom || 1;
  return {
    fx: W ? ((e.clientX - r.left) - editor.panX) / (W * z) : 0,
    fy: H ? ((e.clientY - r.top) - editor.panY) / (H * z) : 0,
  };
}

function sortedBoundaries(marks) {
  return [0, ...[...marks].sort((a, b) => a - b), 1];
}

function buildMeasureHTML(m, editor) {
  const ref = m.ref;
  const W = editor.canvas.width;
  const H = editor.canvas.height;
  const z = editor.zoom || 1;
  // Reference rect in pane (screen) pixels, anchored to the image content.
  const sx = editor.panX + ref.x * W * z;
  const sy = editor.panY + ref.y * H * z;
  const sw = ref.w * W * z;
  const sh = ref.h * H * z;
  const pct = (n) => (n * 100) + '%';

  let marks = '';
  m.hMarks.forEach((f, i) => {
    marks += `<div class="m-mark m-mark-h" data-axis="h" data-i="${i}" style="left:${pct(f)}"></div>`;
  });
  m.vMarks.forEach((f, i) => {
    marks += `<div class="m-mark m-mark-v" data-axis="v" data-i="${i}" style="top:${pct(f)}"></div>`;
  });

  let labels = '';
  const hb = sortedBoundaries(m.hMarks);
  for (let i = 0; i < hb.length - 1; i++) {
    const mid = (hb[i] + hb[i + 1]) / 2;
    labels += `<div class="m-label m-label-h" style="left:${pct(mid)}">${Math.round((hb[i + 1] - hb[i]) * 100)}%</div>`;
  }
  const vb = sortedBoundaries(m.vMarks);
  for (let i = 0; i < vb.length - 1; i++) {
    const mid = (vb[i] + vb[i + 1]) / 2;
    labels += `<div class="m-label m-label-v" style="top:${pct(mid)}">${Math.round((vb[i + 1] - vb[i]) * 100)}%</div>`;
  }

  let handles = '';
  ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach((dir) => {
    handles += `<div class="m-handle" data-dir="${dir}"></div>`;
  });

  return `<div class="m-ref axis-${m.axis}" style="left:${sx}px;top:${sy}px;width:${sw}px;height:${sh}px">` +
    `<div class="m-badge">ref 100%</div>${marks}${labels}${handles}</div>`;
}

function renderMeasureEditor(editor) {
  const m = state.measure;
  const layer = editor.measureLayer;
  if (!layer) return;
  // Needs an image to anchor to; hide when off / hidden / empty.
  if (!m.on || editor.pane.hidden || editor.versionIndex < 0 || !editor.canvas.width) {
    layer.classList.remove('on');
    layer.innerHTML = '';
    layer.style.opacity = '';
    return;
  }
  layer.classList.add('on');
  layer.style.opacity = String(appSettings.measureOpacity);
  layer.innerHTML = buildMeasureHTML(m, editor);
}

function renderMeasure() {
  editors.forEach(renderMeasureEditor);
}

// The reference the layer starts with when activated and the user hasn't set one.
function defaultReferenceRect(editor) {
  if (appSettings.measureDefaultScreenshot || !editor || editor.versionIndex < 0 || !editor.canvas.width) {
    return { x: 0, y: 0, w: 1, h: 1 }; // full screenshot
  }
  // "App width": the pane's visible extent expressed in image fractions.
  const W = editor.canvas.width;
  const H = editor.canvas.height;
  const z = editor.zoom || 1;
  const paneW = editor.pane.clientWidth;
  const paneH = editor.pane.clientHeight;
  const x = (0 - editor.panX) / (W * z);
  const y = (0 - editor.panY) / (H * z);
  return { x, y, w: paneW / (W * z), h: paneH / (H * z) };
}

function setMeasureOn(on) {
  state.measure.on = on;
  btnMeasure.classList.toggle('active', on);
  measureControls.hidden = !on;
  if (on && !state.measure.refSet) {
    state.measure.ref = defaultReferenceRect(activeEditor());
  }
  renderMeasure();
}

function setMeasureAxis(axis) {
  state.measure.axis = axis;
  measureAxisButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.axis === axis));
  renderMeasure();
}

function addMeasureMarker(fx, fy) {
  const m = state.measure;
  // Skip near-duplicates so a double-click on the reference doesn't stack two
  // overlapping markers at (almost) the same spot.
  const notNear = (arr, f) => !arr.some((g) => Math.abs(g - f) < 0.01);
  if (m.axis === 'h') {
    const f = (fx - m.ref.x) / m.ref.w;
    if (f > 0.01 && f < 0.99 && notNear(m.hMarks, f)) { m.hMarks.push(f); m.hMarks.sort((a, b) => a - b); }
  } else {
    const f = (fy - m.ref.y) / m.ref.h;
    if (f > 0.01 && f < 0.99 && notNear(m.vMarks, f)) { m.vMarks.push(f); m.vMarks.sort((a, b) => a - b); }
  }
  renderMeasure();
}

function attachMeasureEvents(editor) {
  const layer = editor.measureLayer;

  layer.addEventListener('mousedown', (e) => {
    if (!state.measure.on || e.button !== 0) return;
    focusEditor(editor);
    const m = state.measure;
    const target = e.target;

    if (target.classList.contains('m-handle')) {
      measureDrag = { type: 'resize', dir: target.dataset.dir, editor, start: imgFracFromEvent(editor, e), ref0: { ...m.ref } };
    } else if (target.classList.contains('m-mark')) {
      measureDrag = { type: 'mark', axis: target.dataset.axis, i: +target.dataset.i, editor, start: imgFracFromEvent(editor, e), moved: false };
    } else if (target.classList.contains('m-ref') || target.classList.contains('m-label') || target.classList.contains('m-badge')) {
      measureDrag = { type: 'refmove', editor, start: imgFracFromEvent(editor, e), ref0: { ...m.ref }, moved: false };
    } else {
      return; // clicks on the transparent layer fall through to the canvas
    }
    e.stopPropagation();
    e.preventDefault();
  });

  layer.addEventListener('dblclick', (e) => {
    if (!e.target.classList.contains('m-mark')) return;
    const m = state.measure;
    const arr = e.target.dataset.axis === 'h' ? m.hMarks : m.vMarks;
    arr.splice(+e.target.dataset.i, 1);
    renderMeasure();
    e.stopPropagation();
  });
}

document.addEventListener('mousemove', (e) => {
  if (!measureDrag) return;
  const m = state.measure;
  const cur = imgFracFromEvent(measureDrag.editor, e);

  if (measureDrag.type === 'resize') {
    const dx = cur.fx - measureDrag.start.fx;
    const dy = cur.fy - measureDrag.start.fy;
    const r0 = measureDrag.ref0;
    const min = 0.02;
    let { x, y, w, h } = r0;
    const dir = measureDrag.dir;
    // No 0..1 clamp: the reference may sit anywhere over (or beyond) the image.
    if (dir.includes('w')) { x = Math.min(r0.x + dx, r0.x + r0.w - min); w = r0.x + r0.w - x; }
    if (dir.includes('e')) { w = Math.max(min, r0.w + dx); }
    if (dir.includes('n')) { y = Math.min(r0.y + dy, r0.y + r0.h - min); h = r0.y + r0.h - y; }
    if (dir.includes('s')) { h = Math.max(min, r0.h + dy); }
    m.ref = { x, y, w, h };
    m.refSet = true;
    renderMeasure();
  } else if (measureDrag.type === 'refmove') {
    const dx = cur.fx - measureDrag.start.fx;
    const dy = cur.fy - measureDrag.start.fy;
    if (Math.abs(dx) > 0.004 || Math.abs(dy) > 0.004) measureDrag.moved = true;
    if (measureDrag.moved) {
      m.ref.x = measureDrag.ref0.x + dx;
      m.ref.y = measureDrag.ref0.y + dy;
      m.refSet = true;
      renderMeasure();
    }
  } else if (measureDrag.type === 'mark') {
    // Ignore sub-threshold movement so a plain click never rebuilds the DOM —
    // rebuilding would detach the marker mid double-click and kill click-to-delete.
    if (!measureDrag.moved &&
        Math.abs(cur.fx - measureDrag.start.fx) < 0.004 &&
        Math.abs(cur.fy - measureDrag.start.fy) < 0.004) return;
    measureDrag.moved = true;
    // Don't re-sort mid-drag: it would shuffle indices under the pointer.
    if (measureDrag.axis === 'h') {
      m.hMarks[measureDrag.i] = clamp((cur.fx - m.ref.x) / m.ref.w, 0.001, 0.999);
    } else {
      m.vMarks[measureDrag.i] = clamp((cur.fy - m.ref.y) / m.ref.h, 0.001, 0.999);
    }
    renderMeasure();
  }
});

document.addEventListener('mouseup', () => {
  if (!measureDrag) return;
  if (measureDrag.type === 'refmove' && !measureDrag.moved) {
    addMeasureMarker(measureDrag.start.fx, measureDrag.start.fy);
  } else if (measureDrag.type === 'mark' && measureDrag.moved) {
    // Only reorder + re-render if the marker was actually dragged; a plain click
    // must leave the DOM intact so a following dblclick can delete it.
    state.measure.hMarks.sort((a, b) => a - b);
    state.measure.vMarks.sort((a, b) => a - b);
    renderMeasure();
  }
  measureDrag = null;
});

function drawMeasureLabel(ctx, text, x, y) {
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = state.color;
  ctx.fillText(text, x, y);
}

function bakeMeasure() {
  const editor = activeEditor();
  if (editor.versionIndex < 0) {
    showToast('No image to bake into');
    return;
  }
  const m = state.measure;
  const W = editor.canvas.width;
  const H = editor.canvas.height;
  // Reference rect in image pixels — coords are already image fractions.
  const rx = m.ref.x * W;
  const ry = m.ref.y * H;
  const rw = m.ref.w * W;
  const rh = m.ref.h * H;

  pushVersionUndo(editor);

  const ctx = editor.ctx;
  ctx.save();
  ctx.strokeStyle = state.color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.font = '600 15px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const vline = (x) => { ctx.beginPath(); ctx.moveTo(x, ry); ctx.lineTo(x, ry + rh); ctx.stroke(); };
  const hline = (y) => { ctx.beginPath(); ctx.moveTo(rx, y); ctx.lineTo(rx + rw, y); ctx.stroke(); };

  // Reference outline (dashed)
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.setLineDash([]);

  // Width dividers + segment labels along the top edge
  m.hMarks.forEach((f) => vline(rx + f * rw));
  const hb = sortedBoundaries(m.hMarks);
  for (let i = 0; i < hb.length - 1; i++) {
    drawMeasureLabel(ctx, Math.round((hb[i + 1] - hb[i]) * 100) + '%', rx + ((hb[i] + hb[i + 1]) / 2) * rw, ry + 14);
  }

  // Height dividers + segment labels along the left edge
  m.vMarks.forEach((f) => hline(ry + f * rh));
  const vb = sortedBoundaries(m.vMarks);
  for (let i = 0; i < vb.length - 1; i++) {
    drawMeasureLabel(ctx, Math.round((vb[i + 1] - vb[i]) * 100) + '%', rx + 24, ry + ((vb[i] + vb[i + 1]) / 2) * rh);
  }

  ctx.restore();
  markVersionChanged(editor);
  showToast('Measurements baked');
}

editors.forEach(attachMeasureEvents);
btnMeasure.addEventListener('click', () => setMeasureOn(!state.measure.on));
measureAxisButtons.forEach((btn) => btn.addEventListener('click', () => setMeasureAxis(btn.dataset.axis)));
btnMeasureBake.addEventListener('click', bakeMeasure);
btnMeasureReset.addEventListener('click', () => {
  state.measure.refSet = false;
  state.measure.ref = defaultReferenceRect(activeEditor());
  state.measure.hMarks = [];
  state.measure.vMarks = [];
  renderMeasure();
});

// Lock the 100% reference to the screenshot's dimensions (true) or the full app
// area (false). Persists, keeps the toolbar toggle + settings checkbox in sync,
// and live-snaps the reference to the chosen extent.
function setMeasureScope(screenshot) {
  appSettings.measureDefaultScreenshot = screenshot;
  applyAppSettingsInputs();
  saveAppSettings();
  state.measure.refSet = false;
  state.measure.ref = defaultReferenceRect(activeEditor());
  renderMeasure();
}

btnMeasureScope.addEventListener('click', () => setMeasureScope(!appSettings.measureDefaultScreenshot));
settingMeasureDefaultScreenshot.addEventListener('change', () => setMeasureScope(settingMeasureDefaultScreenshot.checked));

settingMeasureOpacity.addEventListener('input', () => {
  appSettings.measureOpacity = clamp(parseInt(settingMeasureOpacity.value, 10) / 100, 0.2, 1);
  renderMeasure();
});
settingMeasureOpacity.addEventListener('change', () => { saveAppSettings(); });

// Refit only the panes still showing the automatic fit. Once the user has
// zoomed or panned deliberately, a resize (or a DPI change, which arrives as
// one) must keep their view instead of snapping back to fit and losing the
// detail they were looking at.
window.addEventListener('resize', () => {
  visibleEditors().forEach((editor) => {
    if (editor.viewAdjusted) {
      clampView(editor);
      applyTransform(editor);
    } else {
      fitToArea(editor);
    }
  });
});

async function init() {
  await loadAppSettings();
  await window.annotatorAPI.setWindowSquareCorners(appSettings.squareAppCorners).catch((error) => {
    console.error('Failed to apply square app corners:', error);
  });

  state.saveFolder = localStorage.getItem('saveFolder') || null;
  updateFolderDisplay();
  clearEditor(editors[1]);
  focusEditor(editors[0]);

  const dataURL = await window.annotatorAPI.readClipboardImage();
  if (dataURL) {
    await addImageFromDataURL(dataURL, { saveCurrent: false });
  }
}

init();
