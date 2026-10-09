import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// Mirrors the Obsidian Community directory's automated review (eslint-plugin-obsidianmd).
// The scanner tracks the plugin's latest version, so re-run `npm update` before each release.
export default defineConfig([
	{ ignores: ["main.js", "node_modules/"] }, // main.js is the esbuild output; lint src/ instead
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.*", "esbuild.config.*"],
				},
			},
		},
	},
]);
