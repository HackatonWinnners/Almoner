import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Tiny zero-dependency static server for the dashboard. `npm run dashboard`.
const dir = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 5173);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

createServer(async (req, res) => {
  try {
    const path = (req.url ?? "/").split("?")[0];
    const file = join(dir, path === "/" ? "index.html" : path.replace(/^\/+/, ""));
    if (!file.startsWith(dir)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => {
  console.log(`\n  Almoner dashboard → http://localhost:${port}\n`);
});
