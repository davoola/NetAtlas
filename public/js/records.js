let currentPage = 1;
let currentSort = 'updated_at';
let currentOrder = 'desc';

function formatMacInput(raw) {
  if (!raw) return '';
  const hex = String(raw).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!hex) return '';
  if (hex.length !== 12) return hex;
  return hex.slice(0, 4) + '-' + hex.slice(4, 8) + '-' + hex.slice(8, 12);
}

let dictionaries = { deviceTypes: [], statuses: [], departments: [], vlanPlans: [] };
let canEdit = false;

async function loadDictionaries() {
  try {
    const [dt, st, dep, vp] = await Promise.all([
      api('/api/dict/device-types'),
      api('/api/dict/statuses'),
      api('/api/dict/departments'),
      api('/api/dict/vlan-plans'),
    ]);
    dictionaries = { deviceTypes: dt, statuses: st, departments: dep, vlanPlans: vp };

    const vlanFilter = document.getElementById('filterVlan');
    vp.forEach(p => vlanFilter.add(new Option(`${p.vlan} - ${p.name || '未命名'} (${p.subnet || '未设置网段'})`, `plan:${p.id}`)));

    const deptFilter = document.getElementById('filterDept');
    dep.forEach(d => deptFilter.add(new Option(d.name, d.name)));

    const statusFilter = document.getElementById('filterStatus');
    st.forEach(s => statusFilter.add(new Option(s.name, s.name)));

    const dtFilter = document.getElementById('filterDeviceType');
    dt.forEach(d => dtFilter.add(new Option(d.name, d.name)));

    populateFormSelects();
  } catch (e) {
    showToast('加载字典失败: ' + e.message, 'error');
  }
}

function populateFormSelects() {
  const fVlan = document.getElementById('f_vlan');
  fVlan.innerHTML = '<option value="">请选择VLAN</option>';
  dictionaries.vlanPlans.forEach(p => {
    fVlan.add(new Option(`${p.vlan} - ${p.name || '未命名'} (${p.subnet || '未设置网段'})`, `plan:${p.id}`));
  });

  const fDt = document.getElementById('f_device_type');
  fDt.innerHTML = '<option value="">请选择</option>';
  dictionaries.deviceTypes.forEach(d => fDt.add(new Option(d.name, d.name)));

  const fDep = document.getElementById('f_department');
  fDep.innerHTML = '<option value="">请选择</option>';
  dictionaries.departments.forEach(d => fDep.add(new Option(d.name, d.name)));

  const fSt = document.getElementById('f_status');
  fSt.innerHTML = '<option value="">请选择</option>';
  dictionaries.statuses.forEach(s => fSt.add(new Option(s.name, s.name)));
}

function getVlanSubnet(vlanToken) {
  if (!vlanToken) return null;
  const m = String(vlanToken).match(/^plan:(\d+)$/);
  if (m) {
    const plan = dictionaries.vlanPlans.find(p => p.id === Number(m[1]));
    if (plan && plan.subnet) return plan.subnet;
  }
  return null;
}

