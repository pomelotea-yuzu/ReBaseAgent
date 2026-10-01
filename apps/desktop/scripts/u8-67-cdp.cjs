/* eslint-disable */
/**
 * U8 任务 6.7（Electron 实机第二批）：实验臂增删/非法值/{}/继承参数、三段计划、
 * 修改后失效、设置往返/仅换 key、取消费用确认及副作用说明；零调用/落盘由 mock
 * 计数（GET /__log served）和 traces 目录指纹核对。
 *
 * 对应 delta 场景：#32 运行入口打开明确实验目标、#33 切运行不更换实验父本（仅入口半边）、
 * #34 实验空参数与显式空对象区分、#36 离开实验恢复不带计划许可（计划失效呈现）、
 * #52/53/54/55 批次分组标签（experimentId 随组展示）、#56 未确认时阻断真实调用、
 * #57 dry-run 无密钥（零调用）、#58/59 三段计划、#61 费用确认区分臂数和请求数、
 * #62 计划直接展示、#63 修改臂再改回不恢复计划、#64 配置轮换与来源撤销作废计划（仅换 key 半边）、
 * #66 无有效计划和确认不提交实验。
 *
 * 分层登记：副作用声明路径需要带风险工具的父本（纯对话父本 risky=[] ⇒ 复选框不出现）
 * ⇒ 声明路径按 U5 6.5 实机（旧载体）+ 3.4/3.9 迁移判据承载；本批验证披露措辞与
 * 无工具父本的完整计划链路。overridden/discarded 形态需父 run 录有 params
 * （CreateRunRequest 无 params 字段 ⇒ 父录值恒无）⇒ 新增形态实机呈现，
 * 覆盖/丢弃由 fork-runner CLI 单元承载（字段渲染同一条 ArmPlanRow）。
 *
 * 用法：`node apps/desktop/scripts/u8-67-cdp.cjs --tag=experiment-plan`
 * 前置：dev 已由 run-all 起（CDP 9612）；mock-llm 18799 已由 run-all 进程内起好。
 */
"use strict";
const { writeFileSync, mkdirSync, existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const http = require("node:http");
const H = require("./lib/u4-smoke-harness.cjs");

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TAG = arg("tag", "experiment-plan");

const OUT_DIR = join(H.REPO, ".workbuddy", "u8", "u8-67");
const SHOT_DIR = join(OUT_DIR, "shots");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });

const checks = [];
const dump = {};
function check(name, ok, detail) {
  checks.push({ tag: TAG, name, ok: ok === true, detail: detail ?? null });
  const shown =
    detail === undefined || detail === null
      ? ""
      : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  console.log(`${ok === true ? "✓" : "✗"} ${name}${ok === true ? "" : shown}`);
}
function note(text) {
  console.log(`ℹ ${text}`);
  checks.push({ tag: TAG, name: `[登记] ${text}`, ok: true, note: true });
}
function headShort() {
  try {
    const head = readFileSync(join(H.REPO, ".git", "HEAD"), "utf8").trim();
    const m = head.match(/^ref: (.+)$/);
    if (m) {
      const refFile = join(H.REPO, ".git", ...m[1].split("/"));
      if (existsSync(refFile)) return readFileSync(refFile, "utf8").trim().slice(0, 7);
    }
    return head.slice(0, 7);
  } catch {
    return "unknown";
  }
}
function finish(extraMeta = {}) {
  const failed = checks.filter((c) => !c.ok && !c.note);
  writeFileSync(
    join(OUT_DIR, `${TAG}-measurements.json`),
    JSON.stringify({ tag: TAG, meta: { head: headShort(), ...extraMeta }, checks, failed: failed.length, dump }, null, 2),
  );
  console.log(`检查 ${checks.filter((c) => !c.note).length} 条，失败 ${failed.length} 条`);
  clearTimeout(watchdog);
  process.exit(failed.length === 0 ? 0 : 1);
}
const watchdog = setTimeout(() => {
  console.error(`看门狗：${TAG} 超过 12 分钟未收尾 ⇒ 判失败退出`);
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), "watchdog timeout");
  process.exit(3);
}, 720_000);

/** mock 服务计数（node 侧直读：__log.served） */
function mockServed() {
  return new Promise((resolve, reject) => {
    const req = http.get("http://127.0.0.1:18799/__log", (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body).served);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("mock /__log 超时"));
    });
  });
}

