import type { Tracer } from "@opentelemetry/api";
import { ACPError, isACPError } from "./errors.ts";
import { canTransition, isTerminal } from "./fsm.ts";
import { withIdempotency } from "./idempotency.ts";
import { HEADERS, parseHeaders } from "./lib/headers.ts";
import { err, ok } from "./lib/http.ts";
import type { SignatureConfig } from "./lib/signature.ts";
import { verifySignature } from "./lib/signature.ts";
import { traced } from "./lib/tracing.ts";
import type { KV, SessionStore } from "./storage.ts";
import { createRedisSessionStore } from "./storage.ts";
import type {
	CheckoutSession,
	CompleteCheckoutSessionRequest,
	CompleteCheckoutSessionResponse,
	CreateCheckoutSessionRequest,
	Order,
	OrderStatus,
	Refund,
	UpdateCheckoutSessionRequest,
} from "./types.ts";

export type Products = {
	price(input: {
		items: Array<{ id: string; quantity: number }>;
		customer?: CheckoutSession["customer"];
		fulfillment?: CheckoutSession["fulfillment"];
	}): Promise<{
		items: CheckoutSession["items"];
		totals: CheckoutSession["totals"];
		fulfillment?: CheckoutSession["fulfillment"];
		messages?: CheckoutSession["messages"];
		ready: boolean;
	}>;
};

export type Payments = {
	// Delegated token (recommended path) or other payment handles
	authorize(input: {
		session: CheckoutSession;
		delegated_token?: string;
	}): Promise<{ ok: true; intent_id: string } | { ok: false; reason: string }>;
	capture(
		intent_id: string,
	): Promise<{ ok: true } | { ok: false; reason: string }>;
};

export type Webhooks = {
	// Merchant → Agent platform webhook emitter (signed)
	orderUpdated(evt: {
		checkout_session_id: string;
		status: OrderStatus;
		order?: Order;
	}): Promise<void>;
};

