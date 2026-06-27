'use strict';

const UNDO_LIMIT = 50;
const ERASE_RADIUS = 15;

const state = {
  versions: [],
  activeVersion: -1,
  focusedEditorIndex: 0,
  splitMode: false,
  tool: 'draw',
  color: '#ffcc00',
  textSize: 24,
  saveFolder: null,
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
  }),
];

let appSettings = defaultAppSettings();
let toastTimer;

function defaultAppSettings() {
  return { squareAppCorners: false };
}

function normalizeAppSettings(settings) {
  return {
    ...defaultAppSettings(),
    ...(settings || {}),
    squareAppCorners: !!settings?.squareAppCorners,
  };
}

function applyAppSettingsInputs() {
  settingSquareAppCorners.checked = appSettings.squareAppCorners;
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

function pushUndo(editor, snapshot) {
  const v = editor.versionIndex >= 0 ? state.versions[editor.versionIndex] : null;
  if (!v || !snapshot) return;
  v.undoStack.push(snapshot);
  if (v.undoStack.length > UNDO_LIMIT) v.undoStack.shift();
  v.redoStack = [];
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
  }
}

function fitToArea(editor) {
  const availW = editor.pane.clientWidth;
  const availH = editor.pane.clientHeight;
  if (!availW || !availH || !editor.canvas.width || !editor.canvas.height) return;
  editor.zoom = Math.min(availW / editor.canvas.width, availH / editor.canvas.height);
  editor.panX = (availW - editor.canvas.width * editor.zoom) / 2;
  editor.panY = (availH - editor.canvas.height * editor.zoom) / 2;
  applyTransform(editor);
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
  editor.preActionSnapshot = editor.ctx.getImageData(0, 0, editor.canvas.width, editor.canvas.height);

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
  pushUndo(editor, editor.ctx.getImageData(0, 0, editor.canvas.width, editor.canvas.height));
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
    const newZoom = Math.max(0.05, Math.min(20, editor.zoom * factor));
    const rect = editor.pane.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const canvasX = (mouseX - editor.panX) / editor.zoom;
    const canvasY = (mouseY - editor.panY) / editor.zoom;
    editor.zoom = newZoom;
    editor.panX = mouseX - canvasX * newZoom;
    editor.panY = mouseY - canvasY * newZoom;
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
  const current = editor.ctx.getImageData(0, 0, editor.canvas.width, editor.canvas.height);
  v.redoStack.push(current);
  const snap = v.undoStack.pop();
  editor.ctx.putImageData(snap, 0, 0);
  v.annotationData = snap;
  v.modified = true;
  refreshEditorsForVersion(editor.versionIndex, editor);
  showToast('Undo');
}

function redo() {
  const editor = activeEditor();
  if (editor.versionIndex < 0) return;
  const v = state.versions[editor.versionIndex];
  if (!v.redoStack.length) return;
  const current = editor.ctx.getImageData(0, 0, editor.canvas.width, editor.canvas.height);
  v.undoStack.push(current);
  const snap = v.redoStack.pop();
  editor.ctx.putImageData(snap, 0, 0);
  v.annotationData = snap;
  v.modified = true;
  refreshEditorsForVersion(editor.versionIndex, editor);
  showToast('Redo');
}

function renderTabs() {
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
    tabBar.insertBefore(tab, btnClearWorkspace);
  });
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
  loadVersionToEditor(editor, state.versions[idx], { fit: editor.canvas.width !== prevW || editor.canvas.height !== prevH });
  if (editor.canvas.width !== prevW || editor.canvas.height !== prevH) fitToArea(editor);
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
  focusEditor(editors[0]);
  renderTabs();
  updateActiveControls();
  if (showMessage) showToast('Workspace cleared');
}

btnClearWorkspace.addEventListener('click', () => clearWorkspace());

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
}

btnToggleSplit.addEventListener('click', () => setSplitMode(!state.splitMode));

function addImageFromDataURL(dataURL, { filePath = null, saveCurrent = true, toastMessage = null } = {}) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
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
  if (e.ctrlKey && e.key === 'z' && !hasActiveTextInput()) {
    e.preventDefault();
    undo();
  }
  if (e.ctrlKey && e.key === 'y' && !hasActiveTextInput()) {
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

brightnessSlider.addEventListener('input', () => {
  const v = activeVersion();
  if (!v) return;
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
  v.rotation = 0;
  v.modified = true;
  visibleEditors()
    .filter((editor) => editor.versionIndex === activeEditor().versionIndex)
    .forEach(applyTransform);
  updateActiveControls();
});

function getOutputDataURL(editor, scale = 1) {
  const v = editor.versionIndex >= 0 ? state.versions[editor.versionIndex] : null;
  if (!v) return null;

  const baseTmp = imageDataToCanvas(v.baseImageData);
  const annTmp = imageDataToCanvas(v.annotationData);
  const fullW = v.baseImageData.width;
  const fullH = v.baseImageData.height;
  const crop = editor.cropFrame.w > 0 && editor.cropFrame.h > 0
    ? editor.cropFrame
    : { x: 0, y: 0, w: fullW, h: fullH };
  const x = Math.max(0, Math.min(crop.x, fullW - 1));
  const y = Math.max(0, Math.min(crop.y, fullH - 1));
  const w = Math.max(1, Math.min(crop.w, fullW - x));
  const h = Math.max(1, Math.min(crop.h, fullH - y));
  const rad = v.rotation * Math.PI / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const outW = Math.max(1, Math.round((w * cos + h * sin) * scale));
  const outH = Math.max(1, Math.round((w * sin + h * cos) * scale));
  const tmp = document.createElement('canvas');
  tmp.width = outW;
  tmp.height = outH;
  const tCtx = tmp.getContext('2d');

  tCtx.translate(outW / 2, outH / 2);
  tCtx.rotate(rad);
  tCtx.translate(-(w * scale) / 2, -(h * scale) / 2);
  tCtx.filter = `brightness(${v.brightness / 100}) contrast(${v.contrast / 100})`;
  tCtx.drawImage(baseTmp, x, y, w, h, 0, 0, w * scale, h * scale);
  tCtx.filter = 'none';
  tCtx.drawImage(annTmp, x, y, w, h, 0, 0, w * scale, h * scale);
  return tmp.toDataURL('image/png');
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

  const ok = await window.annotatorAPI.saveFile({ path: filePath, dataURL: getOutputDataURL(editor, 1) });
  if (ok) {
    v.filePath = filePath;
    v.modified = false;
    showToast(savedName ? `Saved: ${savedName}` : 'Saved');
  } else {
    showToast('Save failed');
  }
}

async function saveAs() {
  const editor = activeEditor();
  if (editor.versionIndex < 0) return;
  saveVisibleEditorsToVersions();
  const filePath = await window.annotatorAPI.saveFileAs({
    dataURL: getOutputDataURL(editor, 1),
    defaultName: `screenshot_${autoTimestamp()}_${editor.versionIndex + 1}.png`,
  });
  if (filePath) {
    const v = state.versions[editor.versionIndex];
    v.filePath = filePath;
    v.manualFileName = true;
    v.modified = false;
    showToast('Saved');
  }
}

async function copyImage() {
  const editor = activeEditor();
  if (editor.versionIndex < 0) {
    showToast('No image loaded');
    return;
  }
  saveVisibleEditorsToVersions();
  const ok = await window.annotatorAPI.writeClipboardImage(getOutputDataURL(editor, copyScale));
  showToast(ok ? 'Copied to clipboard' : 'Copy failed');
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

window.addEventListener('resize', () => {
  visibleEditors().forEach(fitToArea);
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
