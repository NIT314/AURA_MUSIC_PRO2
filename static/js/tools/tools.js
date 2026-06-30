/*
  AURA ∞ MUSIC - Tools Orchestrator
  Manages initialization of tools submodules and general page UI bindings.
*/

document.addEventListener("DOMContentLoaded", () => {
    // Initialize Tools UI submodules
    if (window.AuraBackend) AuraBackend.init();
    if (window.AuraUniversalLink) AuraUniversalLink.init();
    if (window.AuraBroadcast) AuraBroadcast.init();
    if (window.AuraAdmin) AuraAdmin.init();

    // Setup general collapse triggers (Listening Stats & Admin Portal)
    const collapseTriggers = document.querySelectorAll(".collapse-trigger");
    collapseTriggers.forEach(trigger => {
        trigger.addEventListener("click", () => {
            const isCollapsed = trigger.classList.contains("collapsed");
            
            // Toggle header state
            if (isCollapsed) {
                trigger.classList.remove("collapsed");
            } else {
                trigger.classList.add("collapsed");
            }

            // Toggle content visibility
            const content = trigger.nextElementSibling;
            if (content) {
                if (content.classList.contains("hide")) {
                    content.classList.remove("hide");
                    // Micro-animation scroll into view if needed
                    trigger.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                } else {
                    content.classList.add("hide");
                }
            }
        });
    });
});

// Premium custom dynamic modal dialog system
window.showAuraConfirm = function(title, message, onConfirm, onCancel) {
    const modal = document.getElementById("aura-dialog-modal");
    const titleEl = document.getElementById("aura-dialog-title");
    const msgEl = document.getElementById("aura-dialog-message");
    
    const confirmBtn = document.getElementById("aura-dialog-confirm-btn");
    const cancelBtn = document.getElementById("aura-dialog-cancel-btn");
    const closeBtn = document.getElementById("aura-dialog-close-btn");

    if (!modal || !confirmBtn || !cancelBtn || !closeBtn) return;

    titleEl.textContent = title;
    msgEl.textContent = message;

    // Clean dynamic listener overrides to prevent trigger duplication
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
    
    const newCancelBtn = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
    
    const newCloseBtn = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);

    const closeModal = () => {
        modal.classList.add("hide");
    };

    newConfirmBtn.addEventListener("click", () => {
        closeModal();
        if (onConfirm) onConfirm();
    });

    const cancelHandler = () => {
        closeModal();
        if (onCancel) onCancel();
    };

    newCancelBtn.addEventListener("click", cancelHandler);
    newCloseBtn.addEventListener("click", cancelHandler);

    modal.classList.remove("hide");
};
