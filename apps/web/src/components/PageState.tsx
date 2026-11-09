import type { ReactNode } from "react";

import { Button } from "./ui";

type PageStateKind = "loading" | "empty" | "degraded" | "error";

const stateContent: Record<
  PageStateKind,
  { action: string; description: string; mark: string; title: string }
> = {
  loading: {
    action: "Loading",
    description: "The requested view is being prepared.",
    mark: "···",
    title: "Gathering the latest view",
  },
  empty: {
    action: "Create something",
    description: "There is nothing to show here yet.",
    mark: "○",
    title: "A clear place to begin",
  },
  degraded: {
    action: "Try again",
    description: "Some information is temporarily unavailable.",
    mark: "!",
    title: "Showing what is available",
  },
  error: {
    action: "Retry",
    description: "This view could not be loaded.",
    mark: "×",
    title: "Something interrupted the request",
  },
};

type PageStateProps = {
  actionLabel?: string;
  children?: ReactNode;
  kind: PageStateKind;
  onAction?: () => void;
  title?: string;
};

export function PageState({
  actionLabel,
  children,
  kind,
  onAction,
  title,
}: PageStateProps) {
  const content = stateContent[kind];

  return (
    <section
      aria-busy={kind === "loading" ? true : undefined}
      className={`page-state page-state--${kind}`}
    >
      <span aria-hidden="true" className="page-state__mark">
        {content.mark}
      </span>
      <div>
        <p className="page-state__kind">{kind}</p>
        <h3>{title ?? content.title}</h3>
        <p>{children ?? content.description}</p>
      </div>
      {kind === "loading" ? (
        <span className="page-state__loader" aria-hidden="true" />
      ) : onAction ? (
        <Button onClick={onAction} variant="secondary">
          {actionLabel ?? content.action}
        </Button>
      ) : null}
    </section>
  );
}
