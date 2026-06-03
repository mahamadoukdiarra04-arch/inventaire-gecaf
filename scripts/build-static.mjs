import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");
const buildVersion = "31";
const files = ["index.html", "styles.css", "app.js", "manifest.webmanifest", "sw.js", "rescue.html", "_redirects", "_headers"];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const file of files) {
  let content = await readFile(join(root, file), "utf8");
  if (file === "index.html") {
    content = content
      .replace(/styles\.css\?v=\d+/g, `styles-v${buildVersion}.css`)
      .replace(/app\.js\?v=\d+/g, `app-v${buildVersion}.js`)
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
