async function loadDashboard() {
  try {
    const data = await api('/api/stats');
    const k = data.kpi;
    document.getElementById('kpi-total').textContent = k.total;
    document.getElementById('kpi-used').textContent = k.used;
    document.getElementById('kpi-reserved').textContent = k.reserved;
    document.getElementById('kpi-deprecated').textContent = k.deprecated;
    document.getElementById('kpi-mac').textContent = k.withMac;
    document.getElementById('kpi-sunlogin').textContent = k.withSunlogin;
    document.getElementById('kpi-dup').textContent = k.dupIps;
    document.getElementById('kpi-macConflict').textContent = k.macConflictIps;
    document.getElementById('kpi-activeVlan').textContent = k.activeVlans;

    // VLAN stats table with utilization
    const vlanBody = document.getElementById('vlanStatsBody');
    vlanBody.innerHTML = data.vlanStats.map(v => {
      // Calculate capacity from address_pool_note or default /24 (254 usable - 1 gateway)
      let capacity = 253; // default /24 minus gateway
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
      const utilColor = utilization >= 80 ? 'var(--error)' : (utilization >= 60 ? 'var(--warning)' : 'var(--success)');
      return `
        <tr>
          <td>${escapeHtml(v.vlan)}</td>
          <td>${escapeHtml(v.name || '-')} / ${escapeHtml(v.subnet || '-')}</td>
          <td>${escapeHtml(v.mask || '-')}</td>
          <td>${escapeHtml(v.gateway || '-')}</td>
          <td><strong>${v.count}</strong></td>
          <td>${capacity}</td>
          <td>
            <div style="display:flex;align-items:center;gap:6px">
              <div class="stat-bar" style="width:80px"><div class="stat-bar-fill" style="width:${Math.min(utilization,100)}%;background:${utilColor}"></div></div>
              <span style="color:${utilColor};font-weight:600">${utilization}%</span>
            </div>
          </td>
          <td>${escapeHtml(v.description || '-')}</td>
          <td>${escapeHtml(v.address_pool_note || '-')}</td>
        </tr>
      `;
    }).join('');

    // Department stats
    const deptDiv = document.getElementById('deptStats');
    deptDiv.innerHTML = data.deptStats.map(d => `
      <div class="stat-item">
        <span class="stat-item-name">${escapeHtml(d.department)}</span>
        <span class="stat-item-value">
          <span class="stat-item-count">${d.cnt}</span>
          <span class="stat-item-pct">${d.percentage}%</span>
          <div class="stat-bar"><div class="stat-bar-fill" style="width:${d.percentage}%"></div></div>
        </span>
      </div>
    `).join('') || '<p style="color:var(--neutral-400)">暂无数据</p>';

    // Device type stats
    const devDiv = document.getElementById('deviceStats');
    devDiv.innerHTML = data.deviceStats.map(d => `
      <div class="stat-item">
        <span class="stat-item-name">${escapeHtml(d.device_type)}</span>
        <span class="stat-item-value">
          <span class="stat-item-count">${d.cnt}</span>
          <span class="stat-item-pct">${d.percentage}%</span>
          <div class="stat-bar"><div class="stat-bar-fill" style="width:${d.percentage}%"></div></div>
        </span>
      </div>
    `).join('') || '<p style="color:var(--neutral-400)">暂无数据</p>';
  } catch (e) {
    showToast('加载仪表板失败: ' + e.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', loadDashboard);
