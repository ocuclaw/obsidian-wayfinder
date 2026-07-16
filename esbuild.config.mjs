import esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import process from "process";

const prod = process.argv[2] === "production";

if (prod) {
  const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
  if (manifest.version !== pkg.version) {
    throw new Error(
      `Version mismatch: manifest.json is ${manifest.version}, package.json is ${pkg.version}`,
    );
  }
}

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2021",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
