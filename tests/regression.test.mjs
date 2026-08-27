// Regression suite for the Screenshot Annotator frontend.
//
//   node --test tests/regression.test.mjs      (or: npm test)
//
// Drives the real src/app.js in headless Edge through the harness. Every case
// here failed before the fix it names; the comment on each says what the user
// would have seen.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launchBrowser, waitReady, makeImageJS } from './harness.mjs';

let server, cdp, closeBrowser;

before(async () => {
  const started = await startServer();
  server = started.server;
  const browser = await launchBrowser({ url: `http://127.0.0.1:${started.port}/`, dpr: 1 });
  cdp = browser.cdp;
  closeBrowser = browser.close;
  await waitReady(cdp);
});

after(async () => {
  await closeBrowser?.();
  server?.close();
});

// Load a fresh image of the given size as the only version.
const reset = (w, h, color = '#3366cc') => cdp.eval(`
  clearWorkspace(false);
  window.__mock.reset();
  window.__mock.clipboardImage = (() => { ${makeImageJS(w, h, color)} })();
  state.saveFolder = 'C:/mock/saved';
  await pasteFromClipboard();
  return state.versions.length;
`);

describe('export guards (oversized images)', () => {
  test('save() refuses a canvas-limit export instead of writing a 0-byte png', async () => {
    // Was: toDataURL() returned "data:,", save_file wrote 0 bytes, the toast
    // said "Saved: ..." and the version was marked unmodified.
    await reset(13000, 13000);
    const r = await cdp.eval(`
      const ed = editors[0];
      const v = state.versions[ed.versionIndex];
      v.rotation = 45;               // ~18385^2 = 338M px, past the 268M budget
      v.modified = true;
      await save();
      const call = window.__mock.callsTo('save_file')[0];
      return { wroteAnything: !!call,
               dataUrl: call ? call.args.dataUrl.slice(0, 24) : null,
               toast: document.getElementById('toast').textContent,
               stillMarkedModified: v.modified };
    `);
    assert.notEqual(r.dataUrl, 'data:,', 'an empty data URL reached the disk');
    if (r.wroteAnything) {
      assert.ok(r.dataUrl.startsWith('data:image/png'), `wrote a non-PNG: ${r.dataUrl}`);
    }
    assert.ok(!/^Saved/.test(r.toast) || r.dataUrl?.startsWith('data:image/png'),
      `reported success without valid data: ${r.toast}`);
  });

  test('copyImage() never puts an empty image on the clipboard', async () => {
    await reset(13000, 13000);
    const r = await cdp.eval(`
      const ed = editors[0];
      state.versions[ed.versionIndex].rotation = 45;
      let sent = null;
      window.__mock.setHandler('write_clipboard_image', (a) => { sent = a.dataUrl; return true; });
      await copyImage();
      return { sent: sent ? sent.slice(0, 24) : null, toast: document.getElementById('toast').textContent };
    `);
    assert.notEqual(r.sent, 'data:,');
    if (r.sent) assert.ok(r.sent.startsWith('data:image/png'));
  });

  test('an oversized export is downscaled to a real image and says so', async () => {
    await reset(13000, 13000);
    const r = await cdp.eval(`
      const ed = editors[0];
      state.versions[ed.versionIndex].rotation = 45;
      const out = getOutputDataURL(ed, 1);
      if (!out) return { out: null };
      const img = new Image();
      await new Promise(res => { img.onload = res; img.onerror = res; img.src = out.dataURL; });
      return { note: out.note, dims: [img.width, img.height] };
    `);
    assert.ok(r.note, 'a downscaled export must report that it was downscaled');
    assert.ok(r.dims[0] > 0 && r.dims[1] > 0, 'export decoded to a 0-sized image');
    assert.ok(r.dims[0] * r.dims[1] <= 16384 * 16384);
  });

  test('a normal-sized export is untouched and unannotated', async () => {
    await reset(800, 600);
    const r = await cdp.eval(`
      const out = getOutputDataURL(editors[0], 1);
      const img = new Image();
      await new Promise(res => { img.onload = res; img.src = out.dataURL; });
      return { note: out.note, dims: [img.width, img.height] };
    `);
    assert.equal(r.note, null);
    assert.deepEqual(r.dims, [800, 600]);
  });
});