export function createHandlers(
	handlers: {
		products: Products;
		payments: Payments;
		sessions?: SessionStore;
	},
	options: {
		store: KV;
		tracer?: Tracer;
		signature?: SignatureConfig;
	},
) {
	const { products, payments } = handlers;
	// Use provided session store or default to Redis-backed store
	const sessions = handlers.sessions ?? createRedisSessionStore(options.store);
	const idempotency = options.store;
	const { tracer, signature } = options;

	/**
	 * Verify request signature if configured
	 * Returns error response if verification fails
	 */
	async function checkSignature(req: Request): Promise<Response | null> {
		if (!signature) return null; // Signature verification disabled

		// Clone request since body can only be read once
		const cloned = req.clone();
		const isValid = await verifySignature(cloned, signature);

		if (!isValid) {
			return err({
				code: "invalid_signature",
				message: "Request signature verification failed",
				type: "authentication_error",
				status: 401,
			});
		}

		return null;
	}

	return {
		// POST /checkout_sessions
		create: async (req: Request, body: CreateCheckoutSessionRequest) =>
			traced(tracer, "checkout.create", async (span) => {
				// Verify signature first
				const sigErr = await checkSignature(req);
				if (sigErr) return sigErr;
				const H = parseHeaders(req);
				const idek = H.idempotencyKey;
				idek && span?.setAttribute("idempotency_key", idek);

				const compute = async (): Promise<CheckoutSession> => {
					const quote = await traced(
						tracer,
						"products.price",
						() =>
							products.price({
								items: body.items,
								customer: body.customer,
								fulfillment: body.fulfillment,
							}),
						{ items_count: body.items.length.toString() },
					);

					const session: CheckoutSession = {
						id: crypto.randomUUID(),
						status: quote.ready ? "ready_for_payment" : "not_ready_for_payment",
						items: quote.items,
						totals: quote.totals,
						fulfillment: quote.fulfillment,
						customer: body.customer,
						messages: quote.messages,
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
						links: {},
					};

					span?.setAttribute("session_id", session.id);
					span?.setAttribute("session_status", session.status);

					await traced(tracer, "session.put", () => sessions.put(session), {
						session_id: session.id,
					});
					return session;
				};

				try {
					const { reused, value } = await withIdempotency(
						idek,
						idempotency,
						compute,
					);

					span?.setAttribute("idempotency_reused", reused.toString());

					return ok<CheckoutSession>(value, {
						status: reused ? 200 : 201,
						echo: {
							[HEADERS.IDEMPOTENCY]: idek,
							[HEADERS.REQ_ID]: H.requestId,
						},
					});
				} catch (e: unknown) {
					if (isACPError(e)) {
						return err({
							code: e.code,
							message: e.message,
							param: e.param,
							type: e.type,
							status: e.status,
						});
					}
					return err({
						code: "internal_error",
						message: "Internal server error",
						type: "api_error",
						status: 500,
					});
				}
			}),

		// POST /checkout_sessions/:id
		update: async (
			req: Request,
			id: string,
			body: UpdateCheckoutSessionRequest,
		) =>
			traced(tracer, "checkout.update", async (span) => {
				// Verify signature first
				const sigErr = await checkSignature(req);
				if (sigErr) return sigErr;
				const H = parseHeaders(req);
				const idek = H.idempotencyKey;
				span?.setAttribute("session_id", id);
				idek && span?.setAttribute("idempotency_key", idek);

				const compute = async (): Promise<CheckoutSession> => {
					const s = await traced(
						tracer,
						"session.get",
						() => sessions.get(id),
						{ session_id: id },
					);

					if (!s)
						throw new ACPError({
							code: "session_not_found",
							message: `Session "${id}" not found`,
							param: "checkout_session_id",
							type: "invalid_request_error",
							status: 404,
						});

					// Terminal sessions are immutable records of what was (not) paid for
					if (isTerminal(s.status))
						throw new ACPError({
							code: "invalid_state",
							message: `Cannot update a session in state "${s.status}"`,
							param: "status",
							type: "invalid_request_error",
							status: 400,
						});

					// Merge updates
					const items =
						body.items ?? s.items.map(({ id, quantity }) => ({ id, quantity }));
					const quote = await traced(
						tracer,
						"products.price",
						() =>
							products.price({
								items,
								customer: body.customer ?? s.customer,
								fulfillment: body.fulfillment ?? s.fulfillment,
							}),
						{ items_count: items.length.toString() },
					);

					// Determine next status based on quote readiness and FSM rules
					// FSM rules: ready_for_payment can only go to completed/canceled, not back to not_ready
					let nextStatus = s.status;
					if (quote.ready && s.status === "not_ready_for_payment") {
						// Can upgrade from not_ready to ready
						nextStatus = "ready_for_payment";
					} else if (!quote.ready && s.status === "not_ready_for_payment") {
						// Stay in not_ready state
						nextStatus = "not_ready_for_payment";
					}
					// Note: If ready_for_payment and quote becomes not ready, we keep ready_for_payment
					// since the FSM doesn't allow downgrading. The messages should indicate issues.

					const next: CheckoutSession = {
						...s,
						items: quote.items,
						totals: quote.totals,
						fulfillment: quote.fulfillment,
						customer: body.customer ?? s.customer,
						messages: quote.messages,
						status: nextStatus,
						updated_at: new Date().toISOString(),
					};

					span?.setAttribute("session_status", next.status);

					await traced(tracer, "session.put", () => sessions.put(next), {
						session_id: next.id,
					});
					return next;
				};

				try {
					const { reused, value } = await withIdempotency(
						idek,
						idempotency,
						compute,
					);

					span?.setAttribute("idempotency_reused", reused.toString());

					return ok(value, {
						status: 200,
						echo: {
							[HEADERS.IDEMPOTENCY]: idek,
							[HEADERS.REQ_ID]: H.requestId,
						},
					});
				} catch (e: unknown) {
					if (isACPError(e)) {
						return err({
							code: e.code,
							message: e.message,
							param: e.param,
							type: e.type,
							status: e.status,
						});
					}
					return err({
						code: "internal_error",
						message: "Internal server error",
						type: "api_error",
						status: 500,
					});
				}
			}),

		// POST /checkout_sessions/:id/complete
		complete: async (
			req: Request,
			id: string,
			body: CompleteCheckoutSessionRequest,
		) =>
			traced(tracer, "checkout.complete", async (span) => {
				// Verify signature first
				const sigErr = await checkSignature(req);
				if (sigErr) return sigErr;
				const H = parseHeaders(req);
				const idek = H.idempotencyKey;
				span?.setAttribute("session_id", id);
				idek && span?.setAttribute("idempotency_key", idek);

				const compute = async (): Promise<CompleteCheckoutSessionResponse> => {
					const s = await traced(
						tracer,
						"session.get",
						() => sessions.get(id),
						{ session_id: id },
					);

					if (!s)
						throw new ACPError({
							code: "session_not_found",
							message: `Session "${id}" not found`,
							param: "checkout_session_id",
							type: "invalid_request_error",
							status: 404,
						});

					if (s.status !== "ready_for_payment")
						throw new ACPError({
							code: "invalid_state",
							message: `Cannot complete from "${s.status}"`,
							param: "status",
							type: "invalid_request_error",
							status: 400,
						});

					// authorize & capture
					const auth = await traced(
						tracer,
						"payments.authorize",
						() =>
							payments.authorize({
								session: s,
								delegated_token: body.payment?.delegated_token,
							}),
						{ session_id: s.id },
					);

					if (!auth.ok)
						throw new ACPError({
							code: "payment_authorization_failed",
							message: auth.reason,
							type: "invalid_request_error",
							status: 400,
						});

					span?.setAttribute("payment_intent_id", auth.intent_id);

					const cap = await traced(
						tracer,
						"payments.capture",
						() => payments.capture(auth.intent_id),
						{ intent_id: auth.intent_id },
					);

					if (!cap.ok)
						throw new ACPError({
							code: "payment_capture_failed",
							message: cap.reason,
							type: "invalid_request_error",
							status: 400,
						});

					// Note: FSM transition is already validated above (status must be "ready_for_payment")
					// and ready_for_payment -> completed is always valid per fsm.ts

					const completed: CheckoutSession = {
						...s,
						status: "completed",
						updated_at: new Date().toISOString(),
					};

					await traced(tracer, "session.put", () => sessions.put(completed), {
						session_id: completed.id,
					});

					const order: Order = {
						id: auth.intent_id,
						checkout_session_id: s.id,
						status: "placed",
					};

					return { ...completed, order };
				};

				try {
					const { reused, value } = await withIdempotency(
						idek,
						idempotency,
						compute,
					);

					span?.setAttribute("idempotency_reused", reused.toString());

					return ok<CompleteCheckoutSessionResponse>(value, {
						status: 200,
						echo: {
							[HEADERS.IDEMPOTENCY]: idek,
							[HEADERS.REQ_ID]: H.requestId,
						},
					});
				} catch (e: unknown) {
					if (isACPError(e)) {
						return err({
							code: e.code,
							message: e.message,
							param: e.param,
							type: e.type,
							status: e.status,
						});
					}
					return err({
						code: "internal_error",
						message: "Internal server error",
						type: "api_error",
						status: 500,
					});
				}
			}),

		// POST /checkout_sessions/:id/cancel
		cancel: async (req: Request, id: string) =>
			traced(tracer, "checkout.cancel", async (span) => {
				// Verify signature first
				const sigErr = await checkSignature(req);
				if (sigErr) return sigErr;
				const H = parseHeaders(req);
				const idek = H.idempotencyKey;
				span?.setAttribute("session_id", id);
				idek && span?.setAttribute("idempotency_key", idek);

				const compute = async (): Promise<CheckoutSession> => {
					const s = await traced(
						tracer,
						"session.get",
						() => sessions.get(id),
						{ session_id: id },
					);

					if (!s)
						throw new ACPError({
							code: "session_not_found",
							message: `Session "${id}" not found`,
							param: "checkout_session_id",
							type: "invalid_request_error",
							status: 404,
						});

					const can = canTransition(s.status, "canceled");
					if (can !== true)
						throw new ACPError({
							code: "invalid_state",
							message: can.error,
							param: "status",
							type: "invalid_request_error",
							status: 400,
						});

					const next: CheckoutSession = {
						...s,
						status: "canceled",
						updated_at: new Date().toISOString(),
					};

					await traced(tracer, "session.put", () => sessions.put(next), {
						session_id: next.id,
					});

					return next;
				};

				try {
					const { reused, value } = await withIdempotency(
						idek,
						idempotency,
						compute,
					);

					span?.setAttribute("idempotency_reused", reused.toString());

					return ok(value, {
						status: 200,
						echo: {
							[HEADERS.IDEMPOTENCY]: idek,
							[HEADERS.REQ_ID]: H.requestId,
						},
					});
				} catch (e: unknown) {
					if (isACPError(e)) {
						return err({
							code: e.code,
							message: e.message,
							param: e.param,
							type: e.type,
							status: e.status,
						});
					}
					return err({
						code: "internal_error",
						message: "Internal server error",
						type: "api_error",
						status: 500,
					});
				}
			}),

		// GET /checkout_sessions/:id
		get: async (req: Request, id: string) =>
			traced(tracer, "checkout.get", async (span) => {
				// Verify signature first
				const sigErr = await checkSignature(req);
				if (sigErr) return sigErr;
				const H = parseHeaders(req);
				span?.setAttribute("session_id", id);

				const s = await traced(tracer, "session.get", () => sessions.get(id), {
					session_id: id,
				});

				if (!s)
					return err({
						code: "session_not_found",
						message: `Session "${id}" not found`,
						param: "checkout_session_id",
						type: "invalid_request_error",
						status: 404,
					});

				span?.setAttribute("session_status", s.status);

				return ok(s, { status: 200, echo: { [HEADERS.REQ_ID]: H.requestId } });
			}),
	};
}

