import type { Server } from "node:http";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import type { ProxyHandler, ProxyRequestContext } from "./handler.js";

/**
 * node:http 薄壳：只负责收集请求字节、调 handler、把响应流 pipe 回客户端。
 * 仅绑 127.0.0.1（回环明文 HTTP，无网络面）；端口占用抛明确错误。
 */
export interface ProxyServerOptions {
  port: number;
  /** 缺省 127.0.0.1；不暴露改绑定地址的口子（Non-goal：不做局域网监听） */
  host?: string;
  handler: ProxyHandler;
}

export interface ProxyServer {
  port: number;
  stop(): Promise<void>;
}

export function startProxyServer(options: ProxyServerOptions): Promise<ProxyServer> {
  const { port, host = "127.0.0.1", handler } = options;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const ctx: ProxyRequestContext = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        rawBody: Buffer.concat(chunks),
      };
      try {
        const result = await handler.handle(ctx);
        res.writeHead(result.status, result.headers);
        try {
          await new Promise<void>((resolve, reject) => {
            Readable.fromWeb(result.body as Parameters<typeof Readable.fromWeb>[0])
              .pipe(res)
              .on("finish", () => resolve())
              .on("error", (e: Error) => reject(e));
          });
          result.clientOk();
        } catch {
          result.clientFailed();
          if (!res.headersSent) {
            res.writeHead(502, { "content-type": "application/json" });
          }
          res.end();
        }
      } catch (e) {
        // handler 自身意外异常：明确 500，不吞
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(
          JSON.stringify({ error: { message: `录制代理内部错误：${(e as Error).message}` } }),
        );
      }
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        reject(new Error(`端口 ${port} 已被占用，无法启动录制代理（可在设置中换端口）`));
      } else {
        reject(new Error(`录制代理启动失败：${e.message}`));
      }
    });
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        port: actualPort,
        stop: () =>
          new Promise<void>((resolveStop) => {
            server.close(() => resolveStop());
          }),
      });
    });
  });
}
