// Точка входа воркера node:worker_threads с компилятором в wasm.
//
// Обвязка `@arxo/law-engine` (dist/worker.js) подписывается сама только в
// браузерном воркере (`self`) и грузит модуль через fetch, которого у Node
// для file:// нет. Здесь — тот же протокол сообщений (`serve`), но модуль
// читается с диска и инстанцируется один раз на воркер; диспетчер — три
// вида: init, call (палитра §225), engineInfo. Исполнитель дел (evaluate,
// хэндлы) расширению не нужен: дела считает `lawc eval`/`test` на векторе.
//
// Файл — ESM намеренно: обвязка поставляется ESM, а расширение — CommonJS;
// граница проходит по воркеру, и это единственное место, где они встречаются.
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
        throw new Error(`law-engine worker: неизвестный вид запроса ${String(message.kind)}`);
    }
  },
);