describe('import guards (oversized images)', () => {
  test('an import that cannot allocate still settles its promise', async () => {
    // Was: the throw escaped img.onload, the promise never settled, and the
    // Open Images loop awaited it forever — no toast, no error, UI stuck.
    const r = await cdp.eval(`
      clearWorkspace(false);
      const Real = window.ImageData;
      window.ImageData = function () { throw new RangeError('Array buffer allocation failed'); };
      let settled = 'PENDING';
      const url = (() => { ${makeImageJS(80, 60)} })();
      const p = addImageFromDataURL(url).then(v => settled = 'resolved:' + v,
                                              e => settled = 'rejected');
      await Promise.race([p, new Promise(r => setTimeout(r, 1500))]);
      window.ImageData = Real;
      return settled;
    `);
    assert.equal(r, 'resolved:false', 'import promise did not settle');
  });

  test('Open Images finishes its loop and reports, even when a file fails', async () => {
    const r = await cdp.eval(`
      clearWorkspace(false);
      const Real = window.ImageData;
      window.ImageData = function () { throw new RangeError('Array buffer allocation failed'); };
      window.__mock.files['C:/mock/a.png'] = (() => { ${makeImageJS(60, 40)} })();
      window.__mock.dialogResult = ['C:/mock/a.png'];
      document.getElementById('btn-open-folder').click();
      let toast = '';
      const start = Date.now();
      while (Date.now() - start < 3000) {
        await new Promise(r => setTimeout(r, 80));
        toast = document.getElementById('toast').textContent;
        if (toast.includes('Opened') || toast.includes('No supported') || toast.includes('Could not')) break;
      }
      window.ImageData = Real;
      return toast;
    `);
    assert.match(r, /No supported|Could not|Opened/, `Open Images never reported back (toast: "${r}")`);
  });

  test('an image past the canvas budget is rejected with a clear message', async () => {
    const r = await cdp.eval(`
      clearWorkspace(false);
      // A data URL whose decoded size is over budget; use a real oversized canvas.
      const c = document.createElement('canvas');
      c.width = 17000; c.height = 17000;
      const url = c.toDataURL('image/png');
      if (url === 'data:,') {
        // The source canvas itself is over budget, so build the check directly.
        return { skipped: true, guard: exceedsCanvasBudget(17000, 17000) };
      }
      const ok = await addImageFromDataURL(url);
      return { skipped: false, ok, toast: document.getElementById('toast').textContent };
    `);
    if (r.skipped) assert.equal(r.guard, true, 'budget guard does not flag a 17000^2 image');
    else assert.equal(r.ok, false);
  });
});