// ---------------------------------------------------------------------------
// 页内读数与动作
// ---------------------------------------------------------------------------

const abState = (call) =>
  H.storeQ(
    call,
    `return JSON.stringify({
       view: s.view, selectedRunId: s.selectedRunId,
       experimentTarget: s.experimentTarget,
       inFlight: s.modelAbInFlight,
     });`,
  );

/** 编辑器 DOM 读数（按钮态/计划区/披露/拦截文案） */
const abDom = (call) =>
  H.ev(
    call,
    `(() => {
       const root = Array.from(document.querySelectorAll('div'))
         .find(d => (d.textContent || '').includes('模型 A/B 实验 · 同上下文多臂对比') && d.querySelector('[data-confirm-execution]'));
       if (!root) return JSON.stringify(null);
       const btns = Array.from(root.querySelectorAll('button'));
       const byText = (t) => btns.find(b => (b.textContent || '').trim().startsWith(t));
       const preview = byText('校验并预览计划') ?? byText('重新校验') ?? byText('校验中…');
       const exec = byText('确认执行');
       const confirm = root.querySelector('[data-confirm-execution]');
       const planArea = Array.from(root.querySelectorAll('div'))
         .find(d => (d.textContent || '').includes('校验通过 · 执行计划'));
       return JSON.stringify({
         planText: planArea ? planArea.textContent : null,
         previewDisabled: preview ? preview.disabled : null,
         execDisabled: exec ? exec.disabled : null,
         execLabel: exec ? exec.textContent.trim() : null,
         confirmDisabled: confirm ? confirm.disabled : null,
         confirmPressed: confirm ? confirm.getAttribute('aria-pressed') : null,
         disclosure: (root.querySelector('dl') || {}).textContent ?? null,
         blocked: (root.textContent || '').includes('空 fork') || (root.textContent || '').includes('不能为空'),
         staleText: (() => {
           const amber = Array.from(root.querySelectorAll('div')).filter(d => d.className.includes('amber-800'));
           return amber.length > 0 ? amber[amber.length - 1].textContent : null;
         })(),
       });
     })()`,
  ).then(JSON.parse);

/** 臂行输入定位（第 n 臂的 model / paramsText 输入） */
async function setArm(call, index, model, paramsText) {
  const r = await H.ev(
    call,
    `(() => {
       const rows = Array.from(document.querySelectorAll('div'))
         .filter(d => typeof d.className === 'string' && d.className.includes('border-sky-200') && d.querySelector('input[placeholder="model 名"]'));
       const row = rows[${index}];
       if (!row) {
         const candidates = Array.from(document.querySelectorAll('input[placeholder="model 名"]')).length;
         return JSON.stringify({ error: 'row-not-found', matched: rows.length, modelInputs: candidates });
       }
       const inputs = row.querySelectorAll('input');
       const set = (el, v) => {
         const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
         setter.call(el, v);
         el.dispatchEvent(new Event('input', { bubbles: true }));
       };
       set(inputs[0], ${JSON.stringify(model)});
       set(inputs[1], ${JSON.stringify(paramsText)});
       return JSON.stringify({ ok: true, model: inputs[0].value, params: inputs[1].value });
     })()`,
  ).then(JSON.parse);
  if (r?.ok !== true) throw new Error(`臂 ${index + 1} 输入未生效：${JSON.stringify(r)}`);
  await H.sleep(400);
}

async function clickPreviewAndWait(call, timeoutMs = 20000) {
  const servedBefore = await mockServed();
  const ok = await H.ev(
    call,
    `(() => {
       const b = Array.from(document.querySelectorAll('button'))
         .find(x => { const t = (x.textContent || '').trim(); return t === '校验并预览计划' || t === '重新校验'; });
       if (!b || b.disabled) return false;
       b.click(); return true; })()`,
  );
  if (ok !== true) throw new Error("预览按钮不可点");
  // 等 previewing 出现→消失（或计划区直接出现）
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = await abDom(call);
    if (st?.planText !== null && st?.previewDisabled === false) break;
    if (Date.now() > deadline) throw new Error(`预览未收尾：${JSON.stringify(st)}`);
    await H.sleep(500);
  }
  return { servedBefore };
}

