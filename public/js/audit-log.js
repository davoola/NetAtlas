let auditPage = 1;

const ACTION_LABELS = {
  create_record: '新增IP记录',
  update_record: '修改IP记录',
  delete_record: '删除IP记录',
  import_data: '数据导入',
  export_records: '导出IP记录',
  login_failed: '登录失败',
  add_device_type: '新增设备类型',
  update_device_type: '修改设备类型',
  delete_device_type: '删除设备类型',
  add_status: '新增使用状态',
  update_status: '修改使用状态',
  delete_status: '删除使用状态',
  add_department: '新增部门',
  update_department: '修改部门',
  delete_department: '删除部门',
  add_vlan_plan: '新增VLAN规划',
  update_vlan_plan: '修改VLAN规划',
  delete_vlan_plan: '删除VLAN规划',
  add_prefix_gateway: '新增网关映射',
  update_prefix_gateway: '修改网关映射',
  delete_prefix_gateway: '删除网关映射',
  create_user: '创建用户',
  update_user: '修改用户',
  delete_user: '删除用户',
  reset_password: '重置密码',
  update_permissions: '修改权限',
  change_password: '修改密码',
  update_setting: '修改系统配置',
  cleanup_audit_logs: '清理审计日志',
};

const TARGET_LABELS = {
  ip_record: 'IP记录',
  device_type: '设备类型',
  status: '使用状态',
  department: '部门',
  vlan_plan: 'VLAN规划',
  prefix_gateway: '网关映射',
  user: '用户',
  import: '数据导入',
  settings: '系统配置',
};

async function loadAuditLogs() {
  try {
    const params = new URLSearchParams({
      page: auditPage,
      perPage: 20,
      search: document.getElementById('auditSearch').value,
      startDate: document.getElementById('auditStartDate').value,
      endDate: document.getElementById('auditEndDate').value,
      target_type: document.getElementById('auditTargetType').value,
    });
    const data = await api('/api/audit-logs?' + params);
    const tbody = document.getElementById('auditBody');
    if (data.rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--neutral-400);padding:40px">暂无日志</td></tr>';
    } else {
      tbody.innerHTML = data.rows.map(r => `
        <tr>
          <td>${r.id}</td>
          <td>${escapeHtml(r.created_at || '-')}</td>
          <td>${escapeHtml(r.username || '-')}</td>
          <td>${escapeHtml(ACTION_LABELS[r.action] || r.action || '-')}</td>
          <td>${escapeHtml(TARGET_LABELS[r.target_type] || r.target_type || '-')}</td>
          <td>${escapeHtml(r.detail || '-')}</td>
          <td>${r.ip_address ? escapeHtml(r.ip_address) : '-'}</td>
        </tr>
      `).join('');
    }

    const pagDiv = document.getElementById('auditPagination');
    if (data.totalPages <= 1) {
      pagDiv.innerHTML = `<span class="page-info">共 ${data.total} 条</span>`;
    } else {
      let html = `<button ${auditPage <= 1 ? 'disabled' : ''} data-page="${auditPage - 1}">上一页</button>`;
      for (let i = 1; i <= data.totalPages; i++) {
        if (i === 1 || i === data.totalPages || Math.abs(i - auditPage) <= 2) {
          html += `<button class="${i === auditPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
        } else if (Math.abs(i - auditPage) === 3) {
          html += '<span class="page-info">...</span>';
        }
      }
      html += `<button ${auditPage >= data.totalPages ? 'disabled' : ''} data-page="${auditPage + 1}">下一页</button>`;
      html += `<span class="page-info">共 ${data.total} 条</span>`;
      pagDiv.innerHTML = html;
      pagDiv.querySelectorAll('button[data-page]').forEach(btn => {
        btn.addEventListener('click', function() { goAuditPage(parseInt(this.dataset.page)); });
      });
    }
  } catch (e) {
    showToast('加载审计日志失败: ' + e.message, 'error');
  }
}

function goAuditPage(p) { auditPage = p; loadAuditLogs(); }

document.addEventListener('DOMContentLoaded', () => {
  loadAuditLogs();
  document.getElementById('btnAuditFilter').addEventListener('click', () => { auditPage = 1; loadAuditLogs(); });
  document.getElementById('btnAuditReset').addEventListener('click', () => {
    document.getElementById('auditSearch').value = '';
    document.getElementById('auditStartDate').value = '';
    document.getElementById('auditEndDate').value = '';
    document.getElementById('auditTargetType').value = '';
    auditPage = 1;
    loadAuditLogs();
  });
  document.getElementById('auditSearch').addEventListener('keypress', e => {
    if (e.key === 'Enter') { auditPage = 1; loadAuditLogs(); }
  });
});
