import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AssetDownloader, AssetError, sanitizeFileName } from "../src/core/extractor/assets.js";
import { stripQuery } from "../src/core/extractor/json.js";
import { bytes } from "./support/world.js";

const CONTENT = Buffer.from(bytes(42, 10_000));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

interface Hit {
  url: string;
  range: string | undefined;
}
type Handler = (req: IncomingMessage, res: ServerResponse, hit: Hit, n: number) => void;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function serve(handler: Handler) {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const hit = { url: req.url ?? "", range: req.headers.range };
    hits.push(hit);
    handler(req, res, hit, hits.length);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

/** A well-behaved file server with Range support. */
const fileServer: Handler = (_req, res, hit) => {
  const m = hit.range ? /^bytes=(\d+)-$/.exec(hit.range) : null;
  if (m) {
    const start = Number(m[1]);
    res.writeHead(206, {
      "content-type": "application/octet-stream",
      "content-range": `bytes ${start}-${CONTENT.length - 1}/${CONTENT.length}`,
      "content-length": String(CONTENT.length - start),
    });
    res.end(CONTENT.subarray(start));
  } else {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(CONTENT.length),
    });
    res.end(CONTENT);
  }
};

async function downloader(extra: Partial<ConstructorParameters<typeof AssetDownloader>[0]> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "np-assets-")); // the "output directory"
  const sleeps: number[] = [];
  const dl = new AssetDownloader({
    dir: join(dir, "assets"),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { dl, dir, sleeps };
}

const partialPath = (dir: string, url: string) =>
  join(
    dir,
    "assets",
    ".partial",
    createHash("sha256").update(stripQuery(url)).digest("hex").slice(0, 32),
  );

describe("AssetDownloader", () => {
  it("stores the file under <hash>-<name> with correct metadata", async () => {
    const { base } = await serve(fileServer);
    const { dl, dir } = await downloader();
    const ref = await dl.download({ url: `${base}/f/hello.txt?sig=1` });

    expect(ref.path).toBe(`assets/${sha(CONTENT).slice(0, 16)}-hello.txt`);
    expect(ref).toMatchObject({
      sha256: sha(CONTENT),
      bytes: CONTENT.length,
      name: "hello.txt",
      mime: "text/plain",
    });
    expect(await readFile(join(dir, ref.path))).toEqual(CONTENT);
    expect(await readdir(join(dir, "assets", ".partial"))).toEqual([]); // nothing left behind
    expect(dl.stats).toMatchObject({ downloaded: 1, bytes: CONTENT.length });
  });

  it("shares one transfer between concurrent requests for the same file", async () => {
    const { base, hits } = await serve(fileServer);
    const { dl } = await downloader();
    const [a, b] = await Promise.all([
      dl.download({ url: `${base}/f/x.bin?sig=1` }),
      dl.download({ url: `${base}/f/x.bin?sig=2` }),
    ]);
    expect(a).toEqual(b);
    expect(hits).toHaveLength(1);
  });

  it("does not store the same name+content twice, even from different URLs", async () => {
    const { base, hits } = await serve(fileServer);
    const { dl } = await downloader();
    const a = await dl.download({ url: `${base}/one/pic.png`, name: "pic.png" });
    const b = await dl.download({ url: `${base}/two/pic.png`, name: "pic.png" });
    expect(b.path).toBe(a.path);
    expect(hits).toHaveLength(2);
    expect(dl.stats.downloaded).toBe(1);
  });

  it("resumes an interrupted transfer with a Range request", async () => {
    const { base, hits } = await serve(fileServer);
    const { dl, dir } = await downloader();
    const url = `${base}/f/big.bin?sig=1`;
    await mkdir(join(dir, "assets", ".partial"), { recursive: true });
    await writeFile(partialPath(dir, url), CONTENT.subarray(0, 4000));

    const ref = await dl.download({ url });
    expect(hits[0]?.range).toBe("bytes=4000-");
    expect(dl.stats.resumed).toBe(1);
    expect(ref.sha256).toBe(sha(CONTENT));
    expect(await readFile(join(dir, ref.path))).toEqual(CONTENT);
  });

  it("restarts cleanly when the server ignores Range", async () => {
    const { base } = await serve((req, res, hit, n) => {
      const noRange: Handler = (_q, r) => {
        r.writeHead(200, { "content-length": String(CONTENT.length) });
        r.end(CONTENT);
      };
      noRange(req, res, hit, n);
    });
    const { dl, dir } = await downloader();
    const url = `${base}/f/big.bin`;
    await mkdir(join(dir, "assets", ".partial"), { recursive: true });
    await writeFile(partialPath(dir, url), CONTENT.subarray(0, 3000));

    const ref = await dl.download({ url });
    expect(dl.stats.resumed).toBe(0);
    expect(await readFile(join(dir, ref.path))).toEqual(CONTENT);
  });

  it("never splices when the server answers a different range than requested", async () => {
    const { base, hits } = await serve((req, res, hit, n) => {
      if (hit.range) {
        res.writeHead(206, { "content-range": `bytes 0-${CONTENT.length - 1}/${CONTENT.length}` });
        res.end(CONTENT);
      } else fileServer(req, res, hit, n);
    });
    const { dl, dir } = await downloader();
    const url = `${base}/f/big.bin`;
    await mkdir(join(dir, "assets", ".partial"), { recursive: true });
    await writeFile(partialPath(dir, url), CONTENT.subarray(0, 1000));

    const ref = await dl.download({ url });
    expect(hits).toHaveLength(2);
    expect(await readFile(join(dir, ref.path))).toEqual(CONTENT);
  });

  it("recovers from a connection cut mid-transfer, with an intact result", async () => {
    const { base } = await serve((req, res, hit, n) => {
      if (n === 1) {
        res.writeHead(200, { "content-length": String(CONTENT.length) });
        res.write(CONTENT.subarray(0, 5000));
        setTimeout(() => res.destroy(), 100);
      } else fileServer(req, res, hit, n);
    });
    const { dl, dir } = await downloader();
    const ref = await dl.download({ url: `${base}/f/cut.bin` });
    expect(dl.stats.retries).toBeGreaterThanOrEqual(1);
    expect(ref.sha256).toBe(sha(CONTENT));
    expect(await readFile(join(dir, ref.path))).toEqual(CONTENT);
  });

  it("asks for a fresh URL when the signed one is rejected", async () => {
    const { base, hits } = await serve((req, res, hit, n) => {
      if (hit.url.includes("sig=new")) fileServer(req, res, hit, n);
      else {
        res.writeHead(403, { "content-type": "application/xml" });
        res.end("<Error><Code>AccessDenied</Code></Error>");
      }
    });
    const { dl } = await downloader();
    let refreshed = 0;
    const ref = await dl.download({
      url: `${base}/f/a.bin?sig=old`,
      refreshUrl: async () => {
        refreshed++;
        return `${base}/f/a.bin?sig=new`;
      },
    });
    expect(refreshed).toBe(1);
    expect(dl.stats.urlRefreshes).toBe(1);
    expect(hits.map((h) => h.url)).toEqual(["/f/a.bin?sig=old", "/f/a.bin?sig=new"]);
    expect(ref.sha256).toBe(sha(CONTENT));
  });

  it("fails clearly on 403 when it cannot refresh, without retrying", async () => {
    const { base, hits } = await serve((_q, res) => {
      res.writeHead(403);
      res.end();
    });
    const { dl } = await downloader();
    await expect(dl.download({ url: `${base}/f/a.bin` })).rejects.toMatchObject({
      permanent: true,
      message: /403/,
    });
    expect(hits).toHaveLength(1);
  });

  it("gives up after two refreshes that still fail", async () => {
    const { base, hits } = await serve((_q, res) => {
      res.writeHead(403);
      res.end();
    });
    const { dl } = await downloader();
    await expect(
      dl.download({ url: `${base}/f/a.bin`, refreshUrl: async () => `${base}/f/a.bin?again` }),
    ).rejects.toBeInstanceOf(AssetError);
    expect(hits).toHaveLength(3); // original + 2 refreshes
  });

  it("treats 404 as permanent and does not retry", async () => {
    const { base, hits } = await serve((_q, res) => {
      res.writeHead(404);
      res.end();
    });
    const { dl } = await downloader();
    await expect(dl.download({ url: `${base}/gone.bin` })).rejects.toMatchObject({
      permanent: true,
      message: /404/,
    });
    expect(hits).toHaveLength(1);
  });

  it("retries 503, honouring Retry-After", async () => {
    const { base } = await serve((req, res, hit, n) => {
      if (n === 1) {
        res.writeHead(503, { "retry-after": "2" });
        res.end();
      } else if (n === 2) {
        res.writeHead(503);
        res.end();
      } else fileServer(req, res, hit, n);
    });
    const { dl, sleeps } = await downloader();
    await dl.download({ url: `${base}/f/a.bin` });
    expect(sleeps[0]).toBe(2000);
    expect(sleeps).toHaveLength(2);
    expect(dl.stats.retries).toBe(2);
  });

  it("stops after maxAttempts", async () => {
    const { base, hits } = await serve((_q, res) => {
      res.writeHead(503);
      res.end();
    });
    const { dl } = await downloader({ maxAttempts: 3 });
    await expect(dl.download({ url: `${base}/f/a.bin` })).rejects.toMatchObject({
      permanent: false,
      message: /after 3 attempts/,
    });
    expect(hits).toHaveLength(3);
  });

  it("does not cache a failure: a later attempt with a good URL succeeds", async () => {
    const { base } = await serve((req, res, hit, n) => {
      if (hit.url.includes("bad")) {
        res.writeHead(404);
        res.end();
      } else fileServer(req, res, hit, n);
    });
    const { dl } = await downloader();
    await expect(dl.download({ url: `${base}/f/a.bin?bad` })).rejects.toBeDefined();
    await expect(dl.download({ url: `${base}/f/a.bin?good` })).resolves.toMatchObject({
      sha256: sha(CONTENT),
    });
  });
});

describe("sanitizeFileName", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["..\\..\\Windows\\evil.exe", "evil.exe"],
    ["C:\\Users\\me\\a.txt", "a.txt"],
    ["CON.txt", "file-CON.txt"],
    ["nul", "file-nul"],
    ["", "file"],
    ["...", "file"],
    [".hidden", "hidden"],
    ["trailing. .", "trailing"],
    ['we<ird>:na"me|?*.txt', "we_ird__na_me___.txt"],
    ["tab\there\u0000nul", "tab_here_nul"],
    ["Résumé 日本語.pdf", "Résumé 日本語.pdf"],
  ])("%j -> %j", (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });

  it("truncates long names but keeps the extension", () => {
    const out = sanitizeFileName(`${"a".repeat(300)}.pdf`);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith(".pdf")).toBe(true);
  });

  it("normalises Unicode so the same name is always the same bytes", () => {
    expect(sanitizeFileName("e\u0301.txt")).toBe(sanitizeFileName("\u00e9.txt"));
  });

  it("never yields a path separator or a dot-only segment", () => {
    for (const evil of ["/", "\\", "..", "../", "a/../b", "%2e%2e"]) {
      const out = sanitizeFileName(evil);
      expect(out).not.toMatch(/[\\/]/);
      expect(out).not.toBe("..");
      expect(out).not.toBe(".");
    }
  });
});
