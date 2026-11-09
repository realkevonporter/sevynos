// SevynOS M6 — bundle a Tokrah entry with Metro and write the
// output JS. Usage:
//   TOKRAH_SRC=/path/to/tokrah EXPO_PUBLIC_API_URL=http://127.0.0.1:7070 \
//     node build-tokrah.mjs <entry.js> <out.js> [platform]
// NOTE: use @expo/metro, not stock `metro` — the Expo config's
// transform worker emits packed source maps that only the @expo/metro
// serializer understands (stock Metro throws "Unexpected module with
// full source map found" at serialize time).
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKRAH_SRC = process.env.TOKRAH_SRC;
if (!TOKRAH_SRC) {
  console.error("build-tokrah.mjs needs TOKRAH_SRC (Tokrah repo root)");
  process.exit(1);
}
const TOKRAH_ROOT = path.join(TOKRAH_SRC, "tokrah");
const requireTokrah = createRequire(path.join(TOKRAH_ROOT, "package.json"));
const Metro = requireTokrah("@expo/metro/metro/index.js");
const config = requireTokrah(path.join(__dirname, "metro.config.js"));

// The Expo CLI normally sets EXPO_ROUTER_APP_ROOT (the directory
// holding the app/ folder) before running Metro; expo-router/_ctx
// inlines it at transform time into require.context(...). Running
// Metro directly, set it here so the router discovers Tokrah's routes.
if (!process.env.EXPO_ROUTER_APP_ROOT) {
  process.env.EXPO_ROUTER_APP_ROOT = TOKRAH_ROOT;
}

const entry = process.argv[2] ? path.resolve(process.argv[2]) : "";
const out = process.argv[3] ? path.resolve(process.argv[3]) : "";
const platform = process.argv[4] || "ios";
// NOTE: platform 'ios', not a custom 'sevyn': native packages ship
// .ios/.android files with no .native fallback, so a custom platform
// fails to resolve them (react-native-screens TabsHost). The shim is
// selected by module NAME, not by file extension, so 'ios' changes
// nothing about the SevynOS surface — it only picks the iOS variant
// of platform files, which is the closest to real RN behaviour.
if (!entry || !out) {
  console.error("usage: node build-tokrah.mjs <entry.js> <out.js> [platform]");
  process.exit(1);
}
const t0 = Date.now();
await Metro.runBuild(config, {
  entry,
  out,
  platform,
  // The Expo CLI passes the router root as a custom transform option;
  // babel-preset-expo's expo-router plugin rewrites
  // process.env.EXPO_ROUTER_APP_ROOT in expo-router/_ctx to the
  // relative path of this directory, which Metro's require.context
  // then resolves into the route list. Without it the plugin falls
  // back to './app' relative to the workspace root and the context
  // comes back empty ("No routes found").
  customTransformOptions: {
    routerRoot: path.join(TOKRAH_ROOT, "app"),
  },
  // dev:false is REQUIRED, not cosmetic: with dev:true the Expo
  // transform worker emits packed source maps directly as `data.map`,
  // and Metro's source-map builder throws on them ("Unexpected module
  // with full source map found"). With dev:false the worker defers
  // the map to the serializer's reconcile step (map: []), which
  // installs it properly. Production React is also what the host
  // wants (no process global in Hermes).
  dev: false,
  minify: false,
  // NB: the option is `sourceMap`, not `sourceMaps`. It must be true:
  // the Expo custom serializer returns no map when it is false, and
  // Metro then falls back to its own source-map builder, which throws
  // on the Expo transformer's packed maps ("Unexpected module with
  // full source map found"). sourceMapUrl (not inline) is REQUIRED
  // too: with an inline map, getAppendScripts builds the map itself
  // via stock sourceMapString, which throws on packed maps. With a
  // URL it just appends the comment, and the Expo serializer (which
  // understands packed maps) produces the .map file. The .map file is
  // discarded downstream.
  sourceMap: true,
  sourceMapUrl: "bundle.js.map",
  sourceMapOut: out + ".map",
});
console.log(`bundled ${entry} -> ${out} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
