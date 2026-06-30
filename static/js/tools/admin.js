/*
  AURA ∞ MUSIC - Admin Portal Submodule
  Handles session-based JWT authentication, broadcast CRUD forms, and credentials updates.
*/

window.AuraAdmin = {
    // Session token kept strictly in-memory (XSS protection)
    adminToken: null,

    init() {
        const loginBtn = document.getElementById("admin-login-btn");
        const logoutBtn = document.getElementById("admin-logout-btn");
        
        const createBroadcastBtn = document.getElementById("admin-create-broadcast-btn");
        const changePassBtn = document.getElementById("admin-change-pass-trigger");
        
        const savePassBtn = document.getElementById("admin-save-pass-btn");
        const cancelPassBtn = document.getElementById("admin-cancel-pass-btn");

        const saveBroadcastAction = document.getElementById("broadcast-save-btn-action");
        const cancelBroadcastAction = document.getElementById("broadcast-cancel-btn-action");

        if (loginBtn) {
            loginBtn.addEventListener("click", () => this.login());
            // Allow enter key to submit login
            const passInput = document.getElementById("admin-password");
            if (passInput) {
                passInput.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") this.login();
                });
            }
        }

        if (logoutBtn) {
            logoutBtn.addEventListener("click", () => this.logout());
        }

        if (createBroadcastBtn) {
            createBroadcastBtn.addEventListener("click", () => {
                this.showBroadcastForm(null); // Create mode
            });
        }

        if (changePassBtn) {
            changePassBtn.addEventListener("click", () => {
                this.showChangePasswordSection(true);
            });
        }

        if (savePassBtn) {
            savePassBtn.addEventListener("click", () => this.changePassword());
        }

        if (cancelPassBtn) {
            cancelPassBtn.addEventListener("click", () => {
                this.showChangePasswordSection(false);
            });
        }

        if (saveBroadcastAction) {
            saveBroadcastAction.addEventListener("click", () => this.saveBroadcast());
        }

        if (cancelBroadcastAction) {
            cancelBroadcastAction.addEventListener("click", () => {
                this.hideBroadcastForm();
            });
        }
    },

    async login() {
        const usernameEl = document.getElementById("admin-username");
        const passwordEl = document.getElementById("admin-password");
        const loginBtn = document.getElementById("admin-login-btn");

        if (!usernameEl || !passwordEl) return;

        const username = usernameEl.value.trim();
        const password = passwordEl.value.trim();

        if (!username || !password) {
            showToast("Enter username and password.");
            return;
        }

        const backendUrl = window.getAuraBackendUrl();
        if (!backendUrl) {
            showToast("Connect to a backend to access admin controls.");
            return;
        }

        loginBtn.disabled = true;
        loginBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Logging in...`;

        try {
            const res = await fetch(`${backendUrl}/api/admin/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password })
            });

            if (res.status === 429) {
                showToast("Rate limit exceeded. Try again in a minute.");
                return;
            }

            if (!res.ok) {
                const err = await res.json();
                showToast(err.detail || "Authentication failed.");
                return;
            }

            const data = await res.json();
            this.adminToken = data.token;
            
            // Clear inputs
            usernameEl.value = "";
            passwordEl.value = "";

            showToast("Logged in successfully!");
            this.togglePanelState(true);

            if (data.is_default_password) {
                showToast("⚠️ Please change the default password immediately!");
                this.showChangePasswordSection(true);
            } else {
                this.loadAdminBroadcastsList();
            }

        } catch (e) {
            console.error("Login request error:", e);
            showToast("Error connecting to login endpoint.");
        } finally {
            loginBtn.disabled = false;
            loginBtn.innerHTML = `<i class="fa-solid fa-right-to-bracket"></i> Login`;
        }
    },

    logout() {
        this.adminToken = null;
        showToast("Logged out successfully.");
        this.togglePanelState(false);
        this.hideBroadcastForm();
        this.showChangePasswordSection(false);
    },

    togglePanelState(isLoggedIn) {
        const loggedOutEl = document.getElementById("admin-logged-out");
        const loggedInEl = document.getElementById("admin-logged-in");

        if (isLoggedIn) {
            if (loggedOutEl) loggedOutEl.classList.add("hide");
            if (loggedInEl) loggedInEl.classList.remove("hide");
        } else {
            if (loggedOutEl) loggedOutEl.classList.remove("hide");
            if (loggedInEl) loggedInEl.classList.add("hide");
        }
    },

    showChangePasswordSection(show) {
        const section = document.getElementById("admin-change-password-section");
        if (!section) return;
        if (show) {
            section.classList.remove("hide");
            this.hideBroadcastForm();
            const passInput = document.getElementById("admin-new-password");
            if (passInput) passInput.focus();
        } else {
            section.classList.add("hide");
            const passInput = document.getElementById("admin-new-password");
            if (passInput) passInput.value = "";
        }
    },

    async changePassword() {
        const newPasswordEl = document.getElementById("admin-new-password");
        const saveBtn = document.getElementById("admin-save-pass-btn");

        if (!newPasswordEl) return;
        const new_password = newPasswordEl.value.trim();

        if (!new_password || new_password.length < 6) {
            showToast("Password must be at least 6 characters.");
            return;
        }

        const backendUrl = window.getAuraBackendUrl();
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving...";

        try {
            const res = await fetch(`${backendUrl}/api/admin/change-password`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${this.adminToken}`
                },
                body: JSON.stringify({ new_password })
            });

            if (res.ok) {
                showToast("Password changed successfully!");
                this.showChangePasswordSection(false);
                this.loadAdminBroadcastsList();
            } else {
                const err = await res.json();
                showToast(err.detail || "Failed to update password.");
            }
        } catch (e) {
            showToast("Network error. Password update failed.");
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = "Save Password";
        }
    },

    showBroadcastForm(editData) {
        const form = document.getElementById("broadcast-form-section");
        const titleEl = document.getElementById("broadcast-form-title");
        const editIdEl = document.getElementById("broadcast-edit-id");

        const tInput = document.getElementById("broadcast-title");
        const mInput = document.getElementById("broadcast-message");
        const bUrlInput = document.getElementById("broadcast-backend-url");
        const btnTextInput = document.getElementById("broadcast-btn-text");
        const btnUrlInput = document.getElementById("broadcast-btn-url");
        const expiresInput = document.getElementById("broadcast-expires-at");
        const enabledInput = document.getElementById("broadcast-enabled");

        if (!form) return;
        form.classList.remove("hide");
        this.showChangePasswordSection(false);

        if (editData) {
            titleEl.textContent = "Edit Broadcast";
            editIdEl.value = editData.id;
            tInput.value = editData.title || "";
            mInput.value = editData.message || "";
            bUrlInput.value = editData.backend_url || "";
            btnTextInput.value = editData.button_text || "";
            btnUrlInput.value = editData.button_url || "";
            
            // Format datetime: YYYY-MM-DDThh:mm
            if (editData.expires_at) {
                try {
                    const dt = new Date(editData.expires_at);
                    const formatted = dt.toISOString().slice(0, 16);
                    expiresInput.value = formatted;
                } catch {
                    expiresInput.value = "";
                }
            } else {
                expiresInput.value = "";
            }
            enabledInput.checked = editData.enabled !== false;
        } else {
            titleEl.textContent = "Create Broadcast";
            editIdEl.value = "";
            tInput.value = "";
            mInput.value = "";
            bUrlInput.value = "";
            btnTextInput.value = "";
            btnUrlInput.value = "";
            expiresInput.value = "";
            enabledInput.checked = true;
        }
        
        tInput.focus();
    },

    hideBroadcastForm() {
        const form = document.getElementById("broadcast-form-section");
        if (form) form.classList.add("hide");
    },

    async saveBroadcast() {
        const editId = document.getElementById("broadcast-edit-id").value;
        
        const title = document.getElementById("broadcast-title").value.trim();
        const message = document.getElementById("broadcast-message").value.trim();
        const backend_url = document.getElementById("broadcast-backend-url").value.trim();
        const button_text = document.getElementById("broadcast-btn-text").value.trim();
        const button_url = document.getElementById("broadcast-btn-url").value.trim();
        const expiresRaw = document.getElementById("broadcast-expires-at").value;
        const enabled = document.getElementById("broadcast-enabled").checked;

        if (!title || !message) {
            showToast("Title and message are required.");
            return;
        }

        let expires_at = null;
        if (expiresRaw) {
            expires_at = new Date(expiresRaw).toISOString();
        }

        const payload = {
            title,
            message,
            backend_url: backend_url || null,
            button_text: button_text || null,
            button_url: button_url || null,
            expires_at,
            enabled
        };

        const backendUrl = window.getAuraBackendUrl();
        const saveActionBtn = document.getElementById("broadcast-save-btn-action");
        saveActionBtn.disabled = true;

        try {
            let res;
            if (editId) {
                // PUT update
                res = await fetch(`${backendUrl}/api/admin/broadcasts/${editId}`, {
                    method: "PUT",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${this.adminToken}`
                    },
                    body: JSON.stringify(payload)
                });
            } else {
                // POST create
                res = await fetch(`${backendUrl}/api/admin/broadcasts`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${this.adminToken}`
                    },
                    body: JSON.stringify(payload)
                });
            }

            if (res.ok) {
                showToast("Broadcast saved successfully!");
                this.hideBroadcastForm();
                this.loadAdminBroadcastsList();
                // Sync public viewer list
                if (window.AuraBroadcast) window.AuraBroadcast.fetchBroadcasts();
            } else {
                const err = await res.json();
                showToast(err.detail || "Error saving broadcast.");
            }
        } catch (e) {
            showToast("Network error. Failed to save broadcast.");
        } finally {
            saveActionBtn.disabled = false;
        }
    },

    async loadAdminBroadcastsList() {
        const container = document.getElementById("admin-broadcasts-list-container");
        if (!container) return;

        container.innerHTML = `<div class="loading-state"><i class="fa-solid fa-spinner fa-spin"></i> Refreshing list...</div>`;

        const backendUrl = window.getAuraBackendUrl();
        try {
            // Note: Public list endpoint /api/broadcasts filters expired server-side.
            // Admin lists might want to fetch directly or see all.
            // For simplicity, we fetch all broadcasts from the public endpoint or load DB lists.
            // Let's use the public endpoint as fallback but load everything.
            const response = await fetch(`${backendUrl}/api/broadcasts`);
            if (!response.ok) throw new Error();
            const data = await response.json();
            const broadcasts = data.broadcasts || [];

            if (broadcasts.length === 0) {
                container.innerHTML = `<p class="info-text">No broadcasts configured.</p>`;
                return;
            }

            container.innerHTML = "<h4>Active Bulletins</h4>";
            broadcasts.forEach(b => {
                const row = document.createElement("div");
                row.className = "admin-broadcast-row glass-card";
                row.innerHTML = `
                    <div class="row-info">
                        <strong>${b.title}</strong>
                        <p>${b.message.substring(0, 50)}${b.message.length > 50 ? '...' : ''}</p>
                    </div>
                    <div class="row-actions btn-row">
                        <button class="btn btn-border btn-xs edit-btn"><i class="fa-solid fa-pen"></i></button>
                        <button class="btn btn-border btn-xs delete-btn"><i class="fa-solid fa-trash"></i></button>
                    </div>
                `;

                row.querySelector(".edit-btn").addEventListener("click", () => {
                    this.showBroadcastForm(b);
                });

                row.querySelector(".delete-btn").addEventListener("click", async () => {
                    if (confirm(`Delete broadcast: "${b.title}"?`)) {
                        try {
                            const delRes = await fetch(`${backendUrl}/api/admin/broadcasts/${b.id}`, {
                                method: "DELETE",
                                headers: { "Authorization": `Bearer ${this.adminToken}` }
                            });
                            if (delRes.ok) {
                                showToast("Deleted successfully.");
                                this.loadAdminBroadcastsList();
                                if (window.AuraBroadcast) window.AuraBroadcast.fetchBroadcasts();
                            } else {
                                showToast("Failed to delete.");
                            }
                        } catch (err) {
                            showToast("Error deleting item.");
                        }
                    }
                });

                container.appendChild(row);
            });
        } catch (e) {
            container.innerHTML = `<p class="error-text">Failed to fetch list.</p>`;
        }
    }
};
