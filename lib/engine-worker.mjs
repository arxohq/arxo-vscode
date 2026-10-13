// Entry point for the node:worker_threads worker with the compiler in wasm.
//
// The `@arxo/law-engine` wrapper (dist/worker.js) wires itself up only in a
// browser worker (`self`) and loads the module via fetch, which Node lacks
// for file://. Here it's the same message protocol (`serve`), but the module
// is read from disk and instantiated once per worker; the dispatcher has
// three kinds: init, call (palette §225), engineInfo. A case executor
// (evaluate, handles) is not needed by the extension: cases are computed by
// `lawc eval`/`test` on the vector.
//
// The file is ESM deliberately: the wrapper ships as ESM, while the
// extension is CommonJS; the boundary runs through the worker, and this is
// the only place where they meet.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

const { dist, wasm } = workerData;
const { LawEngine } = await import(pathToFileURL(`${dist}/index.js`).href);
const { serve } = await import(pathToFileURL(`${dist}/worker.js`).href);

let booting = null;
const ready = () => (booting ??= readFile(wasm).then((bytes) => LawEngine.instantiate(bytes)));

serve(
  { post: (m) => parentPort.postMessage(m), listen: (f) => parentPort.on('message', f) },
  async (message) => {
    const law = await ready();
    switch (message.kind) {
      case 'init':
        return { value: { abiVersion: law.abiVersion, hasCompiler: law.hasCompiler } };
      case 'call':
        return { bytes: law.callBytes(message.request) };
      case 'engineInfo':
        return { value: law.engineInfo() };
      default:
        throw new Error(`law-engine worker: unknown request kind ${String(message.kind)}`);
    }
  },
);
