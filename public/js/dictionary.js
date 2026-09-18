// --- Dictionary management ---
const canManageDict = document.querySelector('meta[name="user-role"]')?.content === 'superadmin';

async function loadDictDeviceTypes() {
  const items = await api('/api/dict/device-types');
  document.getElementById('dictDeviceTypes').innerHTML = items.map(d => `
    <tr><td>${d.id}</td><td>${escapeHtml(d.name)}</td><td>${escapeHtml(d.description||'-')}</td><td>${d.sort_order}</td>
    ${canManageDict ? `<td class="action-cell"><button class="btn btn-sm btn-secondary" data-action="edit" data-type="device-types" data-id="${d.id}">编辑</button>
    <button class="btn btn-sm btn-danger" data-action="delete" data-type="device-types" data-id="${d.id}">删除</button></td>` : '<td>-</td>'}</tr>`).join('');
  bindDictActions('dictDeviceTypes');
}

async function loadDictStatuses() {
  const items = await api('/api/dict/statuses');
  document.getElementById('dictStatuses').innerHTML = items.map(d => `
    <tr><td>${d.id}</td><td>${escapeHtml(d.name)}</td><td>${escapeHtml(d.description||'-')}</td><td>${d.sort_order}</td>
    ${canManageDict ? `<td class="action-cell"><button class="btn btn-sm btn-secondary" data-action="edit" data-type="statuses" data-id="${d.id}">编辑</button>
    <button class="btn btn-sm btn-danger" data-action="delete" data-type="statuses" data-id="${d.id}">删除</button></td>` : '<td>-</td>'}</tr>`).join('');
  bindDictActions('dictStatuses');
}

async function loadDictDepartments() {
  const items = await api('/api/dict/departments');
  document.getElementById('dictDepartments').innerHTML = items.map(d => `
    <tr><td>${d.id}</td><td>${escapeHtml(d.name)}</td><td>${d.sort_order}</td>
    ${canManageDict ? `<td class="action-cell"><button class="btn btn-sm btn-secondary" data-action="edit" data-type="departments" data-id="${d.id}">编辑</button>
    <button class="btn btn-sm btn-danger" data-action="delete" data-type="departments" data-id="${d.id}">删除</button></td>` : '<td>-</td>'}</tr>`).join('');
  bindDictActions('dictDepartments');
}

async function loadDictVlanPlans() {
  const items = await api('/api/dict/vlan-plans');
  document.getElementById('dictVlanPlans').innerHTML = items.map(d => `
    <tr><td>${escapeHtml(d.vlan)}</td><td>${escapeHtml(d.name||'-')}</td><td>${escapeHtml(d.subnet||'-')}</td>
    <td>${escapeHtml(d.mask||'-')}</td><td>${escapeHtml(d.gateway||'-')}</td><td>${escapeHtml(d.description||'-')}</td>
    <td>${escapeHtml(d.address_pool_note||'-')}</td><td>${d.sort_order}</td>
    ${canManageDict ? `<td><button class="btn btn-sm btn-secondary" data-action="edit" data-type="vlan-plans" data-id="${d.id}">编辑</button>
    <button class="btn btn-sm btn-danger" data-action="delete" data-type="vlan-plans" data-id="${d.id}">删除</button></td>` : '<td>-</td>'}</tr>`).join('');
  bindDictActions('dictVlanPlans');
}

async function loadDictPrefixGateways() {
  const items = await api('/api/dict/prefix-gateways');
  document.getElementById('dictPrefixGateways').innerHTML = items.map(d => `
    <tr><td>${escapeHtml(d.prefix)}</td><td>${escapeHtml(d.gateway)}</td><td>${escapeHtml(d.default_vlan||'-')}</td>
    ${canManageDict ? `<td><button class="btn btn-sm btn-secondary" data-action="edit" data-type="prefix-gateways" data-id="${d.id}">编辑</button>
    <button class="btn btn-sm btn-danger" data-action="delete" data-type="prefix-gateways" data-id="${d.id}">删除</button></td>` : '<td>-</td>'}</tr>`).join('');
  bindDictActions('dictPrefixGateways');
}

