// Map generated bundle positions back to sources.
const fs = require("fs");
const path = require("path");
const TOKRAH_SRC = process.env.TOKRAH_SRC;
if (!TOKRAH_SRC) {
  throw new Error("sourcemap-query.js needs TOKRAH_SRC (Tokrah repo root)");
}
const { SourceMapConsumer } = require(
  path.join(TOKRAH_SRC, "tokrah/node_modules/source-map"),
);
const map = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const positions = process.argv.slice(3).map((p) => {
  const [line, column] = p.split(":").map(Number);
  return { line, column };
});
const c = new SourceMapConsumer(map);
for (const pos of positions) {
  const p = c.originalPositionFor(pos);
  console.log(`${pos.line}:${pos.column} -> ${p.source} ${p.line}:${p.column}`);
}
