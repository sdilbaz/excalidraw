import { ExcalidrawFontFace } from "./ExcalidrawFontFace";

const FONT = "/fonts/Excalifont/Excalifont-Regular.woff2";

const urlsFor = (uri: string) =>
  new ExcalidrawFontFace("Test", uri).urls.map((url) => url.toString());

describe("ExcalidrawFontFace urls", () => {
  const original = {
    assetPath: window.EXCALIDRAW_ASSET_PATH,
    fallback: window.EXCALIDRAW_ASSET_FALLBACK,
  };

  afterEach(() => {
    window.EXCALIDRAW_ASSET_PATH = original.assetPath;
    window.EXCALIDRAW_ASSET_FALLBACK = original.fallback;
  });

  it.each([
    ["unset", undefined],
    ["true", true],
  ])(
    "adds the esm.sh fallback after the asset path when the opt-out is %s",
    (_, fallback) => {
      window.EXCALIDRAW_ASSET_PATH = "http://localhost:3001";
      window.EXCALIDRAW_ASSET_FALLBACK = fallback;

      const urls = urlsFor(FONT);

      expect(urls).toHaveLength(2);
      expect(urls[0]).toBe(
        "http://localhost:3001/fonts/Excalifont/Excalifont-Regular.woff2",
      );
      expect(new URL(urls[1]).host).toBe("esm.sh");
    },
  );

  it("uses only the asset paths when the fallback is turned off", () => {
    window.EXCALIDRAW_ASSET_PATH = [
      "http://localhost:3001",
      "http://127.0.0.1:3001/static/",
    ];
    window.EXCALIDRAW_ASSET_FALLBACK = false;

    expect(urlsFor(FONT)).toEqual([
      "http://localhost:3001/fonts/Excalifont/Excalifont-Regular.woff2",
      "http://127.0.0.1:3001/static/fonts/Excalifont/Excalifont-Regular.woff2",
    ]);
  });

  it("throws when the fallback is off and there is no asset path", () => {
    window.EXCALIDRAW_ASSET_PATH = undefined;
    window.EXCALIDRAW_ASSET_FALLBACK = false;

    expect(() => urlsFor(FONT)).toThrow(/EXCALIDRAW_ASSET_PATH must be set/);
  });

  it.each([
    ["an http url", "https://fonts.example.com/a.woff2", 1],
    ["a data url", "data:font/woff2;base64,AAAA", 1],
  ])("leaves %s untouched by the opt-out", (_, uri, count) => {
    window.EXCALIDRAW_ASSET_PATH = undefined;
    window.EXCALIDRAW_ASSET_FALLBACK = false;

    expect(urlsFor(uri)).toHaveLength(count);
  });
});
