import { useEffect, useRef } from "react";

/**
 * U5（unify-run-execution-workflow）任务 5.3：**配置往返作废会话级许可**的共享钩子。
 *
 * delta「两模式配置后返回任务」的"旧预检/写入许可失效"半边：副本写入授权是
 * **本次操作**的许可，用户去设置里改了模型配置再回来，之前那次勾选授权不该继续生效
 * （打到的是另一台上游）。确认凭据的撤销走 `setSettingsSection` 进出（任务 4.4 已交付），
 * 本钩子管的是**保存成功导致指纹变化**这一路。
 *
 * 只在指纹**变化**时回调一次；首次挂载不算变化（不清掉进页面前就存在的勾选）。
 * 回调经 ref 取最新值，不要求调用方 memoize。
 */
export function useRevokeOnConfigChange(currentStamp: string, revoke: () => void): void {
  const previous = useRef(currentStamp);
  const revokeRef = useRef(revoke);
  revokeRef.current = revoke;
  useEffect(() => {
    if (previous.current === currentStamp) return;
    previous.current = currentStamp;
    revokeRef.current();
  }, [currentStamp]);
}
