/**
 * One static-export server, shared by every browser suite.
 *
 * Both suites had their own copy, and they had drifted: one of them served
 * `.txt` and the other did not. Those files are the App Router's navigation
 * payloads, so without the right content type every in-app navigation silently
 * degrades to a full document load -- which resets client state and makes the
 * guide look like it drops out halfway. That cost real debugging time chasing a
 * bug that existed only in the test harness.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  // Load-bearing: these are the router payloads. See above.
  ".txt": "text/plain",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

/** Resolve a request path and reject any path outside the export root. */
export function resolveExportPath(root, requestUrl) {
  const resolvedRoot = path.resolve(root);
  const pathname = decodeURIComponent((requestUrl ?? "/").split("?")[0]);
  const candidate = path.resolve(resolvedRoot, `.${path.sep}${pathname}`);
  const relative = path.relative(resolvedRoot, candidate);

  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
}

/** Serve `out/` on `port`; resolves to a close function. */
export async function serveStaticExport(port, root = path.resolve("out")) {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(`No static export at ${resolvedRoot}. Run \`pnpm build\` first.`);
  }

  const server = http.createServer((request, response) => {
    let file;
    try {
      file = resolveExportPath(resolvedRoot, request.url);
    } catch {
      response.writeHead(400);
      return response.end("bad request");
    }
    if (!file) {
      response.writeHead(403);
      return response.end("forbidden");
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (fs.existsSync(`${file}.html`)) file += ".html";
      else if (fs.existsSync(path.join(file, "index.html"))) file = path.join(file, "index.html");
      else {
        response.writeHead(404);
        return response.end("not found");
      }
    }
    response.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    });
    fs.createReadStream(file).pipe(response);
  });

  await new Promise((resolve) => server.listen(port, resolve));
  return () => server.close();
}
