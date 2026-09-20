let subnetPlans = [];
let currentPrefix = '';
let subnetSort = 'ip';
let subnetOrder = 'asc';

async function loadSubnetOptions() {
  try {
    const plans = await api('/api/dict/vlan-plans');
    const permData = await api('/api/my-vlan-permissions');
    subnetPlans = plans;
    const select = document.getElementById('subnetSelect');
    select.innerHTML = '<option value="">请选择网段</option>';
    const seen = new Set();
    const allowedTokens = permData.all ? null : new Set(permData.vlans);
    const firstPrefix = [];
    plans.forEach(p => {
      const token = `plan:${p.id}`;
      const allowed = !allowedTokens || allowedTokens.has(token) || allowedTokens.has(p.vlan);
      if (!allowed) return;

      if (p.subnet) {
        const cidrParts = p.subnet.split('/');
        const prefixLen = cidrParts.length === 2 ? parseInt(cidrParts[1], 10) : 24;
        const prefix = cidrParts[0].split('.').slice(0, 3).join('.');
        if (prefixLen < 24) {
          // Large subnet: use plan:CIDR token
          const cidrValue = `plan:${p.subnet}`;
          if (!seen.has(cidrValue)) {
            seen.add(cidrValue);
            select.add(new Option(`${p.subnet} (${p.vlan} - ${p.name || ''})`, cidrValue));
            firstPrefix.push(cidrValue);
          }
        } else {
          if (!seen.has(prefix)) {
            seen.add(prefix);
            select.add(new Option(`${prefix} (${p.vlan} - ${p.name || ''})`, prefix));
            firstPrefix.push(prefix);
          }
        }
      } else if (p.is_dynamic) {
        // Dynamic VLAN with no subnet: use plan:<id> token
        const dynValue = `plan:${p.id}`;
        if (!seen.has(dynValue)) {
          seen.add(dynValue);
          select.add(new Option(`${p.vlan} - ${p.name || '动态IP池'} (动态/DHCP)`, dynValue));
          firstPrefix.push(dynValue);
        }
      }
    });
    if (firstPrefix.length > 0) {
      select.value = firstPrefix[0];
      viewSubnet();
    }
  } catch (e) {
    showToast('加载网段列表失败: ' + e.message, 'error');
  }
}



function getGatewayHost(plan, prefix) {
  if (plan && plan.gateway && plan.gateway !== '-') {
    const parts = plan.gateway.split('.');
    if (parts.length === 4) return parseInt(parts[3]);
  }
  // Fallback: check prefix gateway mapping
  const gw = subnetPlans.find(p => {
    if (!p.subnet) return false;
    const pfx = p.subnet.split('/')[0].split('.').slice(0, 3).join('.');
    return pfx === prefix && p.gateway && p.gateway !== '-';
  });
  if (gw) {
    const parts = gw.gateway.split('.');
    if (parts.length === 4) return parseInt(parts[3]);
  }
  return 1; // default gateway at .1
}

