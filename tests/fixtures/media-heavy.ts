import {
  audio,
  bytes,
  callout,
  childDatabase,
  def,
  externalFile,
  type Fixture,
  fileBlock,
  heading,
  image,
  P,
  pageParent,
  paragraph,
  pdf,
  schemaOf,
  video,
  WORKSPACE_PARENT,
  World,
} from "../support/world.js";

/** Notion-hosted files everywhere: blocks, cover, icon, callout icon, files property, row cover. */
export function mediaHeavy(): Fixture {
  const w = new World("media-heavy");
  const png = bytes(1, 2048);
  const manual = bytes(2, 4096);

  const gallery = w.page({
    title: "Gallery",
    parent: WORKSPACE_PARENT,
    icon: w.file("icon.png", bytes(7, 300), "image/png"),
    cover: w.file("cover.jpg", bytes(6, 1200), "image/jpeg"),
  });
  const assetsDb = w.database({ title: "Assets", parent: pageParent(gallery) });
  const assetsDs = w.dataSource(assetsDb, {
    name: "Assets",
    properties: schemaOf(def("Name", "title", "title"), def("Files", "fil", "files")),
  });

  w.body(gallery, [
    heading(1, "Photos"),
    image(w.file("photo-a.png", png, "image/png"), "First photo"),
    // Same bytes under a different URL: must collapse into one stored asset.
    image(w.file("photo-a-copy.png", png, "image/png")),
    image(externalFile("https://example.com/remote.png")),
    fileBlock(w.file("report-q1.pdf", bytes(3, 3000), "application/pdf"), "Report Q1.pdf"),
    pdf(w.file("manual.pdf", manual, "application/pdf")),
    video(w.file("clip.mp4", bytes(4, 8192), "video/mp4")),
    audio(w.file("note.mp3", bytes(5, 1500), "audio/mpeg")),
    callout("Attachment note", w.file("callout-icon.png", bytes(8, 250), "image/png")),
    paragraph("Hostile and non-ASCII file names:"),
    // URL-encoded "../../etc/passwd": must never escape the assets directory.
    image(w.file("..%2F..%2Fetc%2Fpasswd", bytes(9, 200), "application/octet-stream")),
    fileBlock(
      w.file("r%C3%A9sum%C3%A9.pdf", bytes(10, 700), "application/pdf"),
      "Résumé 日本語.pdf",
    ),
    childDatabase(assetsDb, "Assets"),
  ]);

  w.row(assetsDs, {
    title: "Brand kit",
    cover: w.file("brand-cover.jpg", bytes(11, 900), "image/jpeg"),
    properties: {
      Files: P.files("fil", [
        { name: "logo.svg", file: w.file("logo.svg", bytes(12, 400), "image/svg+xml") },
        { name: "guide.pdf", file: w.file("guide-copy.pdf", manual, "application/pdf") },
      ]),
    },
  });
  w.row(assetsDs, {
    title: "Press photos",
    properties: {
      Files: P.files("fil", [
        { name: "press.png", file: w.file("press.png", bytes(13, 1100), "image/png") },
      ]),
    },
  });
  w.view(assetsDb, {
    name: "Gallery view",
    type: "gallery",
    dataSourceId: assetsDs,
    configuration: { type: "gallery" },
  });

  return { name: "media-heavy", ws: w.ws, ids: { gallery, assetsDb, assetsDs } };
}
