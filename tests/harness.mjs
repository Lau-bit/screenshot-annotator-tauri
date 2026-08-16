// Headless test harness for the Screenshot Annotator frontend.
//
// Serves the REAL src/ over loopback with a mock Tauri bridge injected ahead of
// api.js, then drives it in headless Edge over CDP. Testing the shipped app.js
// rather than an extracted copy is the point: the bugs this suite covers live in
// the interaction between app.js and the DOM, not in isolated helpers.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(HERE, '..', 'src');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

// Mock backend. Every command is recorded so a test can assert on what the
// frontend actually asked the Rust side to do, and each can be overridden from
// the test via __mock.setHandler.
const BRIDGE = `
window.__mock = {
  calls: [],
  handlers: {},
  dialogResult: null,
  files: {},
  clipboardImage: null,
  setHandler(name, fn) { this.handlers[name] = fn; },
  reset() { this.calls = []; this.handlers = {}; this.dialogResult = null; this.files = {}; },
  callsTo(name) { return this.calls.filter((c) => c.cmd === name); },
};
window.__TAURI__ = {
  core: {
    invoke: async (cmd, args) => {
      window.__mock.calls.push({ cmd, args });
      const h = window.__mock.handlers[cmd];
      if (h) return h(args);
      switch (cmd) {
        case 'read_clipboard_image': return window.__mock.clipboardImage;
        case 'write_clipboard_image': return true;
        case 'save_file':
          window.__mock.files[args.filePath] = args.dataUrl;
          return true;
        case 'ensure_folder': return true;
        case 'get_default_save_folder': return 'C:/mock/saved';
        case 'get_settings': return window.__mock.settings || {};
        case 'set_settings': return true;
        case 'read_image_file': return window.__mock.files[args.filePath] || null;
        case 'open_folder': return true;
        case 'save_window_shape': return { x: 0, y: 0, width: 800, height: 600 };
        case 'set_window_square_corners': return null;
        default: return null;
      }
    },
  },
  dialog: {
    save: async () => window.__mock.dialogResult,
    open: async () => window.__mock.dialogResult,
  },
};
`;

export async function startServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let path = url.pathname === '/' ? '/index.html' : url.pathname;
    try {
      // The page ships a CSP with script-src 'self', so the bridge has to be a
      // real same-origin file rather than an inline <script>.
      if (path === '/__mock.js') {
        res.writeHead(200, { 'Content-Type': MIME['.js'] });
        res.end(BRIDGE);
        return;
      }
      let body = await readFile(join(SRC, path));
      if (path === '/index.html') {
        // Inject the bridge ahead of api.js so window.__TAURI__ exists when it runs.
        body = body
          .toString()
          .replace('<script src="api.js">', '<script src="__mock.js"></script>\n  <script src="api.js">');
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

// ── Minimal CDP client (native WebSocket, no deps) ────────────────────────────

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        this.logs.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.logs.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description
          || msg.params.exceptionDetails.text));
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  async mouse(type, x, y, button = 'left', clickCount = 1) {
    await this.send('Input.dispatchMouseEvent', {
      type, x, y, button,
      buttons: type === 'mouseMoved' && button === 'left' ? 1 : (button === 'left' ? 1 : 0),
      clickCount: type === 'mouseMoved' ? 0 : clickCount,
    });
  }

  async key(text, { ctrl = false, code, keyCode } = {}) {
    const mods = ctrl ? 2 : 0;
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: text, code: code || `Key${text.toUpperCase()}`,
      windowsVirtualKeyCode: keyCode ?? text.toUpperCase().charCodeAt(0), modifiers: mods,
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: text, code: code || `Key${text.toUpperCase()}`,
      windowsVirtualKeyCode: keyCode ?? text.toUpperCase().charCodeAt(0), modifiers: mods,
    });
  }
}

export async function launchBrowser({ url, dpr = 1 }) {
  const browser = process.env.TEST_BROWSER
    || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const profile = await mkdtemp(join(tmpdir(), 'annot-test-'));
  const port = 9500 + Math.floor(Math.random() * 400);
  const proc = spawn(browser, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--force-device-scale-factor=${dpr}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1400,900',
    url,
  ], { stdio: 'ignore' });

  // Wait for the debugger, then attach to the page target.
  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'));
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
  }
  if (!wsUrl) throw new Error('browser debugger never came up');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  return {
    cdp,
    async close() {
      try { ws.close(); } catch { /* already gone */ }
      proc.kill();
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// Waits until app.js has finished init() and the page is interactive.
export async function waitReady(cdp) {
  for (let i = 0; i < 100; i++) {
    const ok = await cdp.eval(
      'return !!(window.__mock && window.annotatorAPI && typeof pasteFromClipboard === "function")');
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('app never became ready');
}

// A deterministic PNG data URL of the given size, drawn in-page.
export const makeImageJS = (w, h, color = '#3366cc') => `
  const c = document.createElement('canvas');
  c.width = ${w}; c.height = ${h};
  const x = c.getContext('2d');
  x.fillStyle = '${color}'; x.fillRect(0, 0, ${w}, ${h});
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, Math.max(1, ${w} >> 1), Math.max(1, ${h} >> 1));
  return c.toDataURL('image/png');
`;
