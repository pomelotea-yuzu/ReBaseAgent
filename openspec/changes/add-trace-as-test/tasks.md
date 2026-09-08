# 任务

- [ ] 1.1 定义测试资产、断言、selector、quantifier、结果和错误类型 schema，补 schema 测试。
- [ ] 1.2 实现定义加载、相对路径解析、单文件/目录发现和退出码映射。
- [ ] 1.3 实现代理 run / 缺配置 run 的静态断言限制与清晰错误。
- [x] 2.1a 实现卡带 `LlmClient`：按请求顺序返回记录响应，记录 request drift，卡带耗尽或剩余未消费时报告配置错误。
- [x] 2.1b 从当前工具注册表构造记录结果桩工具，按工具名和调用序号匹配 result/error，绝不执行真实工具。
- [x] 2.1c 在 `trace-sdk` 的 `BaseTracer` 之上新增并导出 `MemoryTracer`，供 headless runner 收集新 span。
- [x] 2.1d 使用 MemoryTracer headless 调用当前 `runLoop`，不依赖 Electron、网络或文件落盘。
- [x] 2.1e 实现新旧轨迹结构对齐，比较 kind、父子关系、工具名、args 形状、tool-call 结构、顺序和 outcome。
- [ ] 2.2 实现 run.outcome、span selector/quantifier、字段、顺序和数量断言。
- [ ] 2.3 实现 config drift 计算与报告，确保测试路径不调用 replayRun hash 门禁。
- [ ] 2.4 实现失败定位、敏感字段脱敏和长度受限摘要。
- [ ] 3.1 提供 Vitest/Jest 可调用 runner API，支持用户注入当前 config 和 tools。
- [ ] 3.2 提供 CLI 单定义/目录入口、文本报告和 `--report json`。
- [ ] 3.3 提供基线更新路径（重新录制或 `--update-baseline`），禁止失败时静默覆盖测试资产。
- [ ] 4.1 使用 normal、tool-error、infinite-loop、代理 run fixture 覆盖通过、结构漂移、配置漂移和拒绝路径。
- [ ] 4.2 运行包级测试、Biome、TypeScript 检查和 OpenSpec strict 校验。
- [ ] 4.3 更新 README/HANDOFF：定位为运行时回归测试，加入隐私警告、集成方式和 V3a/V3b 路线。
