// 集成测试：node --test tests/    （使用临时数据库和随机端口，不影响真实数据）
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const xlsx = require('@e965/xlsx');

const ROOT = path.join(__dirname, '..');
const PORT = 3900 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'netatlas-')), 'test.db');
const ADMIN_PW = 'TestAdmin#2026';
const env = { ...process.env, DB_PATH, PORT: String(PORT), SESSION_SECRET: 'x'.repeat(48), ADMIN_INITIAL_PASSWORD: ADMIN_PW, IMPORT_MAX_ROWS: '50', ACCESS_LOG: '0', NODE_ENV: 'test' };
let server;

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(method, url, { json, form, body, headers = {}, csrf = true, redirect = 'manual' } = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (csrf && this.csrf) h['x-csrf-token'] = this.csrf;
    let payload = body;
    if (json !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(json); }
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    const res = await fetch(BASE + url, { method, headers: h, body: payload, redirect });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) this.cookie = sc.map(c => c.split(';')[0]).join('; ');
    return res;
  }
  async refreshCsrf(url = '/dashboard') {
    const res = await this.req('GET', url, { headers: { accept: 'text/html' } });
    const html = await res.text();
    const m = html.match(/name="csrf-token" content="([0-9a-f]+)"/) || html.match(/name="_csrf" value="([0-9a-f]+)"/);
    this.csrf = m ? m[1] : '';
    return res;
  }
  async login(username, password) {
    await this.refreshCsrf('/login');
    const res = await this.req('POST', '/login', { form: { username, password, _csrf: this.csrf } });
    if (res.status === 302) await this.refreshCsrf('/dashboard');
    return res;
  }
  api(method, url, json) { return this.req(method, url, { json, headers: { accept: 'application/json' } }); }
}

