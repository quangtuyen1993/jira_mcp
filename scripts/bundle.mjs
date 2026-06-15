/**
 * Bundle script – dùng esbuild để build toàn bộ code + dependencies
 * thành 1 file JS duy nhất, không cần node_modules.
 *
 * Output: dist/jira-mcp.js (có thể chạy trực tiếp: node dist/jira-mcp.js)
 */

import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";

const rootDir = resolve(import.meta.dirname, "..");
const distDir = resolve(rootDir, "dist");
const outFile = resolve(distDir, "jira-mcp.js");

if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

console.log("📦 Bundling Jira MCP server...\n");

await esbuild.build({
  entryPoints: [resolve(rootDir, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: outFile,
  banner: {
    js: "#!/usr/bin/env node",
  },
  packages: "external",
  minify: false,
  sourcemap: false,
  treeShaking: true,
  metafile: true,
});

// Make it executable
const content = readFileSync(outFile, "utf-8");
writeFileSync(outFile, content, { mode: 0o755 });

console.log(`✅ Bundled to: ${outFile}`);
console.log(`   Size: ${(content.length / 1024).toFixed(1)} KB`);
console.log(`\n🚀 Run: node dist/jira-mcp.js`);
