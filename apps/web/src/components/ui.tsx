import {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  cloneElement,
  useEffect,
  useId,
  useRef,
} from "react";

type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

export function Button({
  className = "",
  variant = "primary",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`button button--${variant} ${className}`.trim()}
      type={type}
      {...props}
    />
  );
}

type BadgeTone = "neutral" | "positive" | "warning" | "critical" | "info";

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: BadgeTone;
}) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

type FieldProps = {
  children: ReactElement<{
    "aria-describedby"?: string;
    id?: string;
  }>;
  hint?: string;
  label: string;
};

export function Field({ children, hint, label }: FieldProps) {
  const controlId = useId();
  const hintId = useId();
  const control = cloneElement(children, {
    "aria-describedby": hint ? hintId : children.props["aria-describedby"],
    id: children.props.id ?? controlId,
  });

  return (
    <div className="field">
      <label className="field__label" htmlFor={children.props.id ?? controlId}>
        {label}
      </label>
      {control}
      {hint ? (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Progress({ label, value }: { label: string; value: number }) {
  const boundedValue = Math.min(100, Math.max(0, value));

  return (
    <div className="progress">
      <div className="progress__meta">
        <span>{label}</span>
        <span>{boundedValue}%</span>
      </div>
      <div
        aria-label={label}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={boundedValue}
        className="progress__track"
        role="progressbar"
      >
        <span
          className="progress__value"
          style={{ width: `${boundedValue}%` }}
        />
      </div>
    </div>
  );
}

type DialogProps = {
  children: ReactNode;
  description?: string;
  onClose: () => void;
  open: boolean;
  title: string;
};

export function Dialog({
  children,
  description,
  onClose,
  open,
  title,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!open || dialog === null || dialog.open) {
      return;
    }

    dialog.showModal();
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <dialog
      aria-describedby={description ? descriptionId : undefined}
      aria-labelledby={titleId}
      className="dialog"
      onCancel={onClose}
      ref={dialogRef}
    >
      <div className="dialog__heading">
        <div>
          <p className="eyebrow">Confirmation</p>
          <h2 id={titleId}>{title}</h2>
        </div>
        <Button aria-label="Close dialog" onClick={onClose} variant="quiet">
          <span aria-hidden="true">×</span>
        </Button>
      </div>
      {description ? (
        <p className="dialog__description" id={descriptionId}>
          {description}
        </p>
      ) : null}
      {children}
    </dialog>
  );
}

type NotificationProps = {
  children: ReactNode;
  onDismiss?: () => void;
  tone?: "success" | "warning" | "error";
};

export function Notification({
  children,
  onDismiss,
  tone = "success",
}: NotificationProps) {
  return (
    <div
      className={`notification notification--${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <span className="notification__indicator" />
      <div>{children}</div>
      {onDismiss ? (
        <Button
          aria-label="Dismiss notification"
          onClick={onDismiss}
          variant="quiet"
        >
          <span aria-hidden="true">×</span>
        </Button>
      ) : null}
    </div>
  );
}

export function TableFrame({
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className="table-frame" {...props}>
      {children}
    </div>
  );
}
