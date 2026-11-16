// Something on the dev port that isn't Excalidraw. Usage: node otherServer.mjs <port>
import { createServer } from "node:http";

createServer((_req, res) => res.end("not excalidraw")).listen(
  Number(process.argv[2]),
);
