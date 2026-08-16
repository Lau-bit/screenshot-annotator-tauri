// End-to-end check against the RUNNING app, using real screenshots off disk and
// the real Rust commands (PNG decode, file write, Windows clipboard).
//
//   node tests/e2e-live.mjs <cdpPort> <screenshotDir> <outDir>
//
// Nothing here is mocked: read_image_file really decodes the file, save_file
// really writes it, and the clipboard round-trip really goes through Windows.
import { readdir, readFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const [, , port, shotDir, outDir] = process.argv;

// ── CDP plumbing ─────────────────────────────────────────────────────────────
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.title === 'Screenshot Annotator');
if (!page) throw new Error('no Screenshot Annotator page on that CDP port');
console.log(`attached to "${page.title}" at ${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});
let msgId = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
function evaluate(expression) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate',
      params: { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true },
    }));
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error('timeout'))), 120000);
  }).then((r) => {
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

await mkdir(outDir, { recursive: true });

// Pick three real screenshots of differing sizes.
const all = (await readdir(shotDir)).filter((f) => f.endsWith('.png'));
const picked = [];
for (const f of all.slice(-40)) {
  const buf = await readFile(join(shotDir, f));
  const size = pngSize(buf);
  if (size && !picked.some((p) => p.width === size.width && p.height === size.height)) {
    picked.push({ file: join(shotDir, f), ...size });
  }
  if (picked.length === 3) break;
}
console.log('\nusing real screenshots:');
picked.forEach((p) => console.log(`  ${p.file}  ${p.width}x${p.height}`));

// ── 1. import through the real Rust decoder ─────────────────────────────────
console.log('\n1. import');
await evaluate('clearWorkspace(false); return true;');
for (const shot of picked) {
  const r = await evaluate(`
    const url = await window.annotatorAPI.readImageFile(${JSON.stringify(shot.file)});
    if (!url) return { ok: false, reason: 'rust decode returned null' };
    const added = await addImageFromDataURL(url, { filePath: ${JSON.stringify(shot.file)} });
    const ed = activeEditor();
    return { ok: added, w: ed.canvas.width, h: ed.canvas.height, versions: state.versions.length };
  `);
  check(`import ${shot.width}x${shot.height}`, r.ok && r.w === shot.width && r.h === shot.height,
    `got ${r.w}x${r.h}, ${r.versions} version(s)`);
}

// ── 2. annotate: shapes, freehand, text ─────────────────────────────────────
console.log('\n2. annotate');
const drawn = await evaluate(`
  const ed = activeEditor();
  const paneR = ed.pane.getBoundingClientRect();
  const at = (cx, cy) => ({ clientX: paneR.left + ed.panX + cx * ed.zoom,
                            clientY: paneR.top + ed.panY + cy * ed.zoom, button: 0, bubbles: true });
  const stroke = (tool, x1, y1, x2, y2) => {
    state.tool = tool;
    ed.canvas.dispatchEvent(new MouseEvent('mousedown', at(x1, y1)));
    ed.canvas.dispatchEvent(new MouseEvent('mousemove', at((x1+x2)/2, (y1+y2)/2)));
    ed.canvas.dispatchEvent(new MouseEvent('mousemove', at(x2, y2)));
    ed.canvas.dispatchEvent(new MouseEvent('mouseup', at(x2, y2)));
  };
  const ink = () => { const d = ed.ctx.getImageData(0,0,ed.canvas.width,ed.canvas.height).data;
                      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };
  state.color = '#ff0000';
  const before = ink();
  stroke('rect', 60, 60, 320, 220);      const afterRect = ink();
  stroke('circle', 360, 60, 560, 220);   const afterCircle = ink();
  stroke('line', 60, 260, 560, 300);     const afterLine = ink();
  stroke('draw', 80, 340, 300, 400);     const afterFree = ink();
  // text
  state.tool = 'text'; state.textSize = 32;
  ed.canvas.dispatchEvent(new MouseEvent('click', at(80, 460)));
  ed.textInput.value = 'REGRESSION';
  commitText(ed);
  const afterText = ink();
  state.tool = 'rect';
  return { before, afterRect, afterCircle, afterLine, afterFree, afterText,
           undoDepth: state.versions[ed.versionIndex].undoStack.length };
`);
check('rect drawn', drawn.afterRect > drawn.before, `+${drawn.afterRect - drawn.before}px`);
check('circle drawn', drawn.afterCircle > drawn.afterRect, `+${drawn.afterCircle - drawn.afterRect}px`);
check('line drawn', drawn.afterLine > drawn.afterCircle, `+${drawn.afterLine - drawn.afterCircle}px`);
check('freehand drawn', drawn.afterFree > drawn.afterLine, `+${drawn.afterFree - drawn.afterLine}px`);
check('text committed', drawn.afterText > drawn.afterFree, `+${drawn.afterText - drawn.afterFree}px`);
check('each edit pushed one undo step', drawn.undoDepth === 5, `depth ${drawn.undoDepth}`);

// ── 3. erase + undo/redo ────────────────────────────────────────────────────
console.log('\n3. undo / redo');
const undoRes = await evaluate(`
  const ed = activeEditor();
  const ink = () => { const d = ed.ctx.getImageData(0,0,ed.canvas.width,ed.canvas.height).data;
                      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };
  const full = ink();
  undo(); const afterUndo = ink();
  redo(); const afterRedo = ink();
  return { full, afterUndo, afterRedo };
`);
check('undo removes the last edit', undoRes.afterUndo < undoRes.full);
check('redo restores it exactly', undoRes.afterRedo === undoRes.full);

// ── 4. the fixed bug, in the real app: rotate then Ctrl+Z ───────────────────
console.log('\n4. rotate + brightness are undoable (the fixed bug)');
const rotRes = await evaluate(`
  const ed = activeEditor();
  const v = state.versions[ed.versionIndex];
  const ink = () => { const d = ed.ctx.getImageData(0,0,ed.canvas.width,ed.canvas.height).data;
                      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };
  const inkBefore = ink();
  document.getElementById('btn-rotate-cw').click();
  const rotAfter = v.rotation;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  const res = { inkBefore, rotAfter, rotAfterUndo: v.rotation, inkAfterUndo: ink() };
  // brightness through the real slider
  const slider = document.getElementById('brightness-slider');
  slider.value = '145'; slider.dispatchEvent(new Event('input')); slider.dispatchEvent(new Event('change'));
  res.brightSet = v.brightness;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  res.brightAfterUndo = v.brightness;
  return res;
`);
check('rotate applied', rotRes.rotAfter === 90);
check('Ctrl+Z undoes the rotation', rotRes.rotAfterUndo === 0, `rotation ${rotRes.rotAfterUndo}`);
check('Ctrl+Z did NOT eat the drawing', rotRes.inkAfterUndo === rotRes.inkBefore,
  `${rotRes.inkAfterUndo} vs ${rotRes.inkBefore} px`);
check('Ctrl+Z undoes a brightness change', rotRes.brightAfterUndo === 100,
  `${rotRes.brightSet} -> ${rotRes.brightAfterUndo}`);

// ── 5. zoom survives a resize ───────────────────────────────────────────────
console.log('\n5. zoom');
const zoomRes = await evaluate(`
  const ed = activeEditor();
  ed.pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
  const zoomed = ed.zoom;
  window.dispatchEvent(new Event('resize'));
  const kept = ed.zoom;
  fitToArea(ed);
  return { zoomed, kept, refitted: ed.zoom, adjusted: ed.viewAdjusted };
`);
check('wheel zoom applied', zoomRes.zoomed > 0);
check('resize keeps a deliberate zoom', Math.abs(zoomRes.kept - zoomRes.zoomed) < 1e-9);

// ── 6. save to disk through the real Rust writer ────────────────────────────
console.log('\n6. save');
const savePath = join(outDir, 'e2e-annotated.png').replace(/\\/g, '/');
const saveRes = await evaluate(`
  const ed = activeEditor();
  saveVisibleEditorsToVersions();
  const out = getOutputDataURL(ed, 1);
  if (!out) return { ok: false, reason: 'export refused' };
  const ok = await window.annotatorAPI.saveFile({ path: ${JSON.stringify(savePath)}, dataURL: out.dataURL });
  return { ok, note: out.note, canvas: [ed.canvas.width, ed.canvas.height] };
`);
check('save_file reported success', saveRes.ok === true, saveRes.reason || '');
const savedBuf = await readFile(savePath).catch(() => null);
check('file exists on disk', !!savedBuf, savedBuf ? `${savedBuf.length} bytes` : 'missing');
check('file is not 0 bytes', !!savedBuf && savedBuf.length > 1000, `${savedBuf?.length ?? 0} bytes`);
const savedSize = savedBuf && pngSize(savedBuf);
check('file is a valid PNG with the right dimensions',
  !!savedSize && savedSize.width === saveRes.canvas[0] && savedSize.height === saveRes.canvas[1],
  savedSize ? `${savedSize.width}x${savedSize.height}` : 'not a PNG');

// ── 7. clipboard round trip through Windows ────────────────────────────────
console.log('\n7. clipboard');
const clipRes = await evaluate(`
  const ed = activeEditor();
  const out = getOutputDataURL(ed, 1);
  const wrote = await window.annotatorAPI.writeClipboardImage(out.dataURL);
  await new Promise(r => setTimeout(r, 400));
  const back = await window.annotatorAPI.readClipboardImage();
  if (!back) return { wrote, readBack: false };
  const img = new Image();
  await new Promise(res => { img.onload = res; img.onerror = res; img.src = back; });
  return { wrote, readBack: true, dims: [img.width, img.height], canvas: [ed.canvas.width, ed.canvas.height] };
`);
check('image written to the Windows clipboard', clipRes.wrote === true);
check('same image read back from the clipboard', clipRes.readBack === true);
check('clipboard image has the exported dimensions',
  clipRes.dims && clipRes.dims[0] === clipRes.canvas[0] && clipRes.dims[1] === clipRes.canvas[1],
  clipRes.dims ? `${clipRes.dims[0]}x${clipRes.dims[1]}` : 'n/a');

// ── 8. reopen the saved file ────────────────────────────────────────────────
console.log('\n8. reopen');
const reopenRes = await evaluate(`
  const before = state.versions.length;
  const url = await window.annotatorAPI.readImageFile(${JSON.stringify(savePath)});
  if (!url) return { ok: false };
  const added = await addImageFromDataURL(url);
  const v = state.versions[state.versions.length - 1];
  return { ok: added, grew: state.versions.length === before + 1,
           dims: [v.baseImageData.width, v.baseImageData.height],
           annotationLayerBlank: v.annotationData.data.every(b => b === 0) };
`);
check('saved file reopens', reopenRes.ok === true);
check('reopened at the saved dimensions',
  reopenRes.dims && savedSize && reopenRes.dims[0] === savedSize.width && reopenRes.dims[1] === savedSize.height,
  reopenRes.dims ? `${reopenRes.dims[0]}x${reopenRes.dims[1]}` : 'n/a');
check('reopened image starts with a clean annotation layer', reopenRes.annotationLayerBlank === true);

// ── 9. oversized export refuses rather than writing garbage ────────────────
console.log('\n9. oversized export guard (real save path)');
const guardPath = join(outDir, 'e2e-oversize.png').replace(/\\/g, '/');
const guardRes = await evaluate(`
  // Build a version big enough that a 45deg rotation overflows the canvas budget.
  const c = document.createElement('canvas');
  c.width = 13000; c.height = 13000;
  const x = c.getContext('2d'); x.fillStyle = '#204060'; x.fillRect(0, 0, 13000, 13000);
  const added = await addImageFromDataURL(c.toDataURL('image/png'));
  if (!added) return { imported: false };
  const ed = activeEditor();
  state.versions[ed.versionIndex].rotation = 45;
  const out = getOutputDataURL(ed, 1);
  let wrote = null;
  if (out) wrote = await window.annotatorAPI.saveFile({ path: ${JSON.stringify(guardPath)}, dataURL: out.dataURL });
  return { imported: true, refused: !out, note: out ? out.note : null,
           prefix: out ? out.dataURL.slice(0, 22) : null, wrote };
`);
if (guardRes.imported) {
  check('oversized export produced a real PNG or was refused',
    guardRes.refused || guardRes.prefix?.startsWith('data:image/png'),
    guardRes.refused ? 'refused' : `${guardRes.prefix} (${guardRes.note})`);
  if (!guardRes.refused) {
    const gBuf = await readFile(guardPath).catch(() => null);
    check('no 0-byte file was written', !!gBuf && gBuf.length > 1000, `${gBuf?.length ?? 0} bytes`);
    const gSize = gBuf && pngSize(gBuf);
    check('written file is a decodable PNG', !!gSize, gSize ? `${gSize.width}x${gSize.height}` : 'invalid');
  }
} else {
  check('oversized import was rejected cleanly (no hang)', true, 'import refused, promise settled');
}

// ── summary ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log(`\n${'='.repeat(60)}\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:');
  failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
}
ws.close();
process.exit(failed.length ? 1 : 0);
