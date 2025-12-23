import { defineConfig, type UserConfig } from "tsdown";

const config: UserConfig = defineConfig({
	entry: [
		"./src/index.ts",
		"./src/next/index.ts",
		"./src/feed/index.ts",
		"./src/feed/next/index.ts",
		"./src/mcp/index.ts",
		"./src/test/index.ts",
	],
	outDir: "./dist",
	dts: true,
	sourcemap: true,
	format: "esm",
	platform: "node",
	// plugins: [dts()],
});

export default config;
