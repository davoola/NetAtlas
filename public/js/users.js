let allVlanOptions = [];

function planToken(plan) { return `plan:${plan.id}`; }
function planLabel(plan) { return `${plan.vlan} - ${plan.name || '未命名'} (${plan.subnet || '未设置网段'})`; }

async function loadUsers() {
  try {
    const users = await api('/api/users');
    const tbody = document.getElementById('usersBody');
    tbody.innerHTML = users.map(u => {
      const roleText = u.role === 'superadmin' ? '超级管理员' : (u.role === 'admin' ? '管理员' : '普通用户');
      const statusText = u.enabled ? '<span style="color:var(--success)">启用</span>' : '<span style="color:var(--error)">禁用</span>';
      const perms = (u.vlanPermissions || []).map(token => {
        const plan = allVlanOptions.find(p => planToken(p) === token || p.vlan === token);
        return plan ? planLabel(plan) : token;
      }).join(', ') || '-';
      return `<tr>
        <td>${u.id}</td><td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.display_name||'-')}</td>
        <td><span class="role-badge role-${u.role}">${roleText}</span></td><td>${statusText}</td>
        <td>${escapeHtml(perms)}</td><td>${escapeHtml(u.created_at||'-')}</td>
        <td class="action-cell">
          <button class="btn btn-sm btn-secondary" data-action="edit-user" data-id="${u.id}">编辑</button>
          <button class="btn btn-sm btn-secondary" data-action="reset-pwd" data-id="${u.id}">重置密码</button>
          <button class="btn btn-sm btn-danger" data-action="del-user" data-id="${u.id}">删除</button>
        </td></tr>`;
    }).join('');
    // Bind action buttons
    tbody.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', function() {
        const action = this.dataset.action;
        const id = parseInt(this.dataset.id);
        if (action === 'edit-user') editUser(id);
        else if (action === 'reset-pwd') resetPwd(id);
        else if (action === 'del-user') delUser(id);
      });
    });
  } catch (e) { showToast('加载用户失败: ' + e.message, 'error'); }
}

async function loadVlanOptions() {
  const plans = await api('/api/dict/vlan-plans');
  allVlanOptions = plans;
}

async function editUser(id) {
  const users = await api('/api/users');
  const u = users.find(x => x.id === id);
  if (!u) return;
  document.getElementById('userModalTitle').textContent = '编辑用户';
  document.getElementById('userId').value = u.id;
  document.getElementById('u_username').value = u.username;
  document.getElementById('u_username').readOnly = false;
  document.getElementById('passwordGroup').style.display = 'none';
  document.getElementById('u_password').required = false;
  document.getElementById('u_display_name').value = u.display_name || '';
  document.getElementById('u_role').value = u.role;
  document.getElementById('u_enabled').value = String(u.enabled);
  togglePermSection(u.role, u.vlanPermissions);
  document.getElementById('userModal').classList.add('show');
};

function resetPwd(id) {
  document.getElementById('resetUserId').value = id;
  document.getElementById('resetPassword').value = '';
  document.getElementById('resetModal').classList.add('show');
};

function closeUserModal() { document.getElementById('userModal').classList.remove('show'); }
function closeResetModal() { document.getElementById('resetModal').classList.remove('show'); }

async function delUser(id) {
  if (!confirm('确定删除此用户？')) return;
  try {
    await api(`/api/users/${id}`, { method: 'DELETE' });
    showToast('删除成功', 'success');
    loadUsers();
  } catch (e) { showToast('删除失败: ' + e.message, 'error'); }
};

function togglePermSection(role, existingPerms) {
  const section = document.getElementById('permSection');
  if (role === 'admin') {
    section.style.display = '';
    const list = document.getElementById('permVlanList');
    list.innerHTML = allVlanOptions.map(plan => {
      const token = planToken(plan);
      const checked = existingPerms && (existingPerms.includes(token) || existingPerms.includes(plan.vlan)) ? 'checked' : '';
      return `<div class="checkbox-item"><input type="checkbox" value="${token}" id="perm_${plan.id}" ${checked}><label for="perm_${plan.id}">${escapeHtml(planLabel(plan))}</label></div>`;
    }).join('');
  } else {
    section.style.display = 'none';
  }
}

async function saveUser() {
  const id = document.getElementById('userId').value;
  const role = document.getElementById('u_role').value;
  const data = {
    username: document.getElementById('u_username').value.trim(),
    role,
    display_name: document.getElementById('u_display_name').value,
    enabled: parseInt(document.getElementById('u_enabled').value),
  };
  try {
    if (id) {
      await api(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify(data) });
      if (role === 'admin') {
        const vlans = Array.from(document.querySelectorAll('#permVlanList input:checked')).map(c => c.value);
        await api(`/api/users/${id}/permissions`, { method: 'PUT', body: JSON.stringify({ vlans }) });
      }
      showToast('修改成功', 'success');
    } else {
      const username = document.getElementById('u_username').value;
      const password = document.getElementById('u_password').value;
      if (!username || !password) return showToast('用户名和密码必填', 'error');
      const result = await api('/api/users', { method: 'POST', body: JSON.stringify({ username, password, role, display_name: data.display_name }) });
      if (role === 'admin') {
        const vlans = Array.from(document.querySelectorAll('#permVlanList input:checked')).map(c => c.value);
        await api(`/api/users/${result.id}/permissions`, { method: 'PUT', body: JSON.stringify({ vlans }) });
      }
      showToast('创建成功', 'success');
    }
    closeUserModal();
    loadUsers();
  } catch (e) { showToast('保存失败: ' + e.message, 'error'); }
}

async function doResetPassword() {
  const id = document.getElementById('resetUserId').value;
  const password = document.getElementById('resetPassword').value;
  if (!password || password.length < 6) return showToast('密码至少6位', 'error');
  try {
    await api(`/api/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ password }) });
    showToast('重置成功', 'success');
    closeResetModal();
  } catch (e) { showToast('重置失败: ' + e.message, 'error'); }
}

document.addEventListener('DOMContentLoaded', () => {
  loadVlanOptions().then(loadUsers);

  document.getElementById('btnAddUser').addEventListener('click', () => {
    document.getElementById('userModalTitle').textContent = '新增用户';
    document.getElementById('userForm').reset();
    document.getElementById('userId').value = '';
    document.getElementById('u_username').readOnly = false;
    document.getElementById('passwordGroup').style.display = '';
    document.getElementById('u_password').required = true;
    document.getElementById('u_role').value = 'viewer';
    document.getElementById('u_enabled').value = '1';
    togglePermSection('viewer', []);
    document.getElementById('userModal').classList.add('show');
  });

  document.getElementById('u_role').addEventListener('change', function() {
    togglePermSection(this.value, []);
  });

  document.getElementById('btnSaveUser').addEventListener('click', saveUser);
  document.getElementById('btnResetPassword').addEventListener('click', doResetPassword);

  // Modal close buttons
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', function() {
      document.getElementById(this.dataset.close).classList.remove('show');
    });
  });
});
