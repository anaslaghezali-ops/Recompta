// Exécute normalizeExtractionResults() de extract-client.js (racine du repo)
// sur du JSON lu sur stdin. Les imports CDN (pdf.js) sont remplacés par un stub.
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (specifier.startsWith("https://")) {
          return {
            url: "data:text/javascript,export const GlobalWorkerOptions = {};",
            shortCircuit: true,
          };
        }
        return next(specifier, context);
      }
    `),
);

const { normalizeExtractionResults, setExtractionContext } = await import(
  new URL("../../extract-client.js", import.meta.url)
);
setExtractionContext({ clientIce: process.argv[2] || "" });
let input = "";
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify(normalizeExtractionResults(JSON.parse(input))));