describe('undo history covers the whole version state', () => {
  test('Ctrl+Z after a rotate undoes the rotate, not the previous drawing', async () => {
    // Was: rotation lived outside the undo stack, so Ctrl+Z skipped past it and
    // silently deleted the last thing the user drew.
    await reset(400, 300);
    const r = await cdp.eval(`
      const ed = editors[0];
      const v = state.versions[ed.versionIndex];
      const ink = () => { const d = ed.ctx.getImageData(0,0,ed.canvas.width,ed.canvas.height).data;
                          let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };
      ed.ctx.fillStyle = '#ff0000'; ed.ctx.fillRect(10, 10, 100, 80);
      pushVersionUndo(ed); markVersionChanged(ed);
      ed.ctx.fillStyle = '#00ff00'; ed.ctx.fillRect(150, 10, 100, 80);
      markVersionChanged(ed);
      const inkAfterDrawing = ink();
      document.getElementById('btn-rotate-cw').click();
      const rotAfterClick = v.rotation;
      undo();
      return { inkAfterDrawing, rotAfterClick, rotAfterUndo: v.rotation, inkAfterUndo: ink() };
    `);
    assert.equal(r.rotAfterClick, 90);
    assert.equal(r.rotAfterUndo, 0, 'Ctrl+Z did not undo the rotation');
    assert.equal(r.inkAfterUndo, r.inkAfterDrawing, 'Ctrl+Z destroyed a drawing instead');
  });

  test('a brightness drag is one undo step and is restored', async () => {
    await reset(200, 150);
    const r = await cdp.eval(`
      const v = state.versions[editors[0].versionIndex];
      const slider = document.getElementById('brightness-slider');
      const depth0 = v.undoStack.length;
      for (const val of [110, 120, 130, 140]) {          // a drag = many input events
        slider.value = String(val);
        slider.dispatchEvent(new Event('input'));
      }
      slider.dispatchEvent(new Event('change'));
      const mid = { bright: v.brightness, depth: v.undoStack.length };
      undo();
      return { depth0, mid, brightAfterUndo: v.brightness };
    `);
    assert.equal(r.mid.bright, 140);
    assert.equal(r.mid.depth - r.depth0, 1, 'a slider drag should add exactly one undo step');
    assert.equal(r.brightAfterUndo, 100, 'undo did not restore brightness');
  });

  test('redo restores rotation as well as pixels', async () => {
    await reset(200, 150);
    const r = await cdp.eval(`
      const v = state.versions[editors[0].versionIndex];
      document.getElementById('btn-rotate-cw').click();
      undo();
      const afterUndo = v.rotation;
      redo();
      return { afterUndo, afterRedo: v.rotation };
    `);
    assert.equal(r.afterUndo, 0);
    assert.equal(r.afterRedo, 90);
  });

  test('plain drawing undo/redo still round-trips exactly', async () => {
    await reset(400, 300);
    const r = await cdp.eval(`
      const ed = editors[0];
      const ink = () => { const d = ed.ctx.getImageData(0,0,ed.canvas.width,ed.canvas.height).data;
                          let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };
      state.tool = 'rect'; state.color = '#ff0000';
      const paneR = ed.pane.getBoundingClientRect();
      const at = (cx, cy) => ({ clientX: paneR.left + ed.panX + cx * ed.zoom,
                                clientY: paneR.top + ed.panY + cy * ed.zoom, button: 0, bubbles: true });
      const draw = (a,b,c,d2) => { ed.canvas.dispatchEvent(new MouseEvent('mousedown', at(a,b)));
                                   ed.canvas.dispatchEvent(new MouseEvent('mousemove', at(c,d2)));
                                   ed.canvas.dispatchEvent(new MouseEvent('mouseup', at(c,d2))); };
      draw(10,10,80,60);  const a = ink();
      draw(120,10,200,60); const b = ink();
      undo(); const u = ink();
      redo(); const r2 = ink();
      return { a, b, u, r2 };
    `);
    assert.equal(r.u, r.a, 'undo did not return to the previous drawing state');
    assert.equal(r.r2, r.b, 'redo did not restore the drawing');
  });
});

describe('split view', () => {
  test('re-entering split never binds both panes to one version', async () => {
    // Was: split on -> focus right -> split off -> split on left both panes on
    // the same version, and that tab rendered active AND "already open in the
    // other editor", so neither pane could select it.
    const r = await cdp.eval(`
      clearWorkspace(false);
      for (const col of ['#ee0000', '#00ee00']) {
        window.__mock.clipboardImage = (() => { const c = document.createElement('canvas');
          c.width = 200; c.height = 150; const x = c.getContext('2d');
          x.fillStyle = col; x.fillRect(0,0,200,150); return c.toDataURL(); })();
        await pasteFromClipboard();
      }
      setSplitMode(true);
      focusEditor(editors[1]);
      setSplitMode(false);
      setSplitMode(true);
      const tabs = [...document.querySelectorAll('.tab')].map(t => ({
        active: t.classList.contains('active'), unavailable: t.classList.contains('unavailable') }));
      const res = { left: editors[0].versionIndex, right: editors[1].versionIndex, tabs };
      setSplitMode(false);
      return res;
    `);
    assert.notEqual(r.left, r.right, 'both panes bound to the same version');
    assert.ok(!r.tabs.some((t) => t.active && t.unavailable),
      'the focused pane\'s own tab is marked unavailable');
  });
});

