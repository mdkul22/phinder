import { cp, mkdir, rm, access } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("public", "dist/public", { recursive: true });
await cp("server.mjs", "dist/server.mjs");
await cp("package.json", "dist/package.json");
await access("dist/public/index.html");
console.log("Self-hostable build created in dist/");
