import { existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "rasat/web");
const demoSrc = resolve(here, "src");

if (!existsSync(resolve(webRoot, "package.json"))) {
  throw new Error("rasat/web missing — run npm run fetch (CI checks out odurgut/rasat into ./rasat)");
}

function demoOverlay(): Plugin {
  const searchDir = `${sep}src${sep}search${sep}`;
  const chromeFile = `${sep}src${sep}chrome${sep}Chrome.tsx`;
  const mainFile = `${sep}src${sep}main.tsx`;
  const bannerCss = JSON.stringify(resolve(demoSrc, "banner.css"));
  const cassette = `<a className="demo-banner" href="https://rasat.dev/docs/getting-started" title="Synthetic shop traces on a loop. Nothing is ingested here.">synthetic shop · not ingest</a>`;
  return {
    name: "rasat-demo-overlay",
    enforce: "pre",
    resolveId(id, importer) {
      if (!importer) {
        return;
      }
      if (importer.includes(searchDir) && id === "./api") {
        return resolve(demoSrc, "api.ts");
      }
      if (importer.includes(searchDir) && id === "./live") {
        return resolve(demoSrc, "live.ts");
      }
    },
    transform(code, id) {
      if (id.endsWith(chromeFile) || id.replaceAll("\\", "/").endsWith("src/chrome/Chrome.tsx")) {
        return code.replace("{build ? <VersionMark info={build} /> : null}", `{${cassette}}\n        {build ? <VersionMark info={build} /> : null}`);
      }
      if (id.endsWith(mainFile) || id.replaceAll("\\", "/").endsWith("src/main.tsx")) {
        return `import ${bannerCss};\n${code}`;
      }
    },
  };
}

export default defineConfig({
  root: webRoot,
  plugins: [demoOverlay(), react()],
  define: {
    "import.meta.env.VITE_DEMO_VERSION": JSON.stringify(process.env.VITE_DEMO_VERSION || "demo"),
  },
  resolve: {
    preserveSymlinks: true,
    alias: {
      "/src": resolve(webRoot, "src"),
    },
  },
  server: {
    port: 5175,
    strictPort: true,
    fs: {
      allow: [webRoot, here],
    },
  },
  preview: {
    port: 5175,
    strictPort: true,
  },
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
