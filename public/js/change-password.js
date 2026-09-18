document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', function() {
      document.getElementById(this.dataset.close).classList.remove('show');
    });
  });

  var btn = document.getElementById('btnChangePwd');
  if (btn) btn.addEventListener('click', function() {
    document.getElementById('changePwdModal').classList.add('show');
  });

  var saveBtn = document.getElementById('btnSavePwd');
  if (saveBtn) saveBtn.addEventListener('click', async function() {
    var oldP = document.getElementById('oldPassword').value;
    var newP = document.getElementById('newPassword').value;
    var confP = document.getElementById('confirmPassword').value;
    if (!oldP || !newP) return showToast('请填写完整', 'error');
    if (newP.length < 6) return showToast('新密码至少6位', 'error');
    if (newP !== confP) return showToast('两次输入的新密码不一致', 'error');
    try {
      await api('/api/change-password', { method: 'POST', body: JSON.stringify({ oldPassword: oldP, newPassword: newP }) });
      showToast('密码修改成功', 'success');
      document.getElementById('changePwdModal').classList.remove('show');
      document.getElementById('changePwdForm').reset();
    } catch (e) {
      showToast('修改失败: ' + e.message, 'error');
    }
  });
});
