import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconClose } from "./Icons.tsx";

/**
 * One dialog for every question the dashboard asks.
 *
 * Two things pushed these questions out of the panels themselves. An inline
 * form makes its card grow and shove the rest of the page around while the
 * reader is looking somewhere else, and window.confirm() is browser chrome:
 * it ignores the theme and lands wherever the browser feels like. Over a
 * scrim, the layout behind stays exactly where it was.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    // Give the dialog the keyboard, and hand it back to whatever opened it.
    // A field in the body wins over the close button; a confirmation has no
    // field, so focus lands on the close button rather than on the action.
    const opener = document.activeElement as HTMLElement | null;
    const first =
      box.current?.querySelector<HTMLElement>(".modal-body input") ??
      box.current?.querySelector<HTMLElement>("button");
    first?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  // Rendered at the body, not in place: the cards carry backdrop-filter, which
  // makes them a containing block for position: fixed, and a dialog left inside
  // one gets pinned to the card instead of the viewport.
  return createPortal(
    <div
      className="modal-scrim"
      // mousedown, not click: a drag that starts inside the dialog and ends on
      // the scrim (selecting text, say) should not dismiss it.
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={box}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <IconClose size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * The yes/no case. `danger` is for anything that reaches out and changes the
 * physical world - cutting power to a socket, writing a register.
 */
export function Confirm({
  open,
  title,
  confirmLabel = "Confirm",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? "danger" : ""}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <p className="modal-text">{children}</p>
    </Modal>
  );
}
