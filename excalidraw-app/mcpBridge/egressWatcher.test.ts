import { isLocalUrl } from "./egressWatcher";

const PAGE = "http://localhost:3001/";

describe("isLocalUrl", () => {
  it.each([
    ["http://localhost:3001/assets/font.woff2", true],
    ["ws://localhost:3001/", true],
    ["ws://127.0.0.1:3050/canvas", true],
    ["http://127.0.0.1:3016/v1/ai", true],
    ["http://[::1]:3000/", true],
    ["http://app.localhost:3000/", true],
    ["/relative/path.js", true],
    ["data:image/png;base64,AAAA", true],
    ["blob:http://localhost:3001/uuid", true],
    // values CSP violation events use for non-network sources
    ["inline", true],
    ["eval", true],
    ["", true],
    ["https://json-dev.excalidraw.com/api/v2/post/", false],
    ["https://esm.sh/@excalidraw/excalidraw/fonts/Virgil.woff2", false],
    ["https://fonts.gstatic.com/", false],
    ["wss://oss-collab.excalidraw.com/", false],
    ["http://localhost.evil.example/", false],
    ["http://127.0.0.1.evil.example/", false],
    ["http://192.168.1.10:3001/", false],
  ])("%s -> %s", (url, expected) => {
    expect(isLocalUrl(url, PAGE)).toBe(expected);
  });
});
