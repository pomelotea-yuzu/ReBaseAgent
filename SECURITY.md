# 安全策略

## 支持的版本

| 版本 | 状态 |
|---|---|
| 0.3.0-k1 | ✅ 支持 |
| 0.3.0-k0 | ✅ 支持 |
| < 0.3.0 | ❌ 请升级 |

## 如何报告漏洞

**请勿用公开 issue 报告安全漏洞。**

- 非敏感问题（崩溃、文件丢失等）：正常走 [issue 模板](https://github.com/pomelotea-yuzu/ReBaseAgent/issues/new/choose)；
- 敏感漏洞（凭据泄露、代理转发被劫持、路径逃逸等）：通过 GitHub / Gitee 私信联系
  owner（GitHub `pomelotea-yuzu` · Gitee `yuzu-tea-duck`），或在 GitHub 解禁私报渠道后
  使用 "Report a vulnerability"。

报告请附：影响描述、复现步骤、涉及的组件（desktop / llm-proxy / replay / agent-loop）。
通常 **3 个工作日内**回应。

## 设计上的安全边界（诚实声明）

- **API key**：录制代理仅将 key 暂存于内存、不落盘、不回传渲染层；只有「重发」才需要 key。
  脱敏覆盖本次配置的 apiKey / baseURL 凭据与 Authorization、Bearer、URL 凭据形态，
  **不承诺识别任意业务文本里的所有秘密**。
- **隔离重跑不是权限系统**：文件检查点只保证"父 run / 源目录 / 兄弟分支逐字节不变"，
  不隔离网络、shell 与外部状态源；副本写入授权不改变源目录的访问权限。
- **数据本地优先**：所有数据在应用目录旁的 `data/`，不写 AppData / 注册表；
  但这**不是加密**——磁盘上的 trace 与附件对本机用户是明文可读的。