before(async () => {
  const init = spawnSync(process.execPath, ['--experimental-sqlite', 'db/init.js'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.strictEqual(init.status, 0, init.stderr);
  server = spawn(process.execPath, ['--experimental-sqlite', 'index.js'], { cwd: ROOT, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/login'); return; } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  throw new Error('server did not start');
});
after(() => { if (server) server.kill(); });

const sa = new Client();
const adm = new Client();
const state = {};

test('CSRF: 缺少令牌的登录与写请求被拒绝', async () => {
  const c = new Client();
  await c.refreshCsrf('/login');
  let res = await c.req('POST', '/login', { form: { username: 'admin', password: ADMIN_PW }, csrf: false });
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await sa.login('admin', ADMIN_PW)).status, 302);
  res = await sa.req('POST', '/api/records', { json: { ip: '1.1.1.1' }, csrf: false, headers: { accept: 'application/json' } });
  assert.strictEqual(res.status, 403);
});

test('初始管理员无固定默认密码：admin123 无法登录', async () => {
  const c = new Client();
  const res = await c.login('admin', 'admin123');
  assert.strictEqual(res.status, 401);
});

test('准备数据：VLAN、用户、记录', async () => {
  for (const [vlan, subnet] of [['10', '10.0.10.0/24'], ['20', '10.0.20.0/24']]) {
    const r = await sa.api('POST', '/api/dict/vlan-plans', { vlan, name: 'V' + vlan, subnet, gateway: subnet.replace('.0/24', '.1') });
    assert.strictEqual(r.status, 200);
  }
  const plans = await (await sa.api('GET', '/api/dict/vlan-plans')).json();
  state.plan10 = plans.find(p => p.vlan === '10').id;
  state.plan20 = plans.find(p => p.vlan === '20').id;
  await sa.api('POST', '/api/dict/statuses', { name: '已使用' });
  let r = await sa.api('POST', '/api/users', { username: 'vlan10admin', password: 'Passw0rd!', role: 'admin', display_name: 'A' });
  assert.strictEqual(r.status, 201);
  state.adminId = (await r.json()).id;
  r = await sa.api('PUT', `/api/users/${state.adminId}/permissions`, { vlans: [`plan:${state.plan10}`] });
  assert.strictEqual(r.status, 200);
  r = await sa.api('POST', '/api/users', { username: 'viewer1', password: 'Passw0rd!', role: 'viewer' });
  assert.strictEqual(r.status, 201);
  r = await sa.api('POST', '/api/records', { ip: '10.0.10.5', vlan: `plan:${state.plan10}`, device_name: 'own-10', status: '已使用', department: '' });
  assert.strictEqual(r.status, 201);
  r = await sa.api('POST', '/api/records', { ip: '10.0.20.5', vlan: `plan:${state.plan20}`, device_name: 'other-20', status: '已使用' });
  assert.strictEqual(r.status, 201);
  // 模拟历史数据：IP 落在 VLAN10 网段但记录归属 VLAN20（只能直接写库）
  const raw = new DatabaseSync(DB_PATH);
  raw.prepare("INSERT INTO ip_records (vlan, ip, ip_sort, device_name, status) VALUES ('20','10.0.10.9',167772681,'legacy-20','已使用')").run();
  raw.close();
  assert.strictEqual((await adm.login('vlan10admin', 'Passw0rd!')).status, 302);
});

test('统计/字典/网关查询按 VLAN 权限过滤（受限管理员）', async () => {
  const stats = await (await adm.api('GET', '/api/stats')).json();
  assert.strictEqual(stats.vlanStats.length, 1);
  assert.strictEqual(stats.vlanStats[0].vlan, '10');
  assert.strictEqual(stats.kpi.total, 1);
  const plans = await (await adm.api('GET', '/api/dict/vlan-plans')).json();
  assert.deepStrictEqual(plans.map(p => p.vlan), ['10']);
  const gw = await (await adm.api('GET', '/api/gateway-lookup?ip=10.0.20.5')).json();
  assert.strictEqual(gw.vlan, null);
  const gw2 = await (await adm.api('GET', '/api/gateway-lookup?ip=10.0.10.5')).json();
  assert.strictEqual(gw2.vlan, '10');
  // 超级管理员仍能看到全部
  const sstats = await (await sa.api('GET', '/api/stats')).json();
  assert.strictEqual(sstats.kpi.total, 3);
});

test('数据导入仅超级管理员可用：普通管理员调用导入接口返回 403', async () => {
  const csv = 'VLAN,IP地址,设备名称\n10,10.0.10.5,should-fail\n';
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'a.csv');
  fd.append('strategy', 'update');
  const res = await adm.req('POST', '/api/import/csv', { body: fd, headers: { accept: 'application/json' } });
  assert.strictEqual(res.status, 403);
  const resX = await adm.req('POST', '/api/import/excel', { body: fd, headers: { accept: 'application/json' } });
  assert.strictEqual(resX.status, 403);
});

test('超级管理员导入 update 策略可更新记录', async () => {
  const csv = 'VLAN,IP地址,设备名称\n10,10.0.10.5,renamed\n';
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'a.csv');
  fd.append('strategy', 'update');
  const res = await sa.req('POST', '/api/import/csv', { body: fd, headers: { accept: 'application/json' } });
  assert.strictEqual(res.status, 200);
  const out = await res.json();
  assert.ok(out.updated >= 1);
  const raw = new DatabaseSync(DB_PATH);
  assert.strictEqual(raw.prepare("SELECT device_name n FROM ip_records WHERE ip='10.0.10.5'").get().n, 'renamed');
  raw.close();
});

test('受限管理员可编辑/删除自己 VLAN 的记录，不能操作其他 VLAN', async () => {
  const list = await (await adm.api('GET', '/api/records?perPage=50')).json();
  const own = list.rows.find(r => r.ip === '10.0.10.5');
  let r = await adm.api('PUT', `/api/records/${own.id}`, { ip: '10.0.10.5', vlan: `plan:${state.plan10}`, device_name: 'edited', status: '已使用' });
  assert.strictEqual(r.status, 200);
  const raw = new DatabaseSync(DB_PATH);
  const other = raw.prepare("SELECT id FROM ip_records WHERE ip='10.0.20.5'").get().id;
  raw.close();
  r = await adm.api('PUT', `/api/records/${other}`, { ip: '10.0.20.5', vlan: `plan:${state.plan20}`, device_name: 'x' });
  assert.strictEqual(r.status, 403);
  r = await adm.api('DELETE', `/api/records/${other}`);
  assert.strictEqual(r.status, 403);
  r = await adm.api('GET', `/api/records/${other}`);
  assert.strictEqual(r.status, 403);
});

test('导入严格模式：有被跳过的行则整体回滚', async () => {
  const csv = 'VLAN,IP地址,设备名称\n10,10.0.10.20,new1\n10,not-an-ip,bad\n';
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'b.csv');
  fd.append('strategy', 'skip');
  fd.append('atomic', '1');
  const out = await (await sa.req('POST', '/api/import/csv', { body: fd, headers: { accept: 'application/json' } })).json();
  assert.strictEqual(out.rolledBack, true);
  const raw = new DatabaseSync(DB_PATH);
  assert.strictEqual(raw.prepare("SELECT COUNT(*) c FROM ip_records WHERE ip='10.0.10.20'").get().c, 0);
  raw.close();
});

