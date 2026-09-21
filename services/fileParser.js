const path = require('path');
const { Worker } = require('worker_threads');
const { UserError, logError } = require('../utils/errors');

const MAX_ROWS = parseInt(process.env.IMPORT_MAX_ROWS, 10) || 20000;
const MAX_COLS = parseInt(process.env.IMPORT_MAX_COLS, 10) || 60;
const MAX_CELL_CHARS = parseInt(process.env.IMPORT_MAX_CELL_CHARS, 10) || 2000;
const TIMEOUT_MS = parseInt(process.env.IMPORT_PARSE_TIMEOUT_MS, 10) || 30000;

function parseInWorker(buffer, kind) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'importWorker.js'), {
      workerData: { buffer, kind, maxRows: MAX_ROWS },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let settled = false;
    const finish = (fn, val) => { if (settled) return; settled = true; clearTimeout(timer); worker.terminate(); fn(val); };
    const timer = setTimeout(() => finish(reject, new UserError('文件解析超时，请拆分后重新导入')), TIMEOUT_MS);
    worker.once('message', (msg) => {
      if (msg.error) {
        // CSV 解析错误（结构问题）对用户有帮助且不含内部信息；其余统一为通用提示
        const friendly = typeof msg.code === 'string' && msg.code.startsWith('CSV_')
          ? new UserError('解析CSV失败: ' + msg.error)
          : new UserError(kind === 'excel' ? '解析Excel失败：文件损坏或格式不受支持' : '解析CSV失败');
        logError(null, new Error(msg.error), 'import-parse');
        return finish(reject, friendly);
      }
      finish(resolve, msg.rows);
    });
    worker.once('error', (e) => { logError(null, e, 'import-worker'); finish(reject, new UserError('文件解析失败（文件过大或格式异常）')); });
    worker.once('exit', () => finish(reject, new UserError('文件解析失败')));
  });
}

/** 解析 Excel/CSV 为行对象数组，并施加行数/列数/单元格长度限制。 */
async function parseImportFile(buffer, kind) {
  const rows = await parseInWorker(buffer, kind);
  if (!Array.isArray(rows)) throw new UserError('文件内容无法识别');
  if (rows.length > MAX_ROWS) throw new UserError(`文件行数超过上限（最多 ${MAX_ROWS} 行），请拆分后导入`);
  for (let i = 0; i < rows.length; i++) {
    const keys = Object.keys(rows[i]);
    if (keys.length > MAX_COLS) throw new UserError(`第${i + 2}行列数超过上限（最多 ${MAX_COLS} 列）`);
    for (const k of keys) {
      const v = rows[i][k];
      if (typeof v === 'string' && v.length > MAX_CELL_CHARS) {
        throw new UserError(`第${i + 2}行存在过长的单元格内容（超过 ${MAX_CELL_CHARS} 字符）`);
      }
    }
  }
  return rows;
}

module.exports = { parseImportFile, MAX_ROWS };
