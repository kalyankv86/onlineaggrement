import type { AgreementStatus } from '@/lib/api';
import { STATUS_LABEL, STATUS_TONE, MILESTONES, milestoneStates } from '@/lib/workflow';

export function StatusBadge({ status }: { status: AgreementStatus }) {
  return (
    <span className={`badge badge-${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
  );
}

/** The three mandated milestones (SRS §3), rendered as a rail. */
export function ProgressRail({ status }: { status: AgreementStatus }) {
  const states = milestoneStates(status);
  return (
    <div className="rail" role="list" aria-label="Signing progress">
      {MILESTONES.map((m, i) => (
        <div key={m.key} className={`rail-step ${states[i]}`} role="listitem">
          {m.label}
        </div>
      ))}
    </div>
  );
}

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success';
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      {title && <strong>{title}</strong>}
      {children}
    </div>
  );
}

export function Field({
  label,
  name,
  hint,
  ...rest
}: { label: string; name: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} {...rest} />
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

/**
 * A document hash, shown in full but wrapped.
 *
 * Displayed prominently on purpose: the signer is attesting to *these* bytes, and
 * the same value is submitted back with the action so a stale view is refused
 * (FR-027).
 */
export function Hash({ value, label }: { value: string; label?: string }) {
  return (
    <div>
      {label && <div className="faint">{label}</div>}
      <code style={{ wordBreak: 'break-all' }}>{value}</code>
    </div>
  );
}
