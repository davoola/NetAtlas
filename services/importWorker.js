// 在 worker 线程中解析导入文件：即使遇到恶意/高复杂度文件（ReDoS、超大表格），
// 也不会阻塞主线程事件循环，并且主线程可在超时后强制终止本线程。
const { parentPort, workerData } = require('worker_threads');

function run() {
  const { buffer, kind, maxRows } = workerData;
  if (kind === 'excel') {
    const xlsx = require('@e965/xlsx');
    const wb = xlsx.read(buffer, {
      type: 'buffer', cellDates: true, sheets: 0, sheetRows: maxRows + 2,
      cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false,
    });
    const sheetName = wb.SheetNames[0];
    if (!sheetName || !wb.Sheets[sheetName]) return [];
    return xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
  }
  const { parse } = require('csv-parse/sync');
  return parse(Buffer.from(buffer).toString('utf-8'), {
    columns: true, skip_empty_lines: true, bom: true,
    max_record_size: 256 * 1024, to: maxRows + 1,
  });
}

try {
  parentPort.postMessage({ rows: run() });
} catch (e) {
  parentPort.postMessage({ error: String(e && e.message), code: e && e.code });
}
