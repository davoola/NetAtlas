document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('importForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fileInput = document.getElementById('importFile');
    const type = document.getElementById('importType').value;
    if (!fileInput.files[0]) return showToast('请选择文件', 'error');

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    formData.append('strategy', document.getElementById('importStrategy').value);

    const url = type === 'excel' ? '/api/import/excel' : '/api/import/csv';
    const btn = document.getElementById('btnImport');
    btn.disabled = true;
    btn.textContent = '导入中...';
    document.getElementById('importResult').style.display = 'none';

    try {
      const res = await fetch(url, { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '导入失败');

      document.getElementById('importResult').style.display = '';
      const content = document.getElementById('importResultContent');
      let html = '<div class="import-result-success">导入完成</div>';
      html += '<div style="margin-top:8px;display:flex;gap:16px;flex-wrap:wrap">';
      html += `<span style="color:var(--success)">成功新增: ${data.success} 条</span>`;
      if (data.updated > 0) html += `<span style="color:var(--primary)">更新: ${data.updated} 条</span>`;
      if (data.skip > 0) html += `<span style="color:var(--warning)">跳过: ${data.skip} 条</span>`;
      if (data.totalErrors !== undefined && data.totalErrors > 0) html += `<span style="color:var(--error)">错误: ${data.totalErrors} 条</span>`;
      html += '</div>';

      if (data.errors && data.errors.length > 0) {
        html += '<div class="import-result-error" style="margin-top:12px"><strong>跳过/错误详情：</strong><ul style="margin-top:4px;padding-left:20px">';
        data.errors.forEach(err => { html += `<li>${escapeHtml(err)}</li>`; });
        html += '</ul>';
        if (data.totalErrors !== undefined && data.totalErrors > data.errors.length) {
          html += `<div style="margin-top:4px;color:var(--neutral-500);font-size:0.85em">仅展示前 ${data.errors.length} 条，共有 ${data.totalErrors} 条错误。如需查看完整原因请减小单批导入量。</div>`;
        }
        html += '</div>';
      }
      content.innerHTML = html;
      showToast('导入完成', 'success');
    } catch (e) {
      showToast('导入失败: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '开始导入';
    }
  });

  document.getElementById('btnDownloadTemplate').addEventListener('click', () => {
    const headers = ['VLAN','IP地址','MAC地址','设备类型','设备名称','物理部署位置','所属部门','使用人','备注','使用状态','登记日期','上层交换机','交换机端口','向日葵远程ID','网关'];
    const sampleRow = ['100','192.168.10.50','AA:BB:CC:DD:EE:FF','办公电脑','测试电脑-001','三楼阅览区A302','技术服务部','张三','测试导入用','已使用','2024-01-15','SW-Core-1','Gig1/0/1','123456789','192.168.10.1'];
    const csv = [headers.join(','), sampleRow.join(',')].join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'IP导入模板.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  });
});
