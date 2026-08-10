/**
 * Indian financial year: 1 April to 31 March. Used by the agreement numbering
 * scheme (FR-026 / DEC-018), so the boundary matters — an agreement created on
 * 31 March and one created on 1 April belong to different registers.
 */
export function financialYear(date: Date = new Date()): string {
  const y = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? y : y - 1; // month is 0-based; 3 = April
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Add whole calendar days — SLA arithmetic (FR-021). */
export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}
