import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProxyForkMeta, ProxyRecording } from "@rebaseagent/llm-proxy";
import { deriveProxyConfigHash } from "@rebaseagent/replay";
import { PLAIN_FORMAT_VERSION } from "@rebaseagent/trace-sdk/schema";

/**
 * 代理录制的落盘器：把 llm-proxy 回调的录制数据写成 trace JSONL（一请求一 run）。
 *
 * 形态（与 add-llm-recording-proxy spec 对齐）：
 * - meta：task="(llm-proxy)"、含 source、**config_hash 条件写入**（可派生即写）；
 *   派生失败时写 `config_hash_reason`（缺因枚举）——两者互斥
 * - completed：agent.step(n=1) + llm.call + run.event(stopped/completed)
 * - error：**同样写** agent.step(n=1) + llm.call（request 完整、response 为失败
 *   空占位、顶层 error）+ run.event(stopped/error)。这是 tasks 3.3 的契约变更：
 *   旧形态只落 meta + stopped/error 就不写span，代价是概览无从诊断、失败 run
 *   也没有"自有调用"因而无法编辑重发。
 * - crashed：agent.step + llm.call，无终止事件（读取器识别为运行中断）
 * - fork：parent 指向源 run，fork = { at_span, edit: { field: "messages", value } }
 *
 * span id 恒为 s_01/s_02：代理 run 不经 resolveBranch 合并轨迹（渲染层父链列表呈现），
 * 跨文件 id 重复无冲突。
 */
export class ProxyRunRecorder {
  constructor(private readonly tracesDir: string) {}

  /** 写一个 run 文件，返回 run id */
  write(recording: ProxyRecording, fork?: ProxyForkMeta): string {
    const id = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const file = join(this.tracesDir, `${id}.jsonl`);
    const now = new Date().toISOString();
    const startedAt = recording.started_at ?? now;

    // 从请求快照派生配置指纹（与 agent-loop 同一实现）；派生失败记结构化缺因
    const derivation = deriveProxyConfigHash({
      messages: recording.request.messages,
      ...(recording.request.tools !== undefined ? { tools: recording.request.tools } : {}),
    });

    const meta = {
      type: "run.meta",
      id,
      format_version: PLAIN_FORMAT_VERSION,
      task: recording.meta.task,
      model: recording.meta.model,
      created_at: startedAt,
      parent: fork?.parent ?? null,
      fork:
        fork === undefined
          ? null
          : { at_span: fork.atSpan, edit: { field: "messages", value: fork.editValue } },
      source: recording.meta.source,
      // 二者互斥：可派生写 hash，否则写缺因（供门禁/UI 给精准文案）
      ...(derivation.hash !== null
        ? { config_hash: derivation.hash }
        : { config_hash_reason: derivation.reason }),
    };

    const lines: string[] = [JSON.stringify(meta)];

    if (recording.response !== null) {
      const timing = { started_at: startedAt, ended_at: now };
      lines.push(
        JSON.stringify({
          type: "span",
          id: "s_01",
          parent: null,
          kind: "agent.step",
          n: 1,
          timing,
        }),
      );
      lines.push(
        JSON.stringify({
          type: "span",
          id: "s_02",
          parent: "s_01",
          kind: "llm.call",
          timing,
          request: {
            model: recording.request.model,
            messages: recording.request.messages,
            ...(recording.request.tools !== undefined ? { tools: recording.request.tools } : {}),
            ...(recording.request.params !== undefined ? { params: recording.request.params } : {}),
          },
          response: recording.response,
          //失败诊断（可选）：成功录制省略。**缺省≠ 成功**——渲染层判"这次调用失败"
          // 靠这个字段存在与否，不靠 response 有没有内容。
          ...(recording.error !== undefined ? { error: recording.error } : {}),
        }),
      );
    }

    if (recording.outcome === "completed") {
      lines.push(JSON.stringify({ type: "run.event", event: "stopped", reason: "completed" }));
    } else if (recording.outcome === "error") {
      lines.push(JSON.stringify({ type: "run.event", event: "stopped", reason: "error" }));
    }
    // crashed：不写终止事件（读取器识别为 crashed）

    if (!existsSync(file)) {
      writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
    } else {
      appendFileSync(file, `${lines.join("\n")}\n`, "utf8");
    }
    return id;
  }
}