test('导入：Excel 正常解析；行数超限被拒绝；原型污染表头被忽略', async () => {
  const ws = xlsx.utils.aoa_to_sheet([['VLAN', 'IP地址', '设备名称', '__proto__'], ['10', '10.0.10.30', 'xl-1', 'x']]);
  const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, ws, 'S');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  let fd = new FormData();
  fd.append('file', new Blob([buf]), 'a.xlsx'); fd.append('strategy', 'skip');
  let out = await (await sa.req('POST', '/api/import/excel', { body: fd, headers: { accept: 'application/json' } })).json();
  assert.strictEqual(out.success, 1);
  const rows = ['VLAN,IP地址'].concat(Array.from({ length: 60 }, (_, i) => `10,10.0.10.${100 + i}`)).join('\n');
  fd = new FormData();
  fd.append('file', new Blob([rows]), 'big.csv'); fd.append('strategy', 'skip');
  const res = await adm.req('POST', '/api/import/csv', { body: fd, headers: { accept: 'application/json' } });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /行数超过上限/);
  assert.strictEqual(({}).polluted, undefined);
});

test('导出仅包含权限范围内数据，并对公式前缀转义', async () => {
  await sa.api('POST', '/api/records', { ip: '10.0.10.40', vlan: `plan:${state.plan10}`, device_name: '=1+1', status: '已使用' });
  const text = await (await adm.req('GET', '/api/export/records')).text();
  assert.ok(text.includes("'=1+1"));
  assert.ok(!text.includes('other-20'));
});

test('用户管理：不能禁用/降级自己或最后一个超管；重置不存在用户返回 404', async () => {
  const me = (await (await sa.api('GET', '/api/users')).json()).find(u => u.username === 'admin');
  let r = await sa.api('PUT', `/api/users/${me.id}`, { role: 'viewer' });
  assert.strictEqual(r.status, 400);
  r = await sa.api('PUT', `/api/users/${me.id}`, { enabled: 0 });
  assert.strictEqual(r.status, 400);
  r = await sa.api('PUT', `/api/users/${state.adminId}`, { enabled: 'yes' });
  assert.strictEqual(r.status, 400);
  r = await sa.api('POST', '/api/users/99999/reset-password', { password: 'Whatever1' });
  assert.strictEqual(r.status, 404);
});

test('禁用用户后其现有会话立即失效', async () => {
  const c = new Client();
  await c.login('viewer1', 'Passw0rd!');
  assert.strictEqual((await c.api('GET', '/api/stats')).status, 200);
  const viewer = (await (await sa.api('GET', '/api/users')).json()).find(u => u.username === 'viewer1');
  assert.strictEqual((await sa.api('PUT', `/api/users/${viewer.id}`, { enabled: 0 })).status, 200);
  assert.notStrictEqual((await c.api('GET', '/api/stats')).status, 200);
});

test('使用旧默认密码(admin123)的账号必须先改密', async () => {
  const raw = new DatabaseSync(DB_PATH);
  raw.prepare("INSERT INTO users (username, password_hash, role) VALUES ('legacy', ?, 'viewer')").run(bcrypt.hashSync('admin123', 10));
  raw.close();
  const c = new Client();
  assert.strictEqual((await c.login('legacy', 'admin123')).status, 302);
  let r = await c.api('GET', '/api/stats');
  assert.strictEqual(r.status, 403);
  assert.strictEqual((await r.json()).code, 'PASSWORD_CHANGE_REQUIRED');
  r = await c.api('POST', '/api/change-password', { oldPassword: 'admin123', newPassword: 'admin123' });
  assert.strictEqual(r.status, 400);
  r = await c.api('POST', '/api/change-password', { oldPassword: 'admin123', newPassword: 'N3w-Passw0rd' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await c.api('GET', '/api/stats')).status, 200);
});

test('系统设置仅允许白名单键；字段长度受限', async () => {
  assert.strictEqual((await sa.api('GET', '/api/settings/site_name')).status, 200);
  assert.strictEqual((await sa.api('GET', '/api/settings/session_secret')).status, 404);
  const r = await sa.api('POST', '/api/records', { ip: '10.0.10.50', vlan: `plan:${state.plan10}`, remark: 'x'.repeat(5000) });
  assert.strictEqual(r.status, 400);
});

