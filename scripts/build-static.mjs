import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");
const files = ["index.html", "styles.css", "app.js", "manifest.webmanifest", "sw.js", "rescue.html", "_redirects", "_headers"];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const file of files) {
  await writeFile(join(dist, file), await readFile(join(root, file)));
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