/**
 * Creates ACP handler with reusable utilities
 *
 * @example
 * ```typescript
 * import { acpHandler } from 'acp-handler';
 *
 * export const acp = acpHandler({
 *   products,
 *   payments,
 *   store
 * });
 *
 * // Use in route handler
 * export const { GET, POST } = acp.handlers;
 *
 * // Use webhooks from queue worker
 * await acp.webhooks.sendOrderUpdated(sessionId);
 *
 * // Use sessions from admin dashboard
 * const session = await acp.sessions.get(sessionId);
 * ```
 */
export function acpHandler(config: {
	products: Products;
	payments: Payments;
	store: KV;
	sessions?: SessionStore;
	tracer?: Tracer;
	signature?: SignatureConfig;
}) {
	const {
		products,
		payments,
		store,
		sessions: customSessions,
		tracer,
		signature,
	} = config;

	// Use provided session store or default to Redis-backed store
	const sessions = customSessions ?? createRedisSessionStore(store);

	// Create checkout handlers
	const handlers = createHandlers(
		{ products, payments, sessions },
		{ store, tracer, signature },
	);

	return {
		/**
		 * Route handlers for checkout API endpoints
		 * Use with Next.js catch-all routes or other frameworks
		 */
		handlers,

		/**
		 * Webhook utilities for sending notifications
		 * Can be called from queue workers, warehouse systems, admin panels, etc.
		 */
		webhooks: {
			/**
			 * Send order created webhook
			 * @param sessionId - Checkout session ID
			 * @param webhookConfig - Webhook configuration and event data
			 */
			async sendOrderCreated(
				sessionId: string,
				webhookConfig: {
					webhookUrl: string;
					secret: string;
					merchantName?: string;
					timeoutMs?: number;
					permalinkUrl: string;
					status?: OrderStatus;
					refunds?: Refund[];
				},
			): Promise<void> {
				const { createOutboundWebhook } = await import(
					"./webhooks/outbound.ts"
				);
				const webhook = createOutboundWebhook({
					webhookUrl: webhookConfig.webhookUrl,
					secret: webhookConfig.secret,
					merchantName: webhookConfig.merchantName,
					timeoutMs: webhookConfig.timeoutMs,
				});

				await webhook.orderCreated({
					type: "order",
					checkout_session_id: sessionId,
					permalink_url: webhookConfig.permalinkUrl,
					status: webhookConfig.status ?? "created",
					refunds: webhookConfig.refunds,
				});
			},

			/**
			 * Send order updated webhook
			 * @param sessionId - Checkout session ID
			 * @param webhookConfig - Webhook configuration and event data
			 */
			async sendOrderUpdated(
				sessionId: string,
				webhookConfig: {
					webhookUrl: string;
					secret: string;
					merchantName?: string;
					timeoutMs?: number;
					permalinkUrl: string;
					status: OrderStatus;
					refunds?: Refund[];
				},
			): Promise<void> {
				const { createOutboundWebhook } = await import(
					"./webhooks/outbound.ts"
				);
				const webhook = createOutboundWebhook({
					webhookUrl: webhookConfig.webhookUrl,
					secret: webhookConfig.secret,
					merchantName: webhookConfig.merchantName,
					timeoutMs: webhookConfig.timeoutMs,
				});

				await webhook.orderUpdated({
					type: "order",
					checkout_session_id: sessionId,
					permalink_url: webhookConfig.permalinkUrl,
					status: webhookConfig.status,
					refunds: webhookConfig.refunds,
				});
			},
		},

		/**
		 * Session utilities for querying and updating sessions
		 * Can be used from admin dashboards, analytics, etc.
		 */
		sessions: {
			/**
			 * Get a checkout session by ID
			 */
			get: (id: string) => sessions.get(id),

			/**
			 * Update a checkout session
			 */
			put: (session: CheckoutSession, ttlSec?: number) =>
				sessions.put(session, ttlSec),
		},
	};
}
