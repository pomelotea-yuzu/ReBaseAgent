import { type PresentationMessage, type Translator, explainError } from "@rebaseagent/i18n";

/**
 * store 错误的产品描述：错误发生时保存稳定 code（可选受控 presentation）与旧文案，
 * 展示时按当前语言派生。旧 `error` 字段保留给既有调用方/测试，不作为新判据。
 */
export interface StoreErrorDescriptor {
  readonly code: string;
  readonly presentation?: PresentationMessage;
}

export interface StoreErrorPatch {
  readonly error: string;
  readonly errorDescriptor: StoreErrorDescriptor;
}

export function storeError(
  code: string,
  message: string,
  presentation?: PresentationMessage,
): StoreErrorPatch {
  return {
    error: message,
    errorDescriptor: presentation === undefined ? { code } : { code, presentation },
  };
}

export function clearedStoreError(): { error: null; errorDescriptor: null } {
  return { error: null, errorDescriptor: null };
}

/** 当前语言的产品解释；原始 detail 仍在 store.error 中，由后续批次按需展示。 */
export function describeStoreError(
  descriptor: StoreErrorDescriptor,
  translator: Translator,
): string {
  return explainError({ code: descriptor.code, presentation: descriptor.presentation }, translator)
    .text;
}
