import { describe, expect, it } from "vitest";

/**
 * U2 任务 4.1 / 4.2 / 4.3：文件视图**容器布局判据**（纯逻辑层，design D4）。
 *
 * 对应 delta（requirement「文件目录和差异按内容容器宽度适配」）：
 * -「文件正文在代表视口可读」：inline 文字区 ≥480，并排每侧 ≥320，目录不足时收起。
 * -「同视口下响应容器变化」：**吃容器实测宽**（不是窗口断点）。
 * -「手动布局偏好不被自动折叠覆盖」：自动降级不写回偏好，恢复后还原。
 */

const {
  FILE_DIR_MIN,
  FILE_DIR_MAX,
  FILE_DIR_DEFAULT,
  INLINE_MIN_TEXT,
  SIDE_BY_SIDE_MIN_TEXT,
  clampFileDirWidth,
  stepFileDirWidth,
  decideDirResident,
  decideDiffMode,
  resolveFilePaneVisibility,
  preserveFilePrefs,
  initialFileLayoutPrefs,
} = await import("../src/renderer/src/lib/file-layout");

describe("U2 4.1 目录宽度夹取与键盘步进", () => {
  it("夹到 200–320；非有限值回默认（不用 min 冒充用户意图）", () => {
    expect(clampFileDirWidth(150)).toBe(FILE_DIR_MIN);
    expect(clampFileDirWidth(400)).toBe(FILE_DIR_MAX);
    expect(clampFileDirWidth(260)).toBe(260);
    expect(clampFileDirWidth(Number.NaN)).toBe(FILE_DIR_DEFAULT);
  });

  it("键盘步进 16px，Home/End 到边界，其它键不消费（返回 null）", () => {
    expect(stepFileDirWidth(232, "ArrowRight")).toBe(248);
    expect(stepFileDirWidth(232, "ArrowLeft")).toBe(216);
    expect(stepFileDirWidth(232, "Home")).toBe(FILE_DIR_MIN);
    expect(stepFileDirWidth(232, "End")).toBe(FILE_DIR_MAX);
    expect(stepFileDirWidth(232, "Enter")).toBeNull();
    // 边界处再步进仍夹住
    expect(stepFileDirWidth(FILE_DIR_MAX, "ArrowRight")).toBe(FILE_DIR_MAX);
  });
});

describe("U2 4.1 目录常驻判据（容器实测宽，不是窗口断点）", () => {
  it("容器足够宽 ⇒ 常驻（扣目录+间距+chrome 后文字区仍 ≥480）", () => {
    expect(decideDirResident({ prefs: initialFileLayoutPrefs, containerWidth: 1200 })).toBe(true);
  });

  it("容器偏窄 ⇒ 自动收起目录（正文优先，不把正文挤成窄条）", () => {
    expect(decideDirResident({ prefs: initialFileLayoutPrefs, containerWidth: 700 })).toBe(false);
  });

  it("用户显式收起 ⇒ 即使很宽也不常驻（偏好优先）", () => {
    const prefs = { ...initialFileLayoutPrefs, dirUserCollapsed: true };
    expect(decideDirResident({ prefs, containerWidth: 2000 })).toBe(false);
  });

  it("**同容器宽下改目录宽**会改变结论——证明吃的是容器工况而非窗口", () => {
    const narrowDir = { ...initialFileLayoutPrefs, dirWidth: FILE_DIR_MIN };
    const wideDir = { ...initialFileLayoutPrefs, dirWidth: FILE_DIR_MAX };
    // 取一个临界容器宽：窄目录能常驻、宽目录不行。
    // 常驻条件：width − dirWidth − GUTTER − INLINE_CHROME ≥ INLINE_MIN_TEXT
    // 门槛在 dirWidth 从 200→320 时右移 120px，故取值落在两门槛之间（各留 60px 余量）。
    const width = INLINE_MIN_TEXT + FILE_DIR_MIN + 12 + 74 + 60;
    expect(decideDirResident({ prefs: narrowDir, containerWidth: width })).toBe(true);
    expect(decideDirResident({ prefs: wideDir, containerWidth: width })).toBe(false);
  });
});

describe("U2 4.2 diff 模式判据（inline / 并排）", () => {
  it("auto：两侧文字区各自 ≥320 才并排，否则 inline", () => {
    const wide = decideDiffMode({ prefs: initialFileLayoutPrefs, contentAreaWidth: 800 });
    expect(wide.mode).toBe("sideBySide");
    const narrow = decideDiffMode({ prefs: initialFileLayoutPrefs, contentAreaWidth: 500 });
    expect(narrow.mode).toBe("inline");
  });

  it("用户选 inline ⇒ 宽屏也 inline（不被强制并排）", () => {
    const prefs = { ...initialFileLayoutPrefs, diffPreference: "inline" as const };
    expect(decideDiffMode({ prefs, contentAreaWidth: 2000 }).mode).toBe("inline");
  });

  it("用户选并排但空间不足 ⇒ 降级 inline 且**说明空间不足**（不静默）", () => {
    const prefs = { ...initialFileLayoutPrefs, diffPreference: "sideBySide" as const };
    const r = decideDiffMode({ prefs, contentAreaWidth: 400 });
    expect(r.mode).toBe("inline");
    expect(r.downgraded).toBe(true);
    expect(r.reason).toContain(`${SIDE_BY_SIDE_MIN_TEXT}`);
  });

  it("用户选并排且空间够 ⇒ 并排，不降级", () => {
    const prefs = { ...initialFileLayoutPrefs, diffPreference: "sideBySide" as const };
    const r = decideDiffMode({ prefs, contentAreaWidth: 900 });
    expect(r.mode).toBe("sideBySide");
    expect(r.downgraded).toBe(false);
  });
});

describe("U2 4.1 极窄档：目录与内容占同一主区", () => {
  it("目录非常驻 ⇒ 按 pane 二选一显示", () => {
    expect(resolveFilePaneVisibility({ dirResident: false, pane: "list" })).toEqual({
      showList: true,
      showContent: false,
    });
    expect(resolveFilePaneVisibility({ dirResident: false, pane: "content" })).toEqual({
      showList: false,
      showContent: true,
    });
  });

  it("目录常驻 ⇒ 两者都显示（并排）", () => {
    expect(resolveFilePaneVisibility({ dirResident: true, pane: "list" })).toEqual({
      showList: true,
      showContent: true,
    });
  });
});

describe("U2 4.1 自动降级不写回偏好", () => {
  it("preserveFilePrefs 返回原对象（任何把可见性存回偏好的写法都是错的）", () => {
    const prefs = {
      ...initialFileLayoutPrefs,
      dirWidth: 300,
      diffPreference: "sideBySide" as const,
    };
    expect(preserveFilePrefs(prefs)).toBe(prefs);
  });
});
