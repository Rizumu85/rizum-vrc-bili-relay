import type { RelayStatus } from "./protocol";

export function relayFailureMessage(relay: RelayStatus): string {
  switch (relay.end_reason) {
    case "source_disconnected": return "直播源或视频连接已中断，重新生成地址可重试";
    case "publisher_disconnected": return "推流连接已中断，检查网络后重新生成地址";
    case "start_failed": return "中继未能启动，请检查来源、网络或设置后重试";
    default: return "中继已中断，重新生成地址可重试";
  }
}