describe('zoom and view', () => {
  test('a window resize keeps a deliberately zoomed view', async () => {
    // Was: every resize called fitToArea, throwing away the zoom/pan the user
    // had set — including on the resize that a DPI change generates.
    await reset(800, 600);
    const r = await cdp.eval(`
      const ed = editors[0];
      ed.pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 300, clientY: 200, bubbles: true, cancelable: true }));
      const zoomed = ed.zoom;
      window.dispatchEvent(new Event('resize'));
      return { zoomed: +zoomed.toFixed(4), after: +ed.zoom.toFixed(4), adjusted: ed.viewAdjusted };
    `);
    assert.equal(r.adjusted, true);
    assert.equal(r.after, r.zoomed, 'resize discarded the user zoom');
  });

  test('an untouched view still refits on resize', async () => {
    await reset(800, 600);
    const r = await cdp.eval(`
      const ed = editors[0];
      const before = ed.zoom;
      // The pane is flex:1 1 0, so a plain style.width does not move
      // clientWidth — pin the basis to actually change the available area.
      ed.pane.style.flex = '0 0 400px';
      window.dispatchEvent(new Event('resize'));
      const after = ed.zoom;
      ed.pane.style.flex = '';
      window.dispatchEvent(new Event('resize'));
      return { before: +before.toFixed(4), after: +after.toFixed(4),
               paneWidthChanged: true, adjusted: ed.viewAdjusted };
    `);
    assert.equal(r.adjusted, false);
    assert.notEqual(r.after, r.before, 'a fitted view should refit when the pane changes size');
  });

  test('pointer position maps to the same canvas pixel at any zoom', async () => {
    await reset(800, 600);
    const r = await cdp.eval(`
      const ed = editors[0];
      const res = [];
      for (const z of [0.25, 1, 3.5]) {
        ed.zoom = z; ed.panX = 31; ed.panY = 17; applyTransform(ed);
        const paneR = ed.pane.getBoundingClientRect();
        const p = getCanvasPos(ed, { clientX: paneR.left + 31 + 250 * z, clientY: paneR.top + 17 + 190 * z });
        res.push([Math.round(p.x), Math.round(p.y)]);
      }
      return res;
    `);
    for (const got of r) assert.deepEqual(got, [250, 190]);
  });
});

