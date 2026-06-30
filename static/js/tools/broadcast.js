/*
  AURA ∞ MUSIC - Broadcast Bulletins Submodule
  Fetches active bulletins from the backend and manages backend swap approvals.
*/

window.AuraBroadcast = {
    init() {
        this.fetchBroadcasts();
        window.addEventListener("aura-mode-change", () => {
            this.fetchBroadcasts();
        });
    },

    async fetchBroadcasts() {
        const container = document.getElementById("broadcasts-container");
        if (!container) return;

        const backendUrl = window.getAuraBackendUrl();
        if (!backendUrl) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fa-solid fa-server-slash"></i>
                    <p>No backend connection saved. Banners will appear here once connected.</p>
                </div>
            `;
            return;
        }

        try {
            const response = await fetch(`${backendUrl}/api/broadcasts`);
            if (!response.ok) {
                throw new Error("HTTP " + response.status);
            }
            const data = await response.json();
            const broadcasts = data.broadcasts || [];
            
            if (broadcasts.length === 0) {
                container.innerHTML = `
                    <div class="empty-state">
                        <i class="fa-solid fa-square-rss"></i>
                        <p>No active bulletins at this time.</p>
                    </div>
                `;
                return;
            }

            container.innerHTML = "";
            broadcasts.forEach(b => {
                const card = document.createElement("div");
                card.className = "broadcast-card glass-card";
                
                let actionButtonsHTML = "";
                
                // Add oAction/Use Backend buttons if backend_url is provided
                if (b.backend_url) {
                    actionButtonsHTML += `
                        <button class="btn btn-purple btn-sm use-backend-btn" data-url="${b.backend_url}">
                            <i class="fa-solid fa-circle-check"></i> Use Backend
                        </button>
                        <button class="btn btn-border btn-sm copy-backend-btn" data-url="${b.backend_url}">
                            <i class="fa-solid fa-copy"></i> Copy URL
                        </button>
                    `;
                }

                // Add custom CTA button if provided
                if (b.button_text && b.button_url) {
                    actionButtonsHTML += `
                        <a href="${b.button_url}" target="_blank" class="btn btn-border btn-sm cta-btn">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> ${b.button_text}
                        </a>
                    `;
                }

                card.innerHTML = `
                    <div class="broadcast-header">
                        <h4>${b.title}</h4>
                        <span class="broadcast-time">${new Date(b.created_at).toLocaleDateString()}</span>
                    </div>
                    <p class="broadcast-message">${b.message}</p>
                    ${actionButtonsHTML ? `<div class="broadcast-actions btn-row">${actionButtonsHTML}</div>` : ""}
                `;

                // Hook button listeners
                const useBtn = card.querySelector(".use-backend-btn");
                if (useBtn) {
                    useBtn.addEventListener("click", () => {
                        const targetUrl = useBtn.dataset.url;
                        window.showAuraConfirm(
                            "Switch Backend URL",
                            `Do you want to switch your backend connection to:\n${targetUrl}?`,
                            async () => {
                                try {
                                    const normalizedUrl = await window.saveBackendUrl(targetUrl);
                                    const isAlive = await window.checkBackendHealth();
                                    if (isAlive) {
                                        window.setMode("pro");
                                        showToast("Switched backend successfully! Pro Mode active ⚡");
                                    } else {
                                        window.setMode("lite");
                                        showToast("Backend switched, but host is offline.");
                                    }
                                    if (window.AuraBackend) window.AuraBackend.updateUI();
                                    this.fetchBroadcasts();
                                } catch (err) {
                                    showToast("Failed to switch backend URL.");
                                }
                            }
                        );
                    });
                }

                const copyBtn = card.querySelector(".copy-backend-btn");
                if (copyBtn) {
                    copyBtn.addEventListener("click", () => {
                        const targetUrl = copyBtn.dataset.url;
                        navigator.clipboard.writeText(targetUrl)
                            .then(() => showToast("URL copied to clipboard!"))
                            .catch(() => showToast("Failed to copy URL."));
                    });
                }

                container.appendChild(card);
            });

        } catch (e) {
            console.error("Fetch broadcasts error:", e);
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <p>Failed to load broadcasts. Backend might be unreachable.</p>
                </div>
            `;
        }
    }
};
