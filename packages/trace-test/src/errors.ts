/**
 * trace-test 的配置错误类别。
 *
 * 与「断言失败」严格区分：配置错误表示测试资产与当前代码不兼容
 * （卡带耗尽/剩余、工具表不兼容、trace 未封存、代理 run 等），
 * 对应 CLI 退出码 2；断言失败对应退出码 1。断言失败永不抛错——
 * 它是测试结果数据，不是异常。
 */
export class TraceTestConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceTestConfigError";
  }
}