test('登录限速：连续失败后返回 429', async () => {
  const c = new Client();
  await c.refreshCsrf('/login');
  let last;
  for (let i = 0; i < 7; i++) {
    last = await c.req('POST', '/login', { form: { username: 'ratelimit-user', password: 'bad' + i, _csrf: c.csrf } });
  }
  assert.strictEqual(last.status, 429);
});

// ---------- 以下为增量回归测试 ----------

test('密码策略：所有入口统一最短 8 位', async () => {
  let r = await sa.api('POST', '/api/users', { username: 'short7', password: 'Pass12!', role: 'viewer' });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /至少8位/);
  r = await sa.api('POST', '/api/users', { username: 'weakdef', password: 'admin123', role: 'viewer' });
  assert.strictEqual(r.status, 400);
  r = await sa.api('POST', '/api/users', { username: 'long129', password: 'a'.repeat(129), role: 'viewer' });
  assert.strictEqual(r.status, 400);
  r = await sa.api('POST', '/api/users', { username: 'ok8chars', password: 'Passw0rd', role: 'viewer' });
  assert.strictEqual(r.status, 201);
  const id = (await r.json()).id;
  r = await sa.api('POST', `/api/users/${id}/reset-password`, { password: 'Pass12!' });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /至少8位/);
  r = await sa.api('POST', `/api/users/${id}/reset-password`, { password: 'Passw0rd2' });
  assert.strictEqual(r.status, 200);
  r = await adm.api('POST', '/api/change-password', { oldPassword: 'Passw0rd!', newPassword: 'Abc1234' });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /至少8位/);
});

test('init-db：ADMIN_INITIAL_PASSWORD 少于 8 位时失败并明确报错', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'netatlas-init-')), 'x.db');
  const res = spawnSync(process.execPath, ['--experimental-sqlite', 'db/init.js'], { cwd: ROOT, env: { ...env, DB_PATH: tmp, ADMIN_INITIAL_PASSWORD: 'short7!' }, encoding: 'utf8' });
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /ADMIN_INITIAL_PASSWORD/);
  const raw = new DatabaseSync(tmp);
  assert.strictEqual(raw.prepare('SELECT COUNT(*) c FROM users').get().c, 0);
  raw.close();
});

test('CSRF：已登录用户的所有写接口不带令牌均返回 403，且未产生副作用', async () => {
  const list = await (await adm.api('GET', '/api/records?perPage=50')).json();
  const own = list.rows.find(r => r.ip === '10.0.10.5');
  const j = { accept: 'application/json' };
  const cases = [
    [adm, 'PUT', `/api/records/${own.id}`, { json: { ip: '10.0.10.5', vlan: `plan:${state.plan10}`, device_name: 'csrf-hack' } }],
    [adm, 'DELETE', `/api/records/${own.id}`, {}],
    [adm, 'POST', '/api/records', { json: { ip: '10.0.10.77', vlan: `plan:${state.plan10}` } }],
    [adm, 'POST', '/api/change-password', { json: { oldPassword: 'Passw0rd!', newPassword: 'Hacked-Pass1' } }],
    [sa, 'PUT', `/api/users/${state.adminId}/permissions`, { json: { vlans: [] } }],
    [sa, 'POST', `/api/users/${state.adminId}/reset-password`, { json: { password: 'Hacked-Pass1' } }],
    [sa, 'PUT', `/api/users/${state.adminId}`, { json: { role: 'viewer' } }],
    [sa, 'PUT', '/api/settings/site_name', { json: { value: 'hacked' } }],
    [sa, 'POST', '/api/dict/statuses', { json: { name: 'csrf-status' } }],
    [sa, 'POST', '/api/audit-logs/cleanup', { json: { beforeDate: '2099-01-01' } }],
  ];
  for (const [client, method, url, opts] of cases) {
    const res = await client.req(method, url, { ...opts, csrf: false, headers: j });
    assert.strictEqual(res.status, 403, `${method} ${url} 应为 403，实际 ${res.status}`);
  }
  for (const kind of ['csv', 'excel']) {
    const fd = new FormData();
    fd.append('file', new Blob(['VLAN,IP地址\n10,10.0.10.88\n']), 'x.csv'); fd.append('strategy', 'skip');
    const res = await adm.req('POST', `/api/import/${kind}`, { body: fd, csrf: false, headers: j });
    assert.strictEqual(res.status, 403, `import ${kind} 应为 403`);
  }
  // 副作用检查：记录、权限、密码均未被改变
  const raw = new DatabaseSync(DB_PATH);
  assert.strictEqual(raw.prepare("SELECT COUNT(*) c FROM ip_records WHERE ip IN ('10.0.10.77','10.0.10.88')").get().c, 0);
  assert.notStrictEqual(raw.prepare('SELECT device_name n FROM ip_records WHERE id=?').get(own.id).n, 'csrf-hack');
  assert.strictEqual(raw.prepare('SELECT COUNT(*) c FROM admin_vlan_permissions WHERE user_id=?').get(state.adminId).c, 1);
  assert.strictEqual(raw.prepare("SELECT COUNT(*) c FROM dict_statuses WHERE name='csrf-status'").get().c, 0);
  raw.close();
  assert.strictEqual((await adm.api('GET', '/api/stats')).status, 200);
});