describe('auto-crop to the visible area', () => {
  // Restore the default between cases — the toggle is persisted app settings,
  // so a case that turns it off would otherwise poison every case after it.
  const setAutoCrop = (on) => cdp.eval(`await setAutoCropToZoom(${on}); return appSettings.autoCropToZoom;`);

  test('the wheel will not zoom out past the fit-to-pane floor', async () => {
    // Was: the floor was a flat 0.05, so the image could be wheeled down to a
    // stamp adrift in the middle of an empty pane.
    await reset(2000, 1500);
    const r = await cdp.eval(`
      const ed = editors[0];
      const floor = minZoomFor(ed);
      for (let i = 0; i < 40; i++) {
        ed.pane.dispatchEvent(new WheelEvent('wheel',
          { deltaY: 120, clientX: 300, clientY: 250, bubbles: true, cancelable: true }));
      }
      return { floor: +floor.toFixed(6), zoom: +ed.zoom.toFixed(6), atMin: atMinZoom(ed) };
    `);
    assert.ok(r.floor > 0.05, 'the fit floor should be well above the old flat minimum');
    assert.equal(r.zoom, r.floor, 'the wheel got past the fit-to-pane floor');
    assert.equal(r.atMin, true);
  });

  test('at the floor the image can still be panned past the pane edge', async () => {
    // Was: a fitted image was clamped fully inside the pane, so an edge sitting
    // under a toolbar could never be dragged into the open.
    await reset(2000, 1500);
    const r = await cdp.eval(`
      const ed = editors[0];
      fitToArea(ed);
      ed.panX = -100000;
      clampPan(ed);
      return { panX: ed.panX, imgW: ed.canvas.width * ed.zoom, paneW: ed.pane.clientWidth };
    `);
    assert.ok(r.panX < 0, 'the image is still locked inside the pane');
    assert.ok(r.panX + r.imgW >= 1, 'the image was allowed to leave the pane entirely');
  });

  test('a copy at the floor sends the whole image, however it is panned', async () => {
    await reset(1200, 900);
    const r = await cdp.eval(`
      const ed = editors[0];
      fitToArea(ed);
      ed.panX -= 200; ed.panY -= 150; clampPan(ed); applyTransform(ed);
      let sent = null;
      window.__mock.setHandler('write_clipboard_image', (a) => { sent = a.dataUrl; return true; });
      await copyImage();
      const img = new Image();
      await new Promise((res) => { img.onload = res; img.src = sent; });
      return { dims: [img.width, img.height], active: autoCropActive(ed),
               setting: appSettings.autoCropToZoom,
               lamp: btnAutoCrop.className };
    `);
    assert.equal(r.setting, true, 'auto-crop should default on');
    assert.equal(r.active, false, 'auto-crop must stand down at minimum zoom');
    assert.deepEqual(r.dims, [1200, 900], 'the floor state must copy the whole image');
    assert.match(r.lamp, /state-armed/, 'the lamp should read armed-but-idle at the floor');
  });

  test('a copy while zoomed in sends only the visible slice', async () => {
    await reset(1200, 900);
    const r = await cdp.eval(`
      const ed = editors[0];
      ed.zoom = 3; ed.panX = -600; ed.panY = -300;
      ed.viewAdjusted = true; clampPan(ed); applyTransform(ed);
      const vis = visibleImageRect(ed);
      let sent = null;
      window.__mock.setHandler('write_clipboard_image', (a) => { sent = a.dataUrl; return true; });
      await copyImage();
      const img = new Image();
      await new Promise((res) => { img.onload = res; img.src = sent; });
      return { dims: [img.width, img.height], vis, active: autoCropActive(ed),
               lamp: btnAutoCrop.className,
               toast: document.getElementById('toast').textContent };
    `);
    assert.equal(r.active, true);
    assert.match(r.lamp, /state-active/, 'the lamp should read active while it will crop');
    const expW = Math.min(1200, r.vis.x + r.vis.w) - Math.max(0, r.vis.x);
    const expH = Math.min(900, r.vis.y + r.vis.h) - Math.max(0, r.vis.y);
    assert.deepEqual(r.dims, [expW, expH], 'the clipboard did not match the visible slice');
    assert.ok(r.dims[0] < 1200 || r.dims[1] < 900, 'nothing was actually cropped');
    assert.match(r.toast, /visible area/);
  });

  test('a manual crop frame still bounds the auto-crop', async () => {
    await reset(1200, 900);
    const r = await cdp.eval(`
      const ed = editors[0];
      ed.cropFrame = { x: 100, y: 100, w: 400, h: 300 };
      updateCropOverlayDOM(ed);
      ed.zoom = 3; ed.panX = 0; ed.panY = 0;
      ed.viewAdjusted = true; clampPan(ed); applyTransform(ed);
      const out = getOutputDataURL(ed, 1, { autoCrop: autoCropActive(ed) });
      const img = new Image();
      await new Promise((res) => { img.onload = res; img.src = out.dataURL; });
      return { dims: [img.width, img.height], vis: visibleImageRect(ed) };
    `);
    assert.ok(r.dims[0] <= 400 && r.dims[1] <= 300,
      `auto-crop escaped the manual crop frame: ${r.dims}`);
  });

  test('turning the toggle off restores the whole-image copy', async () => {
    await reset(1200, 900);
    try {
      const r = await cdp.eval(`
        const ed = editors[0];
        ed.zoom = 3; ed.panX = -600; ed.panY = -300;
        ed.viewAdjusted = true; clampPan(ed); applyTransform(ed);
        await setAutoCropToZoom(false);
        let sent = null;
        window.__mock.setHandler('write_clipboard_image', (a) => { sent = a.dataUrl; return true; });
        await copyImage();
        const img = new Image();
        await new Promise((res) => { img.onload = res; img.src = sent; });
        return { dims: [img.width, img.height], lamp: btnAutoCrop.className,
                 checkbox: settingAutoCrop.checked };
      `);
      assert.deepEqual(r.dims, [1200, 900], 'the toggle did not stop the crop');
      assert.match(r.lamp, /state-off/);
      assert.equal(r.checkbox, false, 'the settings checkbox did not follow the lamp');
    } finally {
      assert.equal(await setAutoCrop(true), true);
    }
  });

  test('the setting survives a reload', async () => {
    try {
      await setAutoCrop(false);
      const r = await cdp.eval(`
        const stored = window.__mock.callsTo('set_settings').at(-1).args.data;
        return normalizeAppSettings(JSON.parse(JSON.stringify(stored))).autoCropToZoom;
      `);
      assert.equal(r, false, 'the toggle was not persisted');
    } finally {
      await setAutoCrop(true);
    }
  });
});

