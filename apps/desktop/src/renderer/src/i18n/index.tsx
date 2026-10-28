import {
  type Locale,
  type MessageKey,
  type MissingKeyEvent,
  type RichTextTag,
  type Translator,
  createTranslator,
  toI18nextKey,
} from "@rebaseagent/i18n";
import {
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  createContext,
  useContext,
  useMemo,
  useRef,
} from "react";
import { I18nextProvider, Trans as ReactI18nextTrans } from "react-i18next";

const TranslatorContext = createContext<Translator | null>(null);

export interface I18nProviderProps {
  readonly locale: Locale;
  readonly onMissingKey?: (event: MissingKeyEvent) => void;
  readonly children: ReactNode;
}

/**
 * 同步 Provider：locale 变化只重建 translator 并刷新订阅者，不挂 key 重建子树。
 * 桌面根在前端挂载前已解析偏好（任务 1.2/1.3 接线），这里不读取系统语言。
 */
export function I18nProvider({ locale, onMissingKey, children }: I18nProviderProps) {
  const missingRef = useRef(onMissingKey);
  missingRef.current = onMissingKey;
  const translator = useMemo(
    () =>
      createTranslator({
        locale,
        onMissingKey: (event) => missingRef.current?.(event),
      }),
    [locale],
  );

  return (
    <TranslatorContext.Provider value={translator}>
      <I18nextProvider i18n={translator.instance}>{children}</I18nextProvider>
    </TranslatorContext.Provider>
  );
}

export function useTranslator(): Translator {
  const translator = useContext(TranslatorContext);
  if (translator === null) throw new Error("I18nProvider is missing");
  return translator;
}

type TransComponents = Partial<Record<RichTextTag, ReactElement>>;

type ReactTransProps = Omit<ComponentProps<typeof ReactI18nextTrans>, "i18nKey" | "components"> & {
  readonly i18nKey: MessageKey;
  readonly components?: TransComponents;
};

export function Trans({ i18nKey, components, ...props }: ReactTransProps) {
  return <ReactI18nextTrans {...props} i18nKey={toI18nextKey(i18nKey)} components={components} />;
}
