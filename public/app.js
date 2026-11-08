// public/app.js — API client + UI helpers untuk Nokos.ID V2

const API = (() => {
  async function request(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    let body = opts.body;
    if (!(body instanceof FormData) && body && typeof body === "object") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    // CSRF: ambil dari cookie nokos_csrf, kirim via header
    const csrf = readCookie("nokos_csrf");
    if (csrf && ["POST", "PUT", "PATCH", "DELETE"].includes(opts.method || "GET")) {
      headers["X-CSRF-Token"] = csrf;
    }
    const res = await fetch(path, { ...opts, headers, body, credentials: "same-origin" });
    const ct = res.headers.get("Content-Type") || "";
    let data = null;
    if (ct.includes("application/json")) {
      data = await res.json();
    } else if (ct.includes("image/") || ct.includes("application/octet-stream")) {
      data = await res.blob();
    } else {
      data = await res.text().catch(() => null);
    }
    if (!res.ok) {
      const msg = data?.error || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.code = data?.code;
      err.data = data;
      throw err;
    }
    return data;
  }

  function readCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/([.$?*|{}()[]\\\/+^])/g, "\\$1") + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }

  return {
    register: (payload) => request("/api/auth/register", { method: "POST", body: payload }),
    login: (payload) => request("/api/auth/login", { method: "POST", body: payload }),
    logout: () => request("/api/auth/logout", { method: "POST" }),
    me: () => request("/api/auth/me"),
    wallet: () => request("/api/wallet"),
    walletTransactions: (limit = 20, offset = 0) => request(`/api/wallet/transactions?limit=${limit}&offset=${offset}`),
    deposits: {
      list: () => request("/api/deposits"),
      create: (amount) => request("/api/deposits", { method: "POST", body: { amount } }),
      get: (id) => request(`/api/deposits/${id}`),
      uploadProof: (id, file) => {
        const fd = new FormData();
        fd.append("proof", file);
        return request(`/api/deposits/${id}/proof`, { method: "POST", body: fd });
      },
      cancel: (id) => request(`/api/deposits/${id}/cancel`, { method: "POST" }),
    },
    notifications: () => request("/api/notifications"),
    markNotifRead: (id) => request(`/api/notifications?id=${encodeURIComponent(id)}`, { method: "POST" }),
    otp: {
      providers: () => request("/api/otp/providers"),
      countries: (provider) => request(`/api/otp/countries${provider ? "?provider=" + encodeURIComponent(provider) : ""}`),
      services: (country, provider) => request(`/api/otp/services?country=${encodeURIComponent(country || "")}${provider ? "&provider=" + encodeURIComponent(provider) : ""}`),
      prices: (country, service, provider) => request(`/api/otp/prices?country=${encodeURIComponent(country)}&service=${encodeURIComponent(service)}${provider ? "&provider=" + encodeURIComponent(provider) : ""}`),
      route: (country, service, mode, provider) => {
        const q = new URLSearchParams({ country: country || "", service: service || "", mode: mode || "priority" });
        if (provider) q.set("provider", provider);
        return request(`/api/otp/route?${q.toString()}`);
      },
      createOrder: (payload) => request("/api/otp/orders", { method: "POST", body: payload }),
      listOrders: () => request("/api/otp/orders"),
      getOrder: (id) => request(`/api/otp/orders/${id}`),
      confirmOrder: (id) => request(`/api/otp/orders/${id}`, { method: "POST" }),
      pollStatus: (id) => request(`/api/otp/orders/${id}/status`),
      cancel: (id) => request(`/api/otp/orders/${id}/cancel`, { method: "POST" }),
    },
    admin: {
      deposits: (status = "pending") => request(`/api/admin/deposits?status=${encodeURIComponent(status)}`),
      approve: (id) => request(`/api/admin/deposits/${id}/approve`, { method: "POST" }),
      reject: (id, reason) => request(`/api/admin/deposits/${id}/reject`, { method: "POST", body: { reason } }),
      proofUrl: (id) => `/api/admin/deposits/${id}/proof`,
      stats: () => request("/api/admin/stats"),
      auditLog: (action, limit, offset) =>
        request(`/api/admin/audit-log?${action ? "action=" + encodeURIComponent(action) + "&" : ""}limit=${limit || 50}&offset=${offset || 0}`),
      providers: () => request("/api/admin/providers"),
      providerStats: () => request("/api/admin/providers/stats"),
      createProvider: (payload) => request("/api/admin/providers", { method: "POST", body: payload }),
      getProvider: (id) => request(`/api/admin/providers/${id}`),
      updateProvider: (id, payload) => request(`/api/admin/providers/${id}`, { method: "PATCH", body: payload }),
      deleteProvider: (id) => request(`/api/admin/providers/${id}`, { method: "DELETE" }),
      testProvider: (id) => request(`/api/admin/providers/${id}/test`, { method: "POST" }),
      providerBalance: (id) => request(`/api/admin/providers/${id}/balance`, { method: "POST" }),
    },
    twoFA: {
      setup: () => request("/api/auth/2fa/setup", { method: "POST" }),
      verify: (payload) => request("/api/auth/2fa/verify", { method: "POST", body: payload }),
    },
  };
})();

// ---------- UI helpers ----------
function fmtIDR(cents) {
  if (cents === null || cents === undefined) return "-";
  const rp = Math.floor(cents / 100);
  return "Rp" + rp.toLocaleString("id-ID");
}
function fmtDate(ts) {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  return d.toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function statusBadge(status) {
  const s = String(status || "").toLowerCase();
  const cls = ["approved", "completed", "active"].includes(s) ? "badge-approved"
    : ["rejected", "failed", "cancelled", "cancel"].includes(s) ? "badge-rejected"
    : ["expired"].includes(s) ? "badge-expired"
    : "badge-pending";
  return `<span class="badge ${cls}">${status}</span>`;
}

function toast(message, type = "info", timeout = 3500) {
  let container = document.getElementById("toast");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast";
    document.body.appendChild(container);
  }
  const item = document.createElement("div");
  item.className = `toast-item ${type}`;
  item.textContent = message;
  container.appendChild(item);
  setTimeout(() => {
    item.style.opacity = "0";
    item.style.transition = "opacity 0.3s";
    setTimeout(() => item.remove(), 300);
  }, timeout);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function toggleNav() {
  const links = document.querySelector(".nav-links");
  if (links) links.classList.toggle("open");
}

async function requireAuth() {
  try {
    const me = await API.me();
    return me;
  } catch {
    window.location.href = "/login.html";
    return null;
  }
}

async function requireAdmin() {
  const me = await requireAuth();
  if (!me) return null;
  if (!["super_admin", "admin_deposit", "admin_support", "admin_ops"].includes(me.user.role)) {
    toast("Akses ditolak. Halaman khusus admin.", "error");
    setTimeout(() => (window.location.href = "/dashboard.html"), 1500);
    return null;
  }
  return me;
}

async function logout() {
  try { await API.logout(); } catch {}
  window.location.href = "/login.html";
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

window.API = API;
window.toast = toast;
window.fmtIDR = fmtIDR;
window.fmtDate = fmtDate;
window.statusBadge = statusBadge;
window.el = el;
window.requireAuth = requireAuth;
window.requireAdmin = requireAdmin;
window.logout = logout;
window.toggleNav = toggleNav;
window.escapeHtml = escapeHtml;
