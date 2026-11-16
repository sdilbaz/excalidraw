import { get as httpGet } from "node:http";

// Liveness checks of local servers (the bridge daemon, the dev server) that
// may be starting or stopping. Each check opens its own connection
// (agent: false): a pooled keep-alive connection can be closed by a server
// that is shutting down just as it is reused.

// refused: nothing is listening; reset/broken pipe: the server closed the
// connection mid-request (e.g. it is shutting down)
const NOT_SERVING_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE"]);

export type ProbeResponse = { status: number; body: string };

/** GETs `url`; resolves null if nothing is serving there. */
export const getIfServing = (
  url: string,
  timeoutMs = 5000,
): Promise<ProbeResponse | null> =>
  new Promise((resolve, reject) => {
    const req = httpGet(url, { agent: false, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("timeout", () =>
      req.destroy(
        new Error(`Timed out after ${timeoutMs}ms requesting ${url}`),
      ),
    );
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (NOT_SERVING_CODES.has(error.code ?? "")) {
        resolve(null);
      } else {
        reject(error);
      }
    });
  });