function bindDictActions(tbodyId) {
  document.querySelectorAll(`#${tbodyId} button[data-action]`).forEach(btn => {
    btn.addEventListener('click', function() {
      const action = this.dataset.action;
      const type = this.dataset.type;
      const id = parseInt(this.dataset.id);
      if (action === 'edit') {
        if (type === 'device-types') editDeviceType(id);
        else if (type === 'statuses') editStatus(id);
        else if (type === 'departments') editDept(id);
        else if (type === 'vlan-plans') editVlanPlan(id);
        else if (type === 'prefix-gateways') editPrefixGw(id);
      } else if (action === 'delete') {
        delDict(type, id);
      }
    });
  });
}

window.addDictItem = async function(type, inputId) {
  const name = document.getElementById(inputId).value.trim();
  if (!name) return showToast('请输入名称', 'error');
  try {
    await api(`/api/dict/${type}`, { method: 'POST', body: JSON.stringify({ name }) });
    showToast('添加成功', 'success');
    document.getElementById(inputId).value = '';
    reloadDict(type);
  } catch (e) { showToast('添加失败: ' + e.message, 'error'); }
};

window.delDict = async function(type, id) {
  if (!confirm('确定删除？')) return;
  try {
    await api(`/api/dict/${type}/${id}`, { method: 'DELETE' });
    showToast('删除成功', 'success');
    reloadDict(type);
  } catch (e) { showToast('删除失败: ' + e.message, 'error'); }
};

function reloadDict(type) {
  if (type === 'device-types') loadDictDeviceTypes();
  else if (type === 'statuses') loadDictStatuses();
  else if (type === 'departments') loadDictDepartments();
  else if (type === 'vlan-plans') loadDictVlanPlans();
  else if (type === 'prefix-gateways') loadDictPrefixGateways();
}

// VLAN plan modal
async function editVlanPlan(id) {
  const plans = await api('/api/dict/vlan-plans');
  const p = plans.find(x => x.id === id);
  if (!p) return;
  document.getElementById('vlanModalTitle').textContent = '编辑VLAN规划';
  document.getElementById('vlanPlanId').value = p.id;
  document.getElementById('vp_vlan').value = p.vlan || '';
  document.getElementById('vp_name').value = p.name || '';
  document.getElementById('vp_subnet').value = p.subnet || '';
  document.getElementById('vp_mask').value = p.mask || '';
  document.getElementById('vp_gateway').value = p.gateway || '';
  document.getElementById('vp_description').value = p.description || '';
  document.getElementById('vp_address_pool_note').value = p.address_pool_note || '';
  document.getElementById('vp_sort_order').value = p.sort_order || 0;
  document.getElementById('vlanModal').classList.add('show');
};

function closeVlanModal() { document.getElementById('vlanModal').classList.remove('show'); }

