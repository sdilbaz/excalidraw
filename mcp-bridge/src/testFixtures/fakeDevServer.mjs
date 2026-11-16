// Stand-in for the vite dev server in the daemon tests: serves a page with
// the Excalidraw <title> on the given port. Usage: node fakeDevServer.mjs <port>
import { createServer } from "node:http";

const port = Number(process.argv[2]);
createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<!doctype html><title>Excalidraw Whiteboard</title>");
}).listen(port);
