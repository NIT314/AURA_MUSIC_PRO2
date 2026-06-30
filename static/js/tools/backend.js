/*
  AURA ∞ MUSIC - Backend Connection Submodule
  Manages configuration saving, status checks, and health updates.
*/

window.AuraBackend = {
    init() {
        const urlInput = document.getElementById("backend-url-input");
        const saveBtn = document.getElementById("backend-save-btn");
        const copyBtn = document.getElementById("backend-copy-btn");
        const checkBtn = document.getElementById("backend-check-btn");

        if (urlInput) {
            urlInput.value = window.getAuraBackendUrl() || "";
        }

        if (saveBtn) {
            saveBtn.addEventListener("click", async () => {
                const rawUrl = urlInput.value.trim();
                if (!rawUrl) {
                    showToast("Please enter a backend URL.");
                    return;
                }
                saveBtn.disabled = true;
                saveBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
                
                try {
                    const normalizedUrl = await window.saveBackendUrl(rawUrl);
                    urlInput.value = normalizedUrl;
                    const isAlive = await window.checkBackendHealth();
                    if (isAlive) {
                        window.setMode("pro");
                        showToast("Backend connection verified. Pro Mode enabled!");
                    } else {
                        window.setMode("lite");
                        showToast("Backend saved, but host is offline or unreachable.");
                    }
                    this.updateUI();
                } catch (e) {
                    console.error("Save backend error:", e);
                    showToast("Error saving backend URL.");
                } finally {
                    saveBtn.disabled = false;
                    saveBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save`;
                }
            });
        }

        if (copyBtn) {
            copyBtn.addEventListener("click", () => {
                const url = urlInput.value.trim();
                if (!url) {
                    showToast("No URL to copy!");
                    return;
                }
                navigator.clipboard.writeText(url)
                    .then(() => showToast("Backend URL copied to clipboard!"))
                    .catch(() => showToast("Failed to copy URL."));
            });
        }

        if (checkBtn) {
            checkBtn.addEventListener("click", async () => {
                const currentUrl = window.getAuraBackendUrl();
                if (!currentUrl) {
                    showToast("No backend URL configured. Paste one first.");
                    return;
                }
                checkBtn.disabled = true;
                checkBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Checking...`;
                
                try {
                    const isAlive = await window.checkBackendHealth();
                    if (isAlive) {
                        window.setMode("pro");
                        showToast("Connection alive! Pro Mode enabled.");
                    } else {
                        window.setMode("lite");
                        showToast("Connection failed. Server is unreachable.");
                    }
                    this.updateUI();
                } catch (e) {
                    console.error("Check backend health error:", e);
                    showToast("Error checking backend status.");
                } finally {
                    checkBtn.disabled = false;
                    checkBtn.innerHTML = `<i class="fa-solid fa-circle-check"></i> Check Status`;
                }
            });
        }

        this.updateUI();
    },

    updateUI() {
        const indicator = document.getElementById("backend-health-indicator");
        const statusText = document.getElementById("backend-status-text");
        const currentUrl = window.getAuraBackendUrl();

        if (indicator && statusText) {
            if (!currentUrl) {
                indicator.className = "status-indicator offline";
                statusText.textContent = "Disconnected (No URL configured)";
            } else if (window.auraMode === "pro") {
                indicator.className = "status-indicator pro";
                statusText.textContent = "Connected (Pro Mode active)";
            } else {
                indicator.className = "status-indicator offline";
                statusText.textContent = "Disconnected (Host unreachable)";
            }
        }
        
        const urlInput = document.getElementById("backend-url-input");
        if (urlInput && urlInput.value !== currentUrl) {
            urlInput.value = currentUrl || "";
        }
    }
};
