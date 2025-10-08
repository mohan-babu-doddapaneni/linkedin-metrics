// content.js

// This IIFE (Immediately Invoked Function Expression) ensures the script's setup logic
// only runs once, even if it's injected multiple times.
(() => {
  if (window.hasMohanMetrics) {
    return; // The script has already been initialized.
  }
  window.hasMohanMetrics = true;

  // A global variable to hold the interval ID for our visibility check.
  let visibilityCheckInterval = null;

  /**
   * Ensures the widget exists on a job details page, creating it if necessary.
   * @returns {HTMLElement} The widget element.
   */
  function initializeWidget() {

    let widget = document.getElementById('linkedin-exact-metrics-widget');
    if (widget) {
      widget.style.display = 'block'; // Ensure it's visible if it was hidden
      return widget;
    }

    widget = document.createElement('div');
    widget.id = 'linkedin-exact-metrics-widget';
    widget.innerHTML = `
      <div class="widget-header">Job Posting Metrics</div>
      <div class="widget-body">
        <div id="exact-views"><strong>Views:</strong> <span>Loading...</span></div>
        <div id="exact-applicants"><strong>Applicants:</strong> <span>Loading...</span></div>
        <div id="exact-age"><strong>Posted:</strong> <span>Loading...</span></div>
      </div>
      <div class="widget-footer">Insights by MJ Metrics</div>
    `;
    widget.style.display = 'block'; // Make it visible
    document.body.appendChild(widget);
    return widget;
  }

  /**
   * Resets the widget to its initial "Loading..." state.
   */
  function resetWidget() {
    const widget = initializeWidget(); // This will create it if it doesn't exist.

    widget.querySelector('#exact-views span').textContent = 'Loading...';
    widget.querySelector('#exact-applicants span').textContent = 'Loading...';
    widget.querySelector('#exact-age span').textContent = 'Loading...';
    widget.style.display = 'block'; // Make sure it's visible.
  }
  /**
   * Hides the widget if it exists.
   */
  function hideWidget() {
    const widget = document.getElementById('linkedin-exact-metrics-widget');
    if (widget) {
      widget.style.display = 'none';
    }
  }

  /**
   * Periodically checks if the job details pane is still visible.
   * If not, it hides the widget. This is more reliable than URL-based checks.
   */
  function startVisibilityCheck() {
    // Clear any previous interval to prevent multiple checks running.
    if (visibilityCheckInterval) {
      clearInterval(visibilityCheckInterval);
    }

    visibilityCheckInterval = setInterval(() => {
      const jobDetailsVisible = document.querySelector('.jobs-details__main-content');
      if (!jobDetailsVisible) {
        hideWidget();
        clearInterval(visibilityCheckInterval); // Stop checking once hidden.
      }
    }, 1000); // Check every second.
  }

  /**
   * Updates the widget with the fetched data.
   * @param {number | string} viewCount 
   * @param {number | string} applicantCount
   * @param {string} jobAge
   */
  function updateWidget(viewCount, applicantCount, jobAge) {
    // Always ensure the widget exists before trying to update it.
    const widget = initializeWidget();
    if (!widget) {
      return; // Don't try to update if the widget shouldn't be on the page
    }

    const viewsSpan = widget.querySelector('#exact-views span');
    const applicantsSpan = widget.querySelector('#exact-applicants span');
    const ageSpan = widget.querySelector('#exact-age span');

    if (viewsSpan) {
      // Only format as a number if it is one, otherwise display the string directly.
      viewsSpan.textContent = typeof viewCount === 'number' ? viewCount.toLocaleString() : viewCount;
    }
    if (applicantsSpan) {
      // Only format as a number if it is one, otherwise display the string directly.
      applicantsSpan.textContent = typeof applicantCount === 'number' ? applicantCount.toLocaleString() : applicantCount;
    }
    if (ageSpan) {
      ageSpan.textContent = jobAge;
    }

    // Now that the widget is updated and visible, start checking if we should hide it.
    startVisibilityCheck();
  }

  // --- Main Execution ---

  const messageListener = (request, sender, sendResponse) => {
    if (request.type === "RESET_WIDGET") {
      // A new job page is being viewed, reset the widget to its loading state.
      resetWidget();
    } else if (request.type === "HIDE_WIDGET") {
      hideWidget();
    } else if (request.type === "UPDATE_METRICS") {
      // Ensure data exists before trying to destructure it.
      if (request.data) {
        console.log("Content script received metrics:", request.data);
        const { viewCount, applicantCount, jobAge } = request.data;
        updateWidget(viewCount, applicantCount, jobAge);
      }
    }
    return false; // No async response from other message types
  };

  // Listen for messages from the background script
  chrome.runtime.onMessage.removeListener(messageListener); // Remove old listener to be safe
  chrome.runtime.onMessage.addListener(messageListener);

})();
