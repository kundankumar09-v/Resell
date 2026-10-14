const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const sharp = require("sharp");

const IMAGES_DIR = path.join(__dirname, "..", "public", "seed-images");
fs.mkdirSync(IMAGES_DIR, { recursive: true });

const SOURCES = [
  { filename: "iphone-13-midnight.jpg", url: "https://images.unsplash.com/photo-1632661674596-df8be070a5c5?w=1200&q=80&fm=jpg&fit=crop", credit: "Photo by Ismail Hadine on Unsplash" },
  { filename: "macbook-pro-14.jpg", url: "https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=1200&q=80&fm=jpg&fit=crop", credit: "Photo by Clement Helardot on Unsplash" },
  { filename: "sony-wh1000xm4.jpg", url: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=1200&q=80&fm=jpg&fit=crop", credit: "Photo by Andres Urena on Unsplash" },
  { filename: "nike-af1-white.jpg", url: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=1200&q=80&fm=jpg&fit=crop", credit: "Photo by Greg Rosenke on Unsplash" },
  { filename: "leather-jacket-camel.jpg", url: "https://images.unsplash.com/photo-1551028719-00167b16eac5?w=1200&q=80&fm=jpg&fit=crop", credit: "Photo by Apostolos Vamvouras on Unsplash" },
  { filename: "desk-lamp-led.jpg", url: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=1200&q=80&fm=jpg&fit=crop", credit: "Photo by Stefan Stefancik on Unsplash" },
  { filename: "office-chair-mesh.jpg", url: "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=1200&q=80&fm=jpg&fit=crop", credit: "Photo by Naomi Hebert on Unsplash" },
  { filename: "dumbbells-pair.jpg", url: "https://images.unsplash.com/photo-1526506118085-60ce8714f8c5?w=1200&q=80&fm=jpg&fit=crop", credit: "Photo by Danielle Cerullo on Unsplash" },
  { filename: "office-desk-oak.jpg", url: "https://images.unsplash.com/photo-1518455027359-f3f8164ba6bd?w=1200&q=80&fm=jpg&fit=crop", credit: "Photo by vadim kaipov on Unsplash" },
  { filename: "harry-potter-books.jpg", url: "https://images.unsplash.com/photo-1512820790803-83ca734da794?w=1200&q=80&fm=jpg&fit=crop", credit: "Photo by Thought Catalog on Unsplash" },
  { filename: "apple-watch-se.jpg", url: "https://images.unsplash.com/photo-1546868871-7041f2a55e12?w=1200&q=80&fm=jpg&fit=crop", credit: "Photo by Luke Chesser on Unsplash" },
  { filename: "iphone-demo-case2.jpg", url: "https://images.unsplash.com/photo-1592899677977-9c10ca588bbd?w=1200&q=80&fm=jpg&fit=crop", credit: "Photo by Tran Mau Tri Tam on Unsplash" },
  { filename: "sneakers-demo-case3a.jpg", url: "https://images.unsplash.com/photo-1460353581641-37baddab0fa2?w=1200&q=80&fm=jpg&fit=crop", credit: "Photo by Jakob Owens on Unsplash" },
  { filename: "sneakers-demo-case3b.jpg", url: "https://images.unsplash.com/photo-1491553895911-0055eca6402d?w=1200&q=80&fm=jpg&fit=crop", credit: "Photo by Alexander Schimmeck on Unsplash" },
];

const downloadUrl = (url) =>
  new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error("HTTP " + res.statusCode + " for " + url));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout fetching " + url)); });
  });

(async () => {
  const credits = [];
  for (const src of SOURCES) {
    const dest = path.join(IMAGES_DIR, src.filename);
    console.log("[download] " + src.filename + " ...");
    try {
      const raw = await downloadUrl(src.url);
      const processed = await sharp(raw)
        .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      fs.writeFileSync(dest, processed);
      credits.push(src.filename + ": " + src.credit);
      console.log("  saved " + (processed.length / 1024).toFixed(1) + " KB");
    } catch (err) {
      console.error("  FAILED: " + err.message);
    }
  }
  const creditsPath = path.join(IMAGES_DIR, "CREDITS.md");
  const creditsContent = "# Seed Image Credits\n\nAll images from Unsplash (https://unsplash.com), freely usable under Unsplash License.\n\n" + credits.map(c => "- " + c).join("\n") + "\n";
  fs.writeFileSync(creditsPath, creditsContent);
  console.log("\n[download] Done. Credits -> " + creditsPath);
})();
