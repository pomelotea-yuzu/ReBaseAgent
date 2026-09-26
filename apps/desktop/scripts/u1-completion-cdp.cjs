"use strict";

// Read-only UI regression through the real Electron preload and native CDP input.
// Controlled traces are clearly named; existing traces, blobs and settings are hashed.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "../../..");
const zoom200 = process.argv.includes("--zoom200");
const out = path.join(root, "docs/reviews/2026-09-26-u1-completion", zoom200 ? "zoom200" : ".");
const data = path.join(root, ".rebaseagent");
const port = Number(process.env.U1_CDP_PORT || 9612);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const measurements = [];
let call;
let ws;

function check(name, value, detail) {
  checks.push({ name, passed: value === true, detail });
  if (value !== true) throw new Error(`${name}: ${JSON.stringify(detail)}`);
  console.log(`PASS ${name}`);
}

function hashes(dir, prefix = "") {
  if (!fs.existsSync(dir)) return {};
  const result = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, hashes(file, `${rel}/`));
    else result[rel] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  return result;
}

function surface() {
  return {
    traces: hashes(path.join(data, "traces")),
    blobs: hashes(path.join(data, "workspace-blobs")),
    settings: fs.existsSync(path.join(data, "settings.json"))
      ? createHash("sha256")
          .update(fs.readFileSync(path.join(data, "settings.json")))
          .digest("hex")
      : null,
  };
}

function fixture(source, id, reasoning) {
  const records = fs
    .readFileSync(path.join(root, "apps/desktop/test/fixtures/u1-fixtures", source), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  records[0].id = id;
  records[0].task = `U1 completion fixture: ${id}`;
  if (reasoning) {
    const span = records.find((r) => r.kind === "llm.call");
    span.response.reasoning_content =
      "U1 reasoning: inspect the recorded context before answering.";
    span.response.content = "U1 response: the recorded answer is displayed separately.";
  }
  const text = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
  const target = path.join(data, "traces", `${id}.jsonl`);
  if (fs.existsSync(target) && fs.readFileSync(target, "utf8") !== text)
    throw new Error(`Refuse to replace ${target}`);
  fs.writeFileSync(target, text);
}

async function connect() {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find((p) => p.type === "page" && p.url.includes("localhost"));
  if (!page) throw new Error("No Electron dev renderer");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timer);
    if (message.error) task.reject(new Error(JSON.stringify(message.error)));
    else task.resolve(message.result);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout ${method}`));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Page.bringToFront");
  return page.id;
}

async function ev(expression) {
  const result = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function waitFor(expression) {
  for (let i = 0; i < 80; i++) {
    if (await ev(expression)) return;
    await sleep(100);
  }
  throw new Error(`Condition timed out: ${expression}`);
}

async function click(expression) {
  const point = await ev(`(() => {
    const el = ${expression};
    if (!el || el.disabled) throw new Error('Missing/disabled click target');
    el.scrollIntoView({block:'center',behavior:'instant'});
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (!r.width || !r.height || !el.contains(document.elementFromPoint(x,y))) throw new Error('Click target occluded');
    return {x,y};
  })()`);
  await call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    clickCount: 1,
  });
  await call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    clickCount: 1,
  });
  await sleep(180);
}

const el = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
const button = (text) =>
  `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
async function key(key, code, virtual) {
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: virtual,
    ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: virtual,
  });
  await sleep(160);
}

