import { configure } from "@zip.js/zip.js/lib/zip-core.js";
import { ZIP_CODEC_WORKER_URL, ZIP_WASM_URL } from "@/generated/zip-assets";

// Use the same configuration in the page and the folder ZIP worker. Real
// same-origin assets retain compression workers under the production CSP.
if (typeof location !== "undefined") {
  configure({
    baseURI: location.href,
    workerURI: ZIP_CODEC_WORKER_URL,
    wasmURI: ZIP_WASM_URL,
  });
}

export {
  BlobReader,
  BlobWriter,
  TextWriter,
  Writer,
  ZipReader,
  ZipWriter,
} from "@zip.js/zip.js/lib/zip-core.js";