function updateSubnetSortIndicators() {
  document.querySelectorAll('#subnetTable th[data-sort]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === subnetSort) {
      th.classList.add(subnetOrder === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

async function viewSubnet() {
  const prefix = document.getElementById('subnetSelect').value;
  if (!prefix) { showToast('请选择网段', 'error'); return; }
  currentPrefix = prefix;

  // Large subnet (CIDR) or plan-id token (dynamic VLAN with no subnet)
  const isLargeSubnet = prefix.startsWith('plan:') && prefix.slice(5).includes('/');
  const isDynamicPlanToken = prefix.startsWith('plan:') && !prefix.slice(5).includes('/');

  try {
    const params = new URLSearchParams({ sort: subnetSort, order: subnetOrder });
    const data = await api('/api/subnet/' + encodeURIComponent(prefix) + '?' + params);
    document.getElementById('subnetResult').style.display = '';
    document.getElementById('btnExportSubnet').style.display = '';
    const plan = data.plan;
    const gateway = plan ? (plan.gateway && plan.gateway !== '-' ? plan.gateway : null) : null;
    const vlan = plan ? plan.vlan : null;

    let subnetInfo;
    let rangeStart = 1, rangeEnd = 254, gwHost = 1;
    if (isLargeSubnet) {
      const cidr = prefix.slice(5);
      subnetInfo = `网段 <strong style="color:var(--primary)">${escapeHtml(cidr)}</strong> 共 <strong style="color:var(--primary)">${data.records.length}</strong> 条登记记录` +
        (vlan ? ` | VLAN: <strong style="color:var(--primary)">${escapeHtml(vlan)}</strong>` : '') +
        (plan && plan.mask ? ` | 掩码: ${escapeHtml(plan.mask)}` : '') +
        ` <span style="color:var(--neutral-400);font-size:12px;margin-left:8px">（大子网模式，不计算剩余可用）</span>`;
    } else if (isDynamicPlanToken) {
      subnetInfo = `动态IP池 <strong style="color:var(--primary)">${escapeHtml(vlan || '')}</strong>` +
        (plan && plan.name ? ` - ${escapeHtml(plan.name)}` : '') +
        ` 共 <strong style="color:var(--primary)">${data.records.length}</strong> 条登记记录` +
        ` <span style="color:var(--neutral-400);font-size:12px;margin-left:8px">（动态IP池，不计算剩余可用）</span>`;
    } else {
      // Calculate available count using shared parsePoolRange, subtract gateway
      const pool = parsePoolRange(plan);
      rangeStart = pool.rangeStart;
      rangeEnd = pool.rangeEnd;
      if (plan && plan.address_pool_note) {
        const testMatch = plan.address_pool_note.match(/\.?(\d{1,3})\s*[-–~至到]\s*\.?(\d{1,3})/);
        if (!testMatch) {
          console.warn('地址池说明格式无法识别，已按默认 1-254 计算:', plan.address_pool_note);
        }
      }
      gwHost = getGatewayHost(plan, prefix);
      const totalPoolSize = rangeEnd - rangeStart + 1;
      const gatewayInPool = gwHost >= rangeStart && gwHost <= rangeEnd ? 1 : 0;
      const usedInPool = data.records.filter(r => {
        if (!r.ip) return false;
        const parts = r.ip.split('.');
        if (parts.length !== 4) return false;
        const h = parseInt(parts[3]);
        return h >= rangeStart && h <= rangeEnd;
      }).length;
      const availableCount = totalPoolSize - gatewayInPool - usedInPool;

      subnetInfo = `网段 ${escapeHtml(prefix)}.* 共 <strong style="color:var(--primary)">${data.records.length}</strong> 条登记记录；剩余可用 <strong style="color:var(--success)">${availableCount}</strong>` +
        (vlan ? ` | VLAN: <strong style="color:var(--primary)">${escapeHtml(vlan)}</strong>` : '') +
        (gateway ? ` | 网关: ${escapeHtml(gateway)}` : '') +
        (plan && plan.mask ? ` | 掩码: ${escapeHtml(plan.mask)}` : '');
    }
    document.getElementById('subnetInfo').innerHTML = subnetInfo;

    const tbody = document.getElementById('subnetBody');
    if (data.records.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--neutral-400);padding:40px">该网段暂无登记记录</td></tr>';
    } else {
      tbody.innerHTML = data.records.map(r => {
        const hostPart = r.ip ? r.ip.split('.').slice(3)[0] : '-';
        const dupBadge = r.is_duplicate ? ' <span class="dup-badge">重复</span>' : '';
        const rowClass = r.is_duplicate ? 'row-duplicate' : '';
        return `
          <tr class="${rowClass}">
            <td>${escapeHtml(hostPart)}</td>
            <td>${escapeHtml(r.ip || '-')} ${dupBadge}</td>
            <td>${escapeHtml(r.device_name || '-')}</td>
            <td>${escapeHtml(r.department || '-')}</td>
            <td>${escapeHtml(r.user_name || '-')}</td>
            <td><span class="status-badge ${statusClass(r.status)}">${escapeHtml(r.status || '-')}</span></td>
            <td class="action-cell">
              <button class="icon-btn" title="查看" data-record-id="${r.id}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            </td>
          </tr>
        `;
      }).join('');
      document.querySelectorAll('#subnetBody .icon-btn[data-record-id]').forEach(btn => {
        btn.addEventListener('click', function() { viewSubnetRecord(this.dataset.recordId); });
      });
    }

    // Idle host analysis: skip for large subnets and dynamic VLANs
    if (isLargeSubnet || isDynamicPlanToken) {
      document.getElementById('idleSection').style.display = 'none';
    } else {
      const usedHosts = new Set();
      data.records.forEach(r => {
        if (r.ip) {
          const parts = r.ip.split('.');
          if (parts.length === 4) usedHosts.add(parseInt(parts[3]));
        }
      });

      const idleList = [];
      for (let h = rangeStart; h <= rangeEnd; h++) {
        if (h === gwHost) continue; // skip gateway
        if (!usedHosts.has(h)) idleList.push(h);
      }
      const idleDiv = document.getElementById('idleList');
      if (idleList.length > 0) {
        document.getElementById('idleSection').style.display = '';
        idleDiv.innerHTML = idleList.map(h => `<span class="idle-badge">.${h}</span>`).join('');
      } else {
        document.getElementById('idleSection').style.display = 'none';
      }
    }
  } catch (e) {
    showToast('加载网段明细失败: ' + e.message, 'error');
  }
}

async function viewSubnetRecord(id) {
  try {
    const r = await api(`/api/records/${id}`);
    const fields = [
      ['ID', r.id], ['IP地址', r.ip], ['VLAN', r.vlan], ['MAC地址', r.mac],
      ['设备类型', r.device_type], ['设备名称', r.device_name], ['物理位置', r.location],
      ['所属部门', r.department], ['使用人', r.user_name], ['使用状态', r.status],
      ['登记日期', r.registered_at], ['上层交换机', r.upper_switch],
      ['交换机端口', r.switch_port], ['向日葵ID', r.sunlogin_id],
      ['网关', r.gateway], ['备注', r.remark], ['更新日期', r.updated_at],
    ];
    document.getElementById('subnetViewBody').innerHTML = fields.map(([label, val]) =>
      `<tr><td style="width:140px;color:var(--neutral-500);font-weight:500">${label}</td><td>${escapeHtml(val || '-')}</td></tr>`
    ).join('');
    document.getElementById('subnetViewModal').classList.add('show');
  } catch (e) {
    showToast('获取记录失败: ' + e.message, 'error');
  }
};

function closeSubnetViewModal() { document.getElementById('subnetViewModal').classList.remove('show'); }

document.addEventListener('DOMContentLoaded', () => {
  loadSubnetOptions();
  document.getElementById('btnViewSubnet').addEventListener('click', viewSubnet);
  document.getElementById('btnExportSubnet').addEventListener('click', () => {
    if (!currentPrefix) { showToast('请先选择网段', 'error'); return; }
    window.location.href = '/api/export/subnet/' + encodeURIComponent(currentPrefix);
  });

  // Sort: clickable headers on subnet table
  document.querySelectorAll('#subnetTable th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const sort = th.dataset.sort;
      if (subnetSort === sort) {
        subnetOrder = subnetOrder === 'asc' ? 'desc' : 'asc';
      } else {
        subnetSort = sort;
        subnetOrder = 'asc';
      }
      if (currentPrefix) viewSubnet();
    });
  });

  // Modal close buttons
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', function() {
      document.getElementById(this.dataset.close).classList.remove('show');
    });
  });
});