async function saveVlanPlan() {
  const btn = document.getElementById('btnSaveVlan');
  if (btn) { btn.disabled = true; }
  const id = document.getElementById('vlanPlanId').value;
  const data = {
    vlan: document.getElementById('vp_vlan').value.trim(),
    name: document.getElementById('vp_name').value.trim(),
    subnet: document.getElementById('vp_subnet').value.trim(),
    mask: document.getElementById('vp_mask').value.trim(),
    gateway: document.getElementById('vp_gateway').value.trim(),
    description: document.getElementById('vp_description').value.trim(),
    address_pool_note: document.getElementById('vp_address_pool_note').value.trim(),
    sort_order: parseInt(document.getElementById('vp_sort_order').value) || 0,
  };
  if (!data.vlan) { if (btn) btn.disabled = false; return showToast('VLAN编号不能为空', 'error'); }
  if (!data.subnet) { if (btn) btn.disabled = false; return showToast('网段不能为空', 'error'); }
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(data.subnet)) { if (btn) btn.disabled = false; return showToast('网段格式不正确，应为如 192.168.10.0/24', 'error'); }
  if (data.gateway && !/^\d{1,3}(\.\d{1,3}){3}$/.test(data.gateway)) { if (btn) btn.disabled = false; return showToast('网关IP格式不正确', 'error'); }
  try {
    if (id) {
      await api(`/api/dict/vlan-plans/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    } else {
      await api('/api/dict/vlan-plans', { method: 'POST', body: JSON.stringify(data) });
    }
    showToast('保存成功', 'success');
    closeVlanModal();
    loadDictVlanPlans();
  } catch (e) { showToast('保存失败: ' + e.message, 'error'); }
  finally { if (btn) btn.disabled = false; }
}

// Prefix gateway modal
async function editPrefixGw(id) {
  const items = await api('/api/dict/prefix-gateways');
  const p = items.find(x => x.id === id);
  if (!p) return;
  document.getElementById('prefixModalTitle').textContent = '编辑网关映射';
  document.getElementById('prefixGwId').value = p.id;
  document.getElementById('pg_prefix').value = p.prefix || '';
  document.getElementById('pg_gateway').value = p.gateway || '';
  document.getElementById('pg_default_vlan').value = p.default_vlan || '';
  document.getElementById('prefixModal').classList.add('show');
};

function closePrefixModal() { document.getElementById('prefixModal').classList.remove('show'); }

async function savePrefixGw() {
  const id = document.getElementById('prefixGwId').value;
  const data = {
    prefix: document.getElementById('pg_prefix').value.trim(),
    gateway: document.getElementById('pg_gateway').value.trim(),
    default_vlan: document.getElementById('pg_default_vlan').value.trim(),
  };
  if (!data.prefix) return showToast('IP前缀不能为空', 'error');
  if (!data.gateway) return showToast('网关不能为空', 'error');
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(data.prefix)) return showToast('前缀格式不正确，应为如 192.168.10', 'error');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(data.gateway)) return showToast('网关IP格式不正确', 'error');
  try {
    if (id) {
      await api(`/api/dict/prefix-gateways/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    } else {
      await api('/api/dict/prefix-gateways', { method: 'POST', body: JSON.stringify(data) });
    }
    showToast('保存成功', 'success');
    closePrefixModal();
    loadDictPrefixGateways();
  } catch (e) { showToast('保存失败: ' + e.message, 'error'); }
}

// Tab switching
document.addEventListener('DOMContentLoaded', () => {
  loadDictDeviceTypes();
  loadDictStatuses();
  loadDictDepartments();
  loadDictVlanPlans();
  loadDictPrefixGateways();

  // Load site name
  api('/api/settings/site_name').then(d => { document.getElementById('settingSiteName').value = d.value || ''; });

  // Hide add buttons for non-superadmin
  if (!canManageDict) {
    document.querySelectorAll('.dict-add-row, #btnAddVlan, #btnAddPrefix, #btnSaveSiteName').forEach(el => el.style.display = 'none');
    document.getElementById('settingSiteName').readOnly = true;
  }

  document.querySelectorAll('.dict-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.dict-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.dict-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    });
  });

  if (canManageDict) {
    document.getElementById('btnAddVlan').addEventListener('click', () => {
      document.getElementById('vlanModalTitle').textContent = '新增VLAN规划';
      document.getElementById('vlanForm').reset();
      document.getElementById('vlanPlanId').value = '';
      document.getElementById('vlanModal').classList.add('show');
    });
    document.getElementById('btnSaveVlan').addEventListener('click', saveVlanPlan);

    document.getElementById('btnAddPrefix').addEventListener('click', () => {
      document.getElementById('prefixModalTitle').textContent = '新增网关映射';
      document.getElementById('prefixForm').reset();
      document.getElementById('prefixGwId').value = '';
      document.getElementById('prefixModal').classList.add('show');
    });
    document.getElementById('btnSavePrefix').addEventListener('click', savePrefixGw);

    document.getElementById('btnSaveDeviceType').addEventListener('click', saveDeviceType);
    document.getElementById('btnSaveStatus').addEventListener('click', saveStatus);
    document.getElementById('btnSaveDept').addEventListener('click', saveDept);

    document.getElementById('btnSaveSiteName').addEventListener('click', async () => {
      const val = document.getElementById('settingSiteName').value.trim();
      if (!val) return showToast('请输入网站名称', 'error');
      try {
        await api('/api/settings/site_name', { method: 'PUT', body: JSON.stringify({ value: val }) });
        showToast('保存成功，刷新页面生效', 'success');
      } catch (e) { showToast('保存失败: ' + e.message, 'error'); }
    });
  }

  // Add buttons use data-action
  document.querySelectorAll('[data-action="add-dict"]').forEach(btn => {
    btn.addEventListener('click', function() {
      addDictItem(this.dataset.type, this.dataset.input);
    });
  });

  // Modal close buttons
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', function() {
      document.getElementById(this.dataset.close).classList.remove('show');
    });
  });
});

