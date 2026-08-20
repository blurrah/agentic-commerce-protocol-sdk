import type { CheckoutSessionStatus } from "./types.ts";

const ALLOWED: Record<CheckoutSessionStatus, CheckoutSessionStatus[]> = {
	not_ready_for_payment: ["ready_for_payment", "canceled"],
	ready_for_payment: ["completed", "canceled"],
	completed: [],
	canceled: [],
};

export function isTerminal(status: CheckoutSessionStatus): boolean {
	return ALLOWED[status].length === 0;
}

export function canTransition(
	from: CheckoutSessionStatus,
	to: CheckoutSessionStatus,
): true | { error: string } {
	return ALLOWED[from].includes(to)
		? true
		: { error: `cannot transition from "${from}" to "${to}"` };
}
