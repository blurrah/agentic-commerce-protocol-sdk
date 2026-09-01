import { beforeEach, describe, expect, it } from "vitest";
import { createHandlers } from "../src/checkout/handlers";
import {
	createMemoryStore,
	createMockPayments,
	createMockProducts,
	createRequest,
} from "../src/test";

describe("Checkout Integration", () => {
	let handlers: ReturnType<typeof createHandlers>;
	let products: ReturnType<typeof createMockProducts>;
	let payments: ReturnType<typeof createMockPayments>;
	let store: ReturnType<typeof createMemoryStore>;

	beforeEach(() => {
		products = createMockProducts();
		payments = createMockPayments();
		store = createMemoryStore();

		handlers = createHandlers({ products, payments }, { store });
	});

	describe("Complete checkout flow", () => {
		it("should complete a full checkout from create to complete", async () => {
			// 1. Create session
			const createReq = createRequest("http://test/checkout_sessions", {
				method: "POST",
				body: {
					items: [
						{ id: "prod-1", quantity: 2 },
						{ id: "prod-2", quantity: 1 },
					],
				},
			});

			const createRes = await handlers.create(createReq, {
				items: [
					{ id: "prod-1", quantity: 2 },
					{ id: "prod-2", quantity: 1 },
				],
			});

			expect(createRes.status).toBe(201);
			const session = await createRes.json();
			expect(session.id).toBeDefined();
			expect(session.status).toBe("ready_for_payment");
			expect(session.items).toHaveLength(2);
			expect(session.totals.grand_total.amount).toBe(3000); // 3 items * 1000

			// 2. Update with customer info
			const updateReq = createRequest(
				`http://test/checkout_sessions/${session.id}`,
				{
					method: "POST",
					body: {
						customer: {
							email: "test@example.com",
							name: "Test User",
						},
					},
				},
			);

			const updateRes = await handlers.update(updateReq, session.id, {
				customer: {
					billing_address: {
						email: "test@example.com",
						name: "Test User",
						line1: "123 Main St",
						city: "Anytown",
						postal_code: "12345",
						country: "US",
					},
				},
			});

			expect(updateRes.status).toBe(200);
			const updatedSession = await updateRes.json();
			expect(updatedSession.customer?.billing_address?.email).toBe(
				"test@example.com",
			);

			// 3. Complete checkout
			const completeReq = createRequest(
				`http://test/checkout_sessions/${session.id}/complete`,
				{
					method: "POST",
					body: {
						payment: {
							delegated_token: "tok_test_123",
						},
					},
				},
			);

			const completeRes = await handlers.complete(completeReq, session.id, {
				payment: {
					delegated_token: "tok_test_123",
				},
			});

			expect(completeRes.status).toBe(200);
			const completed = await completeRes.json();
			expect(completed.status).toBe("completed");
			expect(completed.order).toBeDefined();
			expect(completed.order.id).toMatch(/^pi_test_/);

			// 4. Verify payments were called
			expect((payments as any)._calls.authorize).toBe(1);
			expect((payments as any)._calls.capture).toBe(1);
		});
	});

	describe("Idempotency", () => {
		it("should not double-charge on retry with same idempotency key", async () => {
			const idempotencyKey = `idem_test_${Date.now()}`;

			// Create session
			const createReq = createRequest("http://test/checkout_sessions", {
				method: "POST",
				headers: { "idempotency-key": idempotencyKey },
				body: { items: [{ id: "prod-1", quantity: 1 }] },
			});

			const createRes1 = await handlers.create(createReq, {
				items: [{ id: "prod-1", quantity: 1 }],
			});

			expect(createRes1.status).toBe(201);
			const session1 = await createRes1.json();

			// Retry with same idempotency key
			const createReq2 = createRequest("http://test/checkout_sessions", {
				method: "POST",
				headers: { "idempotency-key": idempotencyKey },
				body: { items: [{ id: "prod-1", quantity: 1 }] },
			});

			const createRes2 = await handlers.create(createReq2, {
				items: [{ id: "prod-1", quantity: 1 }],
			});

			expect(createRes2.status).toBe(200); // 200 not 201 on retry
			const session2 = await createRes2.json();

			// Should return same session
			expect(session1.id).toBe(session2.id);
		});

		it("should not double-complete on retry", async () => {
			// Create and prepare session
			const createReq = createRequest("http://test/checkout_sessions", {
				method: "POST",
				body: { items: [{ id: "prod-1", quantity: 1 }] },
			});
			const createRes = await handlers.create(createReq, {
				items: [{ id: "prod-1", quantity: 1 }],
			});
			const session = await createRes.json();

			const idempotencyKey = `idem_complete_${Date.now()}`;

			// Complete once
			const completeReq1 = createRequest(
				`http://test/checkout_sessions/${session.id}/complete`,
				{
					method: "POST",
					headers: { "idempotency-key": idempotencyKey },
					body: { payment: { delegated_token: "tok_123" } },
				},
			);

			const completeRes1 = await handlers.complete(completeReq1, session.id, {
				payment: { delegated_token: "tok_123" },
			});

			const completed1 = await completeRes1.json();

			// Retry with same key
			const completeReq2 = createRequest(
				`http://test/checkout_sessions/${session.id}/complete`,
				{
					method: "POST",
					headers: { "idempotency-key": idempotencyKey },
					body: { payment: { delegated_token: "tok_123" } },
				},
			);

			const completeRes2 = await handlers.complete(completeReq2, session.id, {
				payment: { delegated_token: "tok_123" },
			});

			const completed2 = await completeRes2.json();

			// Should return same result
			expect(completed1.order.id).toBe(completed2.order.id);

			// Payments should only be called once
			expect((payments as any)._calls.authorize).toBe(1);
			expect((payments as any)._calls.capture).toBe(1);
		});
	});

	describe("Error handling", () => {
		it("should return 404 for non-existent session", async () => {
			const req = createRequest("http://test/checkout_sessions/invalid");
			const res = await handlers.get(req, "invalid");

			expect(res.status).toBe(404);
			const error = await res.json();
			expect(error.error).toMatchObject({
				code: "session_not_found",
				type: "invalid_request_error",
			});
		});

		it("should reject completion when payment authorization fails", async () => {
			// Setup with failing payment
			payments = createMockPayments({
				shouldAuthorizeSucceed: false,
				authorizeReason: "Card declined",
			});

			handlers = createHandlers({ products, payments }, { store });

			// Create session
			const createReq = createRequest("http://test/checkout_sessions", {
				method: "POST",
				body: { items: [{ id: "prod-1", quantity: 1 }] },
			});
			const createRes = await handlers.create(createReq, {
				items: [{ id: "prod-1", quantity: 1 }],
			});
			const session = await createRes.json();

			// Try to complete
			const completeReq = createRequest(
				`http://test/checkout_sessions/${session.id}/complete`,
				{
					method: "POST",
					body: { payment: { delegated_token: "tok_123" } },
				},
			);

			const completeRes = await handlers.complete(completeReq, session.id, {
				payment: { delegated_token: "tok_123" },
			});

			const error = await completeRes.json();
			expect(error.error.code).toBe("payment_authorization_failed");
			expect(error.error.message).toBe("Card declined");
		});

		it("should reject completion from invalid state", async () => {
			// Create session
			const createReq = createRequest("http://test/checkout_sessions", {
				method: "POST",
				body: { items: [{ id: "prod-1", quantity: 1 }] },
			});
			const createRes = await handlers.create(createReq, {
				items: [{ id: "prod-1", quantity: 1 }],
			});
			const session = await createRes.json();

			// Cancel it first
			const cancelReq = createRequest(
				`http://test/checkout_sessions/${session.id}/cancel`,
				{ method: "POST" },
			);
			await handlers.cancel(cancelReq, session.id);

			// Try to complete canceled session
			const completeReq = createRequest(
				`http://test/checkout_sessions/${session.id}/complete`,
				{
					method: "POST",
					body: { payment: { delegated_token: "tok_123" } },
				},
			);

			const completeRes = await handlers.complete(completeReq, session.id, {
				payment: { delegated_token: "tok_123" },
			});

			const error = await completeRes.json();
			expect(error.error.code).toBe("invalid_state");
		});
	});

	describe("Header echoing (OpenAI spec compliance)", () => {
		it("should echo Request-Id header", async () => {
			const requestId = "req_custom_123";
			const req = createRequest("http://test/checkout_sessions", {
				method: "POST",
				headers: { "request-id": requestId },
				body: { items: [{ id: "prod-1", quantity: 1 }] },
			});

			const res = await handlers.create(req, {
				items: [{ id: "prod-1", quantity: 1 }],
			});

			expect(res.headers.get("request-id")).toBe(requestId);
		});

		it("should echo Idempotency-Key header", async () => {
			const idempotencyKey = "idem_custom_123";
			const req = createRequest("http://test/checkout_sessions", {
				method: "POST",
				headers: { "idempotency-key": idempotencyKey },
				body: { items: [{ id: "prod-1", quantity: 1 }] },
			});

			const res = await handlers.create(req, {
				items: [{ id: "prod-1", quantity: 1 }],
			});

			expect(res.headers.get("idempotency-key")).toBe(idempotencyKey);
		});
	});

	describe("FSM enforcement on update (terminal states)", () => {
		async function createSession() {
			const createReq = createRequest("http://test/checkout_sessions", {
				method: "POST",
				body: { items: [{ id: "prod-1", quantity: 1 }] },
			});
			const createRes = await handlers.create(createReq, {
				items: [{ id: "prod-1", quantity: 1 }],
			});
			return await createRes.json();
		}

		function updateAttack(sessionId: string) {
			const body = {
				items: [{ id: "prod-laptop", quantity: 100 }],
				customer: {
					billing_address: {
						email: "attacker@example.com",
						name: "Attacker",
						line1: "1 Evil St",
						city: "Nowhere",
						postal_code: "00000",
						country: "US",
					},
				},
			};
			const req = createRequest(`http://test/checkout_sessions/${sessionId}`, {
				method: "POST",
				body,
			});
			return handlers.update(req, sessionId, body);
		}

		it("should reject update on a completed session without re-pricing", async () => {
			// Wrap products with a spy so we can assert price() is never reached
			let priceCalls = 0;
			const spiedProducts = {
				price: async (input: Parameters<typeof products.price>[0]) => {
					priceCalls++;
					return products.price(input);
				},
			};
			handlers = createHandlers(
				{ products: spiedProducts, payments },
				{ store },
			);

			const session = await createSession();
			priceCalls = 0;

			const completeReq = createRequest(
				`http://test/checkout_sessions/${session.id}/complete`,
				{
					method: "POST",
					body: { payment: { delegated_token: "tok_123" } },
				},
			);
			await handlers.complete(completeReq, session.id, {
				payment: { delegated_token: "tok_123" },
			});

			const updateRes = await updateAttack(session.id);

			expect(updateRes.status).toBe(400);
			const error = await updateRes.json();
			expect(error.error).toMatchObject({
				code: "invalid_state",
				param: "status",
				type: "invalid_request_error",
			});

			// Pricing must never run for a terminal session
			expect(priceCalls).toBe(0);

			// No additional payment activity
			expect((payments as any)._calls.authorize).toBe(1);
			expect((payments as any)._calls.capture).toBe(1);

			// Stored session is unchanged
			const getReq = createRequest(
				`http://test/checkout_sessions/${session.id}`,
			);
			const getRes = await handlers.get(getReq, session.id);
			const stored = await getRes.json();
			expect(stored.status).toBe("completed");
			expect(stored.items).toEqual(session.items);
			expect(stored.totals).toEqual(session.totals);
			expect(stored.customer).toEqual(session.customer);
		});

		it("should reject update on a canceled session", async () => {
			const session = await createSession();

			const cancelReq = createRequest(
				`http://test/checkout_sessions/${session.id}/cancel`,
				{ method: "POST" },
			);
			await handlers.cancel(cancelReq, session.id);

			const updateRes = await updateAttack(session.id);

			expect(updateRes.status).toBe(400);
			const error = await updateRes.json();
			expect(error.error).toMatchObject({
				code: "invalid_state",
				param: "status",
				type: "invalid_request_error",
			});

			// Stored session is unchanged
			const getReq = createRequest(
				`http://test/checkout_sessions/${session.id}`,
			);
			const getRes = await handlers.get(getReq, session.id);
			const stored = await getRes.json();
			expect(stored.status).toBe("canceled");
			expect(stored.items).toEqual(session.items);
			expect(stored.totals).toEqual(session.totals);
		});

		it("should still allow update on a not_ready_for_payment session", async () => {
			// Start not ready, then flip the quote to ready to exercise the status ladder
			let ready = false;
			const togglingProducts = {
				price: async (input: Parameters<typeof products.price>[0]) => {
					const quote = await products.price(input);
					return { ...quote, ready };
				},
			};
			handlers = createHandlers(
				{ products: togglingProducts, payments },
				{ store },
			);

			const session = await createSession();
			expect(session.status).toBe("not_ready_for_payment");

			ready = true;
			const body = { items: [{ id: "prod-1", quantity: 3 }] };
			const updateReq = createRequest(
				`http://test/checkout_sessions/${session.id}`,
				{ method: "POST", body },
			);
			const updateRes = await handlers.update(updateReq, session.id, body);

			expect(updateRes.status).toBe(200);
			const updated = await updateRes.json();
			expect(updated.status).toBe("ready_for_payment");
			expect(updated.totals.grand_total.amount).toBe(3000);
		});
	});

	describe("Cancel flow", () => {
		it("should cancel a session", async () => {
			// Create session
			const createReq = createRequest("http://test/checkout_sessions", {
				method: "POST",
				body: { items: [{ id: "prod-1", quantity: 1 }] },
			});
			const createRes = await handlers.create(createReq, {
				items: [{ id: "prod-1", quantity: 1 }],
			});
			const session = await createRes.json();

			// Cancel
			const cancelReq = createRequest(
				`http://test/checkout_sessions/${session.id}/cancel`,
				{ method: "POST" },
			);
			const cancelRes = await handlers.cancel(cancelReq, session.id);

			expect(cancelRes.status).toBe(200);
			const canceled = await cancelRes.json();
			expect(canceled.status).toBe("canceled");
		});
	});
});
