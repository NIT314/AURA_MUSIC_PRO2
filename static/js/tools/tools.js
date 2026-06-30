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
