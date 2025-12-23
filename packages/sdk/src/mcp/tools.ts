import { z } from "zod";

/**
 * MCP tool definition structure
 */
export interface MCPToolDefinition {
	description: string;
	inputSchema: z.ZodSchema;
}

/**
 * Search products in the catalog
 *
 * Maps to: GET /api/products/search
 */
export const searchProducts: MCPToolDefinition = {
	description:
		"Search for products in the catalog. Returns a list of products matching the query with pricing and availability.",
	inputSchema: z.object({
		query: z.string().describe("Search query to find products"),
		category: z.string().optional().describe("Filter by product category"),
		limit: z
			.number()
			.int()
			.positive()
			.default(10)
			.describe("Maximum number of results to return"),
	}),
};

/**
 * Get detailed information about a specific product
 *
 * Maps to: GET /api/products/:id
 */
export const getProduct: MCPToolDefinition = {
	description:
		"Get detailed information about a specific product including variants, images, and full description.",
	inputSchema: z.object({
		product_id: z.string().describe("Unique identifier for the product"),
	}),
};

/**
 * Create a new checkout session
 *
 * Maps to: POST /api/checkout
 */
export const createCheckout: MCPToolDefinition = {
	description:
		"Create a new checkout session with the specified items. Returns pricing, available fulfillment options, and session ID.",
	inputSchema: z.object({
		items: z
			.array(
				z.object({
					id: z.string().describe("Product ID"),
					quantity: z
						.number()
						.int()
						.positive()
						.describe("Quantity to purchase"),
				}),
			)
			.min(1)
			.describe("List of items to add to checkout"),
		customer: z
			.object({
				email: z.string().email().describe("Customer email address"),
				name: z.string().optional().describe("Customer full name"),
			})
			.optional()
			.describe("Customer information (optional at creation)"),
		fulfillment: z
			.object({
				selected_option_id: z
					.string()
					.optional()
					.describe("ID of the selected fulfillment option"),
				address: z
					.object({
						line1: z.string(),
						line2: z.string().optional(),
						city: z.string(),
						state: z.string().optional(),
						postal_code: z.string(),
						country: z.string(),
					})
					.optional()
					.describe("Shipping address"),
			})
			.optional()
			.describe("Fulfillment preferences"),
	}),
};

/**
 * Update an existing checkout session
 *
 * Maps to: PATCH /api/checkout/:id
 */
export const updateCheckout: MCPToolDefinition = {
	description:
		"Update an existing checkout session. Can modify items, customer information, or fulfillment details.",
	inputSchema: z.object({
		session_id: z.string().describe("Checkout session ID to update"),
		items: z
			.array(
				z.object({
					id: z.string().describe("Product ID"),
					quantity: z
						.number()
						.int()
						.positive()
						.describe("Quantity to purchase"),
				}),
			)
			.optional()
			.describe("Updated list of items"),
		customer: z
			.object({
				email: z.string().email().describe("Customer email address"),
				name: z.string().optional().describe("Customer full name"),
			})
			.optional()
			.describe("Customer information"),
		fulfillment: z
			.object({
				selected_option_id: z
					.string()
					.optional()
					.describe("ID of the selected fulfillment option"),
				address: z
					.object({
						line1: z.string(),
						line2: z.string().optional(),
						city: z.string(),
						state: z.string().optional(),
						postal_code: z.string(),
						country: z.string(),
					})
					.optional()
					.describe("Shipping address"),
			})
			.optional()
			.describe("Fulfillment preferences"),
	}),
};

/**
 * Complete a checkout session and process payment
 *
 * Maps to: POST /api/checkout/:id/complete
 *
 * Behavior depends on payment token availability:
 * - With payment token (ACP): Processes payment directly through the complete endpoint
 * - Without payment token (MCP): Returns checkout_url for user to complete payment on merchant site
 */
export const completeCheckout: MCPToolDefinition = {
	description:
		"Complete the checkout process. In MCP context (without payment token), returns a checkout URL for the user to complete payment. In ACP context (with delegated payment token), processes payment directly.",
	inputSchema: z.object({
		session_id: z.string().describe("Checkout session ID to complete"),
		customer: z.object({
			email: z.string().email().describe("Customer email address"),
			name: z.string().describe("Customer full name"),
		}),
		payment: z
			.object({
				method: z.string().describe("Payment method (e.g., 'card', 'paypal')"),
				token: z
					.string()
					.optional()
					.describe(
						"Payment token from payment processor (delegated token for ACP)",
					),
			})
			.optional()
			.describe(
				"Payment information (optional for MCP, required for ACP payment processing)",
			),
	}),
};

/**
 * Cancel a checkout session
 *
 * Maps to: POST /api/checkout/:id/cancel
 */
export const cancelCheckout: MCPToolDefinition = {
	description:
		"Cancel an existing checkout session. The session will be marked as canceled and cannot be completed.",
	inputSchema: z.object({
		session_id: z.string().describe("Checkout session ID to cancel"),
	}),
};

/**
 * Get the current state of a checkout session
 *
 * Maps to: GET /api/checkout/:id
 */
export const getCheckout: MCPToolDefinition = {
	description:
		"Retrieve the current state of a checkout session including items, pricing, and status.",
	inputSchema: z.object({
		session_id: z.string().describe("Checkout session ID to retrieve"),
	}),
};

/**
 * All available MCP tools
 */
export const tools = {
	searchProducts,
	getProduct,
	createCheckout,
	updateCheckout,
	completeCheckout,
	cancelCheckout,
	getCheckout,
} as const;