test('登出：仅支持 POST 且需 CSRF；GET /logout 不可用', async () => {
  const c = new Client();
  await c.login('vlan10admin', 'Passw0rd!');
  let res = await c.req('GET', '/logout', { headers: { accept: 'text/html' } });
  assert.strictEqual(res.status, 404);
  assert.strictEqual((await c.api('GET', '/api/stats')).status, 200);        // GET 不会登出
  res = await c.req('POST', '/logout', { form: {}, csrf: false });           // 无令牌的 POST 被拒绝，会话保持
  assert.strictEqual(res.status, 302);
  assert.strictEqual((await c.api('GET', '/api/stats')).status, 200);
  res = await c.req('POST', '/logout', { form: { _csrf: c.csrf }, csrf: false });
  assert.strictEqual(res.status, 302);
  assert.notStrictEqual((await c.api('GET', '/api/stats')).status, 200);     // 带令牌才真正登出
});

test('生产环境缺少或过短的 SESSION_SECRET 时拒绝启动', () => {
  const prodEnv = { ...env, NODE_ENV: 'production', PORT: String(PORT + 1000) };
  for (const secret of [undefined, 'too-short-secret', 'x'.repeat(31)]) {
    const e = { ...prodEnv };
    if (secret === undefined) delete e.SESSION_SECRET; else e.SESSION_SECRET = secret;
    const res = spawnSync(process.execPath, ['--experimental-sqlite', 'index.js'], { cwd: ROOT, env: e, encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(res.status, 1, `secret=${secret} 应以退出码 1 拒绝启动`);
    assert.match(res.stderr, /SESSION_SECRET/);
  }
});

test('导入审计日志包含批次ID、操作者、文件名与 SHA-256', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['VLAN,IP地址\n10,10.0.10.61\n']), 'audit-check.csv'); fd.append('strategy', 'skip');
  const out = await (await sa.req('POST', '/api/import/csv', { body: fd, headers: { accept: 'application/json' } })).json();
  assert.ok(out.batchId);
  const logs = await (await sa.api('GET', '/api/audit-logs?perPage=5&search=' + out.batchId)).json();
  const d = logs.rows[0].detail;
  assert.match(d, new RegExp(out.batchId));
  assert.match(d, /admin/);
  assert.match(d, /audit-check\.csv/);
  assert.match(d, /SHA-256 [0-9a-f]{64}/);
});

test('网段导出 /api/export/subnet 仍可用，且按权限范围限制', async () => {
  let res = await adm.req('GET', '/api/export/subnet/10.0.10');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  res = await adm.req('GET', '/api/export/subnet/10.0.20', { headers: { accept: 'application/json' } });
  assert.strictEqual(res.status, 403);
  res = await sa.req('GET', '/api/export/subnet/10.0.20');
  assert.strictEqual(res.status, 200);
  assert.ok((await res.text()).includes('other-20'));
});

// ---------- 依赖大版本升级（Express 5 / EJS 6 / multer 2 / bcryptjs 3）兼容性 ----------