describe('keyboard shortcuts', () => {
  test('Ctrl+Shift+Z redoes, Ctrl+Z with shift does not undo', async () => {
    await reset(200, 150);
    const r = await cdp.eval(`
      const ed = editors[0];
      const v = state.versions[ed.versionIndex];
      ed.ctx.fillStyle = '#f00'; ed.ctx.fillRect(0,0,40,40);
      pushVersionUndo(ed); markVersionChanged(ed);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
      const afterUndo = { undo: v.undoStack.length, redo: v.redoStack.length };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      const afterRedo = { undo: v.undoStack.length, redo: v.redoStack.length };
      return { afterUndo, afterRedo };
    `);
    assert.equal(r.afterUndo.redo, 1, 'Ctrl+Z did not undo');
    assert.equal(r.afterRedo.redo, 0, 'Ctrl+Shift+Z did not redo');
  });
});

describe('cancellation', () => {
  test('cancelling every dialog changes nothing', async () => {
    await reset(200, 150);
    const r = await cdp.eval(`
      window.__mock.dialogResult = null;
      const before = { versions: state.versions.length, folder: state.saveFolder };
      window.__mock.calls = [];
      document.getElementById('btn-open-folder').click();
      await new Promise(r => setTimeout(r, 200));
      document.getElementById('btn-pick-folder').click();
      await new Promise(r => setTimeout(r, 200));
      await saveAs();
      return { before, after: { versions: state.versions.length, folder: state.saveFolder },
               wrote: window.__mock.callsTo('save_file').length };
    `);
    assert.deepEqual(r.after, r.before);
    assert.equal(r.wrote, 0, 'a cancelled Save As still wrote a file');
  });
});

describe('save and reopen', () => {
  test('an annotated screenshot round-trips through disk unchanged', async () => {
    await reset(320, 240, '#2255aa');
    const r = await cdp.eval(`
      const ed = editors[0];
      ed.ctx.fillStyle = '#ff0000'; ed.ctx.fillRect(20, 20, 60, 40);
      markVersionChanged(ed);
      await save();
      const saved = window.__mock.callsTo('save_file')[0].args;
      window.__mock.files[saved.filePath] = saved.dataUrl;
      window.__mock.dialogResult = [saved.filePath];
      document.getElementById('btn-open-folder').click();
      await new Promise(r => setTimeout(r, 400));
      const reopened = state.versions[state.versions.length - 1];
      const cmp = await new Promise((res) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
          c.getContext('2d').drawImage(img, 0, 0);
          const a = c.getContext('2d').getImageData(0, 0, img.width, img.height).data;
          const b = reopened.baseImageData.data;
          let diff = 0; for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) diff++;
          res({ dims: [img.width, img.height], diff });
        };
        img.src = saved.dataUrl;
      });
      return cmp;
    `);
    assert.deepEqual(r.dims, [320, 240]);
    assert.equal(r.diff, 0, 'reopened pixels differ from what was written');
  });
});
