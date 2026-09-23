/* eslint-disable */
// Probe: after closing find widget with real Escape key, where does focus land?
// Reuses the same CDP util as u2-52-cdp.cjs. Read-only probe (clicks find + Esc).
"use strict";
const { sleep, cdpConnect, makeSession, ev } = require("./lib/u2-cdp-util.cjs");
const PORT = Number(process.env.CDP_PORT ?? 9612);

async function key(call, k, code, vkCode, wait = 120) {
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: k,
    code,
    windowsVirtualKeyCode: vkCode,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: k,
    code,
    windowsVirtualKeyCode: vkCode,
  });
}

const main = async () => {
  const page = await cdpConnect(PORT);
  const call = await makeSession(page.webSocketDebuggerUrl);
  try {
    await call("Page.enable");
    await call("Runtime.enable");
    await call("Page.bringToFront").catch(() => {});
    await call("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await sleep(400);
    // restore online first (offline scenario left emulateNetworkConditions on)
    await call("Network.enable").catch(() => {});
    await call("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    }).catch(() => {});
    const online = await ev(call, "navigator.onLine");

    const opened = await ev(
      call,
      `(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').includes('查找'));
      if (!b) return 'NO_BTN'; b.click(); return 'clicked'; })()`,
    );
    await sleep(900);
    const findOn = await ev(call, "(() => !!document.querySelector('.find-widget.visible'))()");
    const focusBefore = await ev(
      call,
      `(() => { const a = document.activeElement;
      return a ? a.tagName + '|' + String(a.className).slice(0,50) : 'none'; })()`,
    );

    await key(call, "Escape", "Escape", 27, 800);
    const findOff = await ev(call, "(() => !document.querySelector('.find-widget.visible'))()");
    const focusAfter = await ev(
      call,
      `(() => {
      const a = document.activeElement; if (!a) return { el: 'none' };
      const r = { tag: a.tagName, cls: String(a.className).slice(0, 80), aria: a.getAttribute('aria-label'),
        isMonaco: (a.className||'').includes('monaco') || !!a.closest('.monaco-editor'),
        inTextarea: a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' };
      return r; })()`,
    );
    console.log(
      JSON.stringify({ online, opened, findOn, focusBefore, findOff, focusAfter }, null, 1),
    );
  } finally {
    try {
      process.exit(0);
    } catch {
      /* noop */
    }
  }
  process.exit(0);
};
main().catch((e) => {
  console.error(`ERR ${e.message}`);
  process.exit(1);
});
