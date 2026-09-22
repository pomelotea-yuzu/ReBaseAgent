/**
 * 环境声明补充（U1 任务 5.6）。
 *
 * monaco-editor 的 `exports` 把若干深层入口（语言贡献）映射到无 `.d.ts` 的 `.js`。
 * 静态副作用 `import "…"` 不触发 TS7016，但**动态** `import("…")`（懒加载所需）会要求类型
 * ⇒ 在此声明其为无副作用类型的模块。
 */

declare module "monaco-editor/language/json/monaco.contribution";
declare module "monaco-editor/features/register.all";
