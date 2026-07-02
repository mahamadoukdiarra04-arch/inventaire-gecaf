import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");
const buildVersion = "35";
const files = [
  "index.html",
  "styles.css",
  "mamy-styles.css",
  "app.js",
  "portal.js",
  "mamy-app.js",
  "mamy-products.json",
  "manifest.webmanifest",
  "sw.js",
  "rescue.html",
  "_redirects",
  "_headers",
];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const file of files) {
  let content = await readFile(join(root, file), "utf8");
  if (file === "index.html") {
    content = content
      .replace(/styles\.css\?v=\d+/g, `styles-v${buildVersion}.css`)
      .replace(/mamy-styles\.css\?v=\d+/g, `mamy-styles-v${buildVersion}.css`)
      .replace(/app\.js\?v=\d+/g, `app-v${buildVersion}.js`)
      .replace(/portal\.js\?v=\d+/g, `portal-v${buildVersion}.js`)
      .replace(/mamy-app\.js\?v=\d+/g, `mamy-app-v${buildVersion}.js`)
      .replace(/zxing-browser\.min\.js\?v=\d+/g, `zxing-browser-v${buildVersion}.min.js`)
      .replace(/supabase-config\.js\?v=\d+/g, `supabase-config-v${buildVersion}.js`)
      .replace(/manifest\.webmanifest\?v=\d+/g, `manifest.webmanifest?v=${buildVersion}`);
  }
  await writeFile(join(dist, file), content);
}

const sourceConfig = await readFile(join(root, "supabase-config.js"), "utf8");
const supabaseUrl = process.env.SUPABASE_URL || process.env.GECAF_SUPABASE_URL || "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.GECAF_SUPABASE_ANON_KEY || "";

const config = supabaseUrl && supabaseAnonKey
  ? `window.GECAF_CONFIG = {
  supabaseUrl: ${JSON.stringify(supabaseUrl)},
  supabaseAnonKey: ${JSON.stringify(supabaseAnonKey)},
  syncIntervalMs: 5000,
};
`
  : sourceConfig;

await writeFile(join(dist, "supabase-config.js"), config);
await writeFile(join(dist, `supabase-config-v${buildVersion}.js`), config);
await writeFile(join(dist, `app-v${buildVersion}.js`), await readFile(join(root, "app.js")));
await writeFile(join(dist, `styles-v${buildVersion}.css`), await readFile(join(root, "styles.css")));
await writeFile(join(dist, `portal-v${buildVersion}.js`), await readFile(join(root, "portal.js")));
await writeFile(join(dist, `mamy-app-v${buildVersion}.js`), await readFile(join(root, "mamy-app.js")));
await writeFile(join(dist, `mamy-styles-v${buildVersion}.css`), await readFile(join(root, "mamy-styles.css")));
await writeFile(join(dist, `mamy-products-v${buildVersion}.json`), await readFile(join(root, "mamy-products.json")));
const zxingBundle = await readFile(join(root, "node_modules", "@zxing", "browser", "umd", "zxing-browser.min.js"));
await writeFile(join(dist, "zxing-browser.min.js"), zxingBundle);
await writeFile(join(dist, `zxing-browser-v${buildVersion}.min.js`), zxingBundle);
