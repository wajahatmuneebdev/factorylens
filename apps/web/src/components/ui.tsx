import {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
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
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!open || dialog === null || dialog.open) {
      return;
    }

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.showModal();

    return () => previousFocusRef.current?.focus();
  }, [open]);

  if (!open) {
    return null;
  }

  function keepFocusInDialog(event: ReactKeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      aria-describedby={description ? descriptionId : undefined}
      aria-labelledby={titleId}
      className="dialog"
      onCancel={onClose}
      onKeyDown={keepFocusInDialog}
      ref={dialogRef}
    >
      <div className="dialog__heading">
        <div>
          <p className="eyebrow">Confirmation</p>
          <h2 id={titleId}>{title}</h2>
        </div>
        <Button
          aria-label="Close dialog"
          autoFocus
          onClick={onClose}
          variant="quiet"
        >
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
    <div className="table-frame" role="region" {...props}>
      {children}
    </div>
  );
}
