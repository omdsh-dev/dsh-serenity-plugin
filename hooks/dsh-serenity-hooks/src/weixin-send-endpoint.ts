/**
 * weixin-send-endpoint.ts — 主动发送入口地址的**零依赖叶模块**（v1.30.9，S142）
 *
 * 为什么单独一个模块（R↓）：地址的读者是 `msm-ops.buildMsmEnv`（把地址注入 MSM 子进程 env），
 * 写者才是 `weixin-send-api`（监听器启停）。若 msm-ops 直接 import weixin-send-api，
 * 静态依赖链会拖进整条微信桥栈（weixin-bridge → skiff-core → `@deepseek-ai/dsh-llm`）——
 * 后果实测：`acc-extras` / `ops` / `skiff-admin` 三个测试套件因解析不到宿主包而**整文件加载失败**
 * （它们只用到 MSM 注册表逻辑）。叶模块把「读」与「写」解耦：读者零依赖，写者自己承担重量。
 *
 * 同款先例：`host/effect.ts`（拆卸登记）、`agent-idle.ts`（等待结算）。
 */

let endpoint: string | null = null

/** 设置当前入口地址（weixin-send-api 启停时调用；null = 未启动） */
export function setWeixinSendEndpoint(value: string | null): void {
  endpoint = value
}

/** 当前入口地址（形如 http://127.0.0.1:3082；未启动 → null） */
export function weixinSendEndpoint(): string | null {
  return endpoint
}

/** 测试辅助：重置（进程内单例，测试间隔离用） */
export function resetWeixinSendEndpointForTest(): void {
  endpoint = null
}
