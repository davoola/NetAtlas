// --- Global helpers ---
const currentUser = window.CURRENT_USER || null;

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

function statusClass(status) {
  if (!status) return '';
  if (status.includes('使用') && !status.includes('废弃')) return 'status-used';
  if (status.includes('预留') || status.includes('备用')) return 'status-reserved';
  if (status.includes('废弃')) return 'status-deprecated';
  if (status.includes('DHCP') || status.includes('动态')) return 'status-dhcp';
  return '';
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function parsePoolRange(plan) {
  let rangeStart = 1, rangeEnd = 254;
  if (plan && plan.address_pool_note) {
    const m = plan.address_pool_note.match(/\.?(\d{1,3})\s*[-–~至到]\s*\.?(\d{1,3})/);
    if (m) {
      rangeStart = parseInt(m[1], 10);
      rangeEnd = parseInt(m[2], 10);
    }
  }
  return { rangeStart, rangeEnd };
}

// --- Sidebar toggle ---
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('menuToggle');
  const sidebar = document.getElementById('sidebar');
  const collapse = document.getElementById('sidebarCollapse');
  const overlay = document.getElementById('sidebarOverlay');
  const mainContent = document.getElementById('mainContent');
  if (!sidebar) return;

  const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
  const closeMobile = () => {
    sidebar.classList.remove('show');
    if (overlay) overlay.classList.remove('show');
  };

  toggle?.addEventListener('click', () => {
    sidebar.classList.toggle('show');
    overlay?.classList.toggle('show');
  });
  overlay?.addEventListener('click', closeMobile);
  collapse?.addEventListener('click', () => {
    if (isMobile()) closeMobile();
    else {
      document.body.classList.toggle('sidebar-collapsed');
      const collapsed = document.body.classList.contains('sidebar-collapsed');
      collapse.setAttribute('aria-label', collapsed ? '展开侧边栏' : '收起侧边栏');
      collapse.setAttribute('title', collapsed ? '展开侧边栏' : '收起侧边栏');
    }
  });
  sidebar.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMobile));
});

// --- Draggable modals ---
function makeModalsDraggable() {
  document.querySelectorAll('.modal-overlay .modal').forEach(modal => {
    if (modal.dataset.draggable) return;
    modal.dataset.draggable = '1';
    const header = modal.querySelector('.modal-header');
    if (!header) return;
    let isDragging = false;
    let startX = 0, startY = 0;
    let modalX = 0, modalY = 0;

    header.style.cursor = 'move';
    header.style.userSelect = 'none';

    header.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('modal-close')) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = modal.getBoundingClientRect();
      modalX = rect.left;
      modalY = rect.top;
      modal.style.position = 'fixed';
      modal.style.left = modalX + 'px';
      modal.style.top = modalY + 'px';
      modal.style.margin = '0';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      modal.style.left = (modalX + dx) + 'px';
      modal.style.top = (modalY + dy) + 'px';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  });
}

// Auto-detect new modals and make them draggable
const modalObserver = new MutationObserver(() => {
  makeModalsDraggable();
});
document.addEventListener('DOMContentLoaded', () => {
  makeModalsDraggable();
  if (document.body) {
    modalObserver.observe(document.body, { childList: true, subtree: true });
  }
});
