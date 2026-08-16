// One-shot CDP evaluator against a live app: node tests/cdp-eval.mjs <port> "<js>"
// The JS body runs inside an async IIFE in the app's page and its value is printed.
const [, , port, ...rest] = process.argv;
const expression = rest.join(' ');

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target on that port');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

const result = await new Promise((resolve, reject) => {
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== 1) return;
    if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
    if (msg.result?.exceptionDetails) {
      return reject(new Error(msg.result.exceptionDetails.exception?.description
        || msg.result.exceptionDetails.text));
    }
    resolve(msg.result.result.value);
  });
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    },
  }));
  setTimeout(() => reject(new Error('CDP timeout')), 60000);
});

console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
ws.close();