// --- Device Type edit ---
async function editDeviceType(id) {
  const items = await api('/api/dict/device-types');
  const d = items.find(x => x.id === id);
  if (!d) return;
  document.getElementById('deviceTypeModalTitle').textContent = '编辑设备类型';
  document.getElementById('dt_id').value = d.id;
  document.getElementById('dt_name').value = d.name || '';
  document.getElementById('dt_description').value = d.description || '';
  document.getElementById('dt_sort_order').value = d.sort_order || 0;
  document.getElementById('deviceTypeModal').classList.add('show');
};
function closeDeviceTypeModal() { document.getElementById('deviceTypeModal').classList.remove('show'); }
async function saveDeviceType() {
  const id = document.getElementById('dt_id').value;
  const data = {
    name: document.getElementById('dt_name').value.trim(),
    description: document.getElementById('dt_description').value.trim(),
    sort_order: parseInt(document.getElementById('dt_sort_order').value) || 0,
  };
  if (!data.name) return showToast('请输入名称', 'error');
  try {
    await api(`/api/dict/device-types/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    showToast('保存成功', 'success');
    closeDeviceTypeModal();
    loadDictDeviceTypes();
  } catch (e) { showToast('保存失败: ' + e.message, 'error'); }
}

// --- Status edit ---
async function editStatus(id) {
  const items = await api('/api/dict/statuses');
  const d = items.find(x => x.id === id);
  if (!d) return;
  document.getElementById('statusModalTitle').textContent = '编辑使用状态';
  document.getElementById('st_id').value = d.id;
  document.getElementById('st_name').value = d.name || '';
  document.getElementById('st_description').value = d.description || '';
  document.getElementById('st_sort_order').value = d.sort_order || 0;
  document.getElementById('statusModal').classList.add('show');
};
function closeStatusModal() { document.getElementById('statusModal').classList.remove('show'); }
async function saveStatus() {
  const id = document.getElementById('st_id').value;
  const data = {
    name: document.getElementById('st_name').value.trim(),
    description: document.getElementById('st_description').value.trim(),
    sort_order: parseInt(document.getElementById('st_sort_order').value) || 0,
  };
  if (!data.name) return showToast('请输入名称', 'error');
  try {
    await api(`/api/dict/statuses/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    showToast('保存成功', 'success');
    closeStatusModal();
    loadDictStatuses();
  } catch (e) { showToast('保存失败: ' + e.message, 'error'); }
}

// --- Department edit ---
async function editDept(id) {
  const items = await api('/api/dict/departments');
  const d = items.find(x => x.id === id);
  if (!d) return;
  document.getElementById('deptModalTitle').textContent = '编辑所属部门';
  document.getElementById('dp_id').value = d.id;
  document.getElementById('dp_name').value = d.name || '';
  document.getElementById('dp_sort_order').value = d.sort_order || 0;
  document.getElementById('deptModal').classList.add('show');
};
function closeDeptModal() { document.getElementById('deptModal').classList.remove('show'); }
async function saveDept() {
  const id = document.getElementById('dp_id').value;
  const data = {
    name: document.getElementById('dp_name').value.trim(),
    sort_order: parseInt(document.getElementById('dp_sort_order').value) || 0,
  };
  if (!data.name) return showToast('请输入名称', 'error');
  try {
    await api(`/api/dict/departments/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    showToast('保存成功', 'success');
    closeDeptModal();
    loadDictDepartments();
  } catch (e) { showToast('保存失败: ' + e.message, 'error'); }
}