function ipToIntJS(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function ipInCidrJS(ip, cidr) {
  const intIp = ipToIntJS(ip);
  if (intIp === null) return false;
  const m = String(cidr).match(/^(.+?)\/(\d+)$/);
  if (!m) return false;
  const base = ipToIntJS(m[1]);
  const prefix = parseInt(m[2], 10);
  if (base === null || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return (intIp & mask) >>> 0 === (base & mask) >>> 0;
}

async function loadRecords() {
  try {
    const params = new URLSearchParams({
      page: currentPage,
      perPage: 20,
      search: document.getElementById('searchInput').value,
      vlan: document.getElementById('filterVlan').value,
      department: document.getElementById('filterDept').value,
      status: document.getElementById('filterStatus').value,
      deviceType: document.getElementById('filterDeviceType').value,
      sort: currentSort,
      order: currentOrder,
      onlyDuplicate: document.getElementById('filterDupOnly') && document.getElementById('filterDupOnly').checked ? '1' : '',
      onlyMacConflict: document.getElementById('filterMacConflictOnly') && document.getElementById('filterMacConflictOnly').checked ? '1' : '',
    });
    const data = await api('/api/records?' + params);
    renderRecords(data);
  } catch (e) {
    showToast('加载记录失败: ' + e.message, 'error');
  }
}

function updateSortIndicators() {
  document.querySelectorAll('#recordsTable th[data-sort]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === currentSort) {
      th.classList.add(currentOrder === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

function formatDisplayDate(value) {
  if (!value) return '-';
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return `${match[1]}/${Number(match[2])}/${Number(match[3])}`;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return `${parsed.getFullYear()}/${parsed.getMonth() + 1}/${parsed.getDate()}`;
  return text;
}

function renderRecords(data) {
  updateSortIndicators();
  const tbody = document.getElementById('recordsBody');
  if (data.rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--neutral-400);padding:40px">暂无数据</td></tr>';
  } else {
    tbody.innerHTML = data.rows.map(r => `
      <tr class="${r.is_duplicate ? 'row-duplicate' : ''} ${r.is_mac_conflict ? 'row-mac-conflict' : ''}">
        <td>${escapeHtml(r.ip || '-')} ${r.is_duplicate ? '<span class="dup-badge">重复</span>' : ''} ${r.is_mac_conflict ? '<span class="mac-conflict-badge">MAC冲突</span>' : ''}</td>
        <td>${escapeHtml(r.mac || '-')}</td>
        <td>${escapeHtml(r.device_name || '-')}</td>
        <td>${escapeHtml(r.department || '-')}</td>
        <td>${escapeHtml(r.user_name || '-')}</td>
        <td><span class="status-badge ${statusClass(r.status)}">${escapeHtml(r.status || '-')}</span></td>
        <td class="action-cell">
          <button class="icon-btn" title="查看" data-action="view" data-id="${r.id}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          ${canEdit ? `<button class="icon-btn" title="编辑" data-action="edit" data-id="${r.id}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>` : ''}
          ${canEdit ? `<button class="icon-btn icon-btn-danger" title="删除" data-action="delete" data-id="${r.id}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>` : ''}
        </td>
      </tr>
    `).join('');
    // Bind action buttons via event delegation
    tbody.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', function() {
        const action = this.dataset.action;
        const id = parseInt(this.dataset.id);
        if (action === 'view') viewRecord(id);
        else if (action === 'edit') editRecord(id);
        else if (action === 'delete') deleteRecord(id);
      });
    });
  }

  const pagDiv = document.getElementById('pagination');
  if (data.totalPages <= 1) {
    pagDiv.innerHTML = `<span class="page-info">共 ${data.total} 条</span>`;
  } else {
    let html = `<button ${currentPage <= 1 ? 'disabled' : ''} data-page="${currentPage - 1}">上一页</button>`;
    for (let i = 1; i <= data.totalPages; i++) {
      if (i === 1 || i === data.totalPages || Math.abs(i - currentPage) <= 2) {
        html += `<button class="${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
      } else if (Math.abs(i - currentPage) === 3) {
        html += '<span class="page-info">...</span>';
      }
    }
    html += `<button ${currentPage >= data.totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">下一页</button>`;
    html += `<span class="page-info">共 ${data.total} 条</span>`;
    pagDiv.innerHTML = html;
    pagDiv.querySelectorAll('button[data-page]').forEach(btn => {
      btn.addEventListener('click', function() { goPage(parseInt(this.dataset.page)); });
    });
  }
}

function goPage(p) { currentPage = p; loadRecords(); }

async function viewRecord(id) {
  try {
    const r = await api(`/api/records/${id}`);
    const fields = [
      ['ID', r.id], ['IP地址', r.ip], ['VLAN', r.vlan], ['MAC地址', r.mac],
      ['设备类型', r.device_type], ['设备名称', r.device_name], ['物理位置', r.location],
      ['所属部门', r.department], ['使用人', r.user_name], ['使用状态', r.status],
      ['登记日期', formatDisplayDate(r.registered_at)], ['上层交换机', r.upper_switch],
      ['交换机端口', r.switch_port], ['向日葵ID', r.sunlogin_id],
      ['网关', r.gateway], ['备注', r.remark], ['更新日期', r.updated_at],
    ];
    document.getElementById('viewBody').innerHTML = fields.map(([label, val]) =>
      `<tr><td style="width:140px;color:var(--neutral-500);font-weight:500">${label}</td><td>${escapeHtml(val || '-')}</td></tr>`
    ).join('');
    document.getElementById('viewModal').classList.add('show');
  } catch (e) {
    showToast('获取记录失败: ' + e.message, 'error');
  }
};

function closeViewModal() { document.getElementById('viewModal').classList.remove('show'); }

async function editRecord(id) {
  try {
    const record = await api(`/api/records/${id}`);
    document.getElementById('modalTitle').textContent = '编辑IP登记';
    document.getElementById('recordId').value = record.id;
    const matchingPlan = dictionaries.vlanPlans.find(p => p.vlan === record.vlan && p.subnet && record.ip && ipInCidrJS(record.ip, p.subnet));
    document.getElementById('f_vlan').value = matchingPlan ? `plan:${matchingPlan.id}` : (record.vlan || '');
    document.getElementById('f_ip').value = record.ip || '';
    document.getElementById('f_mac').value = record.mac || '';
    document.getElementById('f_device_type').value = record.device_type || '';
    document.getElementById('f_device_name').value = record.device_name || '';
    document.getElementById('f_location').value = record.location || '';
    document.getElementById('f_department').value = record.department || '';
    document.getElementById('f_user_name').value = record.user_name || '';
    document.getElementById('f_status').value = record.status || '';
    document.getElementById('f_registered_at').value = record.registered_at || '';
    document.getElementById('f_upper_switch').value = record.upper_switch || '';
    document.getElementById('f_switch_port').value = record.switch_port || '';
    document.getElementById('f_sunlogin_id').value = record.sunlogin_id || '';
    document.getElementById('f_gateway').value = record.gateway || '';
    document.getElementById('f_remark').value = record.remark || '';
    document.getElementById('recordModal').classList.add('show');
  } catch (e) {
    showToast('获取记录失败: ' + e.message, 'error');
  }
};

async function deleteRecord(id) {
  if (!confirm('确定删除此记录？')) return;
  try {
    await api(`/api/records/${id}`, { method: 'DELETE' });
    showToast('删除成功', 'success');
    loadRecords();
  } catch (e) {
    showToast('删除失败: ' + e.message, 'error');
  }
};

function closeModal() { document.getElementById('recordModal').classList.remove('show'); }

function openNewModal() {
  document.getElementById('modalTitle').textContent = '新增IP登记';
  document.getElementById('recordForm').reset();
  document.getElementById('recordId').value = '';
  document.getElementById('f_registered_at').value = new Date().toISOString().slice(0, 10);
  document.getElementById('recordModal').classList.add('show');
}

async function saveRecord() {
  const id = document.getElementById('recordId').value;
  const vlanToken = document.getElementById('f_vlan').value;
  const ip = document.getElementById('f_ip').value.trim();

  // Check if selected VLAN is a dynamic (DHCP) pool — IP is optional for those
  const selectedPlan = vlanToken ? (() => { const m = String(vlanToken).match(/^plan:(\d+)$/); return m ? dictionaries.vlanPlans.find(p => p.id === Number(m[1])) : null; })() : null;
  const isDynamicVlan = selectedPlan && selectedPlan.is_dynamic;

  if (!isDynamicVlan) {
    if (!ip) return showToast('IP地址不能为空', 'error');
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return showToast('IP地址格式不正确', 'error');
  } else if (ip && !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return showToast('IP地址格式不正确', 'error');
  }

  // Validate IP matches VLAN subnet using CIDR (only when IP provided and subnet defined)
  if (vlanToken && ip) {
    const vlanSubnet = getVlanSubnet(vlanToken);
    if (vlanSubnet && !ipInCidrJS(ip, vlanSubnet)) {
      showToast(`IP地址必须在所选VLAN网段（${vlanSubnet}）范围内`, 'error');
      return;
    }
  }

  const data = {
    vlan: vlanToken,
    ip: ip,
    mac: formatMacInput(document.getElementById('f_mac').value),
    device_type: document.getElementById('f_device_type').value,
    device_name: document.getElementById('f_device_name').value,
    location: document.getElementById('f_location').value,
    department: document.getElementById('f_department').value,
    user_name: document.getElementById('f_user_name').value,
    status: document.getElementById('f_status').value,
    registered_at: document.getElementById('f_registered_at').value,
    upper_switch: document.getElementById('f_upper_switch').value,
    switch_port: document.getElementById('f_switch_port').value,
    sunlogin_id: document.getElementById('f_sunlogin_id').value,
    gateway: document.getElementById('f_gateway').value,
    remark: document.getElementById('f_remark').value,
  };
  try {
    if (id) {
      await api(`/api/records/${id}`, { method: 'PUT', body: JSON.stringify(data) });
      showToast('修改成功', 'success');
    } else {
      await api('/api/records', { method: 'POST', body: JSON.stringify(data) });
      showToast('新增成功', 'success');
    }
    closeModal();
    loadRecords();
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const userRole = document.querySelector('meta[name="user-role"]')?.content || '';
  canEdit = userRole === 'superadmin' || userRole === 'admin';
  if (canEdit) document.getElementById('btnNewRecord').style.display = '';

  loadDictionaries().then(loadRecords);

  document.getElementById('btnNewRecord').addEventListener('click', openNewModal);
  document.getElementById('btnSaveRecord').addEventListener('click', saveRecord);
  document.getElementById('btnFilter').addEventListener('click', () => { currentPage = 1; loadRecords(); });
  document.getElementById('btnReset').addEventListener('click', () => {
    document.getElementById('searchInput').value = '';
    document.getElementById('filterVlan').value = '';
    document.getElementById('filterDept').value = '';
    document.getElementById('filterStatus').value = '';
    document.getElementById('filterDeviceType').value = '';
    const dupCheckbox = document.getElementById('filterDupOnly');
    if (dupCheckbox) dupCheckbox.checked = false;
    const macCheckbox = document.getElementById('filterMacConflictOnly');
    if (macCheckbox) macCheckbox.checked = false;
    currentPage = 1;
    loadRecords();
  });

  document.getElementById('btnExportRecords').addEventListener('click', () => {
    const params = new URLSearchParams({
      search: document.getElementById('searchInput').value,
      vlan: document.getElementById('filterVlan').value,
      department: document.getElementById('filterDept').value,
      status: document.getElementById('filterStatus').value,
      deviceType: document.getElementById('filterDeviceType').value,
      onlyDuplicate: document.getElementById('filterDupOnly') && document.getElementById('filterDupOnly').checked ? '1' : '',
      onlyMacConflict: document.getElementById('filterMacConflictOnly') && document.getElementById('filterMacConflictOnly').checked ? '1' : '',
    });
    window.location.href = '/api/export/records?' + params;
  });

  document.getElementById('searchInput').addEventListener('keypress', e => {
    if (e.key === 'Enter') { currentPage = 1; loadRecords(); }
  });

  // Auto gateway lookup + VLAN auto-select on IP input
  document.getElementById('f_ip').addEventListener('blur', async function() {
    const ip = this.value.trim();
    if (!ip) return;
    try {
      const data = await api('/api/gateway-lookup?ip=' + encodeURIComponent(ip));
      if (data.gateway) document.getElementById('f_gateway').value = data.gateway;
      if (data.planId) {
        const byId = dictionaries.vlanPlans.find(p => p.id === Number(data.planId));
        if (byId) document.getElementById('f_vlan').value = `plan:${byId.id}`;
      } else if (data.vlan) {
        // 同一 VLAN 编号多网段：按 IP 所属 CIDR 匹配，避免总是选中第一条
        const plan = dictionaries.vlanPlans.find(p =>
          String(p.vlan) === String(data.vlan) && p.subnet && ipInCidrJS(ip, p.subnet)
        ) || dictionaries.vlanPlans.find(p => String(p.vlan) === String(data.vlan));
        if (plan) document.getElementById('f_vlan').value = `plan:${plan.id}`;
      }
    } catch (e) {}
  });

  // When VLAN changes, validate IP against CIDR and auto-fill gateway
  document.getElementById('f_vlan').addEventListener('change', function() {
    const subnet = getVlanSubnet(this.value);
    const ipInput = document.getElementById('f_ip');
    if (subnet && ipInput.value.trim()) {
      if (!ipInCidrJS(ipInput.value.trim(), subnet)) {
        showToast(`IP地址应在所选VLAN网段（${subnet}）范围内`, 'warning');
      }
    }
    // Auto-fill gateway from prefix gateway mapping
    const prefix = subnet ? subnet.split('/')[0].split('.').slice(0, 3).join('.') : null;
    if (prefix) {
      api('/api/dict/prefix-gateways').then(gws => {
        const gw = gws.find(g => g.prefix === prefix);
        if (gw) document.getElementById('f_gateway').value = gw.gateway;
      }).catch(() => {});
    }
  });

  // Sort
  document.querySelectorAll('#recordsTable th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const sort = th.dataset.sort;
      if (currentSort === sort) {
        currentOrder = currentOrder === 'asc' ? 'desc' : 'asc';
      } else {
        currentSort = sort;
        currentOrder = 'asc';
      }
      loadRecords();
    });
  });

  // Filter checkbox for duplicate IPs only
  const dupCheckbox = document.getElementById('filterDupOnly');
  if (dupCheckbox) {
    dupCheckbox.addEventListener('change', () => { currentPage = 1; loadRecords(); });
  }

  // Filter checkbox for MAC conflict IPs only
  const macCheckbox = document.getElementById('filterMacConflictOnly');
  if (macCheckbox) {
    macCheckbox.addEventListener('change', function() {
      if (this.checked) { currentSort = 'mac'; currentOrder = 'asc'; }
      currentPage = 1;
      loadRecords();
      updateSortIndicators();
    });
  }

  // Modal close buttons
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', function() {
      document.getElementById(this.dataset.close).classList.remove('show');
    });
  });
});
