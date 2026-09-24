<!-- 标题格式建议：<类型>(<范围>): <一句话改动>，如 feat(desktop): 文件页支持键盘滚动 -->

## 改动说明

<!-- 为什么改、改了什么。行为变化请写清“之前 / 之后” -->

## 关联 Issue / Change

- 关联 issue：#
- OpenSpec change（如涉及）：`openspec/changes/<name>/`（状态：proposed / applied / archived）

## 自查清单

- [ ] `pnpm check:ci` 全绿（build → typecheck → test → lint → spec）
- [ ] 新增/变更行为有测试覆盖（全部 mock 注入，零 API 消耗）
- [ ] 涉及用户可见行为的：README「当前限制」「路线图」已同步
- [ ] 涉及 spec 的：proposal / tasks / 归档证据（`docs/reviews/`）已附
- [ ] 提交信息一行说清本单元改动