async function screenshot(name) {
  const result = await call("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(result.data, "base64"));
}

async function geometry() {
  return ev(`(() => {
    const rect = selector => { const e=document.querySelector(selector); if(!e) return null;
      const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
    return {width:document.documentElement.clientWidth,height:document.documentElement.clientHeight,
      dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth > document.documentElement.clientWidth,
      nav:rect('#run-navigation'),steps:rect('#steps-navigation'),tabs:rect('[role=tablist]')};
  })()`);
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  fixture("u1-reasoning-only.jsonl", "u1_completion_reasoning", true);
  fixture("u1-ok.jsonl", "u1_completion_tools", false);
  const before = surface();
  await connect();
  await call("Page.reload");
  await sleep(1500);
  await waitFor("document.querySelector('#run-navigation-toggle') !== null");
  await ev(`(async () => {
    const urls=performance.getEntriesByType('resource').map(r=>r.name).filter(u=>new URL(u).pathname.endsWith('/store.ts'));
    if(!urls.length) throw new Error('No loaded store module: '+performance.getEntriesByType('resource').map(r=>r.name).join(','));
    window.__u1Store=(await import(urls[urls.length-1])).useAppStore;
    await window.__u1Store.getState().loadRuns();
    await window.__u1Store.getState().selectRun('u1_completion_reasoning');
  })()`);
  const resize = async (width) => {
    let m = await geometry();
    let outer = Math.round(width * m.dpr + 16);
    for (let i = 0; i < 4; i++) {
      const r = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(__dirname, "lib/u1-completion-window.ps1"),
          "-Width",
          String(outer),
          "-Height",
          "1000",
        ],
        { windowsHide: true, encoding: "utf8" },
      );
      if (r.status !== 0) throw new Error(r.stderr || r.stdout);
      await sleep(450);
      m = await geometry();
      if (Math.abs(m.width - width) < 2) break;
      outer += Math.round((width - m.width) * m.dpr);
    }
    measurements.push(m);
    console.log(`VIEWPORT ${JSON.stringify(m)}`);
    return m;
  };

  if (!zoom200) {
    const wide = await resize(1440);
    check("wide viewport reaches >=1280", wide.width >= 1280, wide);
    await click(el("#run-navigation-toggle"));
    check("wide collapse hides list", await ev("!document.querySelector('#run-navigation')"));
    await click(el("#run-navigation-toggle"));
    check("wide reopen restores list", await ev("!!document.querySelector('#run-navigation')"));
    await screenshot("wide-reopened");
  }

  for (const size of [800, 640]) {
    const m = await resize(size);
    check(`${size} native viewport`, Math.abs(m.width - size) < 35 && !m.overflow, m);
    check(`${size} initially hidden`, await ev("!document.querySelector('#run-navigation')"));
    await click(el("#run-navigation-toggle"));
    const opened = await geometry();
    check(
      `${size} navigation replaces workspace`,
      opened.nav?.width === opened.width && opened.tabs === null,
      opened,
    );
    check(
      `${size} search receives focus`,
      await ev("document.activeElement === document.querySelector('#run-navigation input')"),
    );
    await screenshot(`navigation-${size}`);
    await key("Escape", "Escape", 27);
    check(
      `${size} Escape restores workspace and focus`,
      await ev(
        "!document.querySelector('#run-navigation') && document.activeElement.id === 'run-navigation-toggle' && !!document.querySelector('[role=tablist]')",
      ),
    );
    await key("Enter", "Enter", 13);
    check(
      `${size} keyboard reopens navigation`,
      await ev("!!document.querySelector('#run-navigation')"),
    );
    await click(
      `[...document.querySelectorAll('#run-navigation button')].find(b=>b.textContent.includes('U1 completion fixture: u1_completion_tools'))`,
    );
    await waitFor("window.__u1Store.getState().detail?.meta.id === 'u1_completion_tools'");
    check(
      `${size} selection returns to chosen run`,
      await ev(
        "!document.querySelector('#run-navigation') && window.__u1Store.getState().selectedRunId === 'u1_completion_tools'",
      ),
    );
    await click(button("步骤"));
    await click(el("[data-open-steps]"));
    if (size === 640) {
      const steps = await geometry();
      check(
        "single steps replace workspace",
        steps.steps?.width === steps.width && steps.tabs === null,
        steps,
      );
      await screenshot("steps-640");
      await key("Escape", "Escape", 27);
      check(
        "single steps Escape restores entry focus",
        await ev(
          "document.activeElement.hasAttribute('data-open-steps') && !!document.querySelector('[role=tablist]')",
        ),
      );
      await key("Enter", "Enter", 13);
    }
    await click(
      `[...document.querySelectorAll('#steps-navigation button[title]')].find(b=>b.title.includes('LLM'))`,
    );
    if (size === 640)
      check(
        "single span selection returns to detail",
        await ev(
          "!document.querySelector('#steps-navigation') && !!document.querySelector('[role=tablist]')",
        ),
      );
    else await click(el('#steps-navigation button[aria-label="收起步骤目录"]'));
    await click(el("#run-navigation-toggle"));
    await click(
      `[...document.querySelectorAll('#run-navigation button')].find(b=>b.textContent.includes('U1 completion fixture: u1_completion_reasoning'))`,
    );
    await waitFor("window.__u1Store.getState().detail?.meta.id === 'u1_completion_reasoning'");
  }

  if (zoom200) {
    check("200 percent Electron zoom under forced scale 1", (await geometry()).dpr === 2);
    check(
      "existing traces blobs and settings unchanged",
      JSON.stringify(before) === JSON.stringify(surface()),
    );
    fs.writeFileSync(
      path.join(out, "measurements.json"),
      `${JSON.stringify({ checks, measurements }, null, 2)}\n`,
    );
    return;
  }

  await resize(1440);
  await click(button("步骤"));
  // Drive the actual separator keyboard handler to its maximum width.
  await click(el('#steps-navigation [role="separator"]'));
  const grip = await ev(
    "(() => { const r=document.querySelector('#steps-navigation [role=separator]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()",
  );
  await call("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...grip,
    button: "left",
    clickCount: 1,
  });
  await call("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: grip.x + 30,
    y: grip.y,
    button: "left",
    buttons: 1,
  });
  await call("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: grip.x + 30,
    y: grip.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(150);
  check(
    "separator mouse drag changes steps width",
    await ev(
      "Number(document.querySelector('#steps-navigation [role=separator]').getAttribute('aria-valuenow')) > 232",
    ),
  );
  await key("End", "End", 35);
  check(
    "separator keyboard End reaches maximum",
    await ev(
      "document.querySelector('#steps-navigation [role=separator]').getAttribute('aria-valuenow') === '320'",
    ),
  );
  await resize(1024);
  check(
    "medium constrained steps fold",
    await ev(
      "!document.querySelector('#steps-navigation') && !!document.querySelector('[data-open-steps]')",
    ),
  );
  await click(el("[data-open-steps]"));
  const mediumSteps = await geometry();
  check(
    "medium constrained steps reopen as full workspace",
    mediumSteps.steps?.width === mediumSteps.width &&
      mediumSteps.tabs === null &&
      mediumSteps.nav === null,
    mediumSteps,
  );
  await screenshot("steps-1024");
  await key("Escape", "Escape", 27);
  check(
    "medium steps return restores focus",
    await ev("document.activeElement.hasAttribute('data-open-steps')"),
  );

  // Existing isolated trace is only read. No execution endpoint is invoked.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, ".workbuddy/u3/u3-61/manifest.json"), "utf8"),
  );
  await ev(`window.__u1Store.getState().selectRun(${JSON.stringify(manifest.isoFork)})`);
  await click(button("文件"));
  await waitFor(
    "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='查看全部') || document.querySelector('[role=option]')",
  );
  if (await ev(`${button("查看全部")} !== undefined`)) await click(button("查看全部"));
  if (await ev("!!document.querySelector('button[aria-label=\"显示文件列表\"]')"))
    await click(el('button[aria-label="显示文件列表"]'));
  await waitFor("!!document.querySelector('[role=option]')");
  await click(el('[role="option"]'));
  if (await ev("!!document.querySelector('button[aria-label=\"显示文件内容\"]')"))
    await click(el('button[aria-label="显示文件内容"]'));
  await sleep(900);
  const fileState = () =>
    ev(`window.__u1Store.getState().readingByRun[${JSON.stringify(manifest.isoFork)}].files`);
  const fileBefore = await fileState();
  check("file reading has selected path", !!fileBefore.path, fileBefore);
  check(
    "medium files auto-fold navigation",
    await ev("!document.querySelector('#run-navigation')"),
  );
  await click(el("#run-navigation-toggle"));
  check("medium files navigation reopens", await ev("!!document.querySelector('#run-navigation')"));
  await click(el("#run-navigation-toggle"));
  await resize(640);
  await click(el("#run-navigation-toggle"));
  check(
    "file workspace temporarily unmounts",
    await ev("!document.querySelector('[role=tablist]')"),
  );
  await key("Escape", "Escape", 27);
  await sleep(900);
  const fileAfter = await fileState();
  check(
    "file path checkpoint and pane survive navigation",
    fileBefore.path === fileAfter.path &&
      fileBefore.checkpoint === fileAfter.checkpoint &&
      fileBefore.pane === fileAfter.pane,
    { fileBefore, fileAfter },
  );
  check(
    "restored file content path is visible",
    await ev(`document.body.innerText.includes(${JSON.stringify(fileBefore.path)})`),
  );
  await screenshot("file-restored-640");

  await ev("window.__u1Store.getState().selectRun('u1_completion_tools')");
  await click(button("步骤"));
  await click(el("[data-open-steps]"));
  await click(
    `[...document.querySelectorAll('#steps-navigation button[title]')].find(b=>b.title.includes('read_file'))`,
  );
  await click(button("在此重跑（时间旅行）"));
  await waitFor("!!document.querySelector('[data-draft-compare=\"tool-result\"] .monaco-editor')");
  await ev(`(async () => {
    const url=performance.getEntriesByType('resource').map(r=>r.name).find(u=>new URL(u).pathname.endsWith('/monaco-bootstrap.ts'));
    window.__u1Monaco=await (await import(url)).ensureMonaco();
    window.__u1Editable=()=>window.__u1Monaco.editor.getEditors().find(e=>e.getDomNode()?.offsetParent!==null && !e.getOption(window.__u1Monaco.editor.EditorOption.readOnly));
    window.__u1Editable().focus();
  })()`);
  await call("Input.insertText", { text: "U1 draft survives temporary navigation. " });
  await sleep(300);
  const draft = () =>
    ev(
      "window.__u1Store.getState().callDraftOf({runId:'u1_completion_tools',spanId:'s_03',field:'result'})",
    );
  const draftBefore = await draft();
  check("real editor input creates draft", draftBefore.text.includes("U1 draft survives"), {
    revision: draftBefore.revision,
  });
  await click(el("#run-navigation-toggle"));
  await key("Escape", "Escape", 27);
  await sleep(700);
  const draftAfter = await draft();
  check(
    "draft text and revision survive workspace replacement",
    draftAfter.text === draftBefore.text && draftAfter.revision === draftBefore.revision,
  );
  // Editor expansion is local; reopening must render the stored draft.
  if (!(await ev("!!document.querySelector('[data-draft-compare=\"tool-result\"]')")))
    await click(button("在此重跑（时间旅行）"));
  await waitFor("window.__u1Editable()?.getModel()?.getValue().includes('U1 draft survives')");
  check("reopened editor renders retained draft", true);
  await screenshot("draft-restored-640");
  await ev(
    "(() => { const s=window.__u1Store.getState(), k={runId:'u1_completion_tools',spanId:'s_03',field:'result'}; s.discardCallDraft(k,s.callDraftOf(k).revision); })()",
  );
  await ev("window.__u1Store.getState().selectRun('u1_completion_reasoning')");
  await resize(1440);
  check(
    "automatic folding preserves wide preference",
    await ev("!!document.querySelector('#run-navigation')"),
  );
  await click(button("步骤"));
  await click(button("输出"));
  const reasoning = await ev(`(() => {
    const titles=[...document.querySelectorAll('div.font-semibold')];
    const a=titles.find(e=>e.textContent==='思维链（reasoning_content）')?.parentElement;
    const b=titles.find(e=>e.textContent==='响应正文')?.parentElement;
    if(!a||!b) return {found:false,titles:titles.map(e=>e.textContent)};
    const colored=a.querySelector('.bg-amber-50');
    return {found:true,separate:a!==b,reasoning:a.textContent.includes('U1 reasoning:'),content:b.textContent.includes('U1 response:'),
      a:a.getBoundingClientRect().toJSON(),b:b.getBoundingClientRect().toJSON(),
      color:colored && getComputedStyle(colored).backgroundColor,border:colored && getComputedStyle(colored).borderLeftWidth};
  })()`);
  check(
    "reasoning and response rendered in distinct nonoverlapping sections",
    reasoning.found &&
      reasoning.separate &&
      reasoning.reasoning &&
      reasoning.content &&
      reasoning.a.bottom <= reasoning.b.top,
    reasoning,
  );
  check(
    "reasoning has distinct visible styling",
    reasoning.border === "2px" && reasoning.color !== "rgba(0, 0, 0, 0)",
    reasoning,
  );
  measurements.push({ reasoning });
  await screenshot("reasoning-sections");
  check(
    "existing traces blobs and settings unchanged",
    JSON.stringify(before) === JSON.stringify(surface()),
  );
  fs.writeFileSync(
    path.join(out, "measurements.json"),
    `${JSON.stringify({ checks, measurements }, null, 2)}\n`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, "measurements.json"),
      `${JSON.stringify({ checks, measurements, error: String(error) }, null, 2)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => ws?.close());