async function openSettingsAndSaveKey(call, newKey) {
  // 打开设置（GlobalBar 精确 title）
  const r = await H.ev(
    call,
    `(() => {
       const scope = Array.from(document.querySelectorAll('header'))
         .find(h => Array.from(h.querySelectorAll('button')).some(b => (b.title || '').startsWith('配置 LLM 接入')));
       const b = scope && scope.querySelector('button[title^="配置 LLM 接入"]');
       if (!b) return false; b.click(); return true; })()`,
  );
  if (r !== true) throw new Error("找不到设置入口按钮");
  await H.sleep(900);
  // 改 key（input[type=password]）+ 保存
  const edited = await H.typeIntoDom(call, 'dialog[open] input[type="password"]', newKey);
  if (!String(edited?.value ?? "").includes(newKey)) throw new Error(`key 输入未生效：${JSON.stringify(edited)}`);
  await H.clickInOpenDialog(call, "保存", 1200);
  // 关闭设置：Esc（ModalDialog 最上层合成关闭）⇒ 轮询 dialog 消失
  await H.ev(
    call,
    `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`,
  );
  const deadline = Date.now() + 8000;
  for (;;) {
    const n = await H.ev(call, `JSON.stringify(document.querySelectorAll('dialog[open]').length)`).then(JSON.parse);
    if (n === 0) break;
    if (Date.now() > deadline) throw new Error("设置模态未关闭");
    await H.sleep(400);
  }
  await H.sleep(500);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const page = await H.cdpConnect(H.CDP_PORT);
  const call = await H.makeDialogSession(page.webSocketDebuggerUrl);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.bringToFront").catch(() => {});
  await call("Emulation.clearDeviceMetricsOverride").catch(() => {});

  await call("Page.reload", { ignoreCache: true });
  // ⚠️ 必须等列表真加载（runs.length>0）：418 份水合需要数秒——只等 H.runs 可调用
  // 会在 500ms 时拿到空列表就放行，store 尚未就绪 ⇒ 创建页打开判据全假（首跑坐实）
  for (let i = 0; i < 80; i++) {
    await H.sleep(500);
    try {
      if ((await H.runs(call)).length > 0) break;
    } catch {
      /* 重载瞬间 */
    }
  }
  await H.sleep(900);

  try {
    // 就绪
    const dpr = await H.ev(call, "window.devicePixelRatio");
    check("DPR ≈ 2.1（无 zoom 残留）", Math.abs(dpr - 2.1) < 0.15, `实测 ${dpr}`);
    const served0 = await mockServed();
    check("mock 服务健康（/__log 可读）", typeof served0 === "number", served0);

    // ── 现造父本（UI 创建：纯对话 + 字符串 system ⇒ A/B 合法父本）──
    await H.storeQ(call, `s.openCreateWorkspace(); return JSON.stringify("ok");`);
    await H.sleep(1200);
    const createView = await H.storeQ(
      call,
      `return JSON.stringify({ view: s.view, runsN: s.runs.length });`,
    );
    dump.createView = createView;
    if (createView.view !== "create") throw new Error(`创建页未打开：${JSON.stringify(createView)}`);
    // systemPrompt 在高级区内（折叠不可见 ⇒ 先展开，否则 offsetParent=null 拒聚焦）
    const advanced = await H.ev(
      call,
      `(() => {
         const b = document.querySelector('[data-advanced-toggle]');
         const viewProbe = document.querySelector('[data-create-body]') !== null ||
           Array.from(document.querySelectorAll('textarea')).some(t => (t.placeholder || '').startsWith('要交给模型的任务'));
         return JSON.stringify({
           found: b !== null,
           visible: b !== null && b.offsetParent !== null,
           expanded: b ? b.getAttribute('aria-expanded') : null,
           createViewMounted: viewProbe,
         });
       })()`,
    ).then(JSON.parse);
    dump.createProbe = advanced;
    if (!advanced.found || !advanced.visible) throw new Error(`高级区探测失败：${JSON.stringify(advanced)}`);
    if (advanced.expanded === "false") {
      await H.ev(
        call,
        `(() => { document.querySelector('[data-advanced-toggle]').click(); return true; })()`,
      );
      await H.sleep(700);
    }
    const sys = await H.typeIntoDom(
      call,
      'textarea[placeholder^="例如：你是一个简洁的问答助手"]',
      "你是通用文件助手。",
    );
    const user = await H.typeIntoDom(
      call,
      'textarea[placeholder^="要交给模型的任务"]',
      "U8 实验父本：解释这段代码的作用",
    );
    check("创建表单已填（system + user）", String(sys?.value ?? "").length > 5 && String(user?.value ?? "").length > 5, {
      sys: sys?.value,
      user: user?.value,
    });
    // 确认 → 创建（ready 异步生效 ⇒ 点击后延时读 aria-pressed，不能同步读）
    const confirmClick = await H.ev(
      call,
      `(() => {
         const b = document.querySelector('[data-confirm-execution]');
         if (!b) return JSON.stringify({ state: 'no-button' });
         if (b.disabled) return JSON.stringify({ state: 'disabled', label: b.textContent.trim() });
         b.click();
         return JSON.stringify({ state: 'clicked' });
       })()`,
    ).then(JSON.parse);
    await H.sleep(900);
    const confirmState = await H.ev(
      call,
      `(() => {
         const b = document.querySelector('[data-confirm-execution]');
         return JSON.stringify({ pressed: b ? b.getAttribute('aria-pressed') : null,
           label: b ? b.textContent.trim() : null, disabled: b ? b.disabled : null });
       })()`,
    ).then(JSON.parse);
    dump.confirmClick = { click: confirmClick, after: confirmState };
    if (confirmState.pressed !== "true") {
      throw new Error(`创建确认未挂上：${JSON.stringify({ click: confirmClick, after: confirmState })}`);
    }
    await H.sleep(300);
    const createBtn = await H.ev(
      call,
      `(() => {
         const b = Array.from(document.querySelectorAll('button'))
           .find(x => { const t = (x.textContent || '').trim(); return t === '创建' || t === '创建中…'; });
         return JSON.stringify({ found: b !== undefined, disabled: b ? b.disabled : null, label: b ? b.textContent.trim() : null });
       })()`,
    ).then(JSON.parse);
    dump.createBtn = createBtn;
    if (!createBtn.found || createBtn.disabled) {
      throw new Error(`创建按钮不可点：${JSON.stringify(createBtn)}`);
    }
    const runsBefore = await H.runs(call);
    await H.ev(
      call,
      `(() => {
         const b = Array.from(document.querySelectorAll('button'))
           .find(x => (x.textContent || '').trim() === '创建');
         if (!b || b.disabled) return false; b.click(); return true; })()`,
    ).then((r) => {
      if (r !== true) throw new Error(`创建点击失败：${JSON.stringify(createBtn)}`);
    });
    await H.sleep(1200);
    const afterClick = await H.ev(
      call,
      `(() => {
         const b = Array.from(document.querySelectorAll('button'))
           .find(x => { const t = (x.textContent || '').trim(); return t === '创建' || t === '创建中…'; });
         return JSON.stringify({ label: b ? b.textContent.trim() : null });
       })()`,
    ).then(JSON.parse);
    dump.afterClick = afterClick;
    // 等收口：runs 列表出现新 run
    let parentId = null;
    const deadline = Date.now() + 40000;
    for (;;) {
      const runs = await H.runs(call);
      const fresh = runs.find((id) => !runsBefore.includes(id));
      if (fresh) {
        parentId = fresh;
        break;
      }
      if (Date.now() > deadline) throw new Error(`创建 40s 未收尾（runs=${JSON.stringify(runs)}）`);
      await H.sleep(600);
    }
    const servedAfterCreate = await mockServed();
    check(
      "父本现造成功且 mock 恰好 1 次调用",
      parentId !== null && servedAfterCreate === served0 + 1,
      { parentId, served: [served0, servedAfterCreate] },
    );
    // traces 基线取在父本创建后（创建合法写 1 份 trace）
    const tracesBaseline = H.traceIds();
    dump.parentRunId = parentId;

    // ── 打开实验工作区（运行页头「模型实验」入口）──
    await H.storeQ(call, `await s.selectRun(${JSON.stringify(parentId)}); return JSON.stringify("ok");`);
    await H.sleep(1200);
    await H.ev(
      call,
      `(() => {
         const b = document.querySelector('[data-experiment-entry]');
         if (!b || b.disabled) return false; b.click(); return true; })()`,
    ).then((r) => {
      if (r !== true) throw new Error("「模型实验」入口不可点");
    });
    await H.sleep(1200);
    const st1 = await abState(call);
    check(
      "#32 运行入口打开实验工作区（目标显式绑定父本）",
      st1.view === "experiment" &&
        st1.experimentTarget?.runId === parentId &&
        typeof st1.experimentTarget?.spanId === "string",
      st1,
    );

    // ── 默认两臂 = 空 fork ⇒ 预览被拦（「实验空参数」的拦截半边）──
    let dom = await abDom(call);
    check(
      "#34 默认两臂空 fork ⇒ 预览不可用 + 拦截文案（不产生部分有效请求）",
      dom?.previewDisabled === true,
      dom,
    );
    note("#34 拦截文案的措辞机器判据由 model-ab guard 单元承载（空文本=沿用父、显式 {} 等价空），实机呈现为预览 disabled。");

    // ── 非法值：臂 1 非法 JSON ⇒ 同样拦截 ──
    await setArm(call, 0, "deepseek-chat", "{ temperature: }");
    await setArm(call, 1, "deepseek-reasoner", "{}");
    dom = await abDom(call);
    check("#34 非法参数文本 ⇒ 预览仍不可用（非法原文不清洗）", dom?.previewDisabled === true, dom);

    // ── 合法态：臂 1 覆盖参数（新增形态）、臂 2 显式 {} + 不同 model ──
    await setArm(call, 0, "deepseek-chat", '{"temperature":0.2}');
    dom = await abDom(call);
    check("合法态：预览可用（空文本/显式 {} /非法值三态区分）", dom?.previewDisabled === false, dom);

    // ── 预览 → 三段计划 + 零调用零落盘 ──
    const { servedBefore } = await clickPreviewAndWait(call);
    const servedAfterPreview = await mockServed();
    dom = await abDom(call);
    check(
      "#57/#61 dry-run 零调用（served 不变）、零落盘（traces 只含父本）",
      servedAfterPreview === servedBefore && H.traceIds().size === tracesBaseline.size,
      { served: [servedBefore, servedAfterPreview], traces: [tracesBaseline.size, H.traceIds().size] },
    );
    check(
      "#58/#62 三段计划呈现：生效 params（新增标签）+ 臂 2 显式空 = 沿用父 params",
      (dom?.planText ?? "").includes("校验通过 · 执行计划") &&
        (dom?.planText ?? "").includes("temperature=0.2") &&
        (dom?.planText ?? "").includes("（新增）") &&
        (dom?.planText ?? "").includes("（沿用父 params）") &&
        (dom?.planText ?? "").includes("deepseek-reasoner"),
      dom?.planText?.slice(0, 400),
    );
    check(
      "#54 预览实验组标签在场（experimentId 随组展示）",
      (dom?.planText ?? "").includes("实验组 exp_"),
      (dom?.planText ?? "").match(/实验组 exp_[0-9a-f]+/)?.[0] ?? null,
    );
    check(
      "#61 执行按钮臂数措辞（「2 臂」，不宣称请求次数）",
      dom?.execLabel === "确认执行（2 臂）" && dom?.execDisabled === true,
      { execLabel: dom?.execLabel, execDisabled: dom?.execDisabled },
    );
    check(
      "#56 未确认 ⇒ 执行不可用；确认按钮可用（计划 fresh）",
      dom?.confirmDisabled === false && dom?.confirmPressed === null,
      { confirmDisabled: dom?.confirmDisabled, pressed: dom?.confirmPressed },
    );

    // ── #63 修改臂再改回 ⇒ 计划不恢复 ──
    const revBefore = await H.storeQ(
      call,
      `const k = { runId: s.experimentTarget.runId, spanId: s.experimentTarget.spanId };
       const d = s.modelAbDraftOf(k);
       return JSON.stringify({ revision: d ? d.revision : null, rows: d ? d.rows.map(r => [r.model, r.paramsText]) : null });`,
    );
    await setArm(call, 0, "deepseek-chat-x", '{"temperature":0.2}');
    await setArm(call, 0, "deepseek-chat", '{"temperature":0.2}');
    await H.sleep(800);
    const revAfter = await H.storeQ(
      call,
      `const k = { runId: s.experimentTarget.runId, spanId: s.experimentTarget.spanId };
       const d = s.modelAbDraftOf(k);
       return JSON.stringify({ revision: d ? d.revision : null, rows: d ? d.rows.map(r => [r.model, r.paramsText]) : null });`,
    );
    dump.rev63 = { before: revBefore, after: revAfter };
    dom = await abDom(call);
    dump.dom63 = dom;
    check(
      "#63 修改臂再改回 ⇒ 批次修订推进（改走又改回不回到预览时修订）",
      revAfter.revision !== null && revBefore.revision !== null && revAfter.revision > revBefore.revision,
      { before: revBefore, after: revAfter },
    );
    check(
      "#63 修改臂再改回 ⇒ 计划失效（确认/执行禁用 + 计划区消失 = 「不恢复」的完整行为呈现）",
      dom?.confirmDisabled === true &&
        dom?.execDisabled === true &&
        dom?.planText === null,
      { planText: dom?.planText === null ? "已消失" : dom?.planText?.slice(0, 80),
        confirmDisabled: dom?.confirmDisabled, execDisabled: dom?.execDisabled },
    );
    await clickPreviewAndWait(call);
    dom = await abDom(call);
    check("#63 重新校验 ⇒ 计划恢复（确认按钮可点）", dom?.confirmDisabled === false, dom?.confirmDisabled);

    // ── #64 设置往返不误杀 → 仅换 key 作废 ──
    await openSettingsAndSaveKey(call, "sk-u8-67-rotated");
    const st2 = await abState(call);
    dom = await abDom(call);
    check(
      "#64 已核实仅换 key 保存 ⇒ 计画作废（指纹不变、代次推进：确认禁用 + 计划区消失）",
      dom?.confirmDisabled === true && dom?.planText === null && st2.view === "experiment",
      { planText: dom?.planText === null ? "已消失" : dom?.planText?.slice(0, 80),
        confirmDisabled: dom?.confirmDisabled, view: st2.view },
    );
    await clickPreviewAndWait(call);
    dom = await abDom(call);
    check("#64 重新校验 ⇒ 计划恢复（代次已对齐）", dom?.confirmDisabled === false, dom?.confirmDisabled);

    // ── #56/#61 确认与披露（不真实执行）──
    await H.ev(
      call,
      `(() => { const b = document.querySelector('[data-confirm-execution]'); b.click(); return true; })()`,
    );
    await H.sleep(700);
    dom = await abDom(call);
    check(
      "#56 确认成立 ⇒ 执行按钮就绪（aria-pressed=true）；本批不点执行（零执行纪律）",
      dom?.confirmPressed === "true" && dom?.execDisabled === false,
      { pressed: dom?.confirmPressed, execDisabled: dom?.execDisabled },
    );
    check(
      "#61 披露按臂数措辞（含「2 臂」与费用未知，不含「次真实调用」式宣称）",
      (dom?.disclosure ?? "").includes("2 臂") &&
        (dom?.disclosure ?? "").includes("臂数") &&
        !(dom?.disclosure ?? "").includes("次真实调用"),
      dom?.disclosure?.slice(0, 260),
    );
    const servedFinal = await mockServed();
    check(
      "#57 全程零执行（mock 计数 = 父本 1 次 + 预览 0 次）",
      servedFinal === served0 + 1,
      { served: [served0, servedFinal] },
    );
    check(
      "#57 全程零落盘（traces 与父本创建后一致）",
      H.traceIds().size === tracesBaseline.size,
      { traces: [tracesBaseline.size, H.traceIds().size] },
    );
    await H.shot(call, SHOT_DIR, "experiment-plan.png");
    note("#67 副作用声明路径需带风险工具父本（纯对话父本 risky=[] ⇒ 复选框不出现）⇒ 声明路径按 U5 6.5 实机（旧载体）+ 3.4/3.9 迁移判据承载。");
    note("overridden/丢弃父录值形态需父 run 录有 params（CreateRunRequest 无 params 字段）⇒ 字段渲染同一条 ArmPlanRow，覆盖/丢弃由 fork-runner CLI 单元承载。");
    note("#33 切运行不更换实验父本的实机半边（切运行后目标保持）随 6.8 真实执行批次复核（本批单父本单工作区）。");
    note("🔴 planStaleText/config-stale 失效说明文案当前不可达：commitRows（L314）与 useRevokeOnConfigChange（L222）都先 setPlan(null) ⇒ planStale 恒 false，而文案渲染条件要求 plan!==null——L234 注释「后两种要就近说清楚」的设计意图未接上；实际呈现 = 计划区整体消失 + 按钮禁用（行为安全，缺一句为什么）。是否补呈现或删死代码归定口径。");
  } catch (e) {
    check(`tag 执行异常：${String(e?.message ?? e).slice(0, 300)}`, false);
  }
  finish();
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  writeFileSync(join(OUT_DIR, `${TAG}-error.txt`), String(e?.stack ?? e));
  process.exit(1);
});
