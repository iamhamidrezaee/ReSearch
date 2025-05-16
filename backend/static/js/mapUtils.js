// mapUtils.js - Utility functions for paper map visualization

// Function to add a persistent legend to the orb visualization
function addPersistentOrbLegend() {
    // Remove any existing legend first
    const existingLegend = document.querySelector('.orb-legend');
    if (existingLegend) {
      existingLegend.remove();
    }
    
    // Create the legend container
    const legend = document.createElement('div');
    legend.className = 'orb-legend';
    
    // Add legend content with styled elements
    legend.innerHTML = `
      <h3>Paper Orb Guide</h3>
      <div class="legend-section">
        <div class="legend-title">Color</div>
        <div class="legend-item">
          <div class="color-gradient">
            <span class="gradient-dark"></span>
            <span class="gradient-light"></span>
          </div>
          <div class="legend-desc">Less similar → More similar to center</div>
        </div>
      </div>
      
      <div class="legend-section">
        <div class="legend-title">Size</div>
        <div class="legend-item">
          <div class="size-gradient">
            <span class="size-small"></span>
            <span class="size-medium"></span>
            <span class="size-large"></span>
          </div>
          <div class="legend-desc">Fewer → More citations</div>
        </div>
      </div>
      
      <div class="legend-section">
        <div class="legend-title">Interaction</div>
        <div class="legend-item with-icon">
          <div class="drag-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 8C14 9.1 13.1 10 12 10C10.9 10 10 9.1 10 8C10 6.9 10.9 6 12 6C13.1 6 14 6.9 14 8Z"></path>
              <path d="M12 12L12 18"></path>
              <path d="M12 12L16 14"></path>
              <path d="M12 12L8 14"></path>
            </svg>
          </div>
          <div class="legend-desc">Drag papers away from the cluster to create new clusters</div>
        </div>
      </div>
    `;
    
    // Add toggle button for minimizing/maximizing legend
    const toggleBtn = document.createElement('div');
    toggleBtn.className = 'orb-legend-toggle';
    toggleBtn.innerHTML = '−';
    toggleBtn.title = 'Minimize/Maximize';
    
    toggleBtn.addEventListener('click', () => {
      if (legend.classList.contains('minimized')) {
        legend.classList.remove('minimized');
        toggleBtn.innerHTML = '−';
      } else {
        legend.classList.add('minimized');
        toggleBtn.innerHTML = '+';
      }
    });
    
    legend.appendChild(toggleBtn);
    
    // Add legend to the full-body-container instead of map-container
    // This will make it persist even if the map container is cleared
    const fullBodyContainer = document.querySelector('.full-body-container');
    if (fullBodyContainer) {
      fullBodyContainer.appendChild(legend);
    }
  }