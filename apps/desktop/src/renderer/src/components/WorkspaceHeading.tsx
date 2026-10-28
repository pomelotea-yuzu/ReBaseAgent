import type { ReactNode } from "react";
import { useId, useState } from "react";
import { useTranslator } from "../i18n";
import { DisclosureButton } from "./Disclosure";

/** Compact object/status on the left, actions and optional explanation on the right. */
export function WorkspaceHeading({
  title,
  target,
  summary,
  actions,
  details,
  detailsLabel,
}: {
  readonly title: ReactNode;
  readonly target?: ReactNode;
  readonly summary?: ReactNode;
  readonly actions?: ReactNode;
  readonly details?: ReactNode;
  readonly detailsLabel?: string;
}) {
  const translator = useTranslator();
  const [expanded, setExpanded] = useState(false);
  const controlsId = useId();
  const resolvedDetailsLabel = detailsLabel ?? translator.t("common.detailsSummary");
  return (
    <div className="workspace-heading" data-workspace-heading>
      <div className="workspace-heading-object">
        <div className="shrink-0 font-semibold">{title}</div>
        {target ? (
          <div className="min-w-0 break-all text-reading-meta text-gray-500">{target}</div>
        ) : null}
      </div>
      {actions ? <div className="workspace-heading-actions">{actions}</div> : null}
      {summary ? (
        <div className="workspace-heading-summary text-reading-meta leading-5">{summary}</div>
      ) : null}
      {details ? (
        <div className="workspace-heading-disclosure">
          <DisclosureButton
            expanded={expanded}
            onToggle={() => setExpanded(!expanded)}
            label={translator.t(expanded ? "common.collapseNamed" : "common.expandNamed", {
              name: resolvedDetailsLabel,
            })}
            controls={controlsId}
            className="px-1.5 text-reading-meta text-gray-600 hover:bg-gray-100"
          >
            {resolvedDetailsLabel}
          </DisclosureButton>
        </div>
      ) : null}
      {details ? (
        <div id={controlsId} className="workspace-heading-details" hidden={!expanded}>
          {details}
        </div>
      ) : null}
    </div>
  );
}