test('兼容性：各角色可打开全部页面（EJS 6 + layout + include），静态资源与 404 正常', async () => {
  const pages = ['/dashboard', '/records', '/subnets', '/dictionary', '/users', '/import', '/audit-log'];
  for (const p of pages) {
    const res = await sa.req('GET', p, { headers: { accept: 'text/html' } });
    assert.strictEqual(res.status, 200, p);
    const html = await res.text();
    assert.ok(html.includes('csrf-token') && html.includes('</html>'), `${p} 渲染不完整`);
    assert.ok(!/<%|%>/.test(html), `${p} 含未解析的模板标记`);
  }
  for (const p of ['/dashboard', '/records', '/subnets', '/dictionary']) {
    assert.strictEqual((await adm.req('GET', p, { headers: { accept: 'text/html' } })).status, 200, `admin ${p}`);
  }
  assert.notStrictEqual((await adm.req('GET', '/import', { headers: { accept: 'text/html' } })).status, 200, 'admin 不应访问导入页');
  assert.strictEqual((await adm.req('GET', '/users', { headers: { accept: 'text/html' } })).status === 200, false); // 管理员不能访问用户管理
  assert.strictEqual((await sa.req('GET', '/js/app.js')).status, 200);
  assert.strictEqual((await sa.req('GET', '/css/style.css')).status, 200);
  const nf = await sa.req('GET', '/no-such-page', { headers: { accept: 'text/html' } });
  assert.strictEqual(nf.status, 404);
  assert.ok((await nf.text()).includes('页面不存在'));
});

test('兼容性：无请求体的写请求不会因 req.body 为 undefined 而 500；畸形 URL 编码返回 4xx', async () => {
  // Express 5 中未解析请求体时 req.body 为 undefined
  const noBody = [
    ['POST', '/api/dict/statuses'], ['POST', '/api/users'], ['PUT', '/api/settings/site_name'],
    ['POST', '/api/change-password'], ['POST', '/api/audit-logs/cleanup'],
    ['POST', `/api/users/${state.adminId}/reset-password`], ['PUT', `/api/users/${state.adminId}/permissions`],
    ['POST', '/api/dict/vlan-plans'], ['POST', '/api/dict/prefix-gateways'], ['POST', '/api/records'],
  ];
  for (const [m, u] of noBody) {
    const res = await sa.req(m, u, { headers: { accept: 'application/json' } });
    assert.ok(res.status >= 400 && res.status < 500, `${m} ${u} 期望 4xx，实际 ${res.status}`);
  }
  // 空请求体的用户更新是合法的空操作（所有字段可选），只要不是 5xx
  const noop = await sa.req('PUT', `/api/users/${state.adminId}`, { headers: { accept: 'application/json' } });
  assert.ok(noop.status < 500);
  const bad = await sa.req('GET', '/api/subnet/%E0%A4%A', { headers: { accept: 'application/json' } });
  assert.ok(bad.status >= 400 && bad.status < 500, `畸形编码实际 ${bad.status}`);
});

test('兼容性：大网段（含 / 的 CIDR）明细与导出、检查点、字典增删改', async () => {
  let r = await sa.api('POST', '/api/dict/vlan-plans', { vlan: '30', name: 'Big', subnet: '10.30.0.0/22', gateway: '10.30.0.1' });
  assert.strictEqual(r.status, 200);
  const tok = encodeURIComponent('plan:10.30.0.0/22');
  r = await sa.api('GET', `/api/subnet/${tok}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).plan.vlan, '30');
  assert.strictEqual((await sa.req('GET', `/api/export/subnet/${tok}`)).status, 200);
  assert.strictEqual((await sa.api('POST', '/api/system/checkpoint')).status, 200);
  r = await sa.api('POST', '/api/dict/departments', { name: '测试部' });
  assert.strictEqual(r.status, 200);
  const dep = (await r.json()).find(d => d.name === '测试部');
  assert.strictEqual((await sa.api('PUT', `/api/dict/departments/${dep.id}`, { name: '测试部2' })).status, 200);
  assert.strictEqual((await sa.api('DELETE', `/api/dict/departments/${dep.id}`)).status, 200);
  const dup = await sa.api('POST', '/api/dict/statuses', { name: '已使用' });
  assert.strictEqual(dup.status, 400);
});

test('兼容性：bcryptjs 3 可校验旧版(bcryptjs 2.4.3)生成的哈希', async () => {
  // 该哈希由 bcryptjs@2.4.3 生成，密码 "Legacy-Pass-1"
  const legacyHash = '$2a$10$wiCRkK9.SY/Ed8JRifD2Oun1kcwEix/zbi/rlLDqdP7h9puRKfJMi';
  const raw = new DatabaseSync(DB_PATH);
  raw.prepare("INSERT INTO users (username, password_hash, role) VALUES ('legacyhash', ?, 'viewer')").run(legacyHash);
  raw.close();
  const c = new Client();
  assert.strictEqual((await c.login('legacyhash', 'Legacy-Pass-1')).status, 302);
  assert.strictEqual((await c.api('GET', '/api/stats')).status, 200);
  assert.strictEqual((await new Client().login('legacyhash', 'wrong-password')).status, 401);
});
