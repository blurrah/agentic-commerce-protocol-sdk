/**
 * Configuration for creating MCP handlers
 */
export interface HandlerConfig {
	/**
	 * Base URL of your store's API (e.g., 'https://mystore.com')
	 */
	baseUrl: string;

	/**
	 * Optional headers to include in all requests (e.g., auth tokens)
	 */
	headers?: Record<string, string>;

	/**
	 * Optional fetch implementation (useful for testing or custom logic)
	 */
	fetch?: typeof fetch;

	/**
	 * Function to generate checkout URL for a session.
	 * Used when completeCheckout is called without a payment token (MCP context).
	 * Defaults to `${baseUrl}/checkout/${sessionId}` if not provided.
	 *
	 * @example
	 * ```typescript
	 * getCheckoutUrl: (sessionId) => `https://mystore.com/checkout/${sessionId}`
	 * ```
	 */
	getCheckoutUrl?: (sessionId: string) => string;
}

/**
 * Create handlers that call your acp-handler API endpoints
 *
 * @example
 * ```typescript
 * const handlers = createHandlers({
 *   baseUrl: 'https://mystore.com',
 *   headers: { 'Authorization': 'Bearer token' }
 * });
 *
 * server.registerTool(
 *   'search_products',
 *   tools.searchProducts,
 *   handlers.searchProducts
 * );
 * ```
 */
export function createHandlers(config: HandlerConfig) {
	const { baseUrl, headers = {}, fetch: customFetch = fetch } = config;

	const request = async (
		path: string,
		options: RequestInit = {},
	): Promise<unknown> => {
		const url = `${baseUrl}${path}`;
		const response = await customFetch(url, {
			...options,
			headers: {
				"Content-Type": "application/json",
				...headers,
				...options.headers,
			},
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({
				message: response.statusText,
			}));
			throw new Error(
				`API request failed: ${error.message || response.statusText}`,
			);
		}

		return response.json();
	};

	return {
		/**
		 * Search for products in the catalog
		 */
		searchProducts: async (input: {
			query: string;
			category?: string;
			limit?: number;
		}): Promise<unknown> => {
			const params = new URLSearchParams({
				q: input.query,
			});

			if (input.category) {
				params.set("category", input.category);
			}

			if (input.limit) {
				params.set("limit", String(input.limit));
			}

			return request(`/api/products/search?${params}`);
		},

		/**
		 * Get detailed information about a specific product
		 */
		getProduct: async (input: { product_id: string }): Promise<unknown> => {
			return request(`/api/products/${input.product_id}`);
		},

		/**
		 * Create a new checkout session
		 */
		createCheckout: async (input: any): Promise<unknown> => {
			return request("/api/checkout", {
				method: "POST",
				body: JSON.stringify(input),
			});
		},

		/**
		 * Update an existing checkout session
		 */
		updateCheckout: async (input: any): Promise<unknown> => {
			const { session_id, ...body } = input;
			return request(`/api/checkout/${session_id}`, {
				method: "POST",
				body: JSON.stringify(body),
			});
		},

		/**
		 * Complete a checkout session and process payment.
		 * In MCP context (no payment token), returns checkout URL for user to complete payment.
		 * In ACP context (with payment token), processes payment directly.
		 */
		completeCheckout: async (input: any): Promise<unknown> => {
			const { session_id, customer, payment } = input;

			// MCP context: no payment token provided
			// Return checkout URL for user to complete payment on merchant site
			if (!payment?.token) {
				const checkoutUrl = config.getCheckoutUrl
					? config.getCheckoutUrl(session_id)
					: `${config.baseUrl}/checkout/${session_id}`;

				return {
					checkout_url: checkoutUrl,
					session_id,
					status: "pending_payment",
					message: "Complete your purchase at the checkout link",
				};
			}

			// ACP context: payment token provided
			// Process payment through ACP complete endpoint
			return request(`/api/checkout/${session_id}/complete`, {
				method: "POST",
				body: JSON.stringify({ customer, payment }),
			});
		},

		/**
		 * Cancel a checkout session
		 */
		cancelCheckout: async (input: { session_id: string }): Promise<unknown> => {
			const { session_id } = input;
			return request(`/api/checkout/${session_id}/cancel`, {
				method: "POST",
			});
		},

		/**
		 * Get the current state of a checkout session
		 */
		getCheckout: async (input: { session_id: string }): Promise<unknown> => {
			return request(`/api/checkout/${input.session_id}`);
		},
	};
}

/**
 * Type for the handlers object returned by createHandlers
 */
export type Handlers = ReturnType<typeof createHandlers>;
