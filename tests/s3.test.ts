import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type S3ClientLike, S3Target, syncDirectoryToS3 } from "../src/targets/s3.js";

function commandInput(command: object): Record<string, unknown> {
  return (command as { input: Record<string, unknown> }).input;
}

describe("S3 target", () => {
  it("uploads changed content atomically and skips a matching ETag", async () => {
    const calls: string[] = [];
    const client: S3ClientLike = {
      async send(command) {
        const input = commandInput(command);
        const name = command.constructor.name;
        calls.push(`${name}:${String(input.Key ?? "")}`);
        if (name === "HeadObjectCommand") return { ETag: '"5d41402abc4b2a76b9719d911017c592"' };
        return {};
      },
    };
    const target = new S3Target({ bucket: "bucket", prefix: "notion", client });

    await expect(target.writeIfChanged("page.md", "hello")).resolves.toBe(false);
    expect(calls).toEqual(["HeadObjectCommand:notion/page.md"]);

    calls.length = 0;
    const changedClient: S3ClientLike = {
      async send(command) {
        const input = commandInput(command);
        const name = command.constructor.name;
        calls.push(`${name}:${String(input.Key ?? "")}`);
        if (name === "HeadObjectCommand") return { ETag: '"old"' };
        return {};
      },
    };
    await expect(
      new S3Target({ bucket: "bucket", prefix: "notion", client: changedClient }).writeIfChanged(
        "page.md",
        "hello",
      ),
    ).resolves.toBe(true);
    expect(calls[0]).toBe("HeadObjectCommand:notion/page.md");
    expect(
      calls.some((call) => call.startsWith("PutObjectCommand:notion/page.md.sheaf-upload-")),
    ).toBe(true);
    expect(calls).toContain("CopyObjectCommand:notion/page.md");
    expect(
      calls.some((call) => call.startsWith("DeleteObjectCommand:notion/page.md.sheaf-upload-")),
    ).toBe(true);
  });

  it("continues other files when one upload fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sheaf-s3-"));
    await writeFile(join(dir, "ok.md"), "ok");
    await writeFile(join(dir, "bad.md"), "bad");
    const client: S3ClientLike = {
      async send(command) {
        const input = commandInput(command);
        if (String(input.Key).includes("bad.md")) throw new Error("upload denied");
        if (command.constructor.name === "HeadObjectCommand")
          throw { $metadata: { httpStatusCode: 404 } };
        return {};
      },
    };
    const result = await syncDirectoryToS3(dir, ["bad.md", "ok.md"], {
      bucket: "bucket",
      client,
    });
    expect(result.errors).toEqual([{ path: "bad.md", error: "upload denied" }]);
    expect(result.uploaded).toEqual(["ok.md"]);
  });
});
