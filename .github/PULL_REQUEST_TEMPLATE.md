<!-- Title format: <type>(<scope>): <one-line change>, e.g. feat(desktop): support keyboard scrolling in the Files page -->
<!-- 标题格式建议：<类型>(<范围>): <一句话改动>，如 feat(desktop): 文件页支持键盘滚动 -->

## Summary / 改动说明

<!-- Why and what changed. For behavior changes, state before / after. -->
<!-- 为什么改、改了什么。行为变化请写清“之前 / 之后” -->

## Related issue / change / 关联 Issue / Change

- Related issue / 关联 issue: #
- OpenSpec change (if applicable): active directory `openspec/changes/<name>/`, or archive `openspec/changes/archive/<date>-<name>/`

## Checklist / 自查清单

- [ ] Verification record below is filled in; code/build-config changes run `pnpm check:ci`; pure docs changes check facts, links, and formatting
      已填写下方验证记录；代码/构建配置改动运行 `pnpm check:ci`，纯文档改动核对事实、链接与格式
- [ ] New/changed behavior has corresponding tests and verification; if not applicable, explain why
      新增/变更行为有相应测试与验证；不适用时说明原因
- [ ] For user-visible behavior: README "Current limitations" and "Roadmap" are synced
      涉及用户可见行为的：README「当前限制」「路线图」已同步
- [ ] For spec changes: proposal / tasks and the scenario evidence index `evidence-index.md` are attached; on-device materials are linked by index; uncovered items are listed
      涉及 spec 的：已附 proposal / tasks 与场景证据索引 `evidence-index.md`，实机材料按索引链接；未覆盖项写明限制
- [ ] Commit title describes the specific feature or engineering change; background and purpose are in the body
      提交标题描述具体功能或工程改动，背景与用途写在正文
- [ ] Third-party code, dependencies, icons, docs, or data list source, version, and license, and retain required notices; state if none were introduced
      第三方代码、依赖、图标、文档或数据已列来源、版本与许可，并保留所需声明；未引入时注明
- [ ] Logs, screenshots, and examples contain no valid credentials or unauthorized private data
      已检查日志、截图和示例，不包含有效凭据或未授权的私人数据

## Verification record / 验证记录

<!-- State the corresponding commit, actual commands/checks, and results; include artifact hashes for builds and actual clicks, keyboard, and layout evidence for UI. If not run, write the reason and uncovered scope; do not check items based on old commits. Pure docs do not need to start the app or a model. -->
<!-- 写明对应提交、实际命令/检查和结果；涉及构建时附产物哈希，涉及界面时附实际点击、键盘及布局证据。未运行写原因及未覆盖范围，不能用旧提交的结果勾选通过。纯文档无需启动应用或模型。 -->

## Third-party sources and licenses / 第三方来源与许可

<!-- Write "none introduced" if nothing was added. Otherwise list source links, version/commit, license, modifications, and notice file locations. -->
<!-- 无新增内容时写“未引入”。否则列来源链接、版本/提交、许可、修改情况及声明文件位置。 -->

## Limitations and follow-ups / 限制与后续事项

<!-- Open issues, compatibility impact, items the maintainer must re-verify. Link the primary discussion when submitting across GitHub/Gitee. -->
<!-- 未解决问题、兼容性影响、需要维护者补验的项目。跨 GitHub/Gitee 重复提交时链接主讨论位置。 -->
