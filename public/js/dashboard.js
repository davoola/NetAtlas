async function loadDashboard() {
  try {
    const data = await api('/api/stats');
    const k = data.kpi;
    document.getElementById('kpi-total').textContent = k.total;
    document.getElementById('kpi-used').textContent = k.used;
    document.getElementById('kpi-reserved').textContent = k.reserved;
    document.getElementById('kpi-mac').textContent = k.withMac;
    document.getElementById('kpi-sunlogin').textContent = k.withSunlogin;
    document.getElementById('kpi-dup').textContent = k.dupIps;
    document.getElementById('kpi-macConflict').textContent = k.macConflictIps;
    document.getElementById('kpi-activeVlan').textContent = k.activeVlans;

    // Sidebar VLAN count
    const sidebarCount = document.getElementById('sidebarVlanCount');
    if (sidebarCount) {
      sidebarCount.textContent = String(k.activeVlans || 0).padStart(2, '0');
    }
    const vlanBadge = document.getElementById('vlanCountBadge');
    if (vlanBadge) vlanBadge.textContent = String(data.vlanStats.length).padStart(2, '0');

    // VLAN stats table with utilization
    const vlanBody = document.getElementById('vlanStatsBody');
    vlanBody.innerHTML = data.vlanStats.map(v => {
      let capacity = 253;
      if (v.address_pool_note) {
        const { rangeStart, rangeEnd } = parsePoolRange(v);
        if (rangeStart !== 1 || rangeEnd !== 254) {
          let poolSize = rangeEnd - rangeStart + 1;
          if (v.gateway && v.gateway !== '-') {
            const gwParts = v.gateway.split('.');
            if (gwParts.length === 4) {
              const gwHost = parseInt(gwParts[3]);
              if (gwHost >= rangeStart && gwHost <= rangeEnd) poolSize -= 1;
            }
          }
          capacity = poolSize;
        }
      }
      const utilization = capacity > 0 ? ((v.count / capacity) * 100).toFixed(1) : '0.0';
      const utilNum = parseFloat(utilization);
      const fillClass = utilNum >= 80 ? 'danger' : (utilNum >= 60 ? 'warn' : '');
      const isDhcp = String(v.vlan).toUpperCase() === 'DHCP';
      return `
        <tr>
          <td><span class="vlan-badge ${isDhcp ? 'dhcp' : ''}">${escapeHtml(v.vlan)}</span></td>
          <td>
            <div style="font-weight:600;color:var(--text-primary)">${escapeHtml(v.name || '-')}</div>
            <div style="font-size:12px;color:var(--text-muted)">${escapeHtml(v.subnet || '-')}</div>
          </td>
          <td>${escapeHtml(v.mask || '-')}</td>
          <td>${escapeHtml(v.gateway || '-')}</td>
          <td><strong>${v.count}</strong></td>
          <td>${capacity}</td>
          <td>
            <div class="util-bar-wrap">
              <div class="util-bar"><div class="util-bar-fill ${fillClass}" style="width:${Math.min(utilNum,100)}%"></div></div>
              <span class="util-pct">${utilization}%</span>
            </div>
          </td>
          <td>${escapeHtml(v.description || '-')}</td>
          <td>${escapeHtml(v.address_pool_note || '-')}</td>
        </tr>
      `;
    }).join('');

    // Department stats
    const deptDiv = document.getElementById('deptStats');
    deptDiv.innerHTML = data.deptStats.map((d, i) => `
      <div class="stat-item">
        <span class="stat-item-label">${String(i + 1).padStart(2, '0')} ${escapeHtml(d.department)}</span>
        <div class="stat-item-bar-wrap"><div class="stat-item-bar" style="width:${d.percentage}%"></div></div>
        <span class="stat-item-value">${d.cnt}<span class="stat-item-pct">${d.percentage}%</span></span>
      </div>
    `).join('') || '<p class="text-muted" style="padding:16px 18px">暂无数据</p>';

    // Device type stats
    const devDiv = document.getElementById('deviceStats');
    devDiv.innerHTML = data.deviceStats.map((d, i) => `
      <div class="stat-item">
        <span class="stat-item-label">${String(i + 1).padStart(2, '0')} ${escapeHtml(d.device_type)}</span>
        <div class="stat-item-bar-wrap"><div class="stat-item-bar" style="width:${d.percentage}%"></div></div>
        <span class="stat-item-value">${d.cnt}<span class="stat-item-pct">${d.percentage}%</span></span>
      </div>
    `).join('') || '<p class="text-muted" style="padding:16px 18px">暂无数据</p>';
  } catch (e) {
    showToast('加载仪表板失败: ' + e.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', loadDashboard);
