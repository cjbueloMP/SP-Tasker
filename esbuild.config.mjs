import esbuild from "esbuild";
import { builtinModules } from "node:module";

const watch = process.argv.includes("--watch");

// Deliberately unminified, with no sourcemap in release builds: directory reviewers read main.js,
// and the developer policies prohibit obfuscation.
const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "es2018",
	logLevel: "info",
	sourcemap: watch ? "inline" : false,
	treeShaking: true,
	outfile: "main.js",
	external: [
		"obsidian",
		"electron",
		"@codemirror/*",
		"@lezer/*",
		...builtinModules,
	],
});

if (watch) {
	await context.watch();
} else {
	await context.rebuild();
	await context.dispose();
}
